import { init } from "iii-sdk";
import { ENGINE_URL } from "./shared/config.js";
import { createLogger } from "./shared/logger.js";

const log = createLogger("telemetry");

const { registerFunction, registerTrigger, trigger } = init(ENGINE_URL, {
  workerName: "telemetry",
});

interface MetricEvent {
  name: string;
  value: number;
  labels: Record<string, string>;
  timestamp: number;
}

interface CounterState {
  value: number;
  labels: Record<string, string>;
}

interface HistogramState {
  count: number;
  sum: number;
  min: number;
  max: number;
  buckets: Record<string, number>;
  labels: Record<string, string>;
}

const HISTOGRAM_BOUNDARIES = [
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 10000,
];
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

function bucketKey(name: string, labels: Record<string, string>): string {
  const sorted = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  const labelStr = sorted.map(([k, v]) => `${k}=${v}`).join(",");
  return `${name}|${labelStr}`;
}

registerFunction(
  {
    id: "telemetry::record",
    description: "Record a metric event",
    metadata: { category: "telemetry" },
  },
  async (input: {
    name: string;
    value: number;
    labels?: Record<string, string>;
    type?: "counter" | "histogram" | "gauge";
  }) => {
    const { name, value, labels = {}, type = "counter" } = input;
    const key = bucketKey(name, labels);
    const now = Date.now();

    if (type === "histogram") {
      const existing: HistogramState | null = (await trigger("state::get", {
        scope: "metrics",
        key: `hist:${key}`,
      }).catch(() => null)) as HistogramState | null;

      const state: HistogramState = existing || {
        count: 0,
        sum: 0,
        min: Infinity,
        max: -Infinity,
        buckets: {},
        labels,
      };

      state.count += 1;
      state.sum += value;
      if (value < state.min) state.min = value;
      if (value > state.max) state.max = value;

      for (const boundary of HISTOGRAM_BOUNDARIES) {
        const bk = `le_${boundary}`;
        if (!state.buckets[bk]) state.buckets[bk] = 0;
        if (value <= boundary) state.buckets[bk] += 1;
      }

      await trigger("state::set", {
        scope: "metrics",
        key: `hist:${key}`,
        value: { ...state, updatedAt: now },
      });
    } else if (type === "gauge") {
      await trigger("state::set", {
        scope: "metrics",
        key: `gauge:${key}`,
        value: { value, labels, updatedAt: now },
      });
    } else {
      const existing: CounterState | null = (await trigger("state::get", {
        scope: "metrics",
        key: `counter:${key}`,
      }).catch(() => null)) as CounterState | null;

      const current = existing?.value || 0;
      await trigger("state::set", {
        scope: "metrics",
        key: `counter:${key}`,
        value: { value: current + value, labels, updatedAt: now },
      });
    }

    const event: MetricEvent = { name, value, labels, timestamp: now };
    await trigger("state::update", {
      scope: "metrics",
      key: "events_log",
      operations: [
        { type: "merge", path: "events", value: [event] },
        { type: "set", path: "updatedAt", value: now },
      ],
    }).catch(() =>
      trigger("state::set", {
        scope: "metrics",
        key: "events_log",
        value: { events: [event], updatedAt: now },
      }),
    );

    return { recorded: true, name, key };
  },
);

registerFunction(
  {
    id: "telemetry::summary",
    description: "Return current metrics summary",
    metadata: { category: "telemetry" },
  },
  async () => {
    const all: any = await trigger("state::list", { scope: "metrics" });
    const entries: any[] = all.filter((e: any) => e.key !== "events_log");

    const counters: Record<string, any> = {};
    const histograms: Record<string, any> = {};
    const gauges: Record<string, any> = {};

    const cutoff = Date.now() - ROLLING_WINDOW_MS;

    for (const entry of entries) {
      const { key, value } = entry;
      if (value?.updatedAt && value.updatedAt < cutoff) continue;

      if (key.startsWith("counter:")) {
        counters[key.slice(8)] = { value: value.value, labels: value.labels };
      } else if (key.startsWith("hist:")) {
        const h = value as HistogramState;
        histograms[key.slice(5)] = {
          count: h.count,
          sum: h.sum,
          min: h.min === Infinity ? 0 : h.min,
          max: h.max === -Infinity ? 0 : h.max,
          avg: h.count > 0 ? h.sum / h.count : 0,
          labels: h.labels,
        };
      } else if (key.startsWith("gauge:")) {
        gauges[key.slice(6)] = { value: value.value, labels: value.labels };
      }
    }

    return {
      counters,
      histograms,
      gauges,
      collectedAt: new Date().toISOString(),
    };
  },
);

registerFunction(
  {
    id: "telemetry::dashboard",
    description: "Return formatted metrics for dashboard display",
    metadata: { category: "telemetry" },
  },
  async () => {
    const summary: any = await trigger("telemetry::summary", {});

    const sections: string[] = [];

    sections.push("=== AgentOS Metrics Dashboard ===\n");

    if (Object.keys(summary.counters).length > 0) {
      sections.push("-- Counters --");
      for (const [name, data] of Object.entries(summary.counters) as [
        string,
        any,
      ][]) {
        const labelStr = Object.entries(data.labels || {})
          .map(([k, v]) => `${k}=${v}`)
          .join(" ");
        sections.push(`  ${name} ${labelStr}: ${data.value}`);
      }
      sections.push("");
    }

    if (Object.keys(summary.histograms).length > 0) {
      sections.push("-- Histograms --");
      for (const [name, data] of Object.entries(summary.histograms) as [
        string,
        any,
      ][]) {
        const labelStr = Object.entries(data.labels || {})
          .map(([k, v]) => `${k}=${v}`)
          .join(" ");
        sections.push(`  ${name} ${labelStr}:`);
        sections.push(
          `    count=${data.count} avg=${data.avg.toFixed(1)}ms min=${data.min.toFixed(1)}ms max=${data.max.toFixed(1)}ms`,
        );
      }
      sections.push("");
    }

    if (Object.keys(summary.gauges).length > 0) {
      sections.push("-- Gauges --");
      for (const [name, data] of Object.entries(summary.gauges) as [
        string,
        any,
      ][]) {
        const labelStr = Object.entries(data.labels || {})
          .map(([k, v]) => `${k}=${v}`)
          .join(" ");
        sections.push(`  ${name} ${labelStr}: ${data.value}`);
      }
      sections.push("");
    }

    sections.push(`Collected: ${summary.collectedAt}`);

    return { text: sections.join("\n"), data: summary };
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

log.info("Telemetry worker registered", { functionId: "telemetry" });
