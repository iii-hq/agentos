import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const kvStore: Record<string, Map<string, unknown>> = {};
function getScope(scope: string) {
  if (!kvStore[scope]) kvStore[scope] = new Map();
  return kvStore[scope];
}
function resetKv() {
  for (const key of Object.keys(kvStore)) delete kvStore[key];
}
function seedKv(scope: string, key: string, value: unknown) {
  getScope(scope).set(key, value);
}

const mockTrigger = vi.fn(async (fnId: string, data?: any): Promise<any> => {
  if (fnId === "state::get") return getScope(data.scope).get(data.key) ?? null;
  if (fnId === "state::set") {
    getScope(data.scope).set(data.key, data.value);
    return { ok: true };
  }
  if (fnId === "state::delete") {
    getScope(data.scope).delete(data.key);
    return { ok: true };
  }
  if (fnId === "state::list") {
    return [...getScope(data.scope).entries()].map(([key, value]) => ({
      key,
      value,
    }));
  }
  if (fnId === "skillkit::search") {
    return { results: [{ id: "sk-1", name: "Found Skill" }] };
  }
  return null;
});

const handlers: Record<string, Function> = {};
const mockTriggerVoid = vi.fn();
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
    shutdown: vi.fn(),
  }),
  TriggerAction: { Void: () => ({}) },
}));

vi.mock("../shared/utils.js", () => ({
  requireAuth: vi.fn(),
}));

beforeEach(() => {
  resetKv();
  mockTrigger.mockClear();
});

beforeAll(async () => {
  await import("../skills.js");
});

async function call(id: string, input: any) {
  const handler = handlers[id];
  if (!handler) throw new Error(`Handler ${id} not registered`);
  return handler(input);
}

function authReq(body: any) {
  return { headers: { authorization: "Bearer test" }, body, ...body };
}

describe("skill::list extended", () => {
  it("returns skills with all required fields", async () => {
    const result = await call("skill::list", authReq({}));
    for (const skill of result.slice(0, 5)) {
      expect(skill.id).toBeDefined();
      expect(skill.name).toBeDefined();
      expect(skill.category).toBeDefined();
      expect(skill.tags).toBeDefined();
      expect(Array.isArray(skill.tags)).toBe(true);
    }
  });

  it("filters cloud category returns multiple skills", async () => {
    const result = await call("skill::list", authReq({ category: "cloud" }));
    expect(result.length).toBeGreaterThanOrEqual(5);
    const ids = result.map((s: any) => s.id);
    expect(ids).toContain("aws");
    expect(ids).toContain("kubernetes");
    expect(ids).toContain("terraform");
  });

  it("filters devops category", async () => {
    const result = await call("skill::list", authReq({ category: "devops" }));
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.some((s: any) => s.id === "ci-cd")).toBe(true);
  });

  it("filters languages category", async () => {
    const result = await call("skill::list", authReq({ category: "languages" }));
    expect(result.length).toBeGreaterThanOrEqual(5);
    const ids = result.map((s: any) => s.id);
    expect(ids).toContain("python-expert");
    expect(ids).toContain("typescript-expert");
  });

  it("filters data category", async () => {
    const result = await call("skill::list", authReq({ category: "data" }));
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  it("filters security category", async () => {
    const result = await call("skill::list", authReq({ category: "security" }));
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.some((s: any) => s.id === "security-audit")).toBe(true);
  });

  it("filters by aws tag", async () => {
    const result = await call("skill::list", authReq({ tag: "aws" }));
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].tags).toContain("aws");
  });

  it("filters by python tag", async () => {
    const result = await call("skill::list", authReq({ tag: "python" }));
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("combines installed and bundled without duplicates", async () => {
    seedKv("skills", "unique-custom", {
      id: "unique-custom",
      name: "Unique",
      category: "custom",
      tags: [],
      source: "installed",
    });
    const result = await call("skill::list", authReq({}));
    const customCount = result.filter((s: any) => s.id === "unique-custom").length;
    expect(customCount).toBe(1);
  });
});

describe("skill::install extended", () => {
  it("generates UUID when no name or id", async () => {
    const result = await call("skill::install", authReq({}));
    expect(result.installed).toBe(true);
    expect(result.id).toBeDefined();
    expect(result.id.length).toBeGreaterThan(0);
  });

  it("preserves content in stored skill", async () => {
    await call("skill::install", authReq({
      id: "content-test",
      content: "Skill instructions here",
    }));
    const stored = getScope("skills").get("content-test") as any;
    expect(stored.content).toBe("Skill instructions here");
  });

  it("preserves tags in stored skill", async () => {
    await call("skill::install", authReq({
      id: "tags-test",
      tags: ["devops", "k8s"],
    }));
    const stored = getScope("skills").get("tags-test") as any;
    expect(stored.tags).toEqual(["devops", "k8s"]);
  });

  it("defaults empty tags array", async () => {
    await call("skill::install", authReq({ id: "no-tags" }));
    const stored = getScope("skills").get("no-tags") as any;
    expect(stored.tags).toEqual([]);
  });

  it("defaults description to empty string", async () => {
    await call("skill::install", authReq({ id: "no-desc" }));
    const stored = getScope("skills").get("no-desc") as any;
    expect(stored.description).toBe("");
  });

  it("sets version to 1.0.0", async () => {
    await call("skill::install", authReq({ id: "version-test" }));
    const stored = getScope("skills").get("version-test") as any;
    expect(stored.version).toBe("1.0.0");
  });

  it("sets installedAt timestamp", async () => {
    const before = Date.now();
    await call("skill::install", authReq({ id: "ts-test" }));
    const stored = getScope("skills").get("ts-test") as any;
    expect(stored.installedAt).toBeGreaterThanOrEqual(before);
  });
});

describe("skill::uninstall extended", () => {
  it("removes installed skill from state", async () => {
    seedKv("skills", "to-remove", { id: "to-remove", source: "installed" });
    await call("skill::uninstall", authReq({ id: "to-remove" }));
    expect(getScope("skills").has("to-remove")).toBe(false);
  });

  it("rejects uninstall of docker bundled skill", async () => {
    await expect(
      call("skill::uninstall", authReq({ id: "docker" })),
    ).rejects.toThrow("Cannot uninstall bundled skill");
  });

  it("rejects uninstall of terraform bundled skill", async () => {
    await expect(
      call("skill::uninstall", authReq({ id: "terraform" })),
    ).rejects.toThrow("Cannot uninstall bundled skill");
  });

  it("rejects uninstall of git-expert bundled skill", async () => {
    await expect(
      call("skill::uninstall", authReq({ id: "git-expert" })),
    ).rejects.toThrow("Cannot uninstall bundled skill");
  });
});

describe("skill::get", () => {
  it("returns bundled skill by id", async () => {
    const result = await call("skill::get", { id: "aws" });
    expect(result.name).toBe("AWS Expert");
    expect(result.source).toBe("bundled");
  });

  it("returns installed skill from state", async () => {
    seedKv("skills", "custom-get", {
      id: "custom-get",
      name: "Custom Get",
      source: "installed",
    });
    const result = await call("skill::get", { id: "custom-get" });
    expect(result.name).toBe("Custom Get");
  });

  it("returns kubernetes bundled skill", async () => {
    const result = await call("skill::get", { id: "kubernetes" });
    expect(result.name).toBe("Kubernetes Expert");
  });
});

describe("skill::search extended", () => {
  it("search is case-insensitive", async () => {
    const result = await call("skill::search", authReq({ query: "docker" }));
    expect(result.some((s: any) => s.id === "docker")).toBe(true);
    const result2 = await call("skill::search", authReq({ query: "DOCKER" }));
    expect(result2.some((s: any) => s.id === "docker")).toBe(true);
  });

  it("matches partial words in description", async () => {
    const result = await call("skill::search", authReq({ query: "orchestr" }));
    expect(result.length).toBeGreaterThan(0);
  });

  it("searches across installed and bundled", async () => {
    seedKv("skills", "custom-searchable", {
      id: "custom-searchable",
      name: "Custom Searchable",
      description: "unique-xyzzy",
      tags: [],
    });
    const result = await call("skill::search", authReq({ query: "unique-xyzzy" }));
    expect(result.some((s: any) => s.id === "custom-searchable")).toBe(true);
  });
});

describe("skill::parse extended", () => {
  it("handles multi-line body", async () => {
    const content = `---
name: multi-line
---
Line 1
Line 2
Line 3`;
    const result = await call("skill::parse", { content });
    expect(result.content).toBe("Line 1\nLine 2\nLine 3");
  });

  it("handles frontmatter with colons in value", async () => {
    const content = `---
name: colon-test
description: HTTP server: port 8080
---
Body.`;
    const result = await call("skill::parse", { content });
    expect(result.description).toBe("HTTP server: port 8080");
  });

  it("defaults version to 1.0.0", async () => {
    const content = `---
name: no-version
---
Content.`;
    const result = await call("skill::parse", { content });
    expect(result.version).toBe("1.0.0");
  });

  it("parses comma-separated tags", async () => {
    const content = `---
name: tagged
tags: [a, b, c]
---
Body.`;
    const result = await call("skill::parse", { content });
    expect(result.tags).toEqual(["a", "b", "c"]);
  });
});

describe("skill::marketplace_search", () => {
  it("registers the handler", () => {
    expect(handlers["skill::marketplace_search"]).toBeDefined();
  });

  it("rejects queries shorter than 2 chars", async () => {
    await expect(
      call("skill::marketplace_search", authReq({ query: "a" })),
    ).rejects.toThrow("at least 2 characters");
  });

  it("returns results from skillkit", async () => {
    const result = await call("skill::marketplace_search", authReq({
      query: "kubernetes",
      limit: 5,
    }));
    expect(result.results).toBeDefined();
  });

  it("defaults limit to 10", async () => {
    await call("skill::marketplace_search", authReq({ query: "test" }));
    const skCalls = mockTrigger.mock.calls.filter(
      (c) => c[0] === "skillkit::search",
    );
    expect(skCalls[0][1].limit).toBe(10);
  });

  it("handles skillkit unavailability gracefully", async () => {
    mockTrigger.mockImplementationOnce(async (fnId: string) => {
      if (fnId === "skillkit::search") throw new Error("Connection refused");
      return null;
    });
    const result = await call("skill::marketplace_search", authReq({
      query: "test-unavail",
    }));
    expect(result.error).toContain("SkillKit unavailable");
  });
});
