use std::sync::Arc;

use iii_sdk::{InitOptions, RegisterFunction, register_worker};
use serde_json::Value;

mod config;
mod gate;
mod structs;

use config::GateConfig;
use gate::GateState;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let cfg = GateConfig::from_env();
    let iii = register_worker(&cfg.ws_url, InitOptions::default());
    let state: Arc<GateState> = GateState::new(cfg);

    // gate::set_if_changed
    {
        let iii_ref = iii.clone();
        let state_ref = state.clone();
        iii.register_function(
            RegisterFunction::new_async("gate::set_if_changed", move |input: Value| {
                let iii = iii_ref.clone();
                let state = state_ref.clone();
                async move { gate::set_if_changed(&iii, &state, input).await }
            })
            .description("Write to state only if the new value differs from current; suppresses redundant trigger fires"),
        );
    }

    // gate::increment_throttled
    {
        let iii_ref = iii.clone();
        let state_ref = state.clone();
        iii.register_function(
            RegisterFunction::new_async("gate::increment_throttled", move |input: Value| {
                let iii = iii_ref.clone();
                let state = state_ref.clone();
                async move { gate::increment_throttled(&iii, state, input).await }
            })
            .description("Accumulate numeric increments within a time window; flush one composite state update per window"),
        );
    }

    // gate::debounce
    {
        let iii_ref = iii.clone();
        let state_ref = state.clone();
        iii.register_function(
            RegisterFunction::new_async("gate::debounce", move |input: Value| {
                let iii = iii_ref.clone();
                let state = state_ref.clone();
                async move { gate::debounce(&iii, state, input).await }
            })
            .description("Last-write-wins within a delay window; only the final value commits to state"),
        );
    }

    // gate::accumulate
    {
        let iii_ref = iii.clone();
        let state_ref = state.clone();
        iii.register_function(
            RegisterFunction::new_async("gate::accumulate", move |input: Value| {
                let iii = iii_ref.clone();
                let state = state_ref.clone();
                async move { gate::accumulate(&iii, state, input).await }
            })
            .description("Coalesce concurrent update ops per key; flush one consolidated state update when in-flight write completes or batch threshold is reached"),
        );
    }

    // gate::batch_commit
    {
        let iii_ref = iii.clone();
        let state_ref = state.clone();
        iii.register_function(
            RegisterFunction::new_async("gate::batch_commit", move |input: Value| {
                let iii = iii_ref.clone();
                let state = state_ref.clone();
                async move { gate::batch_commit(&iii, &state, input).await }
            })
            .description("Deduplicate a caller-assembled batch of mutations by (scope, key) and commit in parallel"),
        );
    }

    tracing::info!("gate worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}
