export function safeInt(
  val: unknown,
  min: number,
  max: number,
  defaultVal: number,
): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return defaultVal;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

export function safeString(val: unknown, maxLen = 10_000): string {
  if (typeof val !== "string") return "";
  return val.trim().slice(0, maxLen);
}

export function safeArray<T>(val: unknown, maxLen = 1000): T[] {
  if (!Array.isArray(val)) return [];
  return val.slice(0, maxLen);
}

export function safePagination(
  limit: unknown,
  offset: unknown,
): { limit: number; offset: number } {
  return {
    limit: safeInt(limit, 1, 1000, 100),
    offset: safeInt(offset, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}
