use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct SlashSpec {
    pub name: &'static str,
    pub args: &'static str,
    pub help: &'static str,
}

pub const BUILTIN_REGISTRY_FNS: &[&str] = &[
    "agent::chat",
    "agent::create",
    "memory::remember",
    "memory::recall",
    "memory::search",
    "memory::forget",
    "browser::navigate",
    "browser::click",
    "browser::read",
    "browser::screenshot",
    "approval::decide",
    "approval::pending",
    "council::propose",
    "council::decide",
    "realm::create",
    "realm::list",
    "channel::send",
    "channel::receive",
    "skill::list",
    "skill::run",
    "hand::list",
    "hand::run",
    "workflow::run",
    "workflow::list",
    "task::spawn",
    "task::status",
    "mcp::list",
    "mcp::tools",
    "a2a::send",
    "a2a::cards",
    "directive::create",
    "mission::list",
    "evolve::propose",
    "ledger::summary",
    "metrics::summary",
];

pub const BUILTINS: &[SlashSpec] = &[
    SlashSpec { name: "agent", args: "<id>", help: "Switch active agent" },
    SlashSpec { name: "realm", args: "<name>", help: "Switch realm context" },
    SlashSpec { name: "memory", args: "<query>", help: "Recall from memory worker" },
    SlashSpec { name: "remember", args: "<text>", help: "Store memory in current namespace" },
    SlashSpec { name: "hand", args: "<name>", help: "Run a configured hand bundle" },
    SlashSpec { name: "skill", args: "<id>", help: "Invoke a skill (skillkit-bridge)" },
    SlashSpec { name: "worker", args: "list|add|info <name>", help: "Browse + install workers" },
    SlashSpec { name: "channel", args: "<provider> <msg>", help: "Send via a channel worker" },
    SlashSpec { name: "approve", args: "<id>", help: "Approve a pending request" },
    SlashSpec { name: "deny", args: "<id>", help: "Deny a pending request" },
    SlashSpec { name: "clear", args: "", help: "Clear chat scrollback" },
    SlashSpec { name: "help", args: "", help: "Show keymap + commands" },
    SlashSpec { name: "quit", args: "", help: "Exit TUI" },
];

#[derive(Debug, Clone, PartialEq)]
pub enum Parsed {
    Plain(String),
    Cmd { name: String, args: String },
    Incomplete { partial: String },
}

pub fn parse(input: &str) -> Parsed {
    let trimmed = input.trim_start();
    if !trimmed.starts_with('/') {
        return Parsed::Plain(input.to_string());
    }
    let body = &trimmed[1..];
    if body.is_empty() {
        return Parsed::Incomplete { partial: String::new() };
    }
    match body.split_once(char::is_whitespace) {
        Some((name, rest)) => Parsed::Cmd {
            name: name.to_string(),
            args: rest.trim().to_string(),
        },
        None => Parsed::Incomplete { partial: body.to_string() },
    }
}

pub fn fuzzy_match(needle: &str, hay: &str) -> Option<i32> {
    if needle.is_empty() {
        return Some(0);
    }
    let n = needle.to_lowercase();
    let h = hay.to_lowercase();
    if h.starts_with(&n) {
        return Some(1000 - hay.len() as i32);
    }
    if h.contains(&n) {
        return Some(500 - hay.len() as i32);
    }
    let mut hi = h.chars();
    let mut score: i32 = 0;
    let mut last = -1i32;
    for (idx, c) in n.chars().enumerate() {
        let mut found = false;
        for (j, hc) in hi.by_ref().enumerate() {
            if hc == c {
                let pos = idx as i32 + j as i32;
                if last >= 0 && pos == last + 1 {
                    score += 5;
                }
                last = pos;
                score += 1;
                found = true;
                break;
            }
        }
        if !found {
            return None;
        }
    }
    Some(score)
}

pub fn complete(partial: &str, registry_fns: &[String]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String, i32)> = Vec::new();

    for spec in BUILTINS {
        if let Some(score) = fuzzy_match(partial, spec.name) {
            out.push((
                spec.name.to_string(),
                format!("{} — {}", spec.args, spec.help),
                score + 100,
            ));
        }
    }

    for fname in registry_fns {
        let display_name = fname.replace("::", ".");
        if let Some(score) = fuzzy_match(partial, &display_name) {
            out.push((display_name.clone(), "function".into(), score));
        }
    }

    out.sort_by(|a, b| b.2.cmp(&a.2));
    out.truncate(10);
    out.into_iter().map(|(n, h, _)| (n, h)).collect()
}

#[allow(dead_code)]
pub fn extract_function_names(functions_json: &Value) -> Vec<String> {
    let arr = match functions_json.as_array() {
        Some(a) => a,
        None => return Vec::new(),
    };
    arr.iter()
        .filter_map(|v| {
            v.get("id")
                .or_else(|| v.get("name"))
                .and_then(|s| s.as_str())
                .map(String::from)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain() {
        assert_eq!(parse("hello"), Parsed::Plain("hello".into()));
    }

    #[test]
    fn parses_cmd_with_args() {
        match parse("/agent foo") {
            Parsed::Cmd { name, args } => {
                assert_eq!(name, "agent");
                assert_eq!(args, "foo");
            }
            _ => panic!("expected Cmd"),
        }
    }

    #[test]
    fn parses_incomplete() {
        assert_eq!(parse("/age"), Parsed::Incomplete { partial: "age".into() });
    }

    #[test]
    fn fuzzy_prefix_outranks_substring() {
        let prefix = fuzzy_match("age", "agent").unwrap();
        let sub = fuzzy_match("nt", "agent").unwrap();
        assert!(prefix > sub);
    }

    #[test]
    fn complete_finds_builtin() {
        let suggestions = complete("ag", &[]);
        assert!(suggestions.iter().any(|(n, _)| n == "agent"));
    }

    #[test]
    fn complete_includes_registry_fns() {
        let regs = vec!["memory::store".to_string(), "browser::navigate".into()];
        let s = complete("memory", &regs);
        assert!(s.iter().any(|(n, _)| n == "memory.store"));
    }

    #[test]
    fn extract_names_handles_id_and_name() {
        let v: Value = serde_json::from_str(
            r#"[{"id":"a::x"}, {"name":"b::y"}, {"x":"skip"}]"#,
        )
        .unwrap();
        let names = extract_function_names(&v);
        assert_eq!(names, vec!["a::x", "b::y"]);
    }
}
