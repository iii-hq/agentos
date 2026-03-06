export type Division =
  | "engineering"
  | "quality"
  | "research"
  | "operations"
  | "communication"
  | "support"
  | "personal"
  | "design"
  | "marketing";

export interface AgentPersona {
  division?: Division;
  communicationStyle?: string;
  criticalRules?: string[];
  workflow?: {
    phases: string[];
  };
  successMetrics?: {
    metrics: string[];
  };
  learning?: {
    patterns: string[];
  };
}

export interface AgentConfig {
  id?: string;
  name: string;
  description?: string;
  model?: {
    provider?: string;
    model?: string;
    maxTokens?: number;
  };
  systemPrompt?: string;
  toolProfile?: string;
  capabilities?: {
    tools: string[];
    memoryScopes?: string[];
    networkHosts?: string[];
  };
  resources?: {
    maxTokensPerHour?: number;
    dailyBudget?: number;
    monthlyBudget?: number;
  };
  persona?: AgentPersona;
  codeAgentMode?: boolean;
  approvalOverrides?: Record<string, "auto" | "async" | "sync">;
  tags?: string[];
  createdAt?: number;
}

export interface ChatRequest {
  agentId: string;
  message: string;
  sessionId?: string;
  systemPrompt?: string;
}

export interface ChatResponse {
  content: string;
  model?: string;
  usage?: TokenUsage;
  iterations: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface CostRecord {
  agentId: string;
  sessionId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  timestamp: number;
}

export interface CostSummary {
  total: number;
  breakdown: Array<{ key: string; cost: number; tokens: number }>;
  period: { start: string; end: string };
}

export interface BudgetStatus {
  withinBudget: boolean;
  spent: number;
  limit: number;
  remaining: number;
  projectedMonthly: number;
}

export interface ContextHealthScore {
  overall: number;
  tokenUtilization: number;
  relevanceDecay: number;
  repetitionPenalty: number;
  toolDensity: number;
}

export interface ToolCall {
  callId: string;
  id: string;
  arguments: Record<string, unknown>;
}
