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

export type EvolveStatus =
  | "draft"
  | "staging"
  | "shadow"
  | "canary"
  | "production"
  | "deprecated"
  | "killed";

export type EvolveCandidateClass =
  | "retrieval"
  | "planning"
  | "routing"
  | "workflow_transform"
  | "recommendation";

export type EvolveRiskLabel = "low" | "medium" | "high" | "critical";

export type EvolveRolloutHint = "staging" | "shadow" | "canary";

export interface EvalScores {
  correctness: number | null;
  latency_ms: number;
  cost_tokens: number;
  safety: number;
  overall: number;
}

export interface EvolvedFunction {
  functionId: string;
  code: string;
  description: string;
  authorAgentId: string;
  version: number;
  status: EvolveStatus;
  createdAt: number;
  updatedAt: number;
  evalScores: EvalScores | null;
  securityReport: {
    scanSafe: boolean;
    sandboxPassed: boolean;
    findingCount: number;
  };
  parentVersion?: string;
  metadata: Record<string, unknown> & {
    candidateClass?: EvolveCandidateClass;
    riskLabel?: EvolveRiskLabel;
    rolloutState?: EvolveStatus;
    rolloutHint?: EvolveRolloutHint;
    sourceObservationId?: string;
    improvedFrom?: string;
    depth?: number;
  };
}

export interface EvalResult {
  evalId: string;
  functionId: string;
  scores: EvalScores;
  scorerType: string;
  input: unknown;
  output: unknown;
  expected?: unknown;
  timestamp: number;
}

export interface EvalSuite {
  suiteId: string;
  name: string;
  functionId: string;
  metadata?: {
    candidateClass?: EvolveCandidateClass | null;
    baselineFunctionId?: string | null;
  };
  testCases: Array<{
    input: unknown;
    expected?: unknown;
    scorer?: "exact_match" | "llm_judge" | "semantic_similarity" | "custom";
    scorerFunctionId?: string;
    weight?: number;
  }>;
  createdAt: number;
}

export interface FeedbackPolicy {
  minScoreToKeep: number;
  minEvalsToPromote: number;
  maxFailuresToKill: number;
  autoReviewIntervalMs: number;
}

export interface ReviewResult {
  decisionId: string;
  functionId: string;
  decision: "keep" | "improve" | "promote" | "demote" | "kill";
  reason: string;
  reasonCode?:
    | "no_eval_data"
    | "avg_below_threshold"
    | "too_many_failures"
    | "ready_for_staging"
    | "ready_for_shadow"
    | "ready_for_canary"
    | "ready_for_production";
  avgOverall: number;
  recentFailures: number;
  evalCount: number;
  timestamp: number;
}
