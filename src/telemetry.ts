import { initSDK } from "./shared/config.js";

const { registerFunction, registerTrigger } = initSDK("telemetry");

registerFunction(
  {
    id: "telemetry::summary",
    description: "Return worker metrics summary",
    metadata: { category: "telemetry" },
  },
  async () => {
    const mem = process.memoryUsage();
    return {
      memoryRss: mem.rss,
      memoryHeapUsed: mem.heapUsed,
      memoryHeapTotal: mem.heapTotal,
      uptimeSeconds: process.uptime(),
      collectedAt: new Date().toISOString(),
    };
  },
);

registerFunction(
  {
    id: "telemetry::dashboard",
    description: "Metrics dashboard",
    metadata: { category: "telemetry" },
  },
  async () => {
    const mem = process.memoryUsage();
    const data = {
      memoryRss: mem.rss,
      memoryHeapUsed: mem.heapUsed,
      uptimeSeconds: process.uptime(),
    };
    const lines = [
      `Memory RSS: ${(data.memoryRss / 1024 / 1024).toFixed(1)} MB`,
      `Heap Used: ${(data.memoryHeapUsed / 1024 / 1024).toFixed(1)} MB`,
      `Uptime: ${data.uptimeSeconds.toFixed(0)} s`,
    ];
    return { text: lines.join("\n"), data };
  },
);

registerTrigger({
  type: "http",
  function_id: "telemetry::summary",
  config: { api_path: "api/metrics", http_method: "GET" },
});

registerTrigger({
  type: "http",
  function_id: "telemetry::dashboard",
  config: { api_path: "api/metrics/summary", http_method: "GET" },
});
