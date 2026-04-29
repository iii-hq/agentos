use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CacheEntry {
    pub value: Value,
    #[serde(rename = "cachedAt")]
    pub cached_at: i64,
    #[serde(rename = "ttlMs")]
    pub ttl_ms: i64,
}

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
}

pub fn sanitize_id(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == ':')
        .collect()
}

pub fn cacheable(fn_id: &str) -> bool {
    matches!(
        fn_id,
        "memory::recall" | "memory::user_profile::get" | "agent::list_tools"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cacheable_set_matches_ts() {
        assert!(cacheable("memory::recall"));
        assert!(cacheable("memory::user_profile::get"));
        assert!(cacheable("agent::list_tools"));
        assert!(!cacheable("memory::store"));
    }

    #[test]
    fn sanitize_strips_unsafe() {
        assert_eq!(sanitize_id("agent-1"), "agent-1");
        assert_eq!(sanitize_id("ag/ent$1"), "agent1");
        assert_eq!(sanitize_id("a:b:c"), "a:b:c");
    }

    #[test]
    fn cache_entry_round_trip() {
        let entry = CacheEntry {
            value: serde_json::json!({ "data": "x" }),
            cached_at: 1000,
            ttl_ms: 60_000,
        };
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["cachedAt"], 1000);
        assert_eq!(v["ttlMs"], 60_000);
    }
}
