import { describe, it, expect, vi } from "vitest";
import {
  AppError,
  classifyError,
  withRetry,
  safeCall,
  logError,
} from "@agentos/shared/errors";
import {
  safeInt,
  safeString,
  safeArray,
  safePagination,
} from "@agentos/shared/validate";

describe("AppError", () => {
  it("sets code, context, retryable", () => {
    const err = new AppError("boom", {
      code: "E_TEST",
      context: { key: "val" },
      retryable: true,
    });
    expect(err.message).toBe("boom");
    expect(err.code).toBe("E_TEST");
    expect(err.context).toEqual({ key: "val" });
    expect(err.retryable).toBe(true);
    expect(err.name).toBe("AppError");
  });

  it("defaults retryable to false", () => {
    const err = new AppError("fail", { code: "E_FAIL" });
    expect(err.retryable).toBe(false);
  });
});

describe("classifyError", () => {
  it("returns transient for retryable AppError", () => {
    const err = new AppError("retry me", { code: "E_TEMP", retryable: true });
    expect(classifyError(err)).toBe("transient");
  });

  it("returns permanent for non-retryable AppError", () => {
    const err = new AppError("no retry", { code: "E_PERM", retryable: false });
    expect(classifyError(err)).toBe("permanent");
  });

  it("returns transient for timeout Error", () => {
    expect(classifyError(new Error("Connection timeout"))).toBe("transient");
  });

  it("returns degraded for rate limit Error", () => {
    expect(classifyError(new Error("rate limit exceeded"))).toBe("degraded");
  });

  it("returns permanent for unknown error", () => {
    expect(classifyError("some string")).toBe("permanent");
  });
});

describe("withRetry", () => {
  it("succeeds on first try", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, 3, 1);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient errors", async () => {
    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      if (attempt < 3) throw new Error("Connection timeout");
      return "recovered";
    });
    const result = await withRetry(fn, 3, 1);
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry permanent errors", async () => {
    const permanentErr = new AppError("fatal", {
      code: "E_FATAL",
      retryable: false,
    });
    const fn = vi.fn(async () => {
      throw permanentErr;
    });
    await expect(withRetry(fn, 3, 1)).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("safeCall", () => {
  it("returns result on success", async () => {
    const result = await safeCall(
      async () => 42,
      0,
      { operation: "test" },
    );
    expect(result).toBe(42);
  });

  it("returns fallback on error", async () => {
    const result = await safeCall(
      async () => {
        throw new Error("oops");
      },
      "default",
      { operation: "test" },
    );
    expect(result).toBe("default");
  });
});

describe("logError", () => {
  it("writes to stderr", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError(new Error("test error"), { operation: "unit-test" });
    expect(spy).toHaveBeenCalledTimes(1);
    const output = spy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.level).toBe("error");
    expect(parsed.message).toBe("test error");
    expect(parsed.operation).toBe("unit-test");
    spy.mockRestore();
  });
});

describe("safeInt", () => {
  it("returns defaultVal for NaN", () => {
    expect(safeInt("abc", 0, 100, 50)).toBe(50);
    expect(safeInt(undefined, 0, 100, 50)).toBe(50);
    expect(safeInt(Infinity, 0, 100, 50)).toBe(50);
  });

  it("clamps to min/max", () => {
    expect(safeInt(-10, 0, 100, 50)).toBe(0);
    expect(safeInt(200, 0, 100, 50)).toBe(100);
  });

  it("truncates decimals", () => {
    expect(safeInt(3.7, 0, 100, 50)).toBe(3);
    expect(safeInt(9.9, 0, 100, 50)).toBe(9);
  });
});

describe("safeString", () => {
  it("returns empty for non-string", () => {
    expect(safeString(123)).toBe("");
    expect(safeString(null)).toBe("");
    expect(safeString(undefined)).toBe("");
    expect(safeString({})).toBe("");
  });

  it("trims and slices", () => {
    expect(safeString("  hello  ")).toBe("hello");
    expect(safeString("abcdef", 3)).toBe("abc");
    expect(safeString("  abcdef  ", 4)).toBe("abcd");
  });
});

describe("safeArray", () => {
  it("returns empty for non-array", () => {
    expect(safeArray("not array")).toEqual([]);
    expect(safeArray(null)).toEqual([]);
    expect(safeArray(42)).toEqual([]);
  });

  it("slices to maxLen", () => {
    expect(safeArray([1, 2, 3, 4, 5], 3)).toEqual([1, 2, 3]);
  });
});

describe("safePagination", () => {
  it("returns defaults for undefined", () => {
    const result = safePagination(undefined, undefined);
    expect(result.limit).toBe(100);
    expect(result.offset).toBe(0);
  });
});
