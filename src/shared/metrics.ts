import { getContext } from "iii-sdk";

type MetricType = "counter" | "histogram" | "gauge";

const instrumentCache = new Map<string, any>();

function getMeter() {
  try {
    return getContext().meter;
  } catch {
    return null;
  }
}

function getOrCreate(name: string, factory: () => any): any {
  let instrument = instrumentCache.get(name);
  if (!instrument) {
    instrument = factory();
    instrumentCache.set(name, instrument);
  }
  return instrument;
}

export function recordMetric(
  name: string,
  value: number,
  labels: Record<string, string>,
  type: MetricType = "counter",
): void {
  try {
    const meter = getMeter();
    if (!meter) return;
    if (type === "counter") {
      getOrCreate(name, () => meter.createCounter(name)).add(value, labels);
    } else if (type === "histogram") {
      getOrCreate(name, () => meter.createHistogram(name)).record(value, labels);
    } else if (type === "gauge") {
      getOrCreate(name, () => meter.createUpDownCounter(name)).add(value, labels);
    }
  } catch {}
}
