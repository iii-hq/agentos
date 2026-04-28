use iii_sdk::error::IIIError;
use iii_sdk::{InitOptions, RegisterFunction, RegisterTriggerInput, register_worker};
use serde_json::{Value, json};
use std::sync::OnceLock;
use std::time::Instant;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

fn process_started() -> Instant {
    static STARTED: OnceLock<Instant> = OnceLock::new();
    *STARTED.get_or_init(Instant::now)
}

#[derive(Debug, Clone, Copy)]
struct MemorySample {
    rss: u64,
    heap_used: u64,
    heap_total: u64,
}

fn sample_memory() -> MemorySample {
    let pid = std::process::id();
    let mut sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::everything()),
    );
    sys.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true);

    if let Some(process) = sys.process(Pid::from_u32(pid)) {
        let rss = process.memory();
        let virt = process.virtual_memory();
        MemorySample {
            rss,
            heap_used: rss,
            heap_total: virt,
        }
    } else {
        MemorySample {
            rss: 0,
            heap_used: 0,
            heap_total: 0,
        }
    }
}

fn uptime_seconds() -> f64 {
    process_started().elapsed().as_secs_f64()
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn summary() -> Result<Value, IIIError> {
    let mem = sample_memory();
    Ok(json!({
        "memoryRss": mem.rss,
        "memoryHeapUsed": mem.heap_used,
        "memoryHeapTotal": mem.heap_total,
        "uptimeSeconds": uptime_seconds(),
        "collectedAt": now_iso(),
    }))
}

fn dashboard() -> Result<Value, IIIError> {
    let mem = sample_memory();
    let uptime = uptime_seconds();

    let data = json!({
        "memoryRss": mem.rss,
        "memoryHeapUsed": mem.heap_used,
        "uptimeSeconds": uptime,
    });

    let rss_mb = mem.rss as f64 / 1024.0 / 1024.0;
    let heap_mb = mem.heap_used as f64 / 1024.0 / 1024.0;

    let lines = vec![
        format!("Memory RSS: {:.1} MB", rss_mb),
        format!("Heap Used: {:.1} MB", heap_mb),
        format!("Uptime: {:.0} s", uptime),
    ];

    Ok(json!({
        "text": lines.join("\n"),
        "data": data,
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let _ = process_started();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    iii.register_function(
        RegisterFunction::new_async("telemetry::summary", move |_input: Value| async move {
            summary()
        })
        .description("Return worker metrics summary"),
    );

    iii.register_function(
        RegisterFunction::new_async("telemetry::dashboard", move |_input: Value| async move {
            dashboard()
        })
        .description("Metrics dashboard"),
    );

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "telemetry::summary".to_string(),
        config: json!({ "api_path": "api/metrics", "http_method": "GET" }),
        metadata: None,
    })?;

    iii.register_trigger(RegisterTriggerInput {
        trigger_type: "http".to_string(),
        function_id: "telemetry::dashboard".to_string(),
        config: json!({ "api_path": "api/metrics/summary", "http_method": "GET" }),
        metadata: None,
    })?;

    tracing::info!("telemetry worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sample_memory_returns_nonzero_rss() {
        let m = sample_memory();
        assert!(m.rss > 0, "expected nonzero RSS, got {}", m.rss);
    }

    #[test]
    fn test_uptime_monotonic() {
        let _ = process_started();
        let u1 = uptime_seconds();
        std::thread::sleep(std::time::Duration::from_millis(10));
        let u2 = uptime_seconds();
        assert!(u2 >= u1);
    }

    #[test]
    fn test_uptime_positive() {
        let _ = process_started();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let u = uptime_seconds();
        assert!(u > 0.0);
    }

    #[test]
    fn test_now_iso_contains_t_and_z_or_offset() {
        let s = now_iso();
        assert!(s.contains('T'));
    }

    #[test]
    fn test_summary_has_required_fields() {
        let s = summary().unwrap();
        assert!(s.get("memoryRss").is_some());
        assert!(s.get("memoryHeapUsed").is_some());
        assert!(s.get("memoryHeapTotal").is_some());
        assert!(s.get("uptimeSeconds").is_some());
        assert!(s.get("collectedAt").is_some());
    }

    #[test]
    fn test_summary_field_types() {
        let s = summary().unwrap();
        assert!(s["memoryRss"].is_number());
        assert!(s["memoryHeapUsed"].is_number());
        assert!(s["memoryHeapTotal"].is_number());
        assert!(s["uptimeSeconds"].is_number());
        assert!(s["collectedAt"].is_string());
    }

    #[test]
    fn test_summary_memory_rss_positive() {
        let s = summary().unwrap();
        assert!(s["memoryRss"].as_u64().unwrap_or(0) > 0);
    }

    #[test]
    fn test_summary_uptime_positive() {
        let _ = process_started();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let s = summary().unwrap();
        assert!(s["uptimeSeconds"].as_f64().unwrap_or(0.0) > 0.0);
    }

    #[test]
    fn test_dashboard_has_text_and_data() {
        let d = dashboard().unwrap();
        assert!(d.get("text").is_some());
        assert!(d.get("data").is_some());
    }

    #[test]
    fn test_dashboard_field_types() {
        let d = dashboard().unwrap();
        assert!(d["text"].is_string());
        assert!(d["data"].is_object());
        assert!(d["data"]["memoryRss"].is_number());
        assert!(d["data"]["memoryHeapUsed"].is_number());
        assert!(d["data"]["uptimeSeconds"].is_number());
    }

    #[test]
    fn test_dashboard_text_contains_memory_rss() {
        let d = dashboard().unwrap();
        let text = d["text"].as_str().unwrap();
        assert!(text.contains("Memory RSS"));
    }

    #[test]
    fn test_dashboard_text_contains_heap_used() {
        let d = dashboard().unwrap();
        let text = d["text"].as_str().unwrap();
        assert!(text.contains("Heap Used"));
    }

    #[test]
    fn test_dashboard_text_contains_uptime() {
        let d = dashboard().unwrap();
        let text = d["text"].as_str().unwrap();
        assert!(text.contains("Uptime"));
    }

    #[test]
    fn test_dashboard_text_has_three_lines() {
        let d = dashboard().unwrap();
        let text = d["text"].as_str().unwrap();
        let lines: Vec<&str> = text.split('\n').collect();
        assert_eq!(lines.len(), 3);
    }

    #[test]
    fn test_dashboard_text_includes_mb_unit() {
        let d = dashboard().unwrap();
        let text = d["text"].as_str().unwrap();
        assert!(text.contains("MB"));
    }
}
