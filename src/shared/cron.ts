export function normalizeCronExpression(expression: string): string {
  const fields = expression.trim().split(/\s+/).filter(Boolean);

  if (fields.length === 5) return ["0", ...fields].join(" ");
  if (fields.length === 6) return fields.join(" ");

  throw new Error(`Invalid cron expression: ${expression}`);
}
