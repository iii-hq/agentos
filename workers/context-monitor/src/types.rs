use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(rename = "toolResults", skip_serializing_if = "Option::is_none", default)]
    pub tool_results: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub timestamp: Option<i64>,
    #[serde(rename = "tool_calls", skip_serializing_if = "Option::is_none", default)]
    pub tool_calls: Option<Value>,
    #[serde(rename = "tool_call_id", skip_serializing_if = "Option::is_none", default)]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub importance: Option<i64>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

pub fn estimate_tokens(text: &str) -> i64 {
    let count = text.chars().count() as i64;
    (count + 3) / 4
}

pub fn estimate_messages_tokens(messages: &[Message]) -> i64 {
    let mut total: i64 = 0;
    for msg in messages {
        total += estimate_tokens(&msg.content);
        if let Some(tr) = &msg.tool_results {
            let serialized = serde_json::to_string(tr).unwrap_or_default();
            total += estimate_tokens(&serialized);
        }
    }
    total
}

pub fn truncate_chars(s: &str, max_chars: usize) -> String {
    s.chars().take(max_chars).collect()
}

pub fn word_set(text: &str) -> HashSet<String> {
    text.to_lowercase()
        .split_whitespace()
        .filter(|w| !w.is_empty())
        .map(String::from)
        .collect()
}

pub fn jaccard_similarity(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 0.0;
    }
    let intersection = a.intersection(b).count();
    let union = a.len() + b.len() - intersection;
    if union > 0 {
        intersection as f64 / union as f64
    } else {
        0.0
    }
}

pub fn score_token_utilization(used: i64, max: i64) -> f64 {
    if max <= 0 {
        return 25.0;
    }
    let ratio = used as f64 / max as f64;
    if ratio < 0.5 {
        25.0
    } else if ratio < 0.8 {
        25.0 - ((ratio - 0.5) / 0.3) * 10.0
    } else if ratio < 0.95 {
        15.0 - ((ratio - 0.8) / 0.15) * 15.0
    } else {
        0.0
    }
}

pub fn score_relevance_decay(messages: &[Message], now_ms: i64) -> f64 {
    if messages.is_empty() {
        return 25.0;
    }
    let mut weighted_score = 0.0;
    let mut total_weight = 0.0;
    let len = messages.len();
    for (i, m) in messages.iter().enumerate() {
        let recency = (i + 1) as f64 / len as f64;
        let age = match m.timestamp {
            Some(ts) => (now_ms - ts) as f64 / (1000.0 * 60.0 * 60.0),
            None => (len - i) as f64,
        };
        let age_decay = (1.0 - age / 24.0).max(0.0);
        weighted_score += age_decay * recency;
        total_weight += recency;
    }
    if total_weight > 0.0 {
        (weighted_score / total_weight) * 25.0
    } else {
        25.0
    }
}

pub fn score_repetition(messages: &[Message]) -> f64 {
    if messages.len() < 2 {
        return 25.0;
    }
    let sets: Vec<HashSet<String>> = messages.iter().map(|m| word_set(&m.content)).collect();
    let mut duplicate_count = 0;
    let mut comparisons = 0;
    for i in 0..sets.len() {
        let upper = (i + 5).min(sets.len());
        for j in (i + 1)..upper {
            comparisons += 1;
            if jaccard_similarity(&sets[i], &sets[j]) > 0.8 {
                duplicate_count += 1;
            }
        }
    }
    let dupe_ratio = if comparisons > 0 {
        duplicate_count as f64 / comparisons as f64
    } else {
        0.0
    };
    (25.0 * (1.0 - dupe_ratio)).round()
}

pub fn score_tool_density(messages: &[Message]) -> f64 {
    if messages.is_empty() {
        return 25.0;
    }
    let tool_count = messages
        .iter()
        .filter(|m| m.role == "tool" || m.tool_results.is_some())
        .count();
    let ratio = tool_count as f64 / messages.len() as f64;
    if (0.3..=0.5).contains(&ratio) {
        25.0
    } else if ratio < 0.3 {
        (25.0 * (ratio / 0.3)).round()
    } else {
        (25.0 * (1.0 - (ratio - 0.5) / 0.5)).round()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_utilization_low() {
        assert_eq!(score_token_utilization(100, 1000), 25.0);
    }

    #[test]
    fn token_utilization_above_95_pct() {
        assert_eq!(score_token_utilization(960, 1000), 0.0);
    }

    #[test]
    fn relevance_empty() {
        assert_eq!(score_relevance_decay(&[], 0), 25.0);
    }

    #[test]
    fn repetition_low_with_one_message() {
        let msgs = vec![Message {
            role: "user".into(),
            content: "hello".into(),
            tool_results: None,
            timestamp: None,
            tool_calls: None,
            tool_call_id: None,
            importance: None,
            extra: Default::default(),
        }];
        assert_eq!(score_repetition(&msgs), 25.0);
    }

    #[test]
    fn tool_density_balanced() {
        let mut msgs: Vec<Message> = (0..10)
            .map(|i| Message {
                role: if i % 2 == 0 { "user".into() } else { "tool".into() },
                content: "x".into(),
                tool_results: None,
                timestamp: None,
                tool_calls: None,
                tool_call_id: None,
                importance: None,
                extra: Default::default(),
            })
            .collect();
        msgs.iter_mut().for_each(|_| {});
        let score = score_tool_density(&msgs);
        assert_eq!(score, 25.0);
    }

    #[test]
    fn jaccard_identical_sets() {
        let mut a = HashSet::new();
        a.insert("a".to_string());
        a.insert("b".to_string());
        assert_eq!(jaccard_similarity(&a, &a), 1.0);
    }

    #[test]
    fn estimate_tokens_match_ts_division() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("a"), 1);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
    }
}
