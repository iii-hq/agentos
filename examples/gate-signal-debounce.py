"""
gate-signal-debounce

Shows two gate patterns in Python:

1. gate::debounce — a noisy temperature sensor emits many readings; only the
   settled value commits to state after a 200 ms quiet period.

2. gate::increment_throttled — a request counter accumulates increments from
   concurrent handlers; one composite state update fires per second.

Run against a live iii engine:

    III_WS_URL=ws://localhost:49134 python examples/gate-signal-debounce.py
"""

import asyncio
import os
import random
import time

from iii_sdk import register_worker  # type: ignore[import]

ENGINE_URL = os.getenv("III_WS_URL", "ws://localhost:49134")

sdk = register_worker(ENGINE_URL, {"workerName": "gate-demo-python"})
trigger = sdk.trigger


# --- helper ---

def now_ms() -> int:
    return int(time.time() * 1000)


# --- scenario 1: debounced temperature sensor ---

async def run_debounce_scenario(scope: str, sensor_id: str) -> dict:
    """
    Simulate a noisy sensor emitting 20 readings in 100 ms. With a 200 ms
    debounce window only the final reading commits to state, producing exactly
    1 state::set instead of 20.
    """
    readings = [20.0 + random.uniform(-0.5, 0.5) for _ in range(20)]
    tasks = []
    for temp in readings:
        tasks.append(
            trigger(
                "gate::debounce",
                {
                    "scope": scope,
                    "key": sensor_id,
                    "value": {"temperature": round(temp, 3), "ts": now_ms()},
                    "delay_ms": 200,
                },
            )
        )
    results = await asyncio.gather(*tasks)

    # All 20 calls return committed=False immediately (debounce is async).
    # After 200 ms of quiet, state::set fires exactly once.
    return {
        "totalCalls": len(results),
        "allPending": all(not r.get("committed") for r in results),
        "willCommitAt": results[-1].get("will_commit_at_ms"),
        "lastReading": readings[-1],
    }


# --- scenario 2: throttled request counter ---

async def run_throttle_scenario(scope: str, service_id: str) -> dict:
    """
    Simulate 50 concurrent request handlers each incrementing a counter.
    With a 1 000 ms window, a single state::update fires instead of 50.
    """
    tasks = [
        trigger(
            "gate::increment_throttled",
            {
                "scope": scope,
                "key": service_id,
                "path": "requestCount",
                "by": 1,
                "window_ms": 1000,
            },
        )
        for _ in range(50)
    ]
    results = await asyncio.gather(*tasks)
    first_result = results[0]

    return {
        "totalCalls": len(results),
        "windowFlushedAt": first_result.get("will_flush_at_ms"),
        "accumulatedAfterAllCalls": results[-1].get("accumulated_so_far"),
    }


# --- register demo functions ---

@sdk.register_function(
    id="demo::sensor_debounce",
    description="Run debounce scenario: 20 sensor readings → 1 state write",
)
async def sensor_debounce(input: dict) -> dict:
    return await run_debounce_scenario(
        scope=input.get("scope", "sensors"),
        sensor_id=input.get("sensorId", "temp-001"),
    )


@sdk.register_function(
    id="demo::counter_throttle",
    description="Run throttle scenario: 50 increments in 1 s window → 1 state update",
)
async def counter_throttle(input: dict) -> dict:
    return await run_throttle_scenario(
        scope=input.get("scope", "metrics"),
        service_id=input.get("serviceId", "api-gateway"),
    )


if __name__ == "__main__":
    print("gate signal-debounce demo worker started")
    sdk.run()
