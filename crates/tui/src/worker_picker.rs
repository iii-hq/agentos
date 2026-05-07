use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorkerCard {
    pub name: String,
    pub description: String,
    pub functions: Vec<String>,
    pub installed: bool,
    pub binary_path: Option<String>,
}

pub fn parse_catalog(api_response: &Value, installed: &[String]) -> Vec<WorkerCard> {
    let arr = match api_response.as_array() {
        Some(a) => a,
        None => return Vec::new(),
    };
    let installed_set: std::collections::HashSet<&str> =
        installed.iter().map(|s| s.as_str()).collect();
    arr.iter()
        .filter_map(|v| {
            let name = v.get("name").and_then(|s| s.as_str())?.to_string();
            let description = v
                .get("description")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let functions: Vec<String> = v
                .get("functions")
                .and_then(|f| f.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|s| s.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            let installed = installed_set.contains(name.as_str());
            Some(WorkerCard {
                name,
                description,
                functions,
                installed,
                binary_path: v
                    .get("binary_path")
                    .and_then(|s| s.as_str())
                    .map(String::from),
            })
        })
        .collect()
}

pub fn install_command(card: &WorkerCard) -> String {
    if card.installed {
        format!(
            "$ {}",
            card.binary_path.clone().unwrap_or_else(|| format!("./target/release/{}", card.name))
        )
    } else {
        format!(
            "$ cargo build --release -p {} && ./target/release/{}",
            card.name, card.name
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_card() {
        let v: Value = serde_json::from_str(
            r#"[{"name":"memory","description":"persistent recall","functions":["memory::store","memory::recall"]}]"#,
        )
        .unwrap();
        let cards = parse_catalog(&v, &[]);
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].name, "memory");
        assert_eq!(cards[0].functions.len(), 2);
        assert!(!cards[0].installed);
    }

    #[test]
    fn marks_installed() {
        let v: Value = serde_json::from_str(r#"[{"name":"browser"}]"#).unwrap();
        let cards = parse_catalog(&v, &["browser".to_string()]);
        assert!(cards[0].installed);
    }

    #[test]
    fn install_cmd_for_uninstalled() {
        let card = WorkerCard {
            name: "memory".into(),
            description: "".into(),
            functions: vec![],
            installed: false,
            binary_path: None,
        };
        let cmd = install_command(&card);
        assert!(cmd.contains("cargo build"));
        assert!(cmd.contains("memory"));
    }

    #[test]
    fn install_cmd_for_installed_uses_binary() {
        let card = WorkerCard {
            name: "memory".into(),
            description: "".into(),
            functions: vec![],
            installed: true,
            binary_path: Some("/opt/memory".into()),
        };
        assert_eq!(install_command(&card), "$ /opt/memory");
    }
}
