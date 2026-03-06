import { describe, it, expect } from "vitest";
import type {
  AgentConfig,
  AgentPersona,
  ChatRequest,
  ChatResponse,
  Division,
  TokenUsage,
  ToolCall,
} from "../types.js";

describe("AgentConfig type", () => {
  it("accepts minimal config with only name", () => {
    const config: AgentConfig = { name: "Test Agent" };
    expect(config.name).toBe("Test Agent");
    expect(config.id).toBeUndefined();
    expect(config.description).toBeUndefined();
  });

  it("accepts full config with all fields", () => {
    const config: AgentConfig = {
      id: "agent-1",
      name: "Full Agent",
      description: "An agent with all fields",
      model: { provider: "anthropic", model: "claude-opus-4-6", maxTokens: 8192 },
      systemPrompt: "Be helpful",
      toolProfile: "default",
      capabilities: {
        tools: ["*"],
        memoryScopes: ["self"],
        networkHosts: ["example.com"],
      },
      resources: { maxTokensPerHour: 100000 },
      tags: ["test", "full"],
      createdAt: Date.now(),
    };
    expect(config.id).toBe("agent-1");
    expect(config.model?.provider).toBe("anthropic");
    expect(config.capabilities?.tools).toContain("*");
    expect(config.resources?.maxTokensPerHour).toBe(100000);
  });

  it("allows model without all sub-fields", () => {
    const config: AgentConfig = {
      name: "Partial Model",
      model: { provider: "openai" },
    };
    expect(config.model?.model).toBeUndefined();
    expect(config.model?.maxTokens).toBeUndefined();
  });

  it("allows capabilities without optional scopes", () => {
    const config: AgentConfig = {
      name: "Minimal Caps",
      capabilities: { tools: ["file::read"] },
    };
    expect(config.capabilities?.memoryScopes).toBeUndefined();
    expect(config.capabilities?.networkHosts).toBeUndefined();
  });

  it("allows empty tags array", () => {
    const config: AgentConfig = { name: "No Tags", tags: [] };
    expect(config.tags).toHaveLength(0);
  });
});

describe("ChatRequest type", () => {
  it("requires agentId and message", () => {
    const req: ChatRequest = {
      agentId: "agent-1",
      message: "Hello",
    };
    expect(req.agentId).toBe("agent-1");
    expect(req.message).toBe("Hello");
  });

  it("accepts optional sessionId", () => {
    const req: ChatRequest = {
      agentId: "agent-1",
      message: "Hi",
      sessionId: "session-abc",
    };
    expect(req.sessionId).toBe("session-abc");
  });

  it("accepts optional systemPrompt", () => {
    const req: ChatRequest = {
      agentId: "agent-1",
      message: "Test",
      systemPrompt: "Be concise",
    };
    expect(req.systemPrompt).toBe("Be concise");
  });
});

describe("ChatResponse type", () => {
  it("includes content and iterations", () => {
    const res: ChatResponse = {
      content: "Response text",
      iterations: 3,
    };
    expect(res.content).toBe("Response text");
    expect(res.iterations).toBe(3);
  });

  it("includes optional model and usage", () => {
    const res: ChatResponse = {
      content: "Full response",
      model: "claude-opus-4-6",
      usage: { input: 100, output: 50, total: 150 },
      iterations: 1,
    };
    expect(res.model).toBe("claude-opus-4-6");
    expect(res.usage?.total).toBe(150);
  });
});

describe("TokenUsage type", () => {
  it("tracks input, output, and total", () => {
    const usage: TokenUsage = { input: 200, output: 100, total: 300 };
    expect(usage.input + usage.output).toBe(usage.total);
  });

  it("handles zero usage", () => {
    const usage: TokenUsage = { input: 0, output: 0, total: 0 };
    expect(usage.total).toBe(0);
  });
});

describe("ToolCall type", () => {
  it("has callId, id, and arguments", () => {
    const tc: ToolCall = {
      callId: "call-1",
      id: "memory::store",
      arguments: { content: "data", agentId: "a1" },
    };
    expect(tc.callId).toBe("call-1");
    expect(tc.id).toBe("memory::store");
    expect(tc.arguments.content).toBe("data");
  });

  it("handles empty arguments", () => {
    const tc: ToolCall = {
      callId: "call-2",
      id: "agent::list",
      arguments: {},
    };
    expect(Object.keys(tc.arguments)).toHaveLength(0);
  });

  it("handles nested arguments", () => {
    const tc: ToolCall = {
      callId: "call-3",
      id: "tool::complex",
      arguments: {
        config: { nested: true, depth: 2 },
        items: [1, 2, 3],
      },
    };
    expect((tc.arguments.config as any).nested).toBe(true);
  });

  it("extracts capability namespace from id", () => {
    const tc: ToolCall = {
      callId: "call-4",
      id: "security::check_capability",
      arguments: {},
    };
    const namespace = tc.id.split("::")[0];
    expect(namespace).toBe("security");
  });

  it("handles id without namespace separator", () => {
    const tc: ToolCall = {
      callId: "call-5",
      id: "simple_tool",
      arguments: {},
    };
    const namespace = tc.id.split("::")[0];
    expect(namespace).toBe("simple_tool");
  });
});

describe("Division type", () => {
  it("accepts all valid division values", () => {
    const divisions: Division[] = [
      "engineering",
      "quality",
      "research",
      "operations",
      "communication",
      "support",
      "personal",
      "design",
      "marketing",
    ];
    expect(divisions).toHaveLength(9);
  });
});

describe("AgentPersona type", () => {
  it("accepts empty persona", () => {
    const persona: AgentPersona = {};
    expect(persona.division).toBeUndefined();
    expect(persona.communicationStyle).toBeUndefined();
  });

  it("accepts persona with only division", () => {
    const persona: AgentPersona = { division: "engineering" };
    expect(persona.division).toBe("engineering");
  });

  it("accepts full persona with all fields", () => {
    const persona: AgentPersona = {
      division: "quality",
      communicationStyle: "Constructive and specific",
      criticalRules: ["Never approve insecure code", "Provide alternatives"],
      workflow: {
        phases: ["Scan", "Analyze", "Comment", "Verify", "Approve"],
      },
      successMetrics: {
        metrics: ["Bugs caught >90%", "Review turnaround <4h"],
      },
      learning: {
        patterns: ["Common bug patterns", "Effective review phrasing"],
      },
    };
    expect(persona.division).toBe("quality");
    expect(persona.criticalRules).toHaveLength(2);
    expect(persona.workflow?.phases).toHaveLength(5);
    expect(persona.successMetrics?.metrics).toHaveLength(2);
    expect(persona.learning?.patterns).toHaveLength(2);
  });
});

describe("AgentConfig with persona", () => {
  it("accepts config without persona (backward compat)", () => {
    const config: AgentConfig = { name: "Legacy Agent" };
    expect(config.persona).toBeUndefined();
  });

  it("accepts config with persona", () => {
    const config: AgentConfig = {
      name: "Enriched Agent",
      persona: {
        division: "engineering",
        communicationStyle: "Direct and technical",
        criticalRules: ["Always write tests"],
        workflow: { phases: ["Analyze", "Implement", "Test"] },
        successMetrics: { metrics: ["Coverage >80%"] },
        learning: { patterns: ["Refactoring approaches"] },
      },
      tags: ["coding"],
    };
    expect(config.persona?.division).toBe("engineering");
    expect(config.persona?.workflow?.phases).toContain("Implement");
    expect(config.persona?.successMetrics?.metrics).toHaveLength(1);
  });

  it("filters agents by division", () => {
    const agents: AgentConfig[] = [
      { name: "coder", persona: { division: "engineering" } },
      { name: "reviewer", persona: { division: "quality" } },
      { name: "architect", persona: { division: "engineering" } },
      { name: "assistant", persona: { division: "personal" } },
      { name: "legacy" },
    ];

    const engineering = agents.filter(
      (a) => a.persona?.division === "engineering",
    );
    expect(engineering).toHaveLength(2);
    expect(engineering.map((a) => a.name)).toEqual(["coder", "architect"]);

    const withoutDivision = agents.filter((a) => !a.persona?.division);
    expect(withoutDivision).toHaveLength(1);
    expect(withoutDivision[0].name).toBe("legacy");
  });
});
