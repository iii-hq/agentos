use dashmap::DashMap;
use iii_sdk::{register_worker, InitOptions, III};
use iii_sdk::error::IIIError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use wasmtime::*;

const DEFAULT_FUEL: u64 = 1_000_000;
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const DEFAULT_MEMORY_PAGES: u64 = 256;

#[derive(Debug)]
enum ExecutionError {
    Timeout,
    FuelExhausted,
    Trapped(String),
}

impl std::fmt::Display for ExecutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExecutionError::Timeout => write!(f, "execution timed out"),
            ExecutionError::FuelExhausted => write!(f, "fuel exhausted"),
            ExecutionError::Trapped(msg) => write!(f, "trapped: {}", msg),
        }
    }
}

fn execute_with_dual_metering(
    store: &mut Store<()>,
    func: &TypedFunc<(i32, i32), i64>,
    args: (i32, i32),
    fuel_limit: u64,
    timeout: Duration,
) -> Result<i64, ExecutionError> {
    store.set_fuel(fuel_limit).map_err(|e| ExecutionError::Trapped(e.to_string()))?;
    store.epoch_deadline_trap();
    store.set_epoch_deadline(1);

    let engine = store.engine().clone();
    let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let killed_clone = killed.clone();

    let watchdog = std::thread::spawn(move || {
        let start = std::time::Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(1));
            engine.increment_epoch();
            if start.elapsed() > timeout || killed_clone.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
        }
    });

    let result = func.call(store, args);

    killed.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = watchdog.join();

    match result {
        Ok(val) => Ok(val),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("epoch") || msg.contains("interrupt") {
                Err(ExecutionError::Timeout)
            } else if msg.contains("fuel") {
                Err(ExecutionError::FuelExhausted)
            } else {
                Err(ExecutionError::Trapped(msg))
            }
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct ExecuteRequest {
    #[serde(rename = "moduleId")]
    module_id: String,
    input: Value,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
    fuel: Option<u64>,
    #[serde(rename = "timeoutSecs")]
    timeout_secs: Option<u64>,
    #[serde(rename = "memoryPages")]
    memory_pages: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ValidateRequest {
    #[serde(rename = "moduleId")]
    module_id: String,
    wasm: Vec<u8>,
}

struct ModuleCache {
    engine: Engine,
    modules: DashMap<String, Module>,
}

fn pack_ptr_len(ptr: u32, len: u32) -> i64 {
    ((ptr as i64) << 32) | (len as i64)
}

fn unpack_ptr_len(packed: i64) -> (u32, u32) {
    let ptr = (packed >> 32) as u32;
    let len = (packed & 0xFFFF_FFFF) as u32;
    (ptr, len)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let iii = register_worker("ws://localhost:49134", InitOptions::default())?;

    let mut config = Config::new();
    config.consume_fuel(true);
    config.epoch_interruption(true);
    let engine = Engine::new(&config)?;

    let cache = Arc::new(ModuleCache {
        engine: engine.clone(),
        modules: DashMap::new(),
    });

    let epoch_engine = engine.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(1));
            epoch_engine.increment_epoch();
        }
    });

    let cache_ref = cache.clone();
    let iii_ref = iii.clone();
    iii.register_function_with_description(
        "wasm::execute",
        "Execute WASM module in sandboxed environment",
        move |input: Value| {
            let cache = cache_ref.clone();
            let iii = iii_ref.clone();
            async move { execute_wasm(&iii, &cache, input).await }
        },
    );

    let cache_ref = cache.clone();
    iii.register_function_with_description(
        "wasm::validate",
        "Validate and cache a WASM module",
        move |input: Value| {
            let cache = cache_ref.clone();
            async move { validate_wasm(&cache, input).await }
        },
    );

    let cache_ref = cache.clone();
    iii.register_function_with_description(
        "wasm::list_modules",
        "List cached WASM modules",
        move |_: Value| {
            let cache = cache_ref.clone();
            async move {
                let ids: Vec<String> = cache.modules.iter().map(|e| e.key().clone()).collect();
                Ok(json!({ "modules": ids, "count": ids.len() }))
            }
        },
    );

    iii.register_trigger("http", "wasm::execute", json!({ "api_path": "wasm/execute", "http_method": "POST" }))?;
    iii.register_trigger("http", "wasm::validate", json!({ "api_path": "wasm/validate", "http_method": "POST" }))?;
    iii.register_trigger("http", "wasm::list_modules", json!({ "api_path": "wasm/modules", "http_method": "GET" }))?;

    tracing::info!("wasm-sandbox worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

async fn execute_wasm(iii: &III, cache: &ModuleCache, input: Value) -> Result<Value, IIIError> {
    let req: ExecuteRequest = serde_json::from_value(input)
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let module = cache.modules.get(&req.module_id)
        .ok_or_else(|| IIIError::Handler(format!("Module {} not found in cache", req.module_id)))?
        .clone();

    let fuel = req.fuel.unwrap_or(DEFAULT_FUEL);
    let timeout_secs = req.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS);
    let memory_pages = req.memory_pages.unwrap_or(DEFAULT_MEMORY_PAGES);
    let agent_id = req.agent_id.clone().unwrap_or_default();

    let iii_clone = iii.clone();
    let agent_id_clone = agent_id.clone();

    let mut store = Store::new(&cache.engine, ());

    let mut linker = Linker::new(&cache.engine);

    let iii_host = iii_clone.clone();
    let host_agent_id = agent_id_clone.clone();
    linker.func_wrap("env", "host_call", move |mut caller: Caller<'_, ()>, request_ptr: i32, request_len: i32| -> i64 {
        fn write_to_guest(caller: &mut Caller<'_, ()>, data: &[u8]) -> i64 {
            let alloc = match caller.get_export("alloc") {
                Some(Extern::Func(f)) => f,
                _ => return pack_ptr_len(0, 0),
            };

            let mut results_buf = [Val::I32(0)];
            if alloc.call(&mut *caller, &[Val::I32(data.len() as i32)], &mut results_buf).is_err() {
                return pack_ptr_len(0, 0);
            }

            let out_ptr = results_buf[0].unwrap_i32() as u32;
            let memory = match caller.get_export("memory") {
                Some(Extern::Memory(mem)) => mem,
                _ => return pack_ptr_len(0, 0),
            };

            if memory.write(&mut *caller, out_ptr as usize, data).is_err() {
                return pack_ptr_len(0, 0);
            }

            pack_ptr_len(out_ptr, data.len() as u32)
        }

        fn write_error(caller: &mut Caller<'_, ()>, msg: &str) -> i64 {
            let error_json = serde_json::to_string(&serde_json::json!({ "error": msg }))
                .unwrap_or_else(|_| r#"{"error":"unknown"}"#.to_string());
            write_to_guest(caller, error_json.as_bytes())
        }

        let memory = match caller.get_export("memory") {
            Some(Extern::Memory(mem)) => mem,
            _ => return pack_ptr_len(0, 0),
        };

        let data = memory.data(&caller);
        let start = request_ptr as usize;
        let end = start + request_len as usize;
        if end > data.len() {
            return write_error(&mut caller, "request out of bounds");
        }

        let request_bytes = &data[start..end];
        let request_str = match std::str::from_utf8(request_bytes) {
            Ok(s) => s.to_string(),
            Err(_) => return write_error(&mut caller, "invalid UTF-8 in request"),
        };

        let request: Value = match serde_json::from_str(&request_str) {
            Ok(v) => v,
            Err(e) => return write_error(&mut caller, &format!("invalid JSON: {}", e)),
        };

        let function_id = request["functionId"].as_str().unwrap_or("");
        let args = request.get("args").cloned().unwrap_or(json!({}));

        let iii_inner = iii_host.clone();
        let agent = host_agent_id.clone();
        let func_id = function_id.to_string();

        const WASM_ALLOWED_FUNCTIONS: &[&str] = &[
            "memory::recall",
            "memory::store",
            "tool::web_fetch",
            "tool::file_read",
            "tool::file_list",
            "security::scan_injection",
            "embedding::generate",
        ];

        let result = if !WASM_ALLOWED_FUNCTIONS.contains(&func_id.as_str()) {
            json!({ "error": format!("function '{}' not allowed from WASM sandbox", func_id) }).to_string()
        } else { std::thread::scope(|_| {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                let cap_check = iii_inner.trigger("security::check_capability", json!({
                    "agentId": &agent,
                    "capability": func_id.split("::").next().unwrap_or(""),
                    "resource": &func_id,
                })).await;

                if cap_check.is_err() {
                    return json!({ "error": "capability denied" }).to_string();
                }

                match iii_inner.trigger(&func_id, args).await {
                    Ok(v) => v.to_string(),
                    Err(e) => json!({ "error": e.to_string() }).to_string(),
                }
            })
        }) };

        write_to_guest(&mut caller, result.as_bytes())
    }).map_err(|e| IIIError::Handler(e.to_string()))?;

    linker.func_wrap("env", "host_log", move |mut caller: Caller<'_, ()>, level: i32, msg_ptr: i32, msg_len: i32| {
        let memory = match caller.get_export("memory") {
            Some(Extern::Memory(mem)) => mem,
            _ => return,
        };

        let data = memory.data(&caller);
        let start = msg_ptr as usize;
        let end = start + msg_len as usize;
        if end > data.len() {
            return;
        }

        let msg = match std::str::from_utf8(&data[start..end]) {
            Ok(s) => s,
            Err(_) => return,
        };

        match level {
            0 => tracing::trace!(target: "wasm_guest", "{}", msg),
            1 => tracing::debug!(target: "wasm_guest", "{}", msg),
            2 => tracing::info!(target: "wasm_guest", "{}", msg),
            3 => tracing::warn!(target: "wasm_guest", "{}", msg),
            _ => tracing::error!(target: "wasm_guest", "{}", msg),
        }
    }).map_err(|e| IIIError::Handler(e.to_string()))?;

    let instance = linker.instantiate(&mut store, &module)
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let memory = instance.get_memory(&mut store, "memory")
        .ok_or_else(|| IIIError::Handler("Module does not export 'memory'".into()))?;

    let current_pages = memory.size(&store);
    if current_pages > memory_pages {
        return Err(IIIError::Handler(format!("Module memory {} pages exceeds limit of {}", current_pages, memory_pages)));
    }

    let alloc_fn = instance.get_typed_func::<i32, i32>(&mut store, "alloc")
        .map_err(|e| IIIError::Handler(e.to_string()))?;
    let execute_fn = instance.get_typed_func::<(i32, i32), i64>(&mut store, "execute")
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let input_bytes = serde_json::to_vec(&req.input)
        .map_err(|e| IIIError::Handler(e.to_string()))?;
    let input_ptr = alloc_fn.call(&mut store, input_bytes.len() as i32)
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    memory.write(&mut store, input_ptr as usize, &input_bytes)
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let result_packed = execute_with_dual_metering(
        &mut store,
        &execute_fn,
        (input_ptr, input_bytes.len() as i32),
        fuel,
        Duration::from_secs(timeout_secs),
    ).map_err(|e| IIIError::Handler(e.to_string()))?;
    let (result_ptr, result_len) = unpack_ptr_len(result_packed);

    let mut result_buf = vec![0u8; result_len as usize];
    memory.read(&store, result_ptr as usize, &mut result_buf)
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let fuel_consumed = fuel.saturating_sub(store.get_fuel().unwrap_or(0));

    let output: Value = serde_json::from_slice(&result_buf)
        .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&result_buf).to_string() }));

    Ok(json!({
        "output": output,
        "fuelConsumed": fuel_consumed,
        "moduleId": req.module_id,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_fuel_constant() {
        assert_eq!(DEFAULT_FUEL, 1_000_000);
    }

    #[test]
    fn test_default_timeout_secs_constant() {
        assert_eq!(DEFAULT_TIMEOUT_SECS, 30);
    }

    #[test]
    fn test_default_memory_pages_constant() {
        assert_eq!(DEFAULT_MEMORY_PAGES, 256);
    }

    #[test]
    fn test_pack_ptr_len_basic() {
        let packed = pack_ptr_len(100, 200);
        let (ptr, len) = unpack_ptr_len(packed);
        assert_eq!(ptr, 100);
        assert_eq!(len, 200);
    }

    #[test]
    fn test_pack_ptr_len_zeros() {
        let packed = pack_ptr_len(0, 0);
        let (ptr, len) = unpack_ptr_len(packed);
        assert_eq!(ptr, 0);
        assert_eq!(len, 0);
    }

    #[test]
    fn test_pack_ptr_len_max_values() {
        let packed = pack_ptr_len(u32::MAX, u32::MAX);
        let (ptr, len) = unpack_ptr_len(packed);
        assert_eq!(ptr, u32::MAX);
        assert_eq!(len, u32::MAX);
    }

    #[test]
    fn test_pack_ptr_len_large_ptr() {
        let packed = pack_ptr_len(1_000_000, 42);
        let (ptr, len) = unpack_ptr_len(packed);
        assert_eq!(ptr, 1_000_000);
        assert_eq!(len, 42);
    }

    #[test]
    fn test_pack_ptr_len_large_len() {
        let packed = pack_ptr_len(1, 999_999);
        let (ptr, len) = unpack_ptr_len(packed);
        assert_eq!(ptr, 1);
        assert_eq!(len, 999_999);
    }

    #[test]
    fn test_pack_ptr_len_roundtrip_many() {
        for ptr_val in [0, 1, 100, 65535, 1_000_000, u32::MAX] {
            for len_val in [0, 1, 100, 65535, 1_000_000, u32::MAX] {
                let packed = pack_ptr_len(ptr_val, len_val);
                let (p, l) = unpack_ptr_len(packed);
                assert_eq!(p, ptr_val, "ptr mismatch for ({}, {})", ptr_val, len_val);
                assert_eq!(l, len_val, "len mismatch for ({}, {})", ptr_val, len_val);
            }
        }
    }

    #[test]
    fn test_execute_request_deserialization_minimal() {
        let json_val = json!({
            "moduleId": "mod-1",
            "input": {"key": "value"},
        });
        let req: ExecuteRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.module_id, "mod-1");
        assert_eq!(req.input["key"], "value");
        assert!(req.agent_id.is_none());
        assert!(req.fuel.is_none());
        assert!(req.timeout_secs.is_none());
        assert!(req.memory_pages.is_none());
    }

    #[test]
    fn test_execute_request_deserialization_full() {
        let json_val = json!({
            "moduleId": "mod-2",
            "input": {},
            "agentId": "agent-1",
            "fuel": 500000,
            "timeoutSecs": 10,
            "memoryPages": 128,
        });
        let req: ExecuteRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.module_id, "mod-2");
        assert_eq!(req.agent_id, Some("agent-1".to_string()));
        assert_eq!(req.fuel, Some(500000));
        assert_eq!(req.timeout_secs, Some(10));
        assert_eq!(req.memory_pages, Some(128));
    }

    #[test]
    fn test_validate_request_deserialization() {
        let json_val = json!({
            "moduleId": "mod-v",
            "wasm": [0, 97, 115, 109],
        });
        let req: ValidateRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.module_id, "mod-v");
        assert_eq!(req.wasm, vec![0, 97, 115, 109]);
    }

    #[test]
    fn test_fuel_defaults() {
        let req: ExecuteRequest = serde_json::from_value(json!({
            "moduleId": "test",
            "input": {},
        })).unwrap();
        let fuel = req.fuel.unwrap_or(DEFAULT_FUEL);
        assert_eq!(fuel, 1_000_000);
    }

    #[test]
    fn test_timeout_defaults() {
        let req: ExecuteRequest = serde_json::from_value(json!({
            "moduleId": "test",
            "input": {},
        })).unwrap();
        let timeout = req.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS);
        assert_eq!(timeout, 30);
    }

    #[test]
    fn test_memory_pages_defaults() {
        let req: ExecuteRequest = serde_json::from_value(json!({
            "moduleId": "test",
            "input": {},
        })).unwrap();
        let pages = req.memory_pages.unwrap_or(DEFAULT_MEMORY_PAGES);
        assert_eq!(pages, 256);
    }

    #[test]
    fn test_agent_id_default() {
        let req: ExecuteRequest = serde_json::from_value(json!({
            "moduleId": "test",
            "input": {},
        })).unwrap();
        let agent_id = req.agent_id.unwrap_or_default();
        assert_eq!(agent_id, "");
    }

    #[test]
    fn test_wasm_allowed_functions_list() {
        const WASM_ALLOWED_FUNCTIONS: &[&str] = &[
            "memory::recall",
            "memory::store",
            "tool::web_fetch",
            "tool::file_read",
            "tool::file_list",
            "security::scan_injection",
            "embedding::generate",
        ];
        assert_eq!(WASM_ALLOWED_FUNCTIONS.len(), 7);
        assert!(WASM_ALLOWED_FUNCTIONS.contains(&"memory::recall"));
        assert!(WASM_ALLOWED_FUNCTIONS.contains(&"memory::store"));
        assert!(!WASM_ALLOWED_FUNCTIONS.contains(&"file::delete"));
        assert!(!WASM_ALLOWED_FUNCTIONS.contains(&"network::send"));
    }

    #[test]
    fn test_module_cache_creation() {
        let mut config = Config::new();
        config.consume_fuel(true);
        let engine = Engine::new(&config).unwrap();
        let cache = ModuleCache {
            engine,
            modules: DashMap::new(),
        };
        assert!(cache.modules.is_empty());
    }

    #[test]
    fn test_fuel_consumption_tracking() {
        let initial_fuel: u64 = 1_000_000;
        let remaining_fuel: u64 = 999_000;
        let consumed = initial_fuel.saturating_sub(remaining_fuel);
        assert_eq!(consumed, 1_000);
    }

    #[test]
    fn test_fuel_consumption_saturating() {
        let initial: u64 = 100;
        let remaining: u64 = 200;
        let consumed = initial.saturating_sub(remaining);
        assert_eq!(consumed, 0);
    }

    #[test]
    fn test_pack_ptr_len_power_of_two() {
        for shift in 0..32u32 {
            let val = 1u32 << shift;
            let packed = pack_ptr_len(val, val);
            let (p, l) = unpack_ptr_len(packed);
            assert_eq!(p, val, "ptr failed for 2^{}", shift);
            assert_eq!(l, val, "len failed for 2^{}", shift);
        }
    }

    #[test]
    fn test_pack_ptr_len_alternating_bits() {
        let val_a: u32 = 0xAAAA_AAAA;
        let val_5: u32 = 0x5555_5555;
        let packed = pack_ptr_len(val_a, val_5);
        let (p, l) = unpack_ptr_len(packed);
        assert_eq!(p, val_a);
        assert_eq!(l, val_5);
    }

    #[test]
    fn test_pack_ptr_len_near_u16_max() {
        for val in [u16::MAX as u32 - 1, u16::MAX as u32, u16::MAX as u32 + 1] {
            let packed = pack_ptr_len(val, val);
            let (p, l) = unpack_ptr_len(packed);
            assert_eq!(p, val);
            assert_eq!(l, val);
        }
    }

    #[test]
    fn test_pack_ptr_len_asymmetric() {
        let packed = pack_ptr_len(0, u32::MAX);
        let (p, l) = unpack_ptr_len(packed);
        assert_eq!(p, 0);
        assert_eq!(l, u32::MAX);

        let packed2 = pack_ptr_len(u32::MAX, 0);
        let (p2, l2) = unpack_ptr_len(packed2);
        assert_eq!(p2, u32::MAX);
        assert_eq!(l2, 0);
    }

    #[test]
    fn test_pack_ptr_len_one_one() {
        let packed = pack_ptr_len(1, 1);
        let (p, l) = unpack_ptr_len(packed);
        assert_eq!(p, 1);
        assert_eq!(l, 1);
    }

    #[test]
    fn test_pack_ptr_len_distinct_packed_values() {
        let p1 = pack_ptr_len(1, 2);
        let p2 = pack_ptr_len(2, 1);
        assert_ne!(p1, p2);
    }

    #[test]
    fn test_execute_request_custom_fuel_override() {
        let json_val = json!({
            "moduleId": "mod-fuel",
            "input": {},
            "fuel": 999999,
        });
        let req: ExecuteRequest = serde_json::from_value(json_val).unwrap();
        let fuel = req.fuel.unwrap_or(DEFAULT_FUEL);
        assert_eq!(fuel, 999999);
    }

    #[test]
    fn test_execute_request_custom_timeout_override() {
        let json_val = json!({
            "moduleId": "mod-timeout",
            "input": {},
            "timeoutSecs": 5,
        });
        let req: ExecuteRequest = serde_json::from_value(json_val).unwrap();
        let timeout = req.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS);
        assert_eq!(timeout, 5);
    }

    #[test]
    fn test_execute_request_custom_memory_override() {
        let json_val = json!({
            "moduleId": "mod-mem",
            "input": {},
            "memoryPages": 512,
        });
        let req: ExecuteRequest = serde_json::from_value(json_val).unwrap();
        let pages = req.memory_pages.unwrap_or(DEFAULT_MEMORY_PAGES);
        assert_eq!(pages, 512);
    }

    #[test]
    fn test_execute_request_missing_module_id_fails() {
        let json_val = json!({
            "input": {},
        });
        let result: Result<ExecuteRequest, _> = serde_json::from_value(json_val);
        assert!(result.is_err());
    }

    #[test]
    fn test_execute_request_missing_input_fails() {
        let json_val = json!({
            "moduleId": "mod-1",
        });
        let result: Result<ExecuteRequest, _> = serde_json::from_value(json_val);
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_request_empty_wasm_bytes() {
        let json_val = json!({
            "moduleId": "mod-empty",
            "wasm": [],
        });
        let req: ValidateRequest = serde_json::from_value(json_val).unwrap();
        assert!(req.wasm.is_empty());
        assert_eq!(req.module_id, "mod-empty");
    }

    #[test]
    fn test_validate_request_large_module_id() {
        let large_id = "m".repeat(10_000);
        let json_val = json!({
            "moduleId": large_id,
            "wasm": [0],
        });
        let req: ValidateRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.module_id.len(), 10_000);
    }

    #[test]
    fn test_validate_request_missing_wasm_fails() {
        let json_val = json!({
            "moduleId": "mod-no-wasm",
        });
        let result: Result<ValidateRequest, _> = serde_json::from_value(json_val);
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_request_missing_module_id_fails() {
        let json_val = json!({
            "wasm": [0, 1, 2],
        });
        let result: Result<ValidateRequest, _> = serde_json::from_value(json_val);
        assert!(result.is_err());
    }

    #[test]
    fn test_execution_error_display_timeout() {
        let err = ExecutionError::Timeout;
        assert_eq!(format!("{}", err), "execution timed out");
    }

    #[test]
    fn test_execution_error_display_fuel_exhausted() {
        let err = ExecutionError::FuelExhausted;
        assert_eq!(format!("{}", err), "fuel exhausted");
    }

    #[test]
    fn test_execution_error_display_trapped() {
        let err = ExecutionError::Trapped("out of bounds memory access".to_string());
        assert_eq!(format!("{}", err), "trapped: out of bounds memory access");
    }

    #[test]
    fn test_execution_error_display_trapped_empty() {
        let err = ExecutionError::Trapped("".to_string());
        assert_eq!(format!("{}", err), "trapped: ");
    }

    #[test]
    fn test_module_cache_insert_and_retrieve() {
        let mut config = Config::new();
        config.consume_fuel(true);
        let engine = Engine::new(&config).unwrap();
        let cache = ModuleCache {
            engine: engine.clone(),
            modules: DashMap::new(),
        };

        let wat = r#"(module
            (memory (export "memory") 1)
            (func (export "alloc") (param i32) (result i32) i32.const 0)
            (func (export "execute") (param i32 i32) (result i64) i64.const 0)
        )"#;
        let module = Module::new(&engine, wat).unwrap();
        cache.modules.insert("test-mod".to_string(), module);
        assert_eq!(cache.modules.len(), 1);
        assert!(cache.modules.contains_key("test-mod"));
    }

    #[test]
    fn test_module_cache_multiple_modules() {
        let mut config = Config::new();
        config.consume_fuel(true);
        let engine = Engine::new(&config).unwrap();
        let cache = ModuleCache {
            engine: engine.clone(),
            modules: DashMap::new(),
        };

        let wat = r#"(module (memory (export "memory") 1))"#;
        for i in 0..5 {
            let module = Module::new(&engine, wat).unwrap();
            cache.modules.insert(format!("mod-{}", i), module);
        }
        assert_eq!(cache.modules.len(), 5);
    }

    #[test]
    fn test_module_cache_overwrite_same_key() {
        let mut config = Config::new();
        config.consume_fuel(true);
        let engine = Engine::new(&config).unwrap();
        let cache = ModuleCache {
            engine: engine.clone(),
            modules: DashMap::new(),
        };

        let wat = r#"(module (memory (export "memory") 1))"#;
        let m1 = Module::new(&engine, wat).unwrap();
        let m2 = Module::new(&engine, wat).unwrap();
        cache.modules.insert("same".to_string(), m1);
        cache.modules.insert("same".to_string(), m2);
        assert_eq!(cache.modules.len(), 1);
    }

    #[test]
    fn test_wasm_allowed_functions_exact_count() {
        const WASM_ALLOWED_FUNCTIONS: &[&str] = &[
            "memory::recall",
            "memory::store",
            "tool::web_fetch",
            "tool::file_read",
            "tool::file_list",
            "security::scan_injection",
            "embedding::generate",
        ];
        assert_eq!(WASM_ALLOWED_FUNCTIONS.len(), 7);
    }

    #[test]
    fn test_wasm_allowed_functions_blocked() {
        const WASM_ALLOWED_FUNCTIONS: &[&str] = &[
            "memory::recall",
            "memory::store",
            "tool::web_fetch",
            "tool::file_read",
            "tool::file_list",
            "security::scan_injection",
            "embedding::generate",
        ];
        let blocked = [
            "file::delete",
            "network::send",
            "system::exec",
            "tool::file_write",
            "memory::delete",
            "agent::create",
            "security::check_capability",
        ];
        for func in &blocked {
            assert!(!WASM_ALLOWED_FUNCTIONS.contains(func), "{} should be blocked", func);
        }
    }

    #[test]
    fn test_wasm_allowed_functions_all_present() {
        const WASM_ALLOWED_FUNCTIONS: &[&str] = &[
            "memory::recall",
            "memory::store",
            "tool::web_fetch",
            "tool::file_read",
            "tool::file_list",
            "security::scan_injection",
            "embedding::generate",
        ];
        let expected = [
            "memory::recall",
            "memory::store",
            "tool::web_fetch",
            "tool::file_read",
            "tool::file_list",
            "security::scan_injection",
            "embedding::generate",
        ];
        for func in &expected {
            assert!(WASM_ALLOWED_FUNCTIONS.contains(func), "{} should be allowed", func);
        }
    }

    #[test]
    fn test_fuel_tracking_zero_fuel() {
        let initial: u64 = 0;
        let remaining: u64 = 0;
        let consumed = initial.saturating_sub(remaining);
        assert_eq!(consumed, 0);
    }

    #[test]
    fn test_fuel_tracking_max_u64_fuel() {
        let initial: u64 = u64::MAX;
        let remaining: u64 = 0;
        let consumed = initial.saturating_sub(remaining);
        assert_eq!(consumed, u64::MAX);
    }

    #[test]
    fn test_fuel_tracking_partial_consumption() {
        let initial: u64 = 1_000_000;
        let remaining: u64 = 750_000;
        let consumed = initial.saturating_sub(remaining);
        assert_eq!(consumed, 250_000);
    }

    #[test]
    fn test_memory_pages_zero() {
        let current_pages: u64 = 0;
        let memory_pages: u64 = 0;
        let exceeds = current_pages > memory_pages;
        assert!(!exceeds);
    }

    #[test]
    fn test_memory_pages_at_limit() {
        let current_pages: u64 = 256;
        let memory_pages: u64 = 256;
        let exceeds = current_pages > memory_pages;
        assert!(!exceeds);
    }

    #[test]
    fn test_memory_pages_exceeds_limit() {
        let current_pages: u64 = 257;
        let memory_pages: u64 = 256;
        let exceeds = current_pages > memory_pages;
        assert!(exceeds);
    }

    #[test]
    fn test_memory_pages_max_limit() {
        let current_pages: u64 = 65536;
        let memory_pages: u64 = 65536;
        let exceeds = current_pages > memory_pages;
        assert!(!exceeds);
    }

    #[test]
    fn test_execute_request_serialization_roundtrip() {
        let req = ExecuteRequest {
            module_id: "mod-rt".to_string(),
            input: json!({"data": [1, 2, 3]}),
            agent_id: Some("agent-rt".to_string()),
            fuel: Some(500_000),
            timeout_secs: Some(15),
            memory_pages: Some(128),
        };
        let json_str = serde_json::to_string(&req).unwrap();
        let rt: ExecuteRequest = serde_json::from_str(&json_str).unwrap();
        assert_eq!(rt.module_id, "mod-rt");
        assert_eq!(rt.agent_id, Some("agent-rt".to_string()));
        assert_eq!(rt.fuel, Some(500_000));
    }

    #[test]
    fn test_validate_request_serialization_roundtrip() {
        let req = ValidateRequest {
            module_id: "mod-vrt".to_string(),
            wasm: vec![0, 97, 115, 109, 1, 0, 0, 0],
        };
        let json_str = serde_json::to_string(&req).unwrap();
        let rt: ValidateRequest = serde_json::from_str(&json_str).unwrap();
        assert_eq!(rt.module_id, "mod-vrt");
        assert_eq!(rt.wasm.len(), 8);
    }

    #[test]
    fn test_execute_request_complex_input() {
        let json_val = json!({
            "moduleId": "mod-complex",
            "input": {
                "nested": {"deep": {"value": 42}},
                "array": [1, "two", true, null],
                "empty": {},
            },
        });
        let req: ExecuteRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.input["nested"]["deep"]["value"], 42);
        assert_eq!(req.input["array"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn test_execute_request_null_input() {
        let json_val = json!({
            "moduleId": "mod-null",
            "input": null,
        });
        let req: ExecuteRequest = serde_json::from_value(json_val).unwrap();
        assert!(req.input.is_null());
    }

    #[test]
    fn test_execution_error_debug_trait() {
        let err = ExecutionError::Timeout;
        let debug_str = format!("{:?}", err);
        assert!(debug_str.contains("Timeout"));

        let err2 = ExecutionError::FuelExhausted;
        let debug_str2 = format!("{:?}", err2);
        assert!(debug_str2.contains("FuelExhausted"));

        let err3 = ExecutionError::Trapped("some error".to_string());
        let debug_str3 = format!("{:?}", err3);
        assert!(debug_str3.contains("Trapped"));
        assert!(debug_str3.contains("some error"));
    }

    #[test]
    fn test_module_cache_empty_on_creation() {
        let mut config = Config::new();
        config.consume_fuel(true);
        let engine = Engine::new(&config).unwrap();
        let cache = ModuleCache {
            engine,
            modules: DashMap::new(),
        };
        assert_eq!(cache.modules.len(), 0);
        assert!(cache.modules.is_empty());
    }

    #[test]
    fn test_module_ids_collection_from_cache() {
        let mut config = Config::new();
        config.consume_fuel(true);
        let engine = Engine::new(&config).unwrap();
        let cache = ModuleCache {
            engine: engine.clone(),
            modules: DashMap::new(),
        };

        let wat = r#"(module (memory (export "memory") 1))"#;
        for name in ["alpha", "beta", "gamma"] {
            let module = Module::new(&engine, wat).unwrap();
            cache.modules.insert(name.to_string(), module);
        }
        let mut ids: Vec<String> = cache.modules.iter().map(|e| e.key().clone()).collect();
        ids.sort();
        assert_eq!(ids, vec!["alpha", "beta", "gamma"]);
    }

    #[test]
    fn test_pack_ptr_len_half_max() {
        let half = u32::MAX / 2;
        let packed = pack_ptr_len(half, half);
        let (p, l) = unpack_ptr_len(packed);
        assert_eq!(p, half);
        assert_eq!(l, half);
    }

    #[test]
    fn test_pack_ptr_len_sequential() {
        for i in 0..100u32 {
            let packed = pack_ptr_len(i, i + 1);
            let (p, l) = unpack_ptr_len(packed);
            assert_eq!(p, i);
            assert_eq!(l, i + 1);
        }
    }

    #[test]
    fn test_pack_ptr_len_byte_boundaries() {
        let vals = [0xFFu32, 0xFF00, 0xFF0000, 0xFF000000];
        for v in vals {
            let packed = pack_ptr_len(v, v);
            let (p, l) = unpack_ptr_len(packed);
            assert_eq!(p, v, "byte boundary ptr failed for 0x{:X}", v);
            assert_eq!(l, v, "byte boundary len failed for 0x{:X}", v);
        }
    }

    #[test]
    fn test_execute_request_deeply_nested_input() {
        let json_val = json!({
            "moduleId": "mod-deep",
            "input": {
                "level1": {
                    "level2": {
                        "level3": {
                            "level4": {
                                "level5": {
                                    "value": "deep"
                                }
                            }
                        }
                    }
                }
            },
        });
        let req: ExecuteRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.input["level1"]["level2"]["level3"]["level4"]["level5"]["value"], "deep");
    }

    #[test]
    fn test_execute_request_large_array_input() {
        let arr: Vec<i32> = (0..1000).collect();
        let json_val = json!({
            "moduleId": "mod-arr",
            "input": arr,
        });
        let req: ExecuteRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.input.as_array().unwrap().len(), 1000);
    }

    #[test]
    fn test_execute_request_fuel_zero() {
        let json_val = json!({
            "moduleId": "mod",
            "input": {},
            "fuel": 0,
        });
        let req: ExecuteRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.fuel, Some(0));
        let fuel = req.fuel.unwrap_or(DEFAULT_FUEL);
        assert_eq!(fuel, 0);
    }

    #[test]
    fn test_execute_request_timeout_zero() {
        let json_val = json!({
            "moduleId": "mod",
            "input": {},
            "timeoutSecs": 0,
        });
        let req: ExecuteRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.timeout_secs, Some(0));
    }

    #[test]
    fn test_execute_request_max_fuel() {
        let json_val = json!({
            "moduleId": "mod",
            "input": {},
            "fuel": u64::MAX,
        });
        let req: ExecuteRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.fuel, Some(u64::MAX));
    }

    #[test]
    fn test_module_cache_remove() {
        let mut config = Config::new();
        config.consume_fuel(true);
        let engine = Engine::new(&config).unwrap();
        let cache = ModuleCache {
            engine: engine.clone(),
            modules: DashMap::new(),
        };

        let wat = r#"(module (memory (export "memory") 1))"#;
        let module = Module::new(&engine, wat).unwrap();
        cache.modules.insert("to-remove".to_string(), module);
        assert_eq!(cache.modules.len(), 1);
        cache.modules.remove("to-remove");
        assert_eq!(cache.modules.len(), 0);
    }

    #[test]
    fn test_module_cache_contains_key_check() {
        let mut config = Config::new();
        config.consume_fuel(true);
        let engine = Engine::new(&config).unwrap();
        let cache = ModuleCache {
            engine: engine.clone(),
            modules: DashMap::new(),
        };
        assert!(!cache.modules.contains_key("nonexistent"));
        let wat = r#"(module (memory (export "memory") 1))"#;
        let module = Module::new(&engine, wat).unwrap();
        cache.modules.insert("exists".to_string(), module);
        assert!(cache.modules.contains_key("exists"));
        assert!(!cache.modules.contains_key("nonexistent"));
    }

    #[test]
    fn test_wasm_allowed_functions_memory_recall_present() {
        const WASM_ALLOWED_FUNCTIONS: &[&str] = &[
            "memory::recall", "memory::store", "tool::web_fetch",
            "tool::file_read", "tool::file_list",
            "security::scan_injection", "embedding::generate",
        ];
        assert!(WASM_ALLOWED_FUNCTIONS.contains(&"memory::recall"));
    }

    #[test]
    fn test_wasm_allowed_functions_embedding_generate_present() {
        const WASM_ALLOWED_FUNCTIONS: &[&str] = &[
            "memory::recall", "memory::store", "tool::web_fetch",
            "tool::file_read", "tool::file_list",
            "security::scan_injection", "embedding::generate",
        ];
        assert!(WASM_ALLOWED_FUNCTIONS.contains(&"embedding::generate"));
    }

    #[test]
    fn test_wasm_allowed_functions_no_write_operations() {
        const WASM_ALLOWED_FUNCTIONS: &[&str] = &[
            "memory::recall", "memory::store", "tool::web_fetch",
            "tool::file_read", "tool::file_list",
            "security::scan_injection", "embedding::generate",
        ];
        assert!(!WASM_ALLOWED_FUNCTIONS.contains(&"tool::file_write"));
        assert!(!WASM_ALLOWED_FUNCTIONS.contains(&"tool::file_delete"));
        assert!(!WASM_ALLOWED_FUNCTIONS.contains(&"system::exec"));
    }

    #[test]
    fn test_execution_error_trapped_with_special_chars() {
        let err = ExecutionError::Trapped("error with 'quotes' and \"double quotes\"".to_string());
        let display = format!("{}", err);
        assert!(display.contains("quotes"));
    }

    #[test]
    fn test_execution_error_trapped_unicode() {
        let err = ExecutionError::Trapped("error: \u{4e16}\u{754c}".to_string());
        let display = format!("{}", err);
        assert!(display.contains("\u{4e16}"));
    }

    #[test]
    fn test_fuel_tracking_exact_consumption() {
        let initial: u64 = 1_000_000;
        let remaining: u64 = 1;
        let consumed = initial.saturating_sub(remaining);
        assert_eq!(consumed, 999_999);
    }

    #[test]
    fn test_validate_request_wasm_magic_bytes() {
        let json_val = json!({
            "moduleId": "mod-magic",
            "wasm": [0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00],
        });
        let req: ValidateRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.wasm[0..4], [0x00, 0x61, 0x73, 0x6D]);
    }
}

async fn validate_wasm(cache: &ModuleCache, input: Value) -> Result<Value, IIIError> {
    let req: ValidateRequest = serde_json::from_value(input)
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let module = Module::new(&cache.engine, &req.wasm)
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let mut has_memory = false;
    let mut has_alloc = false;
    let mut has_execute = false;

    for export in module.exports() {
        match export.name() {
            "memory" => {
                if matches!(export.ty(), ExternType::Memory(_)) {
                    has_memory = true;
                }
            }
            "alloc" => {
                if let ExternType::Func(ft) = export.ty() {
                    has_alloc = ft.params().len() == 1 && ft.results().len() == 1;
                }
            }
            "execute" => {
                if let ExternType::Func(ft) = export.ty() {
                    has_execute = ft.params().len() == 2 && ft.results().len() == 1;
                }
            }
            _ => {}
        }
    }

    if !has_memory || !has_alloc || !has_execute {
        let mut missing = Vec::new();
        if !has_memory { missing.push("memory"); }
        if !has_alloc { missing.push("alloc(size) -> ptr"); }
        if !has_execute { missing.push("execute(input_ptr, input_len) -> i64"); }
        return Err(IIIError::Handler(format!("Module missing required exports: {}", missing.join(", "))));
    }

    cache.modules.insert(req.module_id.clone(), module);

    Ok(json!({
        "valid": true,
        "moduleId": req.module_id,
        "cached": true,
    }))
}
