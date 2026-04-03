export function recordMetric(
  name: string,
  value: number,
  labels?: Record<string, string | number>,
  _type?: string,
) {
}

type TriggerVoidFn = (id: string, input: unknown) => void | Promise<unknown>;

export function createRecordMetric(triggerVoid: TriggerVoidFn) {
  return (name: string, value: number, labels?: Record<string, string | number>, _type?: string) => {
    triggerVoid("engine::log::info", {
      message: `metric:${name}=${value}`,
      ...labels,
    });
  };
}
