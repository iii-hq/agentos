use iii_sdk::error::IIIError;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::process::Command;

mod types;

use types::{BrowserSession, Viewport};

const MAX_SESSIONS: usize = 5;
const IDLE_TIMEOUT_MS: i64 = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;

const BRIDGE_SCRIPT: &str = r#"
import sys, json
from playwright.sync_api import sync_playwright

def main():
    params = json.loads(sys.argv[1])
    action = params.get("action")
    headless = params.get("headless", True)
    vw = params.get("viewport", {}).get("width", 1280)
    vh = params.get("viewport", {}).get("height", 720)
    timeout = params.get("timeout", 30000)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        page = browser.new_page(viewport={"width": vw, "height": vh})
        page.set_default_timeout(timeout)

        result = {}

        if action == "navigate":
            page.goto(params["url"], wait_until="domcontentloaded")
            result = {"url": page.url, "title": page.title()}

        elif action == "click":
            page.goto(params.get("currentUrl", "about:blank"), wait_until="domcontentloaded")
            page.click(params["selector"])
            result = {"clicked": params["selector"], "url": page.url}

        elif action == "type":
            page.goto(params.get("currentUrl", "about:blank"), wait_until="domcontentloaded")
            page.fill(params["selector"], params["text"])
            result = {"typed": True, "selector": params["selector"]}

        elif action == "screenshot":
            page.goto(params.get("currentUrl", "about:blank"), wait_until="domcontentloaded")
            path = params.get("savePath", "/tmp/screenshot.png")
            page.screenshot(path=path, full_page=params.get("fullPage", False))
            result = {"path": path}

        elif action == "read":
            page.goto(params.get("currentUrl", "about:blank"), wait_until="domcontentloaded")
            text = page.inner_text("body")
            result = {"text": text[:100000], "url": page.url, "title": page.title()}

        elif action == "close":
            result = {"closed": True}

        browser.close()
        print(json.dumps(result))

if __name__ == "__main__":
    main()
"#;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn assert_no_ssrf(url_str: &str) -> Result<(), IIIError> {
    let parsed = url::Url::parse(url_str).map_err(|e| IIIError::Handler(format!("invalid url: {e}")))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(IIIError::Handler(format!("blocked scheme: {scheme}")));
    }
    match parsed.host() {
        Some(url::Host::Ipv4(ip)) => {
            if ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified() {
                return Err(IIIError::Handler(format!("blocked host: {ip}")));
            }
            // Block link-local AWS/GCP metadata 169.254.x.x (covered by is_link_local)
            // and broadcast / multicast as defense-in-depth.
            if ip.is_broadcast() || ip.is_multicast() {
                return Err(IIIError::Handler(format!("blocked host: {ip}")));
            }
        }
        Some(url::Host::Ipv6(ip)) => {
            if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
                return Err(IIIError::Handler(format!("blocked host: {ip}")));
            }
            // is_unique_local / is_unicast_link_local are unstable on stable Rust;
            // match on the segments directly.
            let segs = ip.segments();
            // fc00::/7 unique local
            if (segs[0] & 0xfe00) == 0xfc00 {
                return Err(IIIError::Handler(format!("blocked host: {ip}")));
            }
            // fe80::/10 link-local
            if (segs[0] & 0xffc0) == 0xfe80 {
                return Err(IIIError::Handler(format!("blocked host: {ip}")));
            }
            // ::ffff:0:0/96 IPv4-mapped — re-check the embedded v4 address
            if segs[0] == 0
                && segs[1] == 0
                && segs[2] == 0
                && segs[3] == 0
                && segs[4] == 0
                && segs[5] == 0xffff
            {
                let v4 = std::net::Ipv4Addr::new(
                    (segs[6] >> 8) as u8,
                    (segs[6] & 0xff) as u8,
                    (segs[7] >> 8) as u8,
                    (segs[7] & 0xff) as u8,
                );
                if v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified() {
                    return Err(IIIError::Handler(format!("blocked host: {v4}")));
                }
            }
        }
        Some(url::Host::Domain(host)) => {
            let lower = host.to_ascii_lowercase();
            if matches!(
                lower.as_str(),
                "localhost" | "metadata.google.internal" | "metadata"
            ) {
                return Err(IIIError::Handler(format!("blocked host: {host}")));
            }
            // Reject common loopback aliases that bypass IP parsing.
            if lower.ends_with(".localhost") || lower == "ip6-localhost" {
                return Err(IIIError::Handler(format!("blocked host: {host}")));
            }
        }
        None => return Err(IIIError::Handler("missing host".into())),
    }
    Ok(())
}

async fn get_session_index(iii: &III) -> Vec<String> {
    let raw = iii
        .trigger(TriggerRequest {
            function_id: "state::get".into(),
            payload: json!({ "scope": "browser_sessions", "key": "_index" }),
            action: None,
            timeout_ms: None,
        })
        .await
        .ok();
    let Some(v) = raw else { return Vec::new() };
    // Accept both the legacy flat-array shape and the new { ids: [...] } shape
    // produced by the atomic state::update path.
    if let Some(arr) = v.as_array() {
        return arr.iter().filter_map(|x| x.as_str().map(String::from)).collect();
    }
    if let Some(arr) = v.get("ids").and_then(|x| x.as_array()) {
        return arr.iter().filter_map(|x| x.as_str().map(String::from)).collect();
    }
    Vec::new()
}

async fn set_session_index(iii: &III, index: Vec<String>) -> Result<(), IIIError> {
    iii.trigger(TriggerRequest {
        function_id: "state::set".into(),
        payload: json!({
            "scope": "browser_sessions",
            "key": "_index",
            "value": { "ids": index }
        }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map(|_| ())
    .map_err(|e| IIIError::Handler(e.to_string()))
}

async fn load_session(iii: &III, agent_id: &str) -> Option<BrowserSession> {
    let val = iii
        .trigger(TriggerRequest {
            function_id: "state::get".into(),
            payload: json!({ "scope": "browser_sessions", "key": agent_id }),
            action: None,
            timeout_ms: None,
        })
        .await
        .ok()?;
    if val.is_null() {
        return None;
    }
    serde_json::from_value(val).ok()
}

async fn save_session(iii: &III, session: &BrowserSession) -> Result<(), IIIError> {
    let value = serde_json::to_value(session).map_err(|e| IIIError::Handler(e.to_string()))?;
    iii.trigger(TriggerRequest {
        function_id: "state::set".into(),
        payload: json!({ "scope": "browser_sessions", "key": session.agent_id, "value": value }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map(|_| ())
    .map_err(|e| IIIError::Handler(e.to_string()))
}

async fn touch_session(iii: &III, session: &mut BrowserSession) -> Result<(), IIIError> {
    session.last_activity = now_ms();
    save_session(iii, session).await
}

async fn run_browser_script(
    session: &BrowserSession,
    action: &str,
    extra: Value,
) -> Result<Value, IIIError> {
    let mut payload = json!({
        "action": action,
        "sessionId": session.id,
        "headless": session.headless,
        "viewport": session.viewport,
        "timeout": DEFAULT_TIMEOUT_MS,
    });
    if let Some(obj) = payload.as_object_mut()
        && let Some(extras) = extra.as_object()
    {
        for (k, v) in extras {
            obj.insert(k.clone(), v.clone());
        }
    }
    let payload_str = serde_json::to_string(&payload).map_err(|e| IIIError::Handler(e.to_string()))?;

    let timeout = Duration::from_millis(DEFAULT_TIMEOUT_MS + 5_000);

    let child = Command::new("python3")
        .arg(&session.script_path)
        .arg(&payload_str)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| IIIError::Handler(format!("spawn failed: {e}")))?;

    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(result) => result.map_err(|e| IIIError::Handler(format!("wait failed: {e}")))?,
        Err(_) => {
            // child is dropped on the early return; kill_on_drop guarantees termination.
            return Err(IIIError::Handler("browser script timed out".into()));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !stderr.is_empty() && stdout.is_empty() {
        let mut snippet = stderr;
        truncate_to_char_boundary(&mut snippet, 1_000);
        return Err(IIIError::Handler(format!("Browser error: {snippet}")));
    }

    match serde_json::from_str::<Value>(&stdout) {
        Ok(v) => Ok(v),
        Err(_) => {
            let mut out = stdout;
            truncate_to_char_boundary(&mut out, 100_000);
            Ok(json!({ "output": out }))
        }
    }
}

/// Truncate `s` to at most `max_bytes` bytes, snapping back to the nearest
/// preceding UTF-8 char boundary so multi-byte characters never panic.
fn truncate_to_char_boundary(s: &mut String, max_bytes: usize) {
    if s.len() <= max_bytes {
        return;
    }
    let mut cut = max_bytes;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    s.truncate(cut);
}

async fn audit(iii: &III, kind: &str, detail: Value) {
    let payload = json!({ "type": kind, "detail": detail });
    let iii_clone = iii.clone();
    tokio::spawn(async move {
        let _ = iii_clone
            .trigger(TriggerRequest {
                function_id: "security::audit".into(),
                payload,
                action: None,
                timeout_ms: None,
            })
            .await;
    });
}

async fn cleanup_idle_sessions(iii: &III) {
    let now = now_ms();
    let index = get_session_index(iii).await;
    let mut remaining: Vec<String> = Vec::new();
    for agent_id in index {
        let session = load_session(iii, &agent_id).await;
        match session {
            Some(s) if now - s.last_activity <= IDLE_TIMEOUT_MS => remaining.push(agent_id),
            Some(s) => {
                let _ = tokio::fs::remove_file(&s.script_path).await;
                audit(
                    iii,
                    "browser_idle_cleanup",
                    json!({ "agentId": agent_id, "sessionId": s.id }),
                )
                .await;
                let _ = iii
                    .trigger(TriggerRequest {
                        function_id: "state::set".into(),
                        payload: json!({ "scope": "browser_sessions", "key": agent_id, "value": null }),
                        action: None,
                        timeout_ms: None,
                    })
                    .await;
            }
            None => {
                let _ = iii
                    .trigger(TriggerRequest {
                        function_id: "state::set".into(),
                        payload: json!({ "scope": "browser_sessions", "key": agent_id, "value": null }),
                        action: None,
                        timeout_ms: None,
                    })
                    .await;
            }
        }
    }
    let _ = set_session_index(iii, remaining).await;
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let iii_bg = iii.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            cleanup_idle_sessions(&iii_bg).await;
        }
    });

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("browser::create_session", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let body = input.get("body").cloned().unwrap_or(input.clone());
                let agent_id = body["agentId"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing agentId".into()))?
                    .to_string();
                let headless = body["headless"].as_bool().unwrap_or(true);
                let viewport: Viewport = serde_json::from_value(body["viewport"].clone())
                    .unwrap_or_default();

                if load_session(&iii, &agent_id).await.is_some() {
                    return Err(IIIError::Handler(format!(
                        "Session already exists for agent: {agent_id}"
                    )));
                }

                let session_id = uuid::Uuid::new_v4().to_string();
                let script_path =
                    std::env::temp_dir().join(format!("browser-bridge-{session_id}.py"));

                let now = now_ms();
                let session = BrowserSession {
                    id: session_id.clone(),
                    agent_id: agent_id.clone(),
                    current_url: "about:blank".into(),
                    headless,
                    viewport: viewport.clone(),
                    created_at: now,
                    last_activity: now,
                    script_path: script_path.to_string_lossy().to_string(),
                };

                // Atomically reserve a slot in the session index BEFORE doing any I/O.
                // state::update is the engine's CAS-style primitive: we append the
                // agent id and check the resulting size in a single round-trip so
                // two concurrent create_session calls cannot both pass the cap.
                let updated_index = iii
                    .trigger(TriggerRequest {
                        function_id: "state::update".into(),
                        payload: json!({
                            "scope": "browser_sessions",
                            "key": "_index",
                            "operations": [
                                { "type": "merge", "path": "ids", "value": [agent_id.clone()] }
                            ],
                            "upsert": { "ids": [agent_id.clone()] }
                        }),
                        action: None,
                        timeout_ms: None,
                    })
                    .await
                    .map_err(|e| IIIError::Handler(format!("reserve session slot: {e}")))?;
                let ids: Vec<String> = updated_index
                    .get("ids")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .unwrap_or_default();
                if ids.len() > MAX_SESSIONS {
                    // Roll the reservation back.
                    let rolled: Vec<String> =
                        ids.into_iter().filter(|id| id != &agent_id).collect();
                    let _ = iii
                        .trigger(TriggerRequest {
                            function_id: "state::set".into(),
                            payload: json!({
                                "scope": "browser_sessions",
                                "key": "_index",
                                "value": { "ids": rolled }
                            }),
                            action: None,
                            timeout_ms: None,
                        })
                        .await;
                    return Err(IIIError::Handler(format!(
                        "Max sessions ({MAX_SESSIONS}) reached"
                    )));
                }

                tokio::fs::write(&script_path, BRIDGE_SCRIPT)
                    .await
                    .map_err(|e| IIIError::Handler(format!("write script failed: {e}")))?;

                save_session(&iii, &session).await?;

                audit(
                    &iii,
                    "browser_session_created",
                    json!({ "agentId": agent_id, "sessionId": session_id, "headless": headless }),
                )
                .await;

                Ok::<Value, IIIError>(json!({
                    "sessionId": session_id,
                    "agentId": agent_id,
                    "headless": headless,
                    "viewport": viewport,
                }))
            }
        })
        .description("Create a new browser session"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("browser::list_sessions", move |_: Value| {
            let iii = iii_clone.clone();
            async move {
                let index = get_session_index(&iii).await;
                let mut list: Vec<Value> = Vec::new();
                let now = now_ms();
                for agent_id in index {
                    if let Some(s) = load_session(&iii, &agent_id).await {
                        list.push(json!({
                            "id": s.id,
                            "agentId": s.agent_id,
                            "currentUrl": s.current_url,
                            "headless": s.headless,
                            "createdAt": s.created_at,
                            "lastActivity": s.last_activity,
                            "idleMs": now - s.last_activity,
                        }));
                    }
                }
                let count = list.len();
                Ok::<Value, IIIError>(json!({ "sessions": list, "count": count }))
            }
        })
        .description("List active browser sessions"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("browser::navigate", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let body = input.get("body").cloned().unwrap_or(input.clone());
                let agent_id = body["agentId"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing agentId".into()))?;
                let url_str = body["url"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing url".into()))?;
                assert_no_ssrf(url_str)?;
                let mut session = load_session(&iii, agent_id)
                    .await
                    .ok_or_else(|| IIIError::Handler(format!("No browser session for agent: {agent_id}")))?;
                touch_session(&iii, &mut session).await?;

                let result = run_browser_script(&session, "navigate", json!({ "url": url_str })).await?;
                let new_url = result["url"].as_str().unwrap_or(url_str).to_string();
                // Re-validate the post-navigation URL to block redirects to internal hosts.
                if new_url != url_str {
                    assert_no_ssrf(&new_url)?;
                }
                session.current_url = new_url.clone();
                save_session(&iii, &session).await?;

                Ok::<Value, IIIError>(json!({
                    "url": new_url,
                    "title": result["title"],
                }))
            }
        })
        .description("Navigate to URL with SSRF check"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("browser::click", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let body = input.get("body").cloned().unwrap_or(input.clone());
                let agent_id = body["agentId"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing agentId".into()))?;
                let selector = body["selector"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing selector".into()))?
                    .to_string();
                let mut session = load_session(&iii, agent_id)
                    .await
                    .ok_or_else(|| IIIError::Handler(format!("No browser session for agent: {agent_id}")))?;
                touch_session(&iii, &mut session).await?;

                // Re-validate the stored URL before reusing it as a navigation target.
                assert_no_ssrf(&session.current_url)?;
                let result = run_browser_script(
                    &session,
                    "click",
                    json!({ "selector": selector, "currentUrl": session.current_url }),
                )
                .await?;
                if let Some(u) = result["url"].as_str() {
                    let new_url = u.to_string();
                    if new_url != session.current_url {
                        assert_no_ssrf(&new_url)?;
                    }
                    session.current_url = new_url;
                    save_session(&iii, &session).await?;
                }

                Ok::<Value, IIIError>(json!({ "clicked": selector, "url": session.current_url }))
            }
        })
        .description("Click element by selector"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("browser::type", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let body = input.get("body").cloned().unwrap_or(input.clone());
                let agent_id = body["agentId"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing agentId".into()))?;
                let selector = body["selector"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing selector".into()))?
                    .to_string();
                let text = body["text"].as_str().unwrap_or("").to_string();
                let mut session = load_session(&iii, agent_id)
                    .await
                    .ok_or_else(|| IIIError::Handler(format!("No browser session for agent: {agent_id}")))?;
                touch_session(&iii, &mut session).await?;

                // Re-validate the stored URL before reusing it as a navigation target.
                assert_no_ssrf(&session.current_url)?;
                run_browser_script(
                    &session,
                    "type",
                    json!({ "selector": selector, "text": text, "currentUrl": session.current_url }),
                )
                .await?;

                let len = text.len();
                Ok::<Value, IIIError>(json!({ "typed": true, "selector": selector, "length": len }))
            }
        })
        .description("Type text into element by selector"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("browser::screenshot", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let body = input.get("body").cloned().unwrap_or(input.clone());
                let agent_id = body["agentId"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing agentId".into()))?;
                let full_page = body["fullPage"].as_bool().unwrap_or(false);
                let mut session = load_session(&iii, agent_id)
                    .await
                    .ok_or_else(|| IIIError::Handler(format!("No browser session for agent: {agent_id}")))?;
                touch_session(&iii, &mut session).await?;

                let save_path = std::env::temp_dir().join(format!(
                    "screenshot-{}-{}.png",
                    session.id,
                    now_ms()
                ));
                let save_path_str = save_path.to_string_lossy().to_string();

                // Re-validate the stored URL before reusing it as a navigation target.
                assert_no_ssrf(&session.current_url)?;
                run_browser_script(
                    &session,
                    "screenshot",
                    json!({
                        "currentUrl": session.current_url,
                        "savePath": save_path_str,
                        "fullPage": full_page,
                    }),
                )
                .await?;

                Ok::<Value, IIIError>(json!({ "path": save_path_str, "url": session.current_url }))
            }
        })
        .description("Take screenshot and save to temp file"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("browser::read_page", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let body = input.get("body").cloned().unwrap_or(input.clone());
                let agent_id = body["agentId"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing agentId".into()))?;
                let mut session = load_session(&iii, agent_id)
                    .await
                    .ok_or_else(|| IIIError::Handler(format!("No browser session for agent: {agent_id}")))?;
                touch_session(&iii, &mut session).await?;

                // Re-validate the stored URL before reusing it as a navigation target.
                assert_no_ssrf(&session.current_url)?;
                let result = run_browser_script(
                    &session,
                    "read",
                    json!({ "currentUrl": session.current_url }),
                )
                .await?;

                let mut text = result["text"].as_str().unwrap_or("").to_string();
                truncate_to_char_boundary(&mut text, 100_000);
                Ok::<Value, IIIError>(json!({
                    "text": text,
                    "url": result["url"].as_str().unwrap_or(&session.current_url),
                    "title": result["title"].as_str().unwrap_or(""),
                }))
            }
        })
        .description("Extract page text content"),
    );

    let iii_clone = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("browser::close", move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let body = input.get("body").cloned().unwrap_or(input.clone());
                let agent_id = body["agentId"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing agentId".into()))?;
                let session = load_session(&iii, agent_id)
                    .await
                    .ok_or_else(|| IIIError::Handler(format!("No browser session for agent: {agent_id}")))?;

                let _ = iii
                    .trigger(TriggerRequest {
                        function_id: "state::set".into(),
                        payload: json!({ "scope": "browser_sessions", "key": agent_id, "value": null }),
                        action: None,
                        timeout_ms: None,
                    })
                    .await;
                let index = get_session_index(&iii).await;
                let new_index: Vec<String> = index.into_iter().filter(|id| id != agent_id).collect();
                set_session_index(&iii, new_index).await?;
                let _ = tokio::fs::remove_file(&session.script_path).await;

                audit(
                    &iii,
                    "browser_session_closed",
                    json!({ "agentId": agent_id, "sessionId": session.id }),
                )
                .await;

                Ok::<Value, IIIError>(json!({
                    "closed": true,
                    "agentId": agent_id,
                    "sessionId": session.id,
                }))
            }
        })
        .description("Close browser session"),
    );

    let triggers = [
        ("browser::create_session", "POST", "api/browser/session"),
        ("browser::list_sessions", "GET", "api/browser/sessions"),
        ("browser::navigate", "POST", "api/browser/navigate"),
        ("browser::click", "POST", "api/browser/click"),
        ("browser::type", "POST", "api/browser/type"),
        ("browser::screenshot", "POST", "api/browser/screenshot"),
        ("browser::read_page", "POST", "api/browser/read"),
        ("browser::close", "POST", "api/browser/close"),
    ];
    for (fid, method, path) in triggers {
        iii.register_trigger(RegisterTriggerInput {
            trigger_type: "http".into(),
            function_id: fid.to_string(),
            config: json!({ "http_method": method, "api_path": path }),
            metadata: None,
        })?;
    }

    tracing::info!("browser worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}
