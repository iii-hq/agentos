import { init } from "iii-sdk";
import { ENGINE_URL } from "./shared/config.js";
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { assertNoSsrf, requireAuth } from "./shared/utils.js";

const execFileAsync = promisify(execFile);

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "browser" },
);

interface BrowserSession {
  id: string;
  agentId: string;
  currentUrl: string;
  headless: boolean;
  viewport: { width: number; height: number };
  createdAt: number;
  lastActivity: number;
  scriptPath: string;
}

const MAX_SESSIONS = 5;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30_000;

async function getSessionIndex(): Promise<string[]> {
  return (
    (await trigger("state::get", {
      scope: "browser_sessions",
      key: "_index",
    })) || []
  );
}

async function setSessionIndex(index: string[]): Promise<void> {
  await triggerVoid("state::set", {
    scope: "browser_sessions",
    key: "_index",
    value: index,
  });
}

async function getSession(agentId: string): Promise<BrowserSession> {
  const session: BrowserSession | null = await trigger("state::get", {
    scope: "browser_sessions",
    key: agentId,
  });
  if (!session) throw new Error(`No browser session for agent: ${agentId}`);
  return session;
}

async function touchSession(agentId: string, session: BrowserSession) {
  session.lastActivity = Date.now();
  await triggerVoid("state::set", {
    scope: "browser_sessions",
    key: agentId,
    value: session,
  });
}

async function runBrowserScript(
  session: BrowserSession,
  action: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const payload = JSON.stringify({
    action,
    sessionId: session.id,
    headless: session.headless,
    viewport: session.viewport,
    timeout: DEFAULT_TIMEOUT_MS,
    ...params,
  });

  const { stdout, stderr } = await execFileAsync(
    "python3",
    [session.scriptPath, payload],
    { timeout: DEFAULT_TIMEOUT_MS + 5000, maxBuffer: 5 * 1024 * 1024 },
  );

  if (stderr && !stdout)
    throw new Error(`Browser error: ${stderr.slice(0, 1000)}`);

  try {
    return JSON.parse(stdout);
  } catch {
    return { output: stdout.slice(0, 100_000) };
  }
}

async function cleanupIdleSessions() {
  const now = Date.now();
  const index = await getSessionIndex();
  const remaining: string[] = [];
  for (const agentId of index) {
    const session: BrowserSession | null = await trigger("state::get", {
      scope: "browser_sessions",
      key: agentId,
    });
    if (!session || now - session.lastActivity > IDLE_TIMEOUT_MS) {
      if (session) {
        unlink(session.scriptPath).catch(() => {});
        triggerVoid("security::audit", {
          type: "browser_idle_cleanup",
          detail: { agentId, sessionId: session.id },
        });
      }
      await triggerVoid("state::set", {
        scope: "browser_sessions",
        key: agentId,
        value: null,
      });
    } else {
      remaining.push(agentId);
    }
  }
  await setSessionIndex(remaining);
}

setInterval(() => {
  cleanupIdleSessions().catch(() => {});
}, 60_000);

const BRIDGE_SCRIPT = `
import sys, json
from playwright.sync_api import sync_playwright

def main():
    params = json.loads(sys.argv[1])
    action = params.get("action")
    headless = params.get("headless", True)
    vw = params.get("viewport", {}).get("width", 1280)
    vh = params.get("viewport", {}).get("height", 720)
    timeout = params.get("timeout", 30000)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        page = browser.new_page(viewport={"width": vw, "height": vh})
        page.set_default_timeout(timeout)

        result = {}

        if action == "navigate":
            page.goto(params["url"], wait_until="domcontentloaded")
            result = {"url": page.url, "title": page.title()}

        elif action == "click":
            page.goto(params.get("currentUrl", "about:blank"), wait_until="domcontentloaded")
            page.click(params["selector"])
            result = {"clicked": params["selector"], "url": page.url}

        elif action == "type":
            page.goto(params.get("currentUrl", "about:blank"), wait_until="domcontentloaded")
            page.fill(params["selector"], params["text"])
            result = {"typed": True, "selector": params["selector"]}

        elif action == "screenshot":
            page.goto(params.get("currentUrl", "about:blank"), wait_until="domcontentloaded")
            path = params.get("savePath", "/tmp/screenshot.png")
            page.screenshot(path=path, full_page=params.get("fullPage", False))
            result = {"path": path}

        elif action == "read":
            page.goto(params.get("currentUrl", "about:blank"), wait_until="domcontentloaded")
            text = page.inner_text("body")
            result = {"text": text[:100000], "url": page.url, "title": page.title()}

        elif action == "close":
            result = {"closed": True}

        browser.close()
        print(json.dumps(result))

if __name__ == "__main__":
    main()
`;

registerFunction(
  {
    id: "browser::create_session",
    description: "Create a new browser session",
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { agentId, headless, viewport } = req.body || req;
    const existing: BrowserSession | null = await trigger("state::get", {
      scope: "browser_sessions",
      key: agentId,
    });
    if (existing)
      throw new Error(`Session already exists for agent: ${agentId}`);
    const index = await getSessionIndex();
    if (index.length >= MAX_SESSIONS)
      throw new Error(`Max sessions (${MAX_SESSIONS}) reached`);

    const sessionId = crypto.randomUUID();
    const scriptPath = join(tmpdir(), `browser-bridge-${sessionId}.py`);

    await writeFile(scriptPath, BRIDGE_SCRIPT, "utf-8");

    const session: BrowserSession = {
      id: sessionId,
      agentId,
      currentUrl: "about:blank",
      headless: headless !== false,
      viewport: viewport || { width: 1280, height: 720 },
      createdAt: Date.now(),
      lastActivity: Date.now(),
      scriptPath,
    };

    await triggerVoid("state::set", {
      scope: "browser_sessions",
      key: agentId,
      value: session,
    });
    await setSessionIndex([...index, agentId]);

    triggerVoid("security::audit", {
      type: "browser_session_created",
      detail: { agentId, sessionId, headless: session.headless },
    });

    return {
      sessionId,
      agentId,
      headless: session.headless,
      viewport: session.viewport,
    };
  },
);

registerFunction(
  { id: "browser::list_sessions", description: "List active browser sessions" },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const index = await getSessionIndex();
    const list = [];
    for (const agentId of index) {
      const s: BrowserSession | null = await trigger("state::get", {
        scope: "browser_sessions",
        key: agentId,
      });
      if (s) {
        list.push({
          id: s.id,
          agentId: s.agentId,
          currentUrl: s.currentUrl,
          headless: s.headless,
          createdAt: s.createdAt,
          lastActivity: s.lastActivity,
          idleMs: Date.now() - s.lastActivity,
        });
      }
    }

    return { sessions: list, count: list.length };
  },
);

registerFunction(
  {
    id: "tool::browser_navigate",
    description: "Navigate to URL with SSRF check",
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { agentId, url } = req.body || req;
    await assertNoSsrf(url);
    const session = await getSession(agentId);
    await touchSession(agentId, session);

    const result = (await runBrowserScript(session, "navigate", {
      url,
    })) as any;
    session.currentUrl = result.url || url;
    await triggerVoid("state::set", {
      scope: "browser_sessions",
      key: agentId,
      value: session,
    });

    return { url: session.currentUrl, title: result.title };
  },
);

registerFunction(
  { id: "tool::browser_click", description: "Click element by selector" },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { agentId, selector } = req.body || req;
    const session = await getSession(agentId);
    await touchSession(agentId, session);
    const result = (await runBrowserScript(session, "click", {
      selector,
      currentUrl: session.currentUrl,
    })) as any;

    if (result.url) {
      session.currentUrl = result.url;
      await triggerVoid("state::set", {
        scope: "browser_sessions",
        key: agentId,
        value: session,
      });
    }

    return { clicked: selector, url: session.currentUrl };
  },
);

registerFunction(
  {
    id: "tool::browser_type",
    description: "Type text into element by selector",
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { agentId, selector, text } = req.body || req;
    const session = await getSession(agentId);
    await touchSession(agentId, session);
    await runBrowserScript(session, "type", {
      selector,
      text,
      currentUrl: session.currentUrl,
    });

    return { typed: true, selector, length: text.length };
  },
);

registerFunction(
  {
    id: "tool::browser_screenshot",
    description: "Take screenshot and save to temp file",
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { agentId, fullPage } = req.body || req;
    const session = await getSession(agentId);
    await touchSession(agentId, session);
    const savePath = join(
      tmpdir(),
      `screenshot-${session.id}-${Date.now()}.png`,
    );

    await runBrowserScript(session, "screenshot", {
      currentUrl: session.currentUrl,
      savePath,
      fullPage: fullPage || false,
    });

    return { path: savePath, url: session.currentUrl };
  },
);

registerFunction(
  { id: "tool::browser_read_page", description: "Extract page text content" },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { agentId } = req.body || req;
    const session = await getSession(agentId);
    await touchSession(agentId, session);
    const result = (await runBrowserScript(session, "read", {
      currentUrl: session.currentUrl,
    })) as any;

    return {
      text: (result.text || "").slice(0, 100_000),
      url: result.url || session.currentUrl,
      title: result.title || "",
    };
  },
);

registerFunction(
  { id: "tool::browser_close", description: "Close browser session" },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { agentId } = req.body || req;
    const session: BrowserSession | null = await trigger("state::get", {
      scope: "browser_sessions",
      key: agentId,
    });
    if (!session) throw new Error(`No browser session for agent: ${agentId}`);

    await triggerVoid("state::set", {
      scope: "browser_sessions",
      key: agentId,
      value: null,
    });
    const index = await getSessionIndex();
    await setSessionIndex(index.filter((id) => id !== agentId));
    await unlink(session.scriptPath).catch(() => {});

    triggerVoid("security::audit", {
      type: "browser_session_closed",
      detail: { agentId, sessionId: session.id },
    });

    return { closed: true, agentId, sessionId: session.id };
  },
);

registerTrigger({
  type: "http",
  function_id: "browser::create_session",
  config: { api_path: "api/browser/session", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "browser::list_sessions",
  config: { api_path: "api/browser/sessions", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "tool::browser_navigate",
  config: { api_path: "api/browser/navigate", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "tool::browser_screenshot",
  config: { api_path: "api/browser/screenshot", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "tool::browser_read_page",
  config: { api_path: "api/browser/read", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "tool::browser_close",
  config: { api_path: "api/browser/close", http_method: "POST" },
});
