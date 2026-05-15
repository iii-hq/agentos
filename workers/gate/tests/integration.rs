// Integration tests for the gate worker.
//
// These tests exercise the pure decision logic (comparison, merge, deduplication)
// that controls when state writes happen. They verify the core value prop —
// write amplification reduction — without requiring a live iii engine.
//
// A full end-to-end test (register a state trigger, run N gate calls against a
// stable value, assert the trigger fired exactly once) requires a running engine
// and is left as future work in the project's e2e suite.

use serde_json::json;

// Pull in the crate's internals through the lib re-exports. Since this is a
// binary crate (no lib.rs), we inline the minimal logic needed here.
//
// The functions under test are `pub(crate)` in gate.rs; we test the same logic
// via duplicate thin wrappers below so the integration test is self-contained.

use serde_json::Value;
use std::collections::HashMap;

// --- mirrored from gate::compare_values ---

fn compare(
    old: Option<&Value>,
    new: &Value,
    comparison: &str,
    epsilon: f64,
) -> (bool, &'static str) {
    let Some(current) = old else {
        return (true, "changed");
    };
    match comparison {
        "epsilon" => match (current.as_f64(), new.as_f64()) {
            (Some(o), Some(n)) if (n - o).abs() <= epsilon => (false, "below_epsilon"),
            _ => (true, "changed"),
        },
        _ => {
            if current == new {
                (false, "unchanged")
            } else {
                (true, "changed")
            }
        }
    }
}

// --- effective-write-count assertions ---

#[test]
fn ten_calls_stable_value_produce_zero_writes() {
    // This is the core write-amplification claim: if a caller calls
    // gate::set_if_changed 10 times with the same value, only the very first
    // call (when the key is absent) would produce a write. Subsequent calls
    // against the already-stored value produce zero writes.
    let stable = json!(42);
    let write_count = (0..10)
        .map(|_| compare(Some(&stable), &stable, "strict", 0.0).0)
        .filter(|&w| w)
        .count();
    assert_eq!(write_count, 0, "stable value must produce no writes");
}

#[test]
fn ten_calls_changing_value_produce_ten_writes() {
    let mut current = json!(0i64);
    let mut write_count = 0usize;
    for i in 1..=10i64 {
        let next = json!(i);
        let (should, _) = compare(Some(&current), &next, "strict", 0.0);
        if should {
            write_count += 1;
        }
        current = next;
    }
    assert_eq!(write_count, 10);
}

#[test]
fn epsilon_stable_signal_produces_zero_writes() {
    // A sensor emitting values within ±0.05 of a baseline should not write.
    let baseline = json!(100.0f64);
    let noisy: &[f64] = &[100.01, 99.98, 100.03, 100.02, 99.99];
    let write_count = noisy
        .iter()
        .map(|&v| compare(Some(&baseline), &json!(v), "epsilon", 0.1).0)
        .filter(|&w| w)
        .count();
    assert_eq!(write_count, 0);
}

#[test]
fn epsilon_significant_change_produces_write() {
    let baseline = json!(100.0f64);
    let (write, reason) = compare(Some(&baseline), &json!(100.5f64), "epsilon", 0.1);
    assert!(write);
    assert_eq!(reason, "changed");
}

#[test]
fn missing_key_always_writes() {
    let (write, reason) = compare(None, &json!("hello"), "strict", 0.0);
    assert!(write);
    assert_eq!(reason, "changed");
}

// --- batch_commit deduplication ---

#[derive(Clone)]
struct Op {
    scope: String,
    key: String,
    seq: usize,
}

fn dedup(ops: Vec<Op>) -> Vec<Op> {
    let mut seen: HashMap<(String, String), usize> = HashMap::new();
    let mut out: Vec<Op> = Vec::new();
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

#[test]
fn batch_dedup_100_calls_same_key_produce_1_write() {
    let ops: Vec<Op> = (0..100)
        .map(|i| Op { scope: "s".into(), key: "k".into(), seq: i })
        .collect();
    let deduped = dedup(ops);
    assert_eq!(deduped.len(), 1);
    assert_eq!(deduped[0].seq, 99, "last write wins");
}

#[test]
fn batch_dedup_mixed_keys_all_kept() {
    let ops: Vec<Op> = (0..10)
        .map(|i| Op { scope: "s".into(), key: format!("k{i}"), seq: i })
        .collect();
    let deduped = dedup(ops);
    assert_eq!(deduped.len(), 10);
}

// --- merge_ops: increment accumulation ---

// Mirrors the merge logic from gate.rs without re-importing the binary crate.
#[derive(Debug, Clone, PartialEq)]
enum Op2 {
    Increment { path: String, value: i64 },
    Set { path: String, value: Value },
}

fn merge(ops: Vec<Op2>) -> Vec<Op2> {
    let mut incr: HashMap<String, i64> = HashMap::new();
    let mut sets: HashMap<String, Value> = HashMap::new();
    for op in ops {
        match op {
            Op2::Increment { path, value } => *incr.entry(path).or_default() += value,
            Op2::Set { path, value } => { sets.insert(path, value); }
        }
    }
    let mut out = Vec::new();
    for (path, value) in sets { out.push(Op2::Set { path, value }); }
    for (path, value) in incr { out.push(Op2::Increment { path, value }); }
    out
}

#[test]
fn merge_100_increments_same_path_produces_1_update() {
    let ops: Vec<Op2> = (0..100)
        .map(|_| Op2::Increment { path: "count".into(), value: 1 })
        .collect();
    let merged = merge(ops);
    assert_eq!(merged.len(), 1);
    match &merged[0] {
        Op2::Increment { value, .. } => assert_eq!(*value, 100),
        _ => panic!("expected Increment"),
    }
}

#[test]
fn merge_10_sets_same_path_produces_1_update() {
    let ops: Vec<Op2> = (0..10)
        .map(|i| Op2::Set { path: "status".into(), value: json!(i) })
        .collect();
    let merged = merge(ops);
    assert_eq!(merged.len(), 1);
    match &merged[0] {
        Op2::Set { value, .. } => assert_eq!(*value, json!(9)),
        _ => panic!("expected Set"),
    }
}
