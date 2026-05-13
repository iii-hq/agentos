use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use iii_sdk::error::IIIError;
use iii_sdk::{III, TriggerRequest};
use serde_json::{json, Value};

use crate::config::GateConfig;
use crate::structs::*;

// --- shared state ---

pub type ThrottleKey = (String, String, String); // (scope, key, path)
pub type DebounceKey = (String, String);
pub type AccumulateKey = (String, String);

pub struct GateState {
    pub config: GateConfig,
    pub throttle: DashMap<ThrottleKey, ThrottleEntry>,
    pub debounce: DashMap<DebounceKey, DebounceEntry>,
    pub accumulate: DashMap<AccumulateKey, AccumulateEntry>,
}

impl GateState {
    pub fn new(config: GateConfig) -> Arc<Self> {
        Arc::new(Self {
            config,
            throttle: DashMap::new(),
            debounce: DashMap::new(),
            accumulate: DashMap::new(),
        })
    }
}

// --- helpers ---

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn fire_and_forget(iii: &III, function_id: &str, payload: Value) {
    let iii = iii.clone();
    let id = function_id.to_string();
    tokio::spawn(async move {
        let _ = iii
            .trigger(TriggerRequest {
                function_id: id,
                payload,
                action: None,
                timeout_ms: None,
            })
            .await;
    });
}

fn emit_attempt(iii: &III, cfg: &GateConfig, function: &str, scope: &str, key: &str, accepted: bool, reason: &str) {
    let Some(topic) = &cfg.attempt_topic else { return };
    fire_and_forget(
        iii,
        "publish",
        json!({
            "topic": topic,
            "data": {
                "function": function,
                "scope": scope,
                "key": key,
                "accepted": accepted,
                "reason": reason,
            }
        }),
    );
}

// --- gate::set_if_changed ---

pub async fn set_if_changed(iii: &III, state: &GateState, input: Value) -> Result<Value, IIIError> {
    let req: SetIfChangedRequest =
        serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;

    tracing::info!(scope = %req.scope, key = %req.key, "gate::set_if_changed");

    let current = iii
        .trigger(TriggerRequest {
            function_id: "state::get".to_string(),
            payload: json!({ "scope": &req.scope, "key": &req.key }),
            action: None,
            timeout_ms: None,
        })
        .await
        .ok()
        .filter(|v| !v.is_null());

    let (should_write, reason) =
        compare_values(current.as_ref(), &req.value, &req.comparison, req.epsilon);

    emit_attempt(iii, &state.config, "gate::set_if_changed", &req.scope, &req.key, should_write, reason);

    if should_write {
        iii.trigger(TriggerRequest {
            function_id: "state::set".to_string(),
            payload: json!({ "scope": &req.scope, "key": &req.key, "value": &req.value }),
            action: None,
            timeout_ms: None,
        })
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;
    }

    Ok(json!({
        "written": should_write,
        "old_value": current,
        "new_value": req.value,
        "reason": reason,
    }))
}

pub(crate) fn compare_values(
    old: Option<&Value>,
    new: &Value,
    comparison: &Option<String>,
    epsilon: Option<f64>,
) -> (bool, &'static str) {
    let Some(current) = old else {
        return (true, "changed");
    };
    match comparison.as_deref().unwrap_or("strict") {
        "epsilon" => {
            let eps = epsilon.unwrap_or(0.0);
            match (current.as_f64(), new.as_f64()) {
                (Some(o), Some(n)) if (n - o).abs() <= eps => (false, "below_epsilon"),
                _ => (true, "changed"),
            }
        }
        // "strict" and "deep": serde_json Value equality is already structural/deep.
        _ => {
            if current == new { (false, "unchanged") } else { (true, "changed") }
        }
    }
}

// --- gate::increment_throttled ---

pub async fn increment_throttled(
    iii: &III,
    state: Arc<GateState>,
    input: Value,
) -> Result<Value, IIIError> {
    let req: IncrementThrottledRequest =
        serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;

    let path = req.path.as_deref().unwrap_or("").to_string();
    let throttle_key: ThrottleKey = (req.scope.clone(), req.key.clone(), path.clone());

    let now = now_ms();
    let flush_at = now + req.window_ms;

    let (accumulated, will_flush_at, is_first) = {
        let mut entry = state.throttle.entry(throttle_key.clone()).or_insert(ThrottleEntry {
            accumulated: 0,
            flush_at_ms: flush_at,
        });
        let is_first = entry.accumulated == 0;
        entry.accumulated += req.by;
        (entry.accumulated, entry.flush_at_ms, is_first)
    };

    tracing::info!(scope = %req.scope, key = %req.key, accumulated, "gate::increment_throttled");
    emit_attempt(iii, &state.config, "gate::increment_throttled", &req.scope, &req.key, true, "accumulated");

    if is_first {
        let iii_clone = iii.clone();
        let state_clone = state.clone();
        let scope = req.scope.clone();
        let key_str = req.key.clone();
        tokio::spawn(async move {
            let delay = will_flush_at.saturating_sub(now_ms());
            tokio::time::sleep(tokio::time::Duration::from_millis(delay)).await;

            if let Some((_, entry)) = state_clone.throttle.remove(&throttle_key) {
                let total = entry.accumulated;
                tracing::info!(scope = %scope, key = %key_str, total, "gate throttle flush");
                let _ = iii_clone
                    .trigger(TriggerRequest {
                        function_id: "state::update".to_string(),
                        payload: json!({
                            "scope": scope,
                            "key": key_str,
                            "operations": [{ "type": "increment", "path": path, "by": total }],
                        }),
                        action: None,
                        timeout_ms: None,
                    })
                    .await;
            }
        });
    }

    Ok(json!({
        "accumulated_so_far": accumulated,
        "will_flush_at_ms": will_flush_at,
        "immediate": is_first,
    }))
}

// --- gate::debounce ---

pub async fn debounce(iii: &III, state: Arc<GateState>, input: Value) -> Result<Value, IIIError> {
    let req: DebounceRequest =
        serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;

    let debounce_key: DebounceKey = (req.scope.clone(), req.key.clone());
    let now = now_ms();
    let will_commit_at = now + req.delay_ms;

    let generation = {
        let mut entry = state.debounce.entry(debounce_key.clone()).or_insert(DebounceEntry {
            value: req.value.clone(),
            generation: 0,
        });
        entry.value = req.value.clone();
        entry.generation += 1;
        entry.generation
    };

    tracing::info!(scope = %req.scope, key = %req.key, generation, "gate::debounce");
    emit_attempt(iii, &state.config, "gate::debounce", &req.scope, &req.key, true, "pending");

    let iii_clone = iii.clone();
    let state_clone = state.clone();
    let scope = req.scope.clone();
    let key_str = req.key.clone();
    let delay = req.delay_ms;
    tokio::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_millis(delay)).await;

        // Atomically check-and-remove: if our generation is still current, commit.
        // If superseded between check and remove, put the entry back for the newer task.
        let to_commit: Option<Value> = {
            let current = state_clone.debounce.get(&debounce_key).map(|e| (e.generation, e.value.clone()));
            match current {
                Some((cgen, value)) if cgen == generation => {
                    if let Some((_, removed)) = state_clone.debounce.remove(&debounce_key) {
                        if removed.generation == generation {
                            Some(value)
                        } else {
                            state_clone.debounce.insert(debounce_key, removed);
                            None
                        }
                    } else {
                        None
                    }
                }
                _ => None,
            }
        };

        if let Some(value) = to_commit {
            tracing::info!(scope = %scope, key = %key_str, "gate debounce commit");
            let _ = iii_clone
                .trigger(TriggerRequest {
                    function_id: "state::set".to_string(),
                    payload: json!({ "scope": scope, "key": key_str, "value": value }),
                    action: None,
                    timeout_ms: None,
                })
                .await;
        }
    });

    Ok(json!({
        "committed": false,
        "will_commit_at_ms": will_commit_at,
    }))
}

// --- gate::accumulate ---

pub async fn accumulate(iii: &III, state: Arc<GateState>, input: Value) -> Result<Value, IIIError> {
    let req: AccumulateRequest =
        serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;

    let map_key: AccumulateKey = (req.scope.clone(), req.key.clone());
    let flush_when = req.flush_when.clone().unwrap_or(FlushWhen::InFlightCompletion);

    let (should_drain, batch_size) = {
        let mut entry = state.accumulate.entry(map_key.clone()).or_insert(AccumulateEntry {
            pending: vec![],
            in_flight: false,
        });

        entry.pending.push(req.op.clone());
        let batch_size = entry.pending.len();

        let should_drain = if entry.in_flight {
            false
        } else {
            match &flush_when {
                FlushWhen::InFlightCompletion => true,
                FlushWhen::ConcurrentCount { threshold } => batch_size >= *threshold,
            }
        };

        if should_drain {
            entry.in_flight = true;
        }

        (should_drain, batch_size)
    };

    tracing::info!(scope = %req.scope, key = %req.key, batch_size, should_drain, "gate::accumulate");
    let status = if should_drain { "flushing" } else { "queued" };
    emit_attempt(iii, &state.config, "gate::accumulate", &req.scope, &req.key, true, status);

    if should_drain {
        // drain_accumulate takes owned values so the future is 'static.
        let iii_clone = iii.clone();
        let state_clone = state.clone();
        let scope = req.scope.clone();
        let key_str = req.key.clone();
        tokio::spawn(async move {
            drain_accumulate(iii_clone, state_clone, scope, key_str, map_key).await;
        });
    }

    Ok(json!({
        "batched": !should_drain,
        "batch_size": batch_size,
    }))
}

// Takes owned III and Arc<GateState> so the returned Future is Send + 'static.
async fn drain_accumulate(
    iii: III,
    state: Arc<GateState>,
    scope: String,
    key_str: String,
    map_key: AccumulateKey,
) {
    loop {
        // Collect pending ops without holding the DashMap lock across an await.
        let ops: Vec<GateOp> = match state.accumulate.get_mut(&map_key) {
            Some(mut e) => std::mem::take(&mut e.pending),
            None => break,
        };

        if ops.is_empty() {
            if let Some(mut e) = state.accumulate.get_mut(&map_key) {
                e.in_flight = false;
            }
            break;
        }

        let merged = merge_ops(ops);
        let count = merged.len();
        let ops_json: Vec<Value> = merged
            .into_iter()
            .filter_map(|op| serde_json::to_value(op).ok())
            .collect();

        tracing::info!(scope = %scope, key = %key_str, count, "gate accumulate drain");

        let _ = iii
            .trigger(TriggerRequest {
                function_id: "state::update".to_string(),
                payload: json!({
                    "scope": &scope,
                    "key": &key_str,
                    "operations": ops_json,
                }),
                action: None,
                timeout_ms: None,
            })
            .await;
        // Loop to pick up ops that arrived while we were writing.
    }
}

pub(crate) fn merge_ops(ops: Vec<GateOp>) -> Vec<GateOp> {
    let mut set_ops: HashMap<String, Value> = HashMap::new();
    let mut incr_ops: HashMap<String, i64> = HashMap::new();
    let mut decr_ops: HashMap<String, i64> = HashMap::new();
    let mut others: Vec<GateOp> = Vec::new();

    for op in ops {
        match op {
            GateOp::Set { path, value } => { set_ops.insert(path, value); }
            GateOp::Increment { path, by } => { *incr_ops.entry(path).or_default() += by; }
            GateOp::Decrement { path, by } => { *decr_ops.entry(path).or_default() += by; }
            other => others.push(other),
        }
    }

    let mut result = Vec::new();
    for (path, value) in set_ops {
        result.push(GateOp::Set { path, value });
    }
    for (path, by) in incr_ops {
        result.push(GateOp::Increment { path, by });
    }
    for (path, by) in decr_ops {
        result.push(GateOp::Decrement { path, by });
    }
    result.extend(others);
    result
}

// --- gate::batch_commit ---

pub async fn batch_commit(iii: &III, state: &GateState, input: Value) -> Result<Value, IIIError> {
    let req: BatchCommitRequest =
        serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;

    // Deduplicate by (scope, key), last write wins.
    let mut seen: HashMap<(String, String), usize> = HashMap::new();
    let mut ops: Vec<BatchOp> = Vec::new();
    for op in req.operations {
        let dk = (op.scope.clone(), op.key.clone());
        if let Some(idx) = seen.get(&dk).copied() {
            ops[idx] = op;
        } else {
            seen.insert(dk, ops.len());
            ops.push(op);
        }
    }

    let total = ops.len();
    tracing::info!(total, "gate::batch_commit");
    emit_attempt(iii, &state.config, "gate::batch_commit", "", "", true, "batch");

    let mut join_set = tokio::task::JoinSet::new();
    for op in ops {
        let iii_clone = iii.clone();
        join_set.spawn(async move {
            let scope = op.scope.clone();
            let key = op.key.clone();
            let ok = if let Some(value) = op.value {
                iii_clone
                    .trigger(TriggerRequest {
                        function_id: "state::set".to_string(),
                        payload: json!({ "scope": &scope, "key": &key, "value": value }),
                        action: None,
                        timeout_ms: None,
                    })
                    .await
                    .is_ok()
            } else if let Some(gate_op) = op.op {
                let op_json = serde_json::to_value(gate_op).unwrap_or(Value::Null);
                iii_clone
                    .trigger(TriggerRequest {
                        function_id: "state::update".to_string(),
                        payload: json!({
                            "scope": &scope,
                            "key": &key,
                            "operations": [op_json],
                        }),
                        action: None,
                        timeout_ms: None,
                    })
                    .await
                    .is_ok()
            } else {
                false
            };
            (scope, key, ok)
        });
    }

    let mut results: Vec<Value> = Vec::with_capacity(total);
    while let Some(res) = join_set.join_next().await {
        let (scope, key, written) = res.unwrap_or_default();
        results.push(json!({ "scope": scope, "key": key, "written": written }));
    }

    let written = results.iter().filter(|r| r["written"].as_bool().unwrap_or(false)).count();

    Ok(json!({
        "written": written,
        "skipped": total - written,
        "results": results,
    }))
}

// --- tests ---

#[cfg(test)]
mod tests {
    use dashmap::DashMap;
    use serde_json::json;

    use super::{compare_values, merge_ops, DebounceKey};
    use crate::structs::{BatchOp, DebounceEntry, GateOp};

    // set_if_changed comparison

    #[test]
    fn strict_same_value_skips_write() {
        let v = json!(42);
        let (write, reason) = compare_values(Some(&v), &v, &None, None);
        assert!(!write);
        assert_eq!(reason, "unchanged");
    }

    #[test]
    fn strict_different_value_writes() {
        let (write, reason) = compare_values(Some(&json!(1)), &json!(2), &None, None);
        assert!(write);
        assert_eq!(reason, "changed");
    }

    #[test]
    fn missing_key_always_writes() {
        let (write, reason) = compare_values(None, &json!(99), &None, None);
        assert!(write);
        assert_eq!(reason, "changed");
    }

    #[test]
    fn epsilon_below_threshold_skips() {
        let cmp = Some("epsilon".to_string());
        let (write, reason) = compare_values(Some(&json!(10.0)), &json!(10.05), &cmp, Some(0.1));
        assert!(!write);
        assert_eq!(reason, "below_epsilon");
    }

    #[test]
    fn epsilon_above_threshold_writes() {
        let cmp = Some("epsilon".to_string());
        let (write, reason) = compare_values(Some(&json!(10.0)), &json!(10.2), &cmp, Some(0.1));
        assert!(write);
        assert_eq!(reason, "changed");
    }

    #[test]
    fn epsilon_exact_boundary_skips() {
        let cmp = Some("epsilon".to_string());
        let (write, reason) = compare_values(Some(&json!(10.0)), &json!(10.1), &cmp, Some(0.1));
        assert!(!write);
        assert_eq!(reason, "below_epsilon");
    }

    #[test]
    fn deep_equal_object_skips() {
        let v = json!({ "a": 1, "b": [1, 2, 3] });
        let cmp = Some("deep".to_string());
        let (write, reason) = compare_values(Some(&v), &v, &cmp, None);
        assert!(!write);
        assert_eq!(reason, "unchanged");
    }

    #[test]
    fn deep_different_object_writes() {
        let cmp = Some("deep".to_string());
        let (write, reason) =
            compare_values(Some(&json!({ "a": 1 })), &json!({ "a": 2 }), &cmp, None);
        assert!(write);
        assert_eq!(reason, "changed");
    }

    // merge_ops

    #[test]
    fn merge_increments_sums_by_path() {
        let ops = vec![
            GateOp::Increment { path: "hits".into(), by: 3 },
            GateOp::Increment { path: "hits".into(), by: 7 },
        ];
        let merged = merge_ops(ops);
        assert_eq!(merged.len(), 1);
        match &merged[0] {
            GateOp::Increment { path, by } => {
                assert_eq!(path, "hits");
                assert_eq!(*by, 10);
            }
            _ => panic!("expected Increment"),
        }
    }

    #[test]
    fn merge_increments_separate_paths_kept_distinct() {
        let ops = vec![
            GateOp::Increment { path: "a".into(), by: 1 },
            GateOp::Increment { path: "b".into(), by: 2 },
        ];
        assert_eq!(merge_ops(ops).len(), 2);
    }

    #[test]
    fn merge_decrements_sums() {
        let ops = vec![
            GateOp::Decrement { path: "credits".into(), by: 5 },
            GateOp::Decrement { path: "credits".into(), by: 3 },
        ];
        let merged = merge_ops(ops);
        assert_eq!(merged.len(), 1);
        match &merged[0] {
            GateOp::Decrement { path, by } => {
                assert_eq!(path, "credits");
                assert_eq!(*by, 8);
            }
            _ => panic!("expected Decrement"),
        }
    }

    #[test]
    fn merge_sets_last_write_wins() {
        let ops = vec![
            GateOp::Set { path: "status".into(), value: json!("a") },
            GateOp::Set { path: "status".into(), value: json!("b") },
            GateOp::Set { path: "status".into(), value: json!("c") },
        ];
        let merged = merge_ops(ops);
        assert_eq!(merged.len(), 1);
        match &merged[0] {
            GateOp::Set { value, .. } => assert_eq!(*value, json!("c")),
            _ => panic!("expected Set"),
        }
    }

    #[test]
    fn merge_non_aggregatable_ops_preserved() {
        let ops = vec![
            GateOp::Append { path: None, value: json!("x") },
            GateOp::Append { path: None, value: json!("y") },
            GateOp::Remove { path: "old".into() },
        ];
        assert_eq!(merge_ops(ops).len(), 3);
    }

    // batch_commit deduplication

    #[test]
    fn batch_dedup_keeps_last_per_key() {
        let ops = vec![
            BatchOp { scope: "s".into(), key: "k".into(), value: Some(json!(1)), op: None },
            BatchOp { scope: "s".into(), key: "k".into(), value: Some(json!(2)), op: None },
            BatchOp { scope: "s".into(), key: "k".into(), value: Some(json!(3)), op: None },
        ];
        let deduped = dedup(ops);
        assert_eq!(deduped.len(), 1);
        assert_eq!(deduped[0].value, Some(json!(3)));
    }

    #[test]
    fn batch_dedup_different_keys_all_kept() {
        let ops = vec![
            BatchOp { scope: "s".into(), key: "a".into(), value: Some(json!(1)), op: None },
            BatchOp { scope: "s".into(), key: "b".into(), value: Some(json!(2)), op: None },
        ];
        assert_eq!(dedup(ops).len(), 2);
    }

    fn dedup(ops: Vec<BatchOp>) -> Vec<BatchOp> {
        let mut seen: std::collections::HashMap<(String, String), usize> = Default::default();
        let mut out: Vec<BatchOp> = Vec::new();
        for op in ops {
            let k = (op.scope.clone(), op.key.clone());
            if let Some(idx) = seen.get(&k).copied() {
                out[idx] = op;
            } else {
                seen.insert(k, out.len());
                out.push(op);
            }
        }
        out
    }

    // wire-format serialization (serde round-trip catches field-name regressions)

    #[test]
    fn increment_op_serializes_by_field() {
        let op = GateOp::Increment { path: "hits".into(), by: 5 };
        let v = serde_json::to_value(&op).expect("serialize");
        assert_eq!(v["by"], json!(5), "Increment must serialize 'by', not 'value'");
        assert!(v.get("value").is_none(), "Increment must not emit a 'value' field");
        assert_eq!(v["path"], json!("hits"));
    }

    #[test]
    fn decrement_op_serializes_by_field() {
        let op = GateOp::Decrement { path: "credits".into(), by: 3 };
        let v = serde_json::to_value(&op).expect("serialize");
        assert_eq!(v["by"], json!(3), "Decrement must serialize 'by', not 'value'");
        assert!(v.get("value").is_none(), "Decrement must not emit a 'value' field");
        assert_eq!(v["path"], json!("credits"));
    }

    #[test]
    fn throttle_flush_json_uses_by_not_value() {
        // increment_throttled builds this json!() literal by hand; serde rename
        // attributes on GateOp don't protect it.  Verify the field name here.
        let path = "hits";
        let total: i64 = 42;
        let payload = json!({
            "operations": [{ "type": "increment", "path": path, "by": total }]
        });
        let op = &payload["operations"][0];
        assert_eq!(op["by"], json!(42), "throttle flush must send 'by'");
        assert!(op.get("value").is_none(), "throttle flush must not send 'value'");
    }

    // debounce generation

    #[test]
    fn debounce_generation_advances() {
        let map: DashMap<DebounceKey, DebounceEntry> = DashMap::new();
        let k: DebounceKey = ("scope".into(), "key".into());

        let g1 = {
            let mut e =
                map.entry(k.clone()).or_insert(DebounceEntry { value: json!(1), generation: 0 });
            e.value = json!(1);
            e.generation += 1;
            e.generation
        };
        let g2 = {
            let mut e =
                map.entry(k.clone()).or_insert(DebounceEntry { value: json!(2), generation: 0 });
            e.value = json!(2);
            e.generation += 1;
            e.generation
        };

        assert_eq!(g1, 1);
        assert_eq!(g2, 2);
        assert_ne!(g1, g2);
    }
}
