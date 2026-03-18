import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";
import { requireAuth } from "./shared/utils.js";
import { SECURITY_HEADERS } from "./security-headers.js";
import { safeCall } from "./shared/errors.js";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "dashboard",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

registerFunction(
  {
    id: "dashboard::page",
    description: "Serve the single-page Alpine.js dashboard",
  },
  async (_input: { path?: string }) => {
    return {
      html: buildDashboardHtml(),
      contentType: "text/html",
      headers: {
        ...SECURITY_HEADERS,
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self' https://cdn.tailwindcss.com https://cdn.jsdelivr.net 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'",
      },
    };
  },
);

registerFunction(
  { id: "dashboard::stats", description: "Aggregate dashboard statistics" },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const ctx = { functionId: "dashboard::stats" };
    const [
      health,
      agents,
      skills,
      usage,
      hands,
      workflows,
      sessions,
      approvals,
    ] = await Promise.all([
      safeCall(
        () =>
          trigger({
            function_id: "state::get",
            payload: { scope: "health", key: "status" },
          }),
        null,
        { ...ctx, operation: "get_health" },
      ),
      safeCall(
        () => trigger({ function_id: "agent::list", payload: {} }),
        { agents: [] },
        { ...ctx, operation: "list_agents" },
      ),
      safeCall(
        () => trigger({ function_id: "skill::list", payload: {} }),
        { skills: [] },
        { ...ctx, operation: "list_skills" },
      ),
      safeCall(
        () => trigger({ function_id: "llm::usage", payload: {} }),
        { stats: [] },
        { ...ctx, operation: "get_usage" },
      ),
      safeCall(
        () => trigger({ function_id: "hand::list", payload: {} }),
        { hands: [] },
        { ...ctx, operation: "list_hands" },
      ),
      safeCall(
        () => trigger({ function_id: "workflow::list", payload: {} }),
        { workflows: [] },
        { ...ctx, operation: "list_workflows" },
      ),
      safeCall(
        () =>
          trigger({
            function_id: "state::list",
            payload: { scope: "sessions" },
          }),
        { entries: [] },
        { ...ctx, operation: "list_sessions" },
      ),
      safeCall(
        () => trigger({ function_id: "approval::list", payload: {} }),
        { pending: [] },
        { ...ctx, operation: "list_approvals" },
      ),
    ]);

    const extract = (val: unknown, key: string) => (val as any)?.[key] || [];
    const agentList = extract(agents, "agents");
    const skillList = extract(skills, "skills");
    const handList = extract(hands, "hands");
    const workflowList = extract(workflows, "workflows");
    const sessionList = extract(sessions, "entries");
    const approvalList = extract(approvals, "pending");
    const usageStats = extract(usage, "stats");

    let totalRequests = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;
    for (const s of usageStats) {
      totalRequests += s.requests || 0;
      totalInputTokens += s.input_tokens || 0;
      totalOutputTokens += s.output_tokens || 0;
      totalCost += s.cost || 0;
    }

    return {
      status: health || "healthy",
      agents: agentList.length,
      agentList,
      skills: skillList.length,
      skillList,
      hands: handList.length,
      handList,
      workflows: workflowList.length,
      workflowList,
      sessions: sessionList.length,
      sessionList: sessionList.slice(-50),
      approvals: approvalList.length,
      approvalList,
      requests: totalRequests,
      tokens: {
        input: totalInputTokens,
        output: totalOutputTokens,
        total: totalInputTokens + totalOutputTokens,
      },
      cost: totalCost,
      uptime: process.uptime(),
    };
  },
);

registerFunction(
  { id: "dashboard::events", description: "Get recent audit events" },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const input = req.body || req;
    const limit = input.limit ?? 100;
    const logs = await safeCall(
      () =>
        trigger({
          function_id: "state::list",
          payload: { scope: "audit" },
        }),
      { entries: [] },
      { operation: "list_audit_events", functionId: "dashboard::events" },
    );
    const entries = ((logs as any)?.entries || []).slice(-limit);
    return { events: entries };
  },
);

registerFunction(
  { id: "dashboard::logs", description: "Get system logs" },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const input = req.body || req;
    const limit = input.limit ?? 200;
    const level = input.level ?? "all";
    const logs = await safeCall(
      () =>
        trigger({
          function_id: "state::list",
          payload: { scope: "logs" },
        }),
      { entries: [] },
      { operation: "list_logs", functionId: "dashboard::logs" },
    );
    let entries = ((logs as any)?.entries || []).slice(-limit);
    if (level !== "all") {
      entries = entries.filter((e: any) => e.level === level);
    }
    return { logs: entries };
  },
);

registerTrigger({
  type: "http",
  function_id: "dashboard::page",
  config: { api_path: "api/dashboard", http_method: "GET" },
});

registerTrigger({
  type: "http",
  function_id: "dashboard::stats",
  config: { api_path: "api/dashboard/stats", http_method: "GET" },
});

registerTrigger({
  type: "http",
  function_id: "dashboard::events",
  config: { api_path: "api/dashboard/events", http_method: "GET" },
});

registerTrigger({
  type: "http",
  function_id: "dashboard::logs",
  config: { api_path: "api/dashboard/logs", http_method: "GET" },
});

function buildDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentOS Dashboard</title>
<script src="https://cdn.tailwindcss.com"></script>
<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
<script>
tailwind.config = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: { 50: '#18181b', 100: '#1e1e22', 200: '#27272a', 300: '#3f3f46' },
        accent: { DEFAULT: '#06b6d4', dim: '#0e7490' },
        ok: '#22c55e',
        warn: '#eab308',
        err: '#ef4444',
      }
    }
  }
}
</script>
</head>
<body class="dark bg-surface-50 text-zinc-200 min-h-screen">
<div x-data="dashboard()" x-init="init()" class="flex h-screen">

  <aside class="w-56 bg-surface-100 border-r border-surface-300 flex flex-col">
    <div class="px-4 py-4 border-b border-surface-300">
      <h1 class="text-lg font-bold text-accent">AgentOS</h1>
      <p class="text-xs text-zinc-500 mt-0.5">Agent Operating System</p>
    </div>
    <nav class="flex-1 py-2">
      <template x-for="item in navItems" :key="item.id">
        <button @click="page = item.id"
          :class="page === item.id ? 'bg-surface-200 text-accent' : 'text-zinc-400 hover:text-zinc-200 hover:bg-surface-200'"
          class="w-full text-left px-4 py-2 text-sm transition-colors flex items-center gap-2">
          <span x-text="item.icon" class="w-5 text-center"></span>
          <span x-text="item.label"></span>
        </button>
      </template>
    </nav>
    <div class="px-4 py-3 border-t border-surface-300 text-xs text-zinc-500">
      <div class="flex items-center gap-1.5">
        <span class="w-2 h-2 rounded-full" :class="stats.status === 'healthy' ? 'bg-ok' : 'bg-err'"></span>
        <span x-text="stats.status || 'connecting...'"></span>
      </div>
      <div class="mt-1" x-text="'Uptime: ' + formatUptime(stats.uptime || 0)"></div>
    </div>
  </aside>

  <main class="flex-1 overflow-y-auto">

    <div x-show="page === 'overview'" class="p-6 space-y-6">
      <h2 class="text-xl font-semibold">Overview</h2>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <template x-for="card in overviewCards" :key="card.label">
          <div class="bg-surface-100 border border-surface-300 rounded-lg p-4">
            <div class="text-xs text-zinc-500 uppercase tracking-wider" x-text="card.label"></div>
            <div class="text-2xl font-bold mt-1" x-text="card.value"></div>
            <div class="text-xs text-zinc-600 mt-1" x-text="card.sub" x-show="card.sub"></div>
          </div>
        </template>
      </div>
      <div class="bg-surface-100 border border-surface-300 rounded-lg p-4">
        <h3 class="text-sm font-medium text-zinc-400 mb-3">Recent Events</h3>
        <div class="space-y-1 max-h-64 overflow-y-auto font-mono text-xs">
          <template x-for="(evt, i) in events.slice(0, 30)" :key="i">
            <div class="flex gap-3 py-1 border-b border-surface-200">
              <span class="text-zinc-600 w-20 shrink-0" x-text="formatTime(evt.timestamp)"></span>
              <span class="text-accent w-24 shrink-0" x-text="evt.action || evt.type || 'event'"></span>
              <span class="text-zinc-400 truncate" x-text="evt.details || evt.message || ''"></span>
            </div>
          </template>
          <div x-show="events.length === 0" class="text-zinc-600 py-2">No events yet</div>
        </div>
      </div>
    </div>

    <div x-show="page === 'agents'" class="p-6 space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-xl font-semibold">Agents</h2>
        <span class="text-sm text-zinc-500" x-text="stats.agents + ' registered'"></span>
      </div>
      <div class="bg-surface-100 border border-surface-300 rounded-lg overflow-hidden">
        <table class="w-full">
          <thead><tr class="border-b border-surface-300">
            <th class="text-left px-4 py-2.5 text-xs text-zinc-500 uppercase">Name</th>
            <th class="text-left px-4 py-2.5 text-xs text-zinc-500 uppercase">Model</th>
            <th class="text-left px-4 py-2.5 text-xs text-zinc-500 uppercase">Status</th>
            <th class="text-left px-4 py-2.5 text-xs text-zinc-500 uppercase">Tags</th>
          </tr></thead>
          <tbody>
            <template x-for="agent in (stats.agentList || [])" :key="agent.name">
              <tr class="border-b border-surface-200 hover:bg-surface-200 transition-colors">
                <td class="px-4 py-2.5 text-sm font-medium" x-text="agent.name"></td>
                <td class="px-4 py-2.5 text-sm text-zinc-400" x-text="agent.model || '-'"></td>
                <td class="px-4 py-2.5"><span class="text-xs px-2 py-0.5 rounded bg-ok/10 text-ok" x-text="agent.status || 'ready'"></span></td>
                <td class="px-4 py-2.5 text-xs text-zinc-500" x-text="(agent.tags || []).join(', ')"></td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>

    <div x-show="page === 'chat'" class="p-6 space-y-4 flex flex-col h-full">
      <h2 class="text-xl font-semibold">Chat</h2>
      <div class="flex-1 bg-surface-100 border border-surface-300 rounded-lg p-4 overflow-y-auto space-y-3 min-h-0 max-h-[60vh]">
        <template x-for="(msg, i) in chatMessages" :key="i">
          <div :class="msg.role === 'user' ? 'text-right' : 'text-left'">
            <div :class="msg.role === 'user' ? 'bg-accent/20 text-accent ml-auto' : 'bg-surface-200 text-zinc-300'"
              class="inline-block max-w-lg rounded-lg px-3 py-2 text-sm" x-text="msg.content"></div>
          </div>
        </template>
        <div x-show="chatMessages.length === 0" class="text-zinc-600 text-center py-8">Start a conversation with an agent</div>
      </div>
      <div class="flex gap-2">
        <select x-model="chatAgent" class="bg-surface-200 border border-surface-300 rounded px-3 py-2 text-sm text-zinc-300">
          <option value="">Select agent</option>
          <template x-for="a in (stats.agentList || [])" :key="a.name">
            <option :value="a.name" x-text="a.name"></option>
          </template>
        </select>
        <input x-model="chatInput" @keydown.enter="sendChat()" type="text" placeholder="Type a message..."
          class="flex-1 bg-surface-200 border border-surface-300 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600">
        <button @click="sendChat()" class="bg-accent text-white px-4 py-2 rounded text-sm font-medium hover:bg-accent-dim transition-colors">Send</button>
      </div>
    </div>

    <div x-show="page === 'channels'" class="p-6 space-y-4">
      <h2 class="text-xl font-semibold">Channels</h2>
      <p class="text-sm text-zinc-500">Message routing channels for agent communication.</p>
      <div class="bg-surface-100 border border-surface-300 rounded-lg p-8 text-center text-zinc-600">Configure channels in config/channels/*.toml</div>
    </div>

    <div x-show="page === 'skills'" class="p-6 space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-xl font-semibold">Skills</h2>
        <span class="text-sm text-zinc-500" x-text="stats.skills + ' installed'"></span>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <template x-for="skill in (stats.skillList || [])" :key="skill.name">
          <div class="bg-surface-100 border border-surface-300 rounded-lg p-4">
            <div class="font-medium text-sm" x-text="skill.name"></div>
            <div class="text-xs text-zinc-500 mt-1" x-text="skill.description || ''"></div>
            <div class="flex gap-1 mt-2">
              <template x-for="tag in (skill.tags || [])" :key="tag">
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-surface-200 text-zinc-400" x-text="tag"></span>
              </template>
            </div>
          </div>
        </template>
      </div>
    </div>

    <div x-show="page === 'hands'" class="p-6 space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-xl font-semibold">Hands</h2>
        <span class="text-sm text-zinc-500" x-text="stats.hands + ' configured'"></span>
      </div>
      <div class="space-y-3">
        <template x-for="hand in (stats.handList || [])" :key="hand.id">
          <div class="bg-surface-100 border border-surface-300 rounded-lg p-4">
            <div class="flex items-center justify-between">
              <div class="font-medium text-sm" x-text="hand.name || hand.id"></div>
              <span class="text-xs px-2 py-0.5 rounded" :class="hand.enabled ? 'bg-ok/10 text-ok' : 'bg-surface-200 text-zinc-500'" x-text="hand.enabled ? 'active' : 'paused'"></span>
            </div>
            <div class="text-xs text-zinc-500 mt-1" x-text="hand.description || ''"></div>
            <div class="text-xs text-zinc-600 mt-2" x-text="'Schedule: ' + (hand.schedule || 'manual')"></div>
          </div>
        </template>
      </div>
    </div>

    <div x-show="page === 'workflows'" class="p-6 space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-xl font-semibold">Workflows</h2>
        <span class="text-sm text-zinc-500" x-text="stats.workflows + ' defined'"></span>
      </div>
      <div class="space-y-3">
        <template x-for="wf in (stats.workflowList || [])" :key="wf.name">
          <div class="bg-surface-100 border border-surface-300 rounded-lg p-4">
            <div class="font-medium text-sm" x-text="wf.name"></div>
            <div class="text-xs text-zinc-500 mt-1" x-text="(wf.steps || []).length + ' steps'"></div>
          </div>
        </template>
        <div x-show="(stats.workflowList || []).length === 0" class="bg-surface-100 border border-surface-300 rounded-lg p-8 text-center text-zinc-600">No workflows defined</div>
      </div>
    </div>

    <div x-show="page === 'sessions'" class="p-6 space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-xl font-semibold">Sessions</h2>
        <span class="text-sm text-zinc-500" x-text="stats.sessions + ' total'"></span>
      </div>
      <div class="bg-surface-100 border border-surface-300 rounded-lg overflow-hidden">
        <table class="w-full">
          <thead><tr class="border-b border-surface-300">
            <th class="text-left px-4 py-2.5 text-xs text-zinc-500 uppercase">ID</th>
            <th class="text-left px-4 py-2.5 text-xs text-zinc-500 uppercase">Agent</th>
            <th class="text-left px-4 py-2.5 text-xs text-zinc-500 uppercase">Started</th>
            <th class="text-left px-4 py-2.5 text-xs text-zinc-500 uppercase">Status</th>
          </tr></thead>
          <tbody>
            <template x-for="sess in (stats.sessionList || [])" :key="sess.id || sess.key">
              <tr class="border-b border-surface-200">
                <td class="px-4 py-2.5 text-sm font-mono" x-text="(sess.id || sess.key || '').slice(0, 12)"></td>
                <td class="px-4 py-2.5 text-sm text-zinc-400" x-text="sess.agent || '-'"></td>
                <td class="px-4 py-2.5 text-sm text-zinc-500" x-text="formatTime(sess.created || sess.timestamp)"></td>
                <td class="px-4 py-2.5"><span class="text-xs px-2 py-0.5 rounded bg-accent/10 text-accent" x-text="sess.status || 'active'"></span></td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>

    <div x-show="page === 'approvals'" class="p-6 space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-xl font-semibold">Approvals</h2>
        <span class="text-sm text-zinc-500" x-text="stats.approvals + ' pending'"></span>
      </div>
      <div class="space-y-3">
        <template x-for="appr in (stats.approvalList || [])" :key="appr.id">
          <div class="bg-surface-100 border border-surface-300 rounded-lg p-4">
            <div class="flex items-center justify-between">
              <div>
                <div class="font-medium text-sm" x-text="appr.action || 'Action'"></div>
                <div class="text-xs text-zinc-500 mt-1" x-text="appr.description || appr.reason || ''"></div>
                <div class="text-xs text-zinc-600 mt-1" x-text="'Agent: ' + (appr.agent || 'unknown')"></div>
              </div>
              <div class="flex gap-2">
                <button @click="handleApproval(appr.id, 'approve')" class="text-xs px-3 py-1.5 rounded bg-ok/20 text-ok hover:bg-ok/30 transition-colors">Approve</button>
                <button @click="handleApproval(appr.id, 'deny')" class="text-xs px-3 py-1.5 rounded bg-err/20 text-err hover:bg-err/30 transition-colors">Deny</button>
              </div>
            </div>
          </div>
        </template>
        <div x-show="stats.approvals === 0" class="bg-surface-100 border border-surface-300 rounded-lg p-8 text-center text-zinc-600">No pending approvals</div>
      </div>
    </div>

    <div x-show="page === 'logs'" class="p-6 space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-xl font-semibold">Logs</h2>
        <select x-model="logLevel" @change="loadLogs()" class="bg-surface-200 border border-surface-300 rounded px-2 py-1 text-sm text-zinc-300">
          <option value="all">All levels</option>
          <option value="error">Errors</option>
          <option value="warn">Warnings</option>
          <option value="info">Info</option>
          <option value="debug">Debug</option>
        </select>
      </div>
      <div class="bg-surface-100 border border-surface-300 rounded-lg p-4 max-h-[70vh] overflow-y-auto font-mono text-xs space-y-0.5">
        <template x-for="(log, i) in logEntries" :key="i">
          <div class="flex gap-2 py-0.5">
            <span class="text-zinc-600 w-20 shrink-0" x-text="formatTime(log.timestamp)"></span>
            <span class="w-12 shrink-0 uppercase"
              :class="log.level === 'error' ? 'text-err' : log.level === 'warn' ? 'text-warn' : log.level === 'debug' ? 'text-zinc-600' : 'text-accent'"
              x-text="log.level || 'info'"></span>
            <span class="text-zinc-400" x-text="log.message || JSON.stringify(log)"></span>
          </div>
        </template>
        <div x-show="logEntries.length === 0" class="text-zinc-600 py-4 text-center">No logs available</div>
      </div>
    </div>

    <div x-show="page === 'settings'" class="p-6 space-y-6">
      <h2 class="text-xl font-semibold">Settings</h2>
      <div class="space-y-4 max-w-2xl">
        <div class="bg-surface-100 border border-surface-300 rounded-lg p-4 space-y-4">
          <h3 class="text-sm font-medium text-zinc-400">System</h3>
          <div class="grid grid-cols-2 gap-4 text-sm">
            <div><span class="text-zinc-500">Status:</span> <span class="text-ok" x-text="stats.status"></span></div>
            <div><span class="text-zinc-500">Uptime:</span> <span x-text="formatUptime(stats.uptime || 0)"></span></div>
            <div><span class="text-zinc-500">Total Requests:</span> <span x-text="(stats.requests || 0).toLocaleString()"></span></div>
            <div><span class="text-zinc-500">Total Cost:</span> <span x-text="'$' + (stats.cost || 0).toFixed(2)"></span></div>
          </div>
        </div>
        <div class="bg-surface-100 border border-surface-300 rounded-lg p-4 space-y-4">
          <h3 class="text-sm font-medium text-zinc-400">Token Usage</h3>
          <div class="grid grid-cols-3 gap-4 text-sm">
            <div><span class="text-zinc-500">Input:</span> <span x-text="(stats.tokens?.input || 0).toLocaleString()"></span></div>
            <div><span class="text-zinc-500">Output:</span> <span x-text="(stats.tokens?.output || 0).toLocaleString()"></span></div>
            <div><span class="text-zinc-500">Total:</span> <span x-text="(stats.tokens?.total || 0).toLocaleString()"></span></div>
          </div>
        </div>
        <div class="bg-surface-100 border border-surface-300 rounded-lg p-4 space-y-4">
          <h3 class="text-sm font-medium text-zinc-400">Integrations</h3>
          <p class="text-xs text-zinc-600">Configure MCP integrations in integrations/*.toml files.</p>
          <button @click="refreshStats()" class="text-xs px-3 py-1.5 rounded bg-accent/20 text-accent hover:bg-accent/30 transition-colors">Refresh Data</button>
        </div>
      </div>
    </div>

  </main>
</div>

<script>
function dashboard() {
  return {
    page: 'overview',
    stats: {},
    events: [],
    logEntries: [],
    logLevel: 'all',
    chatMessages: [],
    chatInput: '',
    chatAgent: '',
    navItems: [
      { id: 'overview', label: 'Overview', icon: '#' },
      { id: 'agents', label: 'Agents', icon: '@' },
      { id: 'chat', label: 'Chat', icon: '>' },
      { id: 'channels', label: 'Channels', icon: '~' },
      { id: 'skills', label: 'Skills', icon: '*' },
      { id: 'hands', label: 'Hands', icon: '!' },
      { id: 'workflows', label: 'Workflows', icon: '%' },
      { id: 'sessions', label: 'Sessions', icon: '=' },
      { id: 'approvals', label: 'Approvals', icon: '?' },
      { id: 'logs', label: 'Logs', icon: '|' },
      { id: 'settings', label: 'Settings', icon: '+' },
    ],
    get overviewCards() {
      return [
        { label: 'Agents', value: this.stats.agents || 0, sub: 'registered templates' },
        { label: 'Skills', value: this.stats.skills || 0, sub: 'installed' },
        { label: 'Hands', value: this.stats.hands || 0, sub: 'autonomous tasks' },
        { label: 'Workflows', value: this.stats.workflows || 0, sub: 'defined' },
        { label: 'Sessions', value: this.stats.sessions || 0, sub: 'active/total' },
        { label: 'Approvals', value: this.stats.approvals || 0, sub: 'pending' },
        { label: 'Requests', value: (this.stats.requests || 0).toLocaleString(), sub: 'total LLM calls' },
        { label: 'Cost', value: '$' + (this.stats.cost || 0).toFixed(2), sub: 'total spend' },
      ]
    },
    init() {
      this.refreshStats()
      this.loadEvents()
      this.loadLogs()
      setInterval(() => this.refreshStats(), 5000)
      setInterval(() => this.loadEvents(), 10000)
    },
    async refreshStats() {
      try {
        const r = await fetch('/api/dashboard/stats')
        this.stats = await r.json()
      } catch (e) {
        this.stats = { ...this.stats, status: 'offline' }
      }
    },
    async loadEvents() {
      try {
        const r = await fetch('/api/dashboard/events')
        const d = await r.json()
        this.events = d.events || []
      } catch {}
    },
    async loadLogs() {
      try {
        const r = await fetch('/api/dashboard/logs?level=' + this.logLevel)
        const d = await r.json()
        this.logEntries = d.logs || []
      } catch {}
    },
    async sendChat() {
      if (!this.chatInput.trim() || !this.chatAgent) return
      const msg = this.chatInput.trim()
      this.chatMessages.push({ role: 'user', content: msg })
      this.chatInput = ''
      try {
        const r = await fetch('/api/agents/' + this.chatAgent + '/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: this.chatAgent, message: msg }),
        })
        const d = await r.json()
        this.chatMessages.push({ role: 'assistant', content: d.content || d.response || d.message || JSON.stringify(d) })
      } catch (e) {
        this.chatMessages.push({ role: 'assistant', content: 'Error: Could not reach agent' })
      }
    },
    async handleApproval(id, action) {
      try {
        await fetch('/api/approvals/decide', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: id, decision: action, decidedBy: 'dashboard' }),
        })
        await this.refreshStats()
      } catch {}
    },
    formatTime(ts) {
      if (!ts) return ''
      return new Date(ts).toLocaleTimeString()
    },
    formatUptime(seconds) {
      if (seconds < 60) return Math.floor(seconds) + 's'
      if (seconds < 3600) return Math.floor(seconds / 60) + 'm'
      const h = Math.floor(seconds / 3600)
      const m = Math.floor((seconds % 3600) / 60)
      return h + 'h ' + m + 'm'
    },
  }
}
</script>
</body>
</html>`;
}
