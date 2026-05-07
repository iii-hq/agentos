#![allow(dead_code)]

use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use serde_json::Value;
use tokio::sync::mpsc;

#[derive(Debug, Clone)]
pub enum StreamEvent {
    Token(String),
    ToolCall { id: String, function: String, args: Value },
    Approval { id: String, function: String, agent: String },
    Done { tokens: usize, ms: u64 },
    Error(String),
    Heartbeat,
}

pub async fn subscribe(stream_base: &str, session_id: &str, tx: mpsc::Sender<StreamEvent>) -> Result<()> {
    let url = format!("{}/agent/events?session={}", stream_base, session_id);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(0))
        .build()?;
    let resp = client.get(&url).send().await?;
    if !resp.status().is_success() {
        return Err(anyhow!("SSE subscribe HTTP {}", resp.status()));
    }
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        loop {
            let Some(idx) = buf.find("\n\n") else { break; };
            let frame = buf.drain(..idx + 2).collect::<String>();
            if let Some(evt) = parse_frame(&frame) {
                if tx.send(evt).await.is_err() {
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}

pub fn parse_frame(frame: &str) -> Option<StreamEvent> {
    let mut event = "message".to_string();
    let mut data = String::new();
    for line in frame.split('\n') {
        if let Some(rest) = line.strip_prefix("event:") {
            event = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.trim_start());
        }
    }
    if data.is_empty() && event != "heartbeat" {
        return None;
    }
    match event.as_str() {
        "token" => Some(StreamEvent::Token(data)),
        "tool_call" | "function_call" => {
            let v: Value = serde_json::from_str(&data).ok()?;
            Some(StreamEvent::ToolCall {
                id: v["id"].as_str().unwrap_or("").to_string(),
                function: v["function"].as_str().or_else(|| v["name"].as_str()).unwrap_or("").to_string(),
                args: v["args"].clone(),
            })
        }
        "approval" => {
            let v: Value = serde_json::from_str(&data).ok()?;
            Some(StreamEvent::Approval {
                id: v["id"].as_str().unwrap_or("").to_string(),
                function: v["function"].as_str().unwrap_or("").to_string(),
                agent: v["agent"].as_str().unwrap_or("").to_string(),
            })
        }
        "done" => {
            let v: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
            Some(StreamEvent::Done {
                tokens: v["tokens"].as_u64().unwrap_or(0) as usize,
                ms: v["ms"].as_u64().unwrap_or(0),
            })
        }
        "error" => Some(StreamEvent::Error(data)),
        "heartbeat" => Some(StreamEvent::Heartbeat),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_token_frame() {
        let f = "event: token\ndata: hello\n\n";
        match parse_frame(f) {
            Some(StreamEvent::Token(s)) => assert_eq!(s, "hello"),
            _ => panic!("expected Token"),
        }
    }

    #[test]
    fn parses_done_frame() {
        let f = "event: done\ndata: {\"tokens\":42,\"ms\":1500}\n\n";
        match parse_frame(f) {
            Some(StreamEvent::Done { tokens, ms }) => {
                assert_eq!(tokens, 42);
                assert_eq!(ms, 1500);
            }
            _ => panic!("expected Done"),
        }
    }

    #[test]
    fn parses_approval_frame() {
        let f = "event: approval\ndata: {\"id\":\"a1\",\"function\":\"browser::navigate\",\"agent\":\"shopper\"}\n\n";
        match parse_frame(f) {
            Some(StreamEvent::Approval { id, function, agent }) => {
                assert_eq!(id, "a1");
                assert_eq!(function, "browser::navigate");
                assert_eq!(agent, "shopper");
            }
            _ => panic!("expected Approval"),
        }
    }

    #[test]
    fn ignores_empty_data() {
        let f = "event: token\ndata: \n\n";
        assert!(parse_frame(f).is_none());
    }

    #[test]
    fn heartbeat_with_no_data_ok() {
        let f = "event: heartbeat\n\n";
        match parse_frame(f) {
            Some(StreamEvent::Heartbeat) => {}
            _ => panic!("expected Heartbeat"),
        }
    }

    #[test]
    fn multiline_data() {
        let f = "event: token\ndata: line1\ndata: line2\n\n";
        match parse_frame(f) {
            Some(StreamEvent::Token(s)) => assert_eq!(s, "line1\nline2"),
            _ => panic!("expected Token"),
        }
    }
}
