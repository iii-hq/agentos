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
  return null;
});

const mockTriggerVoid = vi.fn();
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

describe("skill::list", () => {
  it("returns bundled skills", async () => {
    const result = await call("skill::list", authReq({}));
    expect(result.length).toBeGreaterThan(30);
    expect(result.some((s: any) => s.source === "bundled")).toBe(true);
  });

  it("filters by category", async () => {
    const result = await call("skill::list", authReq({ category: "cloud" }));
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((s: any) => s.category === "cloud")).toBe(true);
  });

  it("filters by tag", async () => {
    const result = await call("skill::list", authReq({ tag: "kubernetes" }));
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((s: any) => s.tags.includes("kubernetes"))).toBe(true);
  });

  it("includes installed skills alongside bundled", async () => {
    seedKv("skills", "custom-1", {
      id: "custom-1",
      name: "Custom Skill",
      description: "Custom",
      content: "",
      category: "custom",
      tags: [],
      version: "1.0.0",
      source: "installed",
    });
    const result = await call("skill::list", authReq({}));
    const custom = result.find((s: any) => s.id === "custom-1");
    expect(custom).toBeDefined();
    expect(custom.source).toBe("installed");
  });

  it("returns empty when filtering by nonexistent category", async () => {
    const result = await call(
      "skill::list",
      authReq({ category: "nonexistent" }),
    );
    expect(result).toHaveLength(0);
  });
});

describe("skill::install", () => {
  it("installs a custom skill", async () => {
    const result = await call(
      "skill::install",
      authReq({
        name: "My Skill",
        description: "Test skill",
        content: "skill content here",
        category: "custom",
        tags: ["test"],
      }),
    );
    expect(result.installed).toBe(true);
    expect(result.id).toBe("my-skill");
  });

  it("generates ID from name", async () => {
    const result = await call(
      "skill::install",
      authReq({
        name: "API Testing Expert",
      }),
    );
    expect(result.id).toBe("api-testing-expert");
  });

  it("uses provided ID over generated one", async () => {
    const result = await call(
      "skill::install",
      authReq({
        id: "explicit-id",
        name: "Some Name",
      }),
    );
    expect(result.id).toBe("explicit-id");
  });

  it("sets source to 'installed'", async () => {
    await call("skill::install", authReq({ name: "Installed Skill" }));
    const stored = getScope("skills").get("installed-skill") as any;
    expect(stored.source).toBe("installed");
    expect(stored.installedAt).toBeDefined();
  });

  it("defaults category to 'custom'", async () => {
    await call("skill::install", authReq({ name: "No Category" }));
    const stored = getScope("skills").get("no-category") as any;
    expect(stored.category).toBe("custom");
  });
});

describe("skill::uninstall", () => {
  it("removes an installed skill", async () => {
    seedKv("skills", "removable", {
      id: "removable",
      source: "installed",
    });
    const result = await call("skill::uninstall", authReq({ id: "removable" }));
    expect(result.uninstalled).toBe(true);
  });

  it("prevents uninstalling bundled skills", async () => {
    await expect(
      call("skill::uninstall", authReq({ id: "aws" })),
    ).rejects.toThrow("Cannot uninstall bundled skill");
  });

  it("prevents uninstalling 'kubernetes' bundled skill", async () => {
    await expect(
      call("skill::uninstall", authReq({ id: "kubernetes" })),
    ).rejects.toThrow("Cannot uninstall bundled skill");
  });
});

describe("skill::search", () => {
  it("searches by name", async () => {
    const result = await call("skill::search", authReq({ query: "Docker" }));
    expect(result.length).toBeGreaterThan(0);
    expect(result.some((s: any) => s.id === "docker")).toBe(true);
  });

  it("searches by description", async () => {
    const result = await call(
      "skill::search",
      authReq({ query: "containers" }),
    );
    expect(result.length).toBeGreaterThan(0);
  });

  it("searches by tags", async () => {
    const result = await call(
      "skill::search",
      authReq({ query: "kubernetes" }),
    );
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes installed skills in search", async () => {
    seedKv("skills", "custom-search", {
      id: "custom-search",
      name: "Search Test",
      description: "searchable content",
      tags: ["findme"],
    });
    const result = await call("skill::search", authReq({ query: "findme" }));
    expect(result.some((s: any) => s.id === "custom-search")).toBe(true);
  });

  it("returns empty for no match", async () => {
    const result = await call(
      "skill::search",
      authReq({ query: "zzz_no_match_xyz" }),
    );
    expect(result).toHaveLength(0);
  });
});

describe("skill::parse - SKILL.md parsing", () => {
  it("parses valid SKILL.md with frontmatter", async () => {
    const content = `---
name: test-skill
description: A test skill
version: 2.0.0
tags: [testing, unit]
---
This is the skill content.`;
    const result = await call("skill::parse", { content });
    expect(result.name).toBe("test-skill");
    expect(result.description).toBe("A test skill");
    expect(result.version).toBe("2.0.0");
    expect(result.tags).toEqual(["testing", "unit"]);
    expect(result.content).toBe("This is the skill content.");
  });

  it("handles content without frontmatter", async () => {
    const result = await call("skill::parse", {
      content: "Just plain content",
    });
    expect(result.name).toBe("unknown");
    expect(result.content).toBe("Just plain content");
  });

  it("handles empty tags", async () => {
    const content = `---
name: minimal
---
Content here.`;
    const result = await call("skill::parse", { content });
    expect(result.name).toBe("minimal");
    expect(result.tags).toEqual([]);
  });
});
