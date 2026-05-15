/**
 * gate-reinforcement-loop
 *
 * Shows how gate::set_if_changed suppresses redundant state writes in a
 * biological-memory reinforcement loop. The loop "sees" the same memory many
 * times but only the first encounter (or a meaningful confidence change) fires
 * a downstream state trigger.
 */

import { registerWorker } from "iii-sdk";
import { ENGINE_URL, registerShutdown } from "../src/shared/config.js";

const sdk = registerWorker(ENGINE_URL, { workerName: "gate-demo-reinforcement" });
registerShutdown(sdk);

const { trigger, registerFunction } = sdk;

// Simulate a memory substrate that reinforces the same observation repeatedly.
registerFunction(
  {
    id: "demo::reinforce_memory",
    description: "Reinforce a memory entry; gate suppresses writes when confidence is stable",
  },
  async (input: { agentId: string; memoryId: string; content: string; confidence: number }) => {
    const { agentId, memoryId, content, confidence } = input;
    const scope = `memory:${agentId}`;

    // Use gate::set_if_changed with epsilon=0.02 so micro-fluctuations in the
    // confidence score (±2%) do not fire state triggers. Only meaningful
    // reinforcement (confidence rising or falling by more than 2%) writes.
    const result = await trigger({
      function_id: "gate::set_if_changed",
      payload: {
        scope,
        key: memoryId,
        value: { content, confidence, reinforcedAt: Date.now() },
        comparison: "epsilon",
        epsilon: 0.02,
      },
    });

    return {
      memoryId,
      written: result.written,
      reason: result.reason,
      previousConfidence: result.old_value?.confidence ?? null,
    };
  }
);

// Simulate 10 rapid reinforcement signals for the same memory with stable confidence.
registerFunction(
  {
    id: "demo::run_reinforcement_scenario",
    description: "Run the write-amplification scenario and report effective-write count",
  },
  async (input: { agentId: string }) => {
    const { agentId } = input;
    const memoryId = "mem-abc-123";
    const content = "The mitochondria is the powerhouse of the cell";

    // First call always writes (key absent).
    const calls: Promise<{ written: boolean; reason: string }>[] = [];
    for (let i = 0; i < 10; i++) {
      // Confidence oscillates between 0.85–0.86 — within epsilon, no write.
      const confidence = 0.85 + (i % 2) * 0.005;
      calls.push(
        trigger({
          function_id: "demo::reinforce_memory",
          payload: { agentId, memoryId, content, confidence },
        })
      );
    }

    const results = await Promise.all(calls);
    const writtenCount = results.filter((r) => r.written).length;

    // Expected: 1 write (first call, key absent). Remaining 9 are suppressed.
    return {
      totalCalls: results.length,
      effectiveWrites: writtenCount,
      suppressedWrites: results.length - writtenCount,
      detail: results.map((r, i) => ({ call: i + 1, written: r.written, reason: r.reason })),
    };
  }
);

console.log("gate reinforcement-loop demo worker started");
