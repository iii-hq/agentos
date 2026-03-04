type TriggerVoidFn = (id: string, input: any) => void;

export function createRecordMetric(triggerVoid: TriggerVoidFn) {
  return function recordMetric(
    name: string,
    value: number,
    labels: Record<string, string>,
    type: "counter" | "histogram" | "gauge" = "counter",
  ) {
    triggerVoid("telemetry::record", { name, value, labels, type });
  };
}
