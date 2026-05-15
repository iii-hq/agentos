use serde::{Deserialize, Serialize};
use serde_json::Value;

// --- set_if_changed ---

#[derive(Debug, Deserialize)]
pub struct SetIfChangedRequest {
    pub scope: String,
    pub key: String,
    pub value: Value,
    pub epsilon: Option<f64>,
    pub comparison: Option<String>,
}

// --- increment_throttled ---

#[derive(Debug, Deserialize)]
pub struct IncrementThrottledRequest {
    pub scope: String,
    pub key: String,
    pub path: Option<String>,
    pub by: i64,
    pub window_ms: u64,
}

// --- debounce ---

#[derive(Debug, Deserialize)]
pub struct DebounceRequest {
    pub scope: String,
    pub key: String,
    pub value: Value,
    pub delay_ms: u64,
}

// --- accumulate ---

#[derive(Debug, Deserialize)]
pub struct AccumulateRequest {
    pub scope: String,
    pub key: String,
    pub op: GateOp,
    pub flush_when: Option<FlushWhen>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FlushWhen {
    InFlightCompletion,
    ConcurrentCount { threshold: usize },
}

// --- batch_commit ---

#[derive(Debug, Deserialize)]
pub struct BatchCommitRequest {
    pub operations: Vec<BatchOp>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BatchOp {
    pub scope: String,
    pub key: String,
    /// Direct value write (maps to state::set).
    pub value: Option<Value>,
    /// Structured update op (maps to state::update with one operation).
    pub op: Option<GateOp>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum GateOp {
    Set {
        path: String,
        value: Value,
    },
    Increment {
        path: String,
        by: i64,
    },
    Decrement {
        path: String,
        by: i64,
    },
    Merge {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<Value>,
        value: Value,
    },
    Append {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<Value>,
        value: Value,
    },
    Remove {
        path: String,
    },
}

// --- internal per-key state types ---

pub struct ThrottleEntry {
    pub accumulated: i64,
    pub flush_at_ms: u64,
}

pub struct DebounceEntry {
    pub value: Value,
    pub generation: u64,
}

pub struct AccumulateEntry {
    pub pending: Vec<GateOp>,
    pub in_flight: bool,
}
