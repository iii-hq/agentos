use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(rename = "toolResults", skip_serializing_if = "Option::is_none", default)]
    pub tool_results: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub importance: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub timestamp: Option<i64>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct BudgetAllocation {
    #[serde(rename = "systemPrompt")]
    pub system_prompt: f64,
    pub skills: f64,
    pub memories: f64,
    pub conversation: f64,
}

pub const DEFAULT_CONTEXT_WINDOW: i64 = 200_000;
pub const DEFAULT_ALLOCATION: BudgetAllocation = BudgetAllocation {
    system_prompt: 0.2,
    skills: 0.15,
    memories: 0.25,
    conversation: 0.4,
};

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_tokens_empty() {
        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn estimate_tokens_4_chars() {
        assert_eq!(estimate_tokens("abcd"), 1);
    }

    #[test]
    fn estimate_tokens_5_chars_ceil() {
        assert_eq!(estimate_tokens("abcde"), 2);
    }

    #[test]
    fn estimate_tokens_100_chars() {
        let s = "a".repeat(100);
        assert_eq!(estimate_tokens(&s), 25);
    }

    #[test]
    fn estimate_tokens_3_chars_ceil() {
        assert_eq!(estimate_tokens("abc"), 1);
        assert_eq!(estimate_tokens("a"), 1);
    }

    #[test]
    fn estimate_tokens_whitespace() {
        assert_eq!(estimate_tokens("    "), 1);
    }

    #[test]
    fn estimate_tokens_newlines() {
        assert_eq!(estimate_tokens("line1\nline2"), 3);
    }

    #[test]
    fn estimate_messages_empty() {
        assert_eq!(estimate_messages_tokens(&[]), 0);
    }

    #[test]
    fn estimate_messages_sum() {
        let msgs = vec![
            Message {
                role: "user".into(),
                content: "a".repeat(40),
                tool_results: None,
                importance: None,
                timestamp: None,
                extra: Default::default(),
            },
            Message {
                role: "assistant".into(),
                content: "b".repeat(40),
                tool_results: None,
                importance: None,
                timestamp: None,
                extra: Default::default(),
            },
        ];
        assert_eq!(estimate_messages_tokens(&msgs), 20);
    }

    #[test]
    fn allocation_sums_to_one() {
        let a = DEFAULT_ALLOCATION;
        let sum = a.system_prompt + a.skills + a.memories + a.conversation;
        assert!((sum - 1.0).abs() < 1e-10);
    }

    #[test]
    fn default_window_is_200k() {
        assert_eq!(DEFAULT_CONTEXT_WINDOW, 200_000);
    }
}
