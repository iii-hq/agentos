import { init } from "iii-sdk";
import { ENGINE_URL } from "./shared/config.js";
import { PRICING } from "./shared/pricing.js";
import type { CostRecord, CostSummary, BudgetStatus } from "./types.js";

const { registerFunction, registerTrigger, trigger, triggerVoid } = init(
  ENGINE_URL,
  { workerName: "cost-tracker" },
);

registerFunction(
  {
    id: "cost::track",
    description: "Calculate and store cost for an LLM call",
    metadata: { category: "cost" },
  },
  async (input: {
    agentId: string;
    sessionId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }): Promise<CostRecord> => {
    const pricing = PRICING[input.model];
    const inputPrice = pricing?.input ?? 0;
    const outputPrice = pricing?.output ?? 0;
    const cacheReadPrice = pricing?.cacheRead ?? inputPrice * 0.1;
    const cacheWritePrice = pricing?.cacheWrite ?? inputPrice * 1.25;

    const cacheRead = input.cacheReadTokens ?? 0;
    const cacheWrite = input.cacheWriteTokens ?? 0;

    const cost =
      (input.inputTokens * inputPrice +
        input.outputTokens * outputPrice +
        cacheRead * cacheReadPrice +
        cacheWrite * cacheWritePrice) /
      1_000_000;

    const now = Date.now();
    const date = new Date(now).toISOString().slice(0, 10);
    const key = `${date}:${input.agentId}:${input.sessionId}:${now}`;

    const record: CostRecord = {
      agentId: input.agentId,
      sessionId: input.sessionId,
      model: input.model,
      provider: pricing ? "known" : "unknown",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      cost,
      timestamp: now,
    };

    await trigger("state::set", {
      scope: "cost_records",
      key,
      value: record,
    });

    triggerVoid("state::update", {
      scope: "cost_daily",
      key: `${date}:${input.agentId}`,
      operations: [
        { type: "increment", path: "cost", value: cost },
        { type: "increment", path: "inputTokens", value: input.inputTokens },
        { type: "increment", path: "outputTokens", value: input.outputTokens },
        { type: "increment", path: "calls", value: 1 },
      ],
    });

    triggerVoid("state::update", {
      scope: "cost_daily",
      key: date,
      operations: [
        { type: "increment", path: "totalCost", value: cost },
        { type: "increment", path: "totalCalls", value: 1 },
      ],
    });

    return record;
  },
);

registerFunction(
  {
    id: "cost::summary",
    description: "Aggregate cost data with grouping",
    metadata: { category: "cost" },
  },
  async (input: {
    agentId?: string;
    startDate?: string;
    endDate?: string;
    groupBy?: "day" | "agent" | "model";
  }): Promise<CostSummary> => {
    const now = new Date();
    const start = input.startDate || now.toISOString().slice(0, 10);
    const end = input.endDate || now.toISOString().slice(0, 10);
    const groupBy = input.groupBy || "day";

    const records: CostRecord[] = [];
    const startDate = new Date(start);
    const endDate = new Date(end);

    for (
      let d = new Date(startDate);
      d <= endDate;
      d = new Date(d.getTime() + 86_400_000)
    ) {
      const dateStr = d.toISOString().slice(0, 10);
      const prefix = input.agentId ? `${dateStr}:${input.agentId}` : dateStr;
      const dayRecords: any = await trigger("state::list", {
        scope: "cost_records",
        prefix,
      }).catch(() => []);

      if (Array.isArray(dayRecords)) {
        for (const r of dayRecords) {
          if (r.value) records.push(r.value);
          else if (r.cost !== undefined) records.push(r);
        }
      }
    }

    const grouped = new Map<string, { cost: number; tokens: number }>();
    let total = 0;

    for (const r of records) {
      let key: string;
      if (groupBy === "day")
        key = new Date(r.timestamp).toISOString().slice(0, 10);
      else if (groupBy === "agent") key = r.agentId;
      else key = r.model;

      const entry = grouped.get(key) || { cost: 0, tokens: 0 };
      entry.cost += r.cost;
      entry.tokens += r.inputTokens + r.outputTokens;
      grouped.set(key, entry);
      total += r.cost;
    }

    const breakdown = [...grouped.entries()].map(([key, val]) => ({
      key,
      cost: Math.round(val.cost * 1_000_000) / 1_000_000,
      tokens: val.tokens,
    }));

    return {
      total: Math.round(total * 1_000_000) / 1_000_000,
      breakdown,
      period: { start, end },
    };
  },
);

registerFunction(
  {
    id: "cost::budget_check",
    description: "Check agent spend against budget limits",
    metadata: { category: "cost" },
  },
  async ({ agentId }: { agentId: string }): Promise<BudgetStatus> => {
    const config: any = await trigger("state::get", {
      scope: "agents",
      key: agentId,
    }).catch(() => null);

    const dailyBudget = config?.resources?.dailyBudget ?? Infinity;
    const monthlyBudget = config?.resources?.monthlyBudget ?? Infinity;

    const today = new Date().toISOString().slice(0, 10);
    const dailyData: any = await trigger("state::get", {
      scope: "cost_daily",
      key: `${today}:${agentId}`,
    }).catch(() => null);

    const dailySpent = dailyData?.cost ?? 0;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    let monthlySpent = 0;

    for (let d = new Date(monthStart); d <= now; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      const dayData: any = await trigger("state::get", {
        scope: "cost_daily",
        key: `${dateStr}:${agentId}`,
      }).catch(() => null);
      monthlySpent += dayData?.cost ?? 0;
    }

    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      0,
    ).getDate();
    const projectedMonthly =
      dayOfMonth > 0 ? (monthlySpent / dayOfMonth) * daysInMonth : 0;

    const limit = Math.min(dailyBudget, monthlyBudget);
    const spent = dailyBudget <= monthlyBudget ? dailySpent : monthlySpent;
    const withinBudget =
      dailySpent <= dailyBudget && monthlySpent <= monthlyBudget;

    if (!withinBudget) {
      triggerVoid("security::audit", {
        type: "budget_exceeded",
        agentId,
        dailySpent,
        monthlySpent,
        dailyBudget,
        monthlyBudget,
      });
    }

    return {
      withinBudget,
      spent: Math.round(spent * 1_000_000) / 1_000_000,
      limit: Number.isFinite(limit) ? limit : -1,
      remaining: Number.isFinite(limit)
        ? Math.round(Math.max(0, limit - spent) * 1_000_000) / 1_000_000
        : -1,
      projectedMonthly: Math.round(projectedMonthly * 1_000_000) / 1_000_000,
    };
  },
);

registerTrigger({
  type: "http",
  function_id: "cost::summary",
  config: { api_path: "api/costs/summary", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "cost::budget_check",
  config: { api_path: "api/costs/:agentId/budget", http_method: "GET" },
});
