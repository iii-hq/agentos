type TriggerFn = (req: {
  function_id: string;
  payload: unknown;
}) => Promise<any>;

export function createSecretGetter(triggerFn: TriggerFn) {
  return async function getSecret(key: string): Promise<string> {
    try {
      const result = await triggerFn({
        function_id: "vault::get",
        payload: { key },
      });
      return result?.value || process.env[key] || "";
    } catch {
      return process.env[key] || "";
    }
  };
}
