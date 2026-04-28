export class AppError extends Error {
  code: string;
  context?: Record<string, unknown>;
  retryable: boolean;

  constructor(
    message: string,
    opts: {
      code: string;
      context?: Record<string, unknown>;
      retryable?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { cause: opts.cause });
    this.name = "AppError";
    this.code = opts.code;
    this.context = opts.context;
    this.retryable = opts.retryable ?? false;
  }
}

export type ErrorClass = "transient" | "permanent" | "degraded";

export function classifyError(e: unknown): ErrorClass {
  if (e instanceof AppError) {
    if (e.retryable) return "transient";
    return "permanent";
  }
  if (e instanceof Error) {
    const msg = e.message.toLowerCase();
    if (
      msg.includes("timeout") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("socket hang up") ||
      msg.includes("aborted") ||
      msg.includes("network")
    ) {
      return "transient";
    }
    if (
      msg.includes("rate limit") ||
      msg.includes("429") ||
      msg.includes("503") ||
      msg.includes("unavailable")
    ) {
      return "degraded";
    }
  }
  return "permanent";
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  backoffMs = 1000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const cls = classifyError(e);
      if (cls === "permanent" || attempt === maxRetries) break;
      const delay = backoffMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

export async function safeCall<T>(
  fn: () => Promise<T>,
  fallback: T,
  context: { functionId?: string; agentId?: string; operation: string },
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    logError(e, context);
    return fallback;
  }
}

export function logError(
  error: unknown,
  context: { functionId?: string; agentId?: string; operation?: string },
): void {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level: "error",
    ...context,
  };
  if (error instanceof AppError) {
    entry.code = error.code;
    entry.message = error.message;
    entry.retryable = error.retryable;
    entry.errorContext = error.context;
    entry.classification = classifyError(error);
  } else if (error instanceof Error) {
    entry.message = error.message;
    entry.stack = error.stack;
    entry.classification = classifyError(error);
  } else {
    entry.message = String(error);
    entry.classification = "permanent";
  }
  console.error(JSON.stringify(entry));
}
