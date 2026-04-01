import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const stateStore = new Map<string, any>();

const mockTrigger = vi.fn(async (id: string, input: any) => {
  if (id === "state::get") {
    return stateStore.get(`${input.scope}:${input.key}`) ?? null;
  }
  return null;
});
const mockTriggerVoid = vi.fn((id: string, input: any) => {
  if (id === "state::set") {
    const key = `${input.scope}:${input.key}`;
    if (input.value === null || input.value === undefined) {
      stateStore.delete(key);
    } else {
      stateStore.set(key, input.value);
    }
  }
});

const handlers: Record<string, Function> = {};
vi.mock("iii-sdk", () => ({
  registerWorker: () => ({
    registerFunction: (config: any, handler: Function) => {
      handlers[config.id] = handler;
    },
    registerTrigger: vi.fn(),
    trigger: (req: any) =>
      req.action
        ? mockTriggerVoid(req.function_id, req.payload)
        : mockTrigger(req.function_id, req.payload),
  }),
  TriggerAction: { Void: () => ({}) },
}));

const PRIVATE_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
];
vi.mock("../shared/utils.js", () => ({
  httpOk: (req: any, data: any) => data,
  requireAuth: vi.fn(),
  assertNoSsrf: vi.fn(async (urlStr: string) => {
    const parsed = new URL(urlStr);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`Blocked protocol: ${parsed.protocol}`);
    }
    const host = parsed.hostname;
    if (host === "localhost" || host === "0.0.0.0") {
      throw new Error(`SSRF blocked: ${host}`);
    }
    for (const p of PRIVATE_PATTERNS) {
      if (p.test(host))
        throw new Error(`SSRF blocked: ${host} is a private/reserved address`);
    }
  }),
}));

let mockExecResult = {
  stdout: '{"url":"https://example.com","title":"Example"}',
  stderr: "",
};
vi.mock("child_process", () => ({
  execFile: Object.assign(vi.fn(), {}),
}));

vi.mock("util", async (importOriginal) => {
  const original: any = await importOriginal();
  return {
    ...original,
    promisify: vi.fn(() => async () => mockExecResult),
  };
});

vi.mock("fs/promises", () => ({
  writeFile: vi.fn(async () => {}),
  unlink: vi.fn(async () => {}),
}));

vi.mock("os", () => ({
  tmpdir: vi.fn(() => "/tmp"),
}));

let testCounter = 0;
function uniqueAgent() {
  return `agent-${++testCounter}-${Date.now()}`;
}

beforeEach(() => {
  mockTrigger.mockClear();
  mockTriggerVoid.mockClear();
  stateStore.clear();
  mockExecResult = {
    stdout: '{"url":"https://example.com","title":"Example"}',
    stderr: "",
  };
});

beforeAll(async () => {
  await import("../browser.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

async function createAndReturn(agentId: string) {
  return call("browser::create_session", {
    body: { agentId },
    headers: { authorization: "Bearer test-key" },
  });
}

async function closeSession(agentId: string) {
  try {
    await call("tool::browser_close", {
      body: { agentId },
      headers: { authorization: "Bearer test-key" },
    });
  } catch {}
}

describe("browser::create_session", () => {
  it("creates a new browser session", async () => {
    const id = uniqueAgent();
    const result = await createAndReturn(id);
    expect(result.sessionId).toBeDefined();
    expect(result.agentId).toBe(id);
    await closeSession(id);
  });

  it("defaults to headless true", async () => {
    const id = uniqueAgent();
    const result = await createAndReturn(id);
    expect(result.headless).toBe(true);
    await closeSession(id);
  });

  it("allows headless false", async () => {
    const id = uniqueAgent();
    const result = await call("browser::create_session", {
      body: { agentId: id, headless: false },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.headless).toBe(false);
    await closeSession(id);
  });

  it("uses default viewport", async () => {
    const id = uniqueAgent();
    const result = await createAndReturn(id);
    expect(result.viewport.width).toBe(1280);
    expect(result.viewport.height).toBe(720);
    await closeSession(id);
  });

  it("accepts custom viewport", async () => {
    const id = uniqueAgent();
    const result = await call("browser::create_session", {
      body: { agentId: id, viewport: { width: 800, height: 600 } },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.viewport.width).toBe(800);
    expect(result.viewport.height).toBe(600);
    await closeSession(id);
  });

  it("rejects duplicate agent session", async () => {
    const id = uniqueAgent();
    await createAndReturn(id);
    await expect(createAndReturn(id)).rejects.toThrow("Session already exists");
    await closeSession(id);
  });

  it("audits session creation", async () => {
    const id = uniqueAgent();
    await createAndReturn(id);
    const auditCalls = mockTriggerVoid.mock.calls.filter(
      (c) => c[0] === "security::audit",
    );
    expect(
      auditCalls.some((c) => c[1].type === "browser_session_created"),
    ).toBe(true);
    await closeSession(id);
  });
});

describe("browser::list_sessions", () => {
  it("returns list of sessions", async () => {
    const result = await call("browser::list_sessions", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.sessions).toBeDefined();
    expect(result.count).toBeDefined();
  });
});

describe("tool::browser_navigate", () => {
  it("rejects SSRF to localhost", async () => {
    await expect(
      call("tool::browser_navigate", {
        body: { agentId: "agent1", url: "http://localhost:8080" },
        headers: { authorization: "Bearer test-key" },
      }),
    ).rejects.toThrow(/SSRF blocked/);
  });

  it("rejects SSRF to 127.0.0.1", async () => {
    await expect(
      call("tool::browser_navigate", {
        body: { agentId: "agent1", url: "http://127.0.0.1" },
        headers: { authorization: "Bearer test-key" },
      }),
    ).rejects.toThrow(/SSRF blocked/);
  });

  it("rejects SSRF to 169.254.169.254", async () => {
    await expect(
      call("tool::browser_navigate", {
        body: { agentId: "agent1", url: "http://169.254.169.254" },
        headers: { authorization: "Bearer test-key" },
      }),
    ).rejects.toThrow(/SSRF blocked/);
  });

  it("rejects SSRF to 10.0.0.1", async () => {
    await expect(
      call("tool::browser_navigate", {
        body: { agentId: "agent1", url: "http://10.0.0.1" },
        headers: { authorization: "Bearer test-key" },
      }),
    ).rejects.toThrow(/SSRF blocked/);
  });

  it("rejects SSRF to 192.168.x.x", async () => {
    await expect(
      call("tool::browser_navigate", {
        body: { agentId: "agent1", url: "http://192.168.1.1" },
        headers: { authorization: "Bearer test-key" },
      }),
    ).rejects.toThrow(/SSRF blocked/);
  });

  it("rejects non-HTTP protocols", async () => {
    await expect(
      call("tool::browser_navigate", {
        body: { agentId: "agent1", url: "ftp://example.com" },
        headers: { authorization: "Bearer test-key" },
      }),
    ).rejects.toThrow(/Blocked protocol/);
  });

  it("rejects file:// protocol", async () => {
    await expect(
      call("tool::browser_navigate", {
        body: { agentId: "agent1", url: "file:///etc/passwd" },
        headers: { authorization: "Bearer test-key" },
      }),
    ).rejects.toThrow(/Blocked protocol/);
  });

  it("throws when no session exists", async () => {
    await expect(
      call("tool::browser_navigate", {
        body: { agentId: "nonexistent-nav", url: "https://example.com" },
        headers: { authorization: "Bearer test-key" },
      }),
    ).rejects.toThrow("No browser session");
  });

  it("navigates to valid URL", async () => {
    const id = uniqueAgent();
    await createAndReturn(id);
    const result = await call("tool::browser_navigate", {
      body: { agentId: id, url: "https://example.com" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.url).toBeDefined();
    expect(result.title).toBeDefined();
    await closeSession(id);
  });
});

describe("tool::browser_click", () => {
  it("clicks selector on page", async () => {
    const id = uniqueAgent();
    await createAndReturn(id);
    mockExecResult = {
      stdout: '{"clicked":"#btn","url":"https://example.com"}',
      stderr: "",
    };
    const result = await call("tool::browser_click", {
      body: { agentId: id, selector: "#btn" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.clicked).toBe("#btn");
    await closeSession(id);
  });

  it("throws when no session exists", async () => {
    await expect(
      call("tool::browser_click", {
        body: { agentId: "no-session-click", selector: "#btn" },
        headers: { authorization: "Bearer test-key" },
      }),
    ).rejects.toThrow("No browser session");
  });
});

describe("tool::browser_type", () => {
  it("types text into selector", async () => {
    const id = uniqueAgent();
    await createAndReturn(id);
    mockExecResult = {
      stdout: '{"typed":true,"selector":"#input"}',
      stderr: "",
    };
    const result = await call("tool::browser_type", {
      body: { agentId: id, selector: "#input", text: "hello world" },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.typed).toBe(true);
    expect(result.length).toBe(11);
    await closeSession(id);
  });
});

describe("tool::browser_screenshot", () => {
  it("takes screenshot", async () => {
    const id = uniqueAgent();
    await createAndReturn(id);
    mockExecResult = { stdout: '{"path":"/tmp/screenshot.png"}', stderr: "" };
    const result = await call("tool::browser_screenshot", {
      body: { agentId: id },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.path).toBeDefined();
    expect(result.url).toBeDefined();
    await closeSession(id);
  });
});

describe("tool::browser_read_page", () => {
  it("reads page text", async () => {
    const id = uniqueAgent();
    await createAndReturn(id);
    mockExecResult = {
      stdout:
        '{"text":"Page content","url":"https://example.com","title":"Example"}',
      stderr: "",
    };
    const result = await call("tool::browser_read_page", {
      body: { agentId: id },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.text).toBe("Page content");
    expect(result.url).toBeDefined();
    expect(result.title).toBeDefined();
    await closeSession(id);
  });
});

describe("tool::browser_close", () => {
  it("closes session", async () => {
    const id = uniqueAgent();
    await createAndReturn(id);
    const result = await call("tool::browser_close", {
      body: { agentId: id },
      headers: { authorization: "Bearer test-key" },
    });
    expect(result.closed).toBe(true);
  });

  it("throws when no session exists", async () => {
    await expect(
      call("tool::browser_close", {
        body: { agentId: "nonexistent-close-unique" },
        headers: { authorization: "Bearer test-key" },
      }),
    ).rejects.toThrow("No browser session");
  });

  it("audits session close", async () => {
    const id = uniqueAgent();
    await createAndReturn(id);
    mockTriggerVoid.mockClear();
    await call("tool::browser_close", {
      body: { agentId: id },
      headers: { authorization: "Bearer test-key" },
    });
    const auditCalls = mockTriggerVoid.mock.calls.filter(
      (c) => c[0] === "security::audit",
    );
    expect(auditCalls.some((c) => c[1].type === "browser_session_closed")).toBe(
      true,
    );
  });
});
