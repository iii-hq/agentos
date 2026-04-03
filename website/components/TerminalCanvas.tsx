import { useEffect, useRef, useState, useCallback } from "react";

const SHELL_COMMANDS: Record<string, string> = {
  help: `Available commands:
  status      System status
  stats       Show statistics
  agents      List agent templates
  evolve      Show self-evolution demo
  compare     Compare with other frameworks
  install     Show install instructions
  mcp         Claude Code integration
  architecture Show architecture
  features    List all features
  hello       Say hello
  clear       Clear terminal`,
  status: `\u25cf AgentOS v0.1.0
  Engine:    ws://localhost:49134  \u25cf running
  API:       http://localhost:3111 \u25cf running
  Workers:   57 connected
  Functions: 1,947 registered
  Uptime:    2h 34m`,
  stats: `\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510
\u2502 Functions      1,947 \u2502 Tests           1,789 \u2502
\u2502 Workers           57 \u2502 Rust Crates        18 \u2502
\u2502 LLM Providers     25 \u2502 Channels           40 \u2502
\u2502 Security Layers   18 \u2502 TUI Screens        25 \u2502
\u2502 Hook Events       10 \u2502 Agent Templates    45 \u2502
\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518`,
  agents: `45 agent templates available:
  coder         Full-stack software engineer
  reviewer      Code review specialist
  architect     System design agent
  researcher    Research and analysis
  debugger      Bug investigation
  orchestrator  Multi-agent coordinator
  security      Vulnerability scanning
  doc-writer    Documentation specialist
  devops-lead   Infrastructure management
  ...and 36 more. Run: agentos agent list`,
  evolve: `evolve::generate \u2192 writing doubler_v1...
  \u2502 function double(n) { return n * 2 }
eval::run \u2192 input: 5, expected: 10 \u2192 \u2713 pass
eval::run \u2192 input: -3, expected: -6 \u2192 \u2717 fail (got 6)
feedback::improve \u2192 analyzing failures...
evolve::generate \u2192 writing doubler_v2...
  \u2502 function double(n) { return n * 2 }
eval::run \u2192 input: -3, expected: -6 \u2192 \u2713 pass
feedback::promote \u2192 doubler_v2 \u2192 production \u2713`,
  compare: `\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510
\u2502                  \u2502 AgentOS  \u2502 OpenClaw \u2502 CrewAI   \u2502
\u251c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
\u2502 Self-evolving    \u2502    \u2713     \u2502    \u2717     \u2502    \u2717     \u2502
\u2502 Rust core        \u2502    \u2713     \u2502    \u2717     \u2502    \u2717     \u2502
\u2502 Security layers  \u2502   18     \u2502    3     \u2502    1     \u2502
\u2502 Channels         \u2502   40     \u2502   15     \u2502    4     \u2502
\u2502 LLM providers    \u2502   25     \u2502   20     \u2502    5     \u2502
\u2502 Hashline edits   \u2502    \u2713     \u2502    \u2717     \u2502    \u2717     \u2502
\u2502 LSP tools        \u2502    \u2713     \u2502    \u2717     \u2502    \u2717     \u2502
\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518`,
  install: `curl -fsSL .../install.sh | sh
agentos start
Two commands. Zero config. 1,947 functions.`,
  mcp: `Claude Code integration:
  claude mcp add agentos -- npx agentos mcp
  10 skills \u00b7 5 commands \u00b7 5 agents \u00b7 2 hooks
  One command to add AgentOS to Claude Code.`,
  architecture: `\u250c\u2500\u2500\u2500 Rust (18 crates) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510
\u2502 cli  tui  security  memory  llm-router        \u2502
\u2502 wasm-sandbox  realm  hierarchy  directive      \u2502
\u2502 mission  ledger  council  pulse  bridge        \u2502
\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518
\u250c\u2500\u2500\u2500 TypeScript (51 workers) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510
\u2502 agent-core  tools  evolve  eval  feedback      \u2502
\u2502 orchestrator  recovery  lifecycle  hashline    \u2502
\u2502 lsp-tools  memory-reflection  swarm  api       \u2502
\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518
\u250c\u2500\u2500\u2500 Python (1 worker) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510
\u2502 embeddings                                     \u2502
\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518`,
  features: `Agent Intelligence:
  \u25ba Self-evolving functions (evolve \u2192 eval \u2192 feedback)
  \u25ba Forge engine (trajectory learning, anti-forgetting)
  \u25ba Memory reflection (auto-curate every 5 turns)
  \u25ba Recall mesh (vector-indexed memory, MMR diversity)
  \u25ba Hashline edits (hash-anchored zero-corruption)
  \u25ba Smart model routing (complexity + agentTier)
Orchestration:
  \u25ba Accord protocols (Raft, Byzantine, Gossip consensus)
  \u25ba Task decomposition (dependency graphs, transitive blocking)
  \u25ba Session lifecycle (spawning \u2192 working \u2192 done)
  \u25ba Sentinel hooks (26 events, priority chaining, abort)
  \u25ba Multi-agent orchestrator (plan \u2192 spawn \u2192 monitor)
Infrastructure:
  \u25ba 18 Rust crates (hot-path performance)
  \u25ba 25 LLM providers (zero lock-in)
  \u25ba 40 channel adapters (Slack, Discord, WhatsApp...)
  \u25ba 18 security layers (RBAC, WASM sandbox, vault)
  \u25ba 25-screen TUI dashboard`,
  hello: `Hello! I'm AgentOS \u2014 the agent operating system that evolves itself.
Try: status, stats, evolve, compare, install, features`,
  clear: "__CLEAR__",
};

const CMD_NAMES = Object.keys(SHELL_COMMANDS);

const BASE_PL = 24;
const PT = 48;
const MAX_CONTENT_W = 900;
const TITLE_H = 36;
const FOOT_H = 32;
const C = { bg: "#0a0a0a", fg: "#d4d4d8", green: "#22c55e", yellow: "#facc15", cyan: "#06b6d4", dim: "#52525b", red: "#ef4444", card: "#18181b", border: "#27272a", white: "#ffffff" };

type Seg = { t: string; c: string };
type CLine = Seg[];
type Glyph = { char: string; bx: number; by: number; color: string; dx: number; dy: number; vx: number; vy: number };

function getFontSize(): number {
  if (typeof window === "undefined") return 13;
  const w = window.innerWidth;
  if (w < 380) return 9;
  if (w < 480) return 10;
  if (w < 768) return 11;
  return 13;
}

function getFont(size: number): string {
  return `${size}px "IBM Plex Mono", ui-monospace, "Courier New", monospace`;
}

function getLineHeight(size: number): number {
  return Math.round(size * 1.55);
}

function L(t: string, c = C.fg): CLine { return [{ t, c }]; }
function M(segs: Seg[]): CLine { return segs; }
function S(t: string, c: string): Seg { return { t, c }; }
function textLines(text: string, c: string): CLine[] { return text.split("\n").map(l => L(l, c)); }

function buildMobileContent(): CLine[] {
  const r: CLine[] = [];
  const push = (...ls: CLine[]) => r.push(...ls);
  const blank = () => r.push(L(""));

  push(L("  AgentOS", C.yellow));
  push(L("  The agent OS that evolves itself.", C.white));
  push(M([S("  agentsos.sh \u00b7 Apache-2.0", C.dim)]));
  blank();

  const stats: [string, string][] = [
    ["Functions", "1,947"], ["Tests", "1,789"],
    ["Workers", "57"], ["Rust Crates", "18"],
    ["LLM Providers", "25"], ["Channels", "40"],
    ["Security", "18"], ["Agents", "45"],
  ];
  for (const [label, val] of stats) {
    push(M([S(`  ${label.padEnd(14)}`, C.dim), S(val, C.yellow)]));
  }
  blank();

  push(L("  Three primitives:", C.white));
  blank();
  push(M([S("  Worker   ", C.yellow), S("connects", C.dim)]));
  push(M([S("  Function ", C.yellow), S("executes", C.dim)]));
  push(M([S("  Trigger  ", C.yellow), S("activates", C.dim)]));
  blank();

  push(L("\u2500\u2500 What makes this different \u2500\u2500", C.dim));
  blank();
  const feats: [string, string][] = [
    ["Self-Evolving", "Agents write and improve their own code"],
    ["Forge Engine", "Trajectory learning, anti-forgetting"],
    ["Accord", "Raft, Byzantine, Gossip consensus"],
    ["Recall Mesh", "Vector memory with MMR diversity"],
    ["Sentinel", "26 lifecycle hooks with abort gates"],
    ["25 LLMs", "Anthropic, OpenAI, Google, Ollama"],
    ["40 Channels", "Slack, Discord, WhatsApp + more"],
  ];
  for (const [title, desc] of feats) {
    push(M([S("  \u25ba ", C.yellow), S(title, C.white)]));
    push(L("    " + desc, C.dim));
  }
  blank();

  push(L("\u2500\u2500 Architecture \u2500\u2500", C.dim));
  blank();
  push(M([S("  Rust ", C.yellow), S("18 crates", C.dim)]));
  push(M([S("  TypeScript ", C.cyan), S("57 workers", C.dim)]));
  push(M([S("  Python ", C.green), S("1 worker", C.dim)]));
  blank();

  push(L("\u2500\u2500 Install \u2500\u2500", C.dim));
  blank();
  push(M([S("  $ ", C.green), S("curl -fsSL .../install.sh | sh", C.fg)]));
  push(M([S("  $ ", C.green), S("agentos start", C.fg)]));
  blank();
  push(L("  Claude Code:", C.dim));
  push(M([S("  $ ", C.green), S("claude mcp add agentos \\", C.fg)]));
  push(L("      -- npx agentos mcp", C.fg));
  blank();
  push(L("  Type 'help' for commands.", C.dim));
  blank();

  return r;
}

function buildContent(): CLine[] {
  const r: CLine[] = [];
  const push = (...ls: CLine[]) => r.push(...ls);
  const blank = () => r.push(L(""));

  push(...textLines(`     _                    _    ___  ____
    / \\   __ _  ___ _ __ | |_ / _ \\/ ___|
   / _ \\ / _\` |/ _ \\ '_ \\| __| | | \\___ \\
  / ___ \\ (_| |  __/ | | | |_| |_| |___) |
 /_/   \\_\\__, |\\___|_| |_|\\__|\\___/|____/
         |___/`, C.yellow));
  blank();
  push(L("  The agent OS that evolves itself.", C.white));
  push(M([S("  Built on iii-engine \u00b7 agentsos.sh \u00b7 Apache-2.0", C.dim)]));
  blank();

  push(...[
    "\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510",
    "\u2502 Functions      1,947 \u2502 Tests           1,789 \u2502",
    "\u2502 Workers           57 \u2502 Rust Crates        18 \u2502",
    "\u2502 LLM Providers     25 \u2502 Channels           40 \u2502",
    "\u2502 Security Layers   18 \u2502 TUI Screens        25 \u2502",
    "\u2502 Hook Events       10 \u2502 Agent Templates    45 \u2502",
    "\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518",
  ].map(s => L(s, C.dim)));
  blank();

  push(L("  Three primitives. That's the entire model.", C.white));
  blank();
  push(M([S("  Worker   ", C.yellow), S("A process that connects to the engine", C.dim)]));
  push(M([S("  Function ", C.yellow), S("A callable unit of work", C.dim)]));
  push(M([S("  Trigger  ", C.yellow), S("Binds a function to HTTP, cron, queue", C.dim)]));
  blank();
  push(L("  No chains. No graphs. No prompt templates.", C.dim));
  push(L("  Every capability is a plain function on the iii-engine bus.", C.dim));
  blank();

  push(L("\u2500\u2500\u2500 What makes this different \u2500\u2500\u2500", C.dim));
  blank();
  const feats: [string, string][] = [
    ["Self-Evolving Functions", "Agents write, test, and improve their own code at runtime."],
    ["Forge Engine", "Trajectory-based learning with anti-forgetting. 5 modes."],
    ["Accord Protocols", "Pluggable consensus: Raft, Byzantine, Gossip. Auto-selected."],
    ["Recall Mesh", "Vector-indexed memory with MMR diversity ranking."],
    ["Sentinel Hooks", "26 lifecycle events with priority chaining and abort gates."],
    ["Task Dependency Graphs", "Transitive blocking, critical path, batch creation."],
    ["25 LLM Providers", "Swap between Anthropic, OpenAI, Google, Ollama. Zero lock-in."],
    ["40 Channels + LSP Tools", "IDE-precision. Slack, Discord, WhatsApp + 37 more."],
  ];
  for (const [title, desc] of feats) {
    push(M([S("  \u25ba ", C.yellow), S(title, C.white)]));
    push(L("    " + desc, C.dim));
  }
  blank();

  push(L("\u2500\u2500\u2500 Architecture \u2500\u2500\u2500", C.dim));
  blank();
  push(L("  Rust (18 crates)", C.yellow));
  push(L("  \u251c cli \u00b7 tui \u00b7 security \u00b7 memory \u00b7 llm-router", C.dim));
  push(L("  \u251c wasm-sandbox \u00b7 realm \u00b7 hierarchy \u00b7 directive", C.dim));
  push(L("  \u2514 mission \u00b7 ledger \u00b7 council \u00b7 pulse \u00b7 bridge", C.dim));
  blank();
  push(L("  TypeScript (57 workers)", C.cyan));
  push(L("  \u251c agent-core \u00b7 tools \u00b7 evolve \u00b7 eval \u00b7 feedback", C.dim));
  push(L("  \u251c orchestrator \u00b7 recovery \u00b7 lifecycle \u00b7 hashline", C.dim));
  push(L("  \u251c consensus \u00b7 forge \u00b7 recall-mesh \u00b7 sentinel", C.dim));
  push(L("  \u2514 lsp-tools \u00b7 memory-reflection \u00b7 swarm \u00b7 api", C.dim));
  blank();
  push(L("  Python (1 worker)", C.green));
  push(L("  \u2514 embeddings", C.dim));
  blank();

  push(L("\u2500\u2500\u2500 Install \u2500\u2500\u2500", C.dim));
  blank();
  push(M([S("  $ ", C.green), S("curl -fsSL .../install.sh | sh", C.fg)]));
  push(M([S("  $ ", C.green), S("agentos start", C.fg)]));
  blank();
  push(L("  Claude Code:", C.dim));
  push(M([S("  $ ", C.green), S("claude mcp add agentos -- npx agentos mcp", C.fg)]));
  blank();
  push(L("  Type 'help' for commands.", C.dim));
  blank();

  return r;
}

function measureCW(font: string): number {
  try {
    const cv = document.createElement("canvas");
    const cx = cv.getContext("2d");
    if (!cx) return 7.8;
    cx.font = font;
    return cx.measureText("M").width;
  } catch { return 7.8; }
}

function getPL(canvasW: number): number {
  if (canvasW < 380) return 4;
  if (canvasW < 480) return 8;
  if (canvasW < 768) return 12;
  if (canvasW > MAX_CONTENT_W + BASE_PL * 2) {
    return Math.floor((canvasW - MAX_CONTENT_W) / 2);
  }
  return BASE_PL;
}

function makeGlyphs(content: CLine[], cw: number, pl: number, lh: number): Glyph[] {
  const gs: Glyph[] = [];
  for (let r = 0; r < content.length; r++) {
    let col = 0;
    for (const seg of content[r]) {
      for (let i = 0; i < seg.t.length; i++) {
        gs.push({ char: seg.t[i], bx: pl + col * cw, by: PT + r * lh, color: seg.c, dx: 0, dy: 0, vx: 0, vy: 0 });
        col++;
      }
    }
  }
  return gs;
}

export default function TerminalCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState("");
  const [cmdHist, setCmdHist] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [ghost, setGhost] = useState("");
  const glyphs = useRef<Glyph[]>([]);
  const scrollY = useRef(0);
  const mouse = useRef({ x: -9999, y: -9999 });
  const cw = useRef(7.8);
  const content = useRef<CLine[]>([]);
  const rows = useRef(0);
  const anim = useRef(0);
  const pl = useRef(BASE_PL);
  const fontSize = useRef(13);
  const lineHeight = useRef(20);
  const font = useRef(getFont(13));
  const touch = useRef({ startY: 0, lastY: 0, active: false });

  const recalcSizing = useCallback(() => {
    fontSize.current = getFontSize();
    lineHeight.current = getLineHeight(fontSize.current);
    font.current = getFont(fontSize.current);
    cw.current = measureCW(font.current);
  }, []);

  const rebuild = useCallback(() => {
    const cv = canvasRef.current;
    const w = cv ? cv.width / (window.devicePixelRatio || 1) : window.innerWidth;
    pl.current = getPL(w);
    const isMobile = w < 480;
    if (content.current.length === 0 || isMobile !== content.current._mobile) {
      content.current = isMobile ? buildMobileContent() : buildContent();
      (content.current as any)._mobile = isMobile;
    }
    glyphs.current = makeGlyphs(content.current, cw.current, pl.current, lineHeight.current);
    rows.current = content.current.length;
  }, []);

  const autoScroll = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const totalH = PT + rows.current * lineHeight.current + FOOT_H + 40;
    const viewH = cv.height / (window.devicePixelRatio || 1);
    if (totalH > viewH) scrollY.current = totalH - viewH;
  }, []);

  const clampScroll = useCallback((viewH: number) => {
    const totalH = PT + rows.current * lineHeight.current + FOOT_H + 40;
    const max = Math.max(0, totalH - viewH);
    scrollY.current = Math.min(max, Math.max(0, scrollY.current));
  }, []);

  const runCmd = useCallback((cmd: string) => {
    const t = cmd.trim().toLowerCase();
    if (!t) return;
    if (t === "clear") {
      const isMobile = window.innerWidth < 480;
      content.current = isMobile ? buildMobileContent() : buildContent();
      (content.current as any)._mobile = isMobile;
      rebuild();
      scrollY.current = 0;
      setCmdHist(p => [t, ...p]);
      setHistIdx(-1);
      return;
    }
    const resp = SHELL_COMMANDS[t] ?? `Command not found: ${t}. Type "help" for available commands.`;
    const newLines: CLine[] = [
      M([S("  $ ", C.green), S(t, C.green)]),
      ...resp.split("\n").map(l => L("  " + l, C.fg)),
      L(""),
    ];
    content.current = [...content.current, ...newLines];
    (content.current as any)._mobile = window.innerWidth < 480;
    rebuild();
    autoScroll();
    setCmdHist(p => [t, ...p]);
    setHistIdx(-1);
  }, [rebuild, autoScroll]);

  const runCmdRef = useRef(runCmd);
  runCmdRef.current = runCmd;

  useEffect(() => {
    recalcSizing();
    const isMobile = window.innerWidth < 480;
    content.current = isMobile ? buildMobileContent() : buildContent();
    (content.current as any)._mobile = isMobile;
    pl.current = getPL(window.innerWidth);
    glyphs.current = makeGlyphs(content.current, cw.current, pl.current, lineHeight.current);
    rows.current = content.current.length;
    setTimeout(() => runCmdRef.current("hello"), 100);
  }, [recalcSizing]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = window.innerWidth, h = window.innerHeight;
      cv.width = w * dpr; cv.height = h * dpr;
      cv.style.width = w + "px"; cv.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      recalcSizing();
      const isMobile = w < 480;
      const wasMobile = (content.current as any)._mobile;
      if (isMobile !== wasMobile) {
        content.current = isMobile ? buildMobileContent() : buildContent();
        (content.current as any)._mobile = isMobile;
      }
      rebuild();
    };
    resize();
    window.addEventListener("resize", resize);

    const onMouse = (e: MouseEvent) => { mouse.current = { x: e.clientX, y: e.clientY }; };
    cv.addEventListener("mousemove", onMouse);

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const viewH = cv.height / (window.devicePixelRatio || 1);
      scrollY.current += e.deltaY;
      clampScroll(viewH);
    };
    cv.addEventListener("wheel", onWheel, { passive: false });

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        touch.current = { startY: e.touches[0].clientY, lastY: e.touches[0].clientY, active: true };
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!touch.current.active || e.touches.length !== 1) return;
      e.preventDefault();
      const y = e.touches[0].clientY;
      const delta = touch.current.lastY - y;
      touch.current.lastY = y;
      const viewH = cv.height / (window.devicePixelRatio || 1);
      scrollY.current += delta;
      clampScroll(viewH);
    };
    const onTouchEnd = () => { touch.current.active = false; };

    cv.addEventListener("touchstart", onTouchStart, { passive: true });
    cv.addEventListener("touchmove", onTouchMove, { passive: false });
    cv.addEventListener("touchend", onTouchEnd, { passive: true });

    const R_RAD = 80, R_FORCE = 12;
    const checkMobile = () => window.innerWidth < 768;

    const frame = () => {
      const w = cv.width / (window.devicePixelRatio || 1);
      const h = cv.height / (window.devicePixelRatio || 1);
      const time = performance.now() / 1000;
      const sy = scrollY.current;
      const mobile = checkMobile();
      const mx = mobile ? -9999 : mouse.current.x;
      const my = mobile ? -9999 : mouse.current.y + sy;
      const lh = lineHeight.current;
      const currentFont = font.current;

      ctx.clearRect(0, 0, w, h);

      ctx.fillStyle = C.card;
      ctx.fillRect(0, 0, w, TITLE_H);
      ctx.strokeStyle = C.border; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, TITLE_H); ctx.lineTo(w, TITLE_H); ctx.stroke();

      const dots = [C.red, C.yellow, C.green];
      const dotR = mobile ? 4 : 5;
      const dotX = mobile ? 12 : 16;
      const dotGap = mobile ? 14 : 18;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath(); ctx.arc(dotX + i * dotGap, TITLE_H / 2, dotR, 0, Math.PI * 2);
        ctx.fillStyle = dots[i]; ctx.fill();
      }
      const titleFontSize = mobile ? 10 : 12;
      ctx.font = `${titleFontSize}px "IBM Plex Mono", monospace`;
      ctx.fillStyle = C.dim;
      const titleText = mobile ? "agentsos.sh" : "AgentOS v0.1.0 \u2014 agentsos.sh";
      ctx.fillText(titleText, dotX + 3 * dotGap + 8, TITLE_H / 2 + 4);

      ctx.save();
      ctx.beginPath(); ctx.rect(0, TITLE_H, w, h - TITLE_H - FOOT_H); ctx.clip();

      const gs = glyphs.current;
      ctx.font = currentFont;
      for (let i = 0; i < gs.length; i++) {
        const g = gs[i];
        const wAmp = mobile ? 0.15 : 1.0;
        const wvx = Math.sin(time * 0.5 + g.by * 0.02) * 1.2 * wAmp;
        const wvy = Math.cos(time * 0.7 + g.bx * 0.015) * 0.8 * wAmp;

        const rdx = g.bx + g.dx - mx, rdy = g.by + g.dy - my;
        const dist = Math.sqrt(rdx * rdx + rdy * rdy);
        if (dist < R_RAD && dist > 0) {
          const f = (1 - dist / R_RAD) * R_FORCE;
          g.vx += (rdx / dist) * f * 0.3;
          g.vy += (rdy / dist) * f * 0.3;
        }

        g.vx += (-g.dx + wvx) * 0.08;
        g.vy += (-g.dy + wvy) * 0.08;
        g.vx *= 0.82; g.vy *= 0.82;
        g.dx += g.vx; g.dy += g.vy;

        if (g.char === " ") continue;
        const sx = g.bx + g.dx, sy2 = g.by + g.dy - sy;
        if (sy2 < TITLE_H - lh || sy2 > h - FOOT_H + lh) continue;
        ctx.fillStyle = g.color;
        ctx.fillText(g.char, sx, sy2);
      }
      ctx.restore();

      ctx.fillStyle = C.card;
      ctx.fillRect(0, h - FOOT_H, w, FOOT_H);
      ctx.strokeStyle = C.border;
      ctx.beginPath(); ctx.moveTo(0, h - FOOT_H); ctx.lineTo(w, h - FOOT_H); ctx.stroke();
      const footFontSize = mobile ? 9 : 11;
      ctx.font = `${footFontSize}px "IBM Plex Mono", monospace`;
      ctx.fillStyle = C.dim;
      const ft = mobile ? "github.com/iii-hq/agentos" : "Apache-2.0  \u00b7  github.com/iii-hq/agentos  \u00b7  agentsos.sh";
      ctx.fillText(ft, (w - ctx.measureText(ft).width) / 2, h - FOOT_H / 2 + 4);

      anim.current = requestAnimationFrame(frame);
    };
    anim.current = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(anim.current);
      window.removeEventListener("resize", resize);
      cv.removeEventListener("mousemove", onMouse);
      cv.removeEventListener("wheel", onWheel);
      cv.removeEventListener("touchstart", onTouchStart);
      cv.removeEventListener("touchmove", onTouchMove);
      cv.removeEventListener("touchend", onTouchEnd);
    };
  }, [rebuild, recalcSizing, clampScroll]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { runCmd(input); setInput(""); setGhost(""); }
    else if (e.key === "ArrowUp") { e.preventDefault(); const n = Math.min(histIdx + 1, cmdHist.length - 1); setHistIdx(n); if (cmdHist[n]) setInput(cmdHist[n]); }
    else if (e.key === "ArrowDown") { e.preventDefault(); const n = histIdx - 1; if (n < 0) { setHistIdx(-1); setInput(""); } else { setHistIdx(n); if (cmdHist[n]) setInput(cmdHist[n]); } }
    else if (e.key === "Tab") { e.preventDefault(); if (ghost) { setInput(ghost); setGhost(""); } }
  };

  const handleInput = (val: string) => {
    setInput(val);
    if (val.length > 0) { const m = CMD_NAMES.find(c => c.startsWith(val.toLowerCase()) && c !== val.toLowerCase()); setGhost(m || ""); }
    else setGhost("");
  };

  const inputFontSize = typeof window !== "undefined" && window.innerWidth < 480 ? 11 : 13;
  const inputPl = typeof window !== "undefined" && window.innerWidth < 480 ? "8px" : `max(${BASE_PL}px, calc((100vw - ${MAX_CONTENT_W}px) / 2))`;

  return (
    <div style={{ position: "relative", width: "100vw", height: "100dvh", background: C.bg, overflow: "hidden" }}>
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, cursor: "default", touchAction: "none" }} onClick={() => inputRef.current?.focus()} />
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: FOOT_H + 36, display: "flex", alignItems: "flex-start", paddingTop: 4, paddingLeft: inputPl, paddingRight: inputPl, pointerEvents: "none", zIndex: 10 }}>
        <span style={{ color: C.green, fontFamily: '"IBM Plex Mono", monospace', fontSize: inputFontSize, fontWeight: 700, marginRight: 8, pointerEvents: "none", userSelect: "none" }}>$</span>
        <div style={{ position: "relative", flex: 1 }}>
          {ghost && input && (
            <span style={{ position: "absolute", left: 0, top: 0, color: C.dim, pointerEvents: "none", whiteSpace: "pre", fontFamily: '"IBM Plex Mono", monospace', fontSize: inputFontSize }}>
              <span style={{ visibility: "hidden" }}>{input}</span>{ghost.slice(input.length)}
            </span>
          )}
          <input ref={inputRef} type="text" style={{ background: "transparent", border: "none", color: C.fg, fontFamily: '"IBM Plex Mono", monospace', fontSize: inputFontSize, outline: "none", width: "100%", caretColor: C.green, padding: 0, pointerEvents: "auto" }} value={input} onChange={e => handleInput(e.target.value)} onKeyDown={handleKey} spellCheck={false} autoComplete="off" autoCapitalize="off" autoFocus />
        </div>
      </div>
    </div>
  );
}
