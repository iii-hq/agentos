import { useState, useEffect, useRef, useCallback } from "react";

const TICK = 18;

function useTyping(text: string, enabled: boolean) {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let i = 0;
    setDisplayed("");
    setDone(false);
    const id = setInterval(() => {
      i++;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(id);
        setDone(true);
      }
    }, TICK);
    return () => clearInterval(id);
  }, [text, enabled]);

  return { displayed, done };
}

function Cursor() {
  return (
    <span className="inline-block w-[8px] h-[18px] bg-[#22c55e] align-middle animate-[blink_1s_step-end_infinite] ml-0.5" />
  );
}

function Prompt({ children }: { children: string }) {
  return (
    <span>
      <span className="text-[#22c55e]">$ </span>
      <span className="text-[#22c55e] font-semibold">{children}</span>
    </span>
  );
}

function Yellow({ children }: { children: React.ReactNode }) {
  return <span className="text-[#facc15]">{children}</span>;
}

function Dim({ children }: { children: React.ReactNode }) {
  return <span className="text-[#52525b]">{children}</span>;
}

function Cyan({ children }: { children: React.ReactNode }) {
  return <span className="text-[#22d3ee]">{children}</span>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="ml-4 px-2 py-0.5 text-[11px] border border-[#333] rounded text-[#71717a] hover:text-[#facc15] hover:border-[#facc15]/40 transition-colors select-none"
      aria-label="Copy to clipboard"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

function Section({
  command,
  defaultOpen = false,
  children,
}: {
  command: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="group">
      <button
        onClick={() => setOpen(!open)}
        className="w-full text-left py-1 flex items-center gap-2 hover:opacity-80 transition-opacity"
      >
        <span className="text-[#52525b] text-xs select-none w-4 text-center">
          {open ? "▾" : "▸"}
        </span>
        <Prompt>{command}</Prompt>
      </button>
      {open && <div className="pl-6 pb-4">{children}</div>}
    </div>
  );
}

const ASCII_LOGO = `     _                    _    ___  ____
    / \\   __ _  ___ _ __ | |_ / _ \\/ ___|
   / _ \\ / _\` |/ _ \\ '_ \\| __| | | \\___ \\
  / ___ \\ (_| |  __/ | | | |_| |_| |___) |
 /_/   \\_\\__, |\\___|_| |_|\\__|\\___/|____/
         |___/`;

function StatsBox() {
  return (
    <pre className="text-[13px] leading-relaxed">
      <Dim>{"  ┌────────────────────────────────────────────────┐"}</Dim>
      {"\n"}
      <Dim>{"  │ "}</Dim>
      <Yellow>Functions</Yellow>
      {"    1,911   "}
      <Dim>│</Dim>
      {" "}
      <Yellow>Tests</Yellow>
      {"      1,789        "}
      <Dim>│</Dim>
      {"\n"}
      <Dim>{"  │ "}</Dim>
      <Yellow>Workers</Yellow>
      {"         51   "}
      <Dim>│</Dim>
      {" "}
      <Yellow>Rust Crates</Yellow>
      {"    18       "}
      <Dim>│</Dim>
      {"\n"}
      <Dim>{"  │ "}</Dim>
      <Yellow>LLM Providers</Yellow>
      {"   25   "}
      <Dim>│</Dim>
      {" "}
      <Yellow>Channels</Yellow>
      {"       40       "}
      <Dim>│</Dim>
      {"\n"}
      <Dim>{"  │ "}</Dim>
      <Yellow>Security Layers</Yellow>
      {" 18   "}
      <Dim>│</Dim>
      {" "}
      <Yellow>TUI Screens</Yellow>
      {"    25       "}
      <Dim>│</Dim>
      {"\n"}
      <Dim>{"  └────────────────────────────────────────────────┘"}</Dim>
    </pre>
  );
}

function FeatureBlock({
  title,
  lines,
}: {
  title: string;
  lines: string[];
}) {
  return (
    <div className="mb-4">
      <div>
        <Yellow>{"► "}</Yellow>
        <span className="font-semibold text-white">{title}</span>
      </div>
      {lines.map((line, i) => (
        <div key={i} className="text-[#a1a1aa] pl-4">
          {line}
        </div>
      ))}
    </div>
  );
}

function ArchBox({
  label,
  count,
  items,
}: {
  label: string;
  count: string;
  items: string[];
}) {
  const header = `─── ${label} (${count}) `;
  const pad = 52 - header.length;
  return (
    <pre className="text-[13px] leading-relaxed mb-2">
      <Dim>{"  ┌"}{header}{"─".repeat(Math.max(0, pad))}{"┐"}</Dim>
      {"\n"}
      {items.map((row, i) => (
        <span key={i}>
          <Dim>{"  │ "}</Dim>
          <Cyan>{row}</Cyan>
          {" ".repeat(Math.max(0, 50 - row.length))}
          <Dim>{"│"}</Dim>
          {"\n"}
        </span>
      ))}
      <Dim>{"  └"}{"─".repeat(52)}{"┘"}</Dim>
    </pre>
  );
}

export default function TerminalCanvas() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [introPhase, setIntroPhase] = useState(0);

  const motd = useTyping("cat /etc/motd", true);

  useEffect(() => {
    if (motd.done) {
      const t = setTimeout(() => setIntroPhase(1), 400);
      return () => clearTimeout(t);
    }
  }, [motd.done]);

  const stats = useTyping("agentos --stats", introPhase >= 1);

  useEffect(() => {
    if (stats.done) {
      const t = setTimeout(() => setIntroPhase(2), 300);
      return () => clearTimeout(t);
    }
  }, [stats.done]);

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-start justify-center p-2 sm:p-4 md:p-6">
      <div className="w-full max-w-4xl border border-[#333] rounded-lg overflow-hidden shadow-2xl shadow-black/80">
        <div className="flex items-center h-9 px-4 bg-[#1a1a1a] border-b border-[#333]">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
            <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
            <span className="w-3 h-3 rounded-full bg-[#28c840]" />
          </div>
          <div className="flex-1 text-center">
            <span className="text-[12px] text-[#71717a] font-mono">
              AgentOS v0.1.0
            </span>
          </div>
          <a
            href="https://agentsos.sh"
            className="text-[12px] text-[#52525b] hover:text-[#facc15] transition-colors font-mono"
          >
            agentsos.sh
          </a>
        </div>

        <div
          ref={scrollRef}
          className="p-4 sm:p-6 md:p-8 font-mono text-[13px] sm:text-[14px] leading-relaxed text-[#e4e4e7] overflow-y-auto max-h-[calc(100vh-80px)] scroll-smooth"
        >
          <div className="mb-6">
            <span className="text-[#22c55e]">$ </span>
            <span className="text-[#22c55e] font-semibold">
              {motd.displayed}
            </span>
            {!motd.done && <Cursor />}
          </div>

          {motd.done && (
            <>
              <pre className="text-[#facc15] text-[12px] sm:text-[13px] leading-tight mb-4 select-none">
                {ASCII_LOGO}
              </pre>
              <div className="mb-2 text-white font-semibold">
                The agent OS that evolves itself.
              </div>
              <div className="mb-6 text-[#a1a1aa]">
                Three primitives. 51 workers. 1,911 functions.
              </div>
            </>
          )}

          {introPhase >= 1 && (
            <div className="mb-6">
              <span className="text-[#22c55e]">$ </span>
              <span className="text-[#22c55e] font-semibold">
                {stats.displayed}
              </span>
              {!stats.done && <Cursor />}
            </div>
          )}

          {stats.done && (
            <>
              <div className="mb-8">
                <StatsBox />
              </div>

              <Section command="agentos explain" defaultOpen>
                <div className="space-y-3 text-[#a1a1aa]">
                  <p>
                    Most agent frameworks give you chains, graphs,
                    and prompt templates.
                  </p>
                  <p>AgentOS gives you three primitives:</p>
                  <pre className="text-[13px] leading-loose">
                    {"  "}
                    <Yellow>Worker</Yellow>
                    {"    A process that connects to the engine\n"}
                    {"  "}
                    <Yellow>Function</Yellow>
                    {"  A callable unit of work\n"}
                    {"  "}
                    <Yellow>Trigger</Yellow>
                    {"   Binds a function to HTTP, cron, queue"}
                  </pre>
                  <p>
                    That's it. Every capability — from LLM routing to
                    swarm coordination to self-evolving functions — is
                    a plain function on the iii-engine bus.
                  </p>
                </div>
              </Section>

              <Section command="agentos features --highlight" defaultOpen>
                <FeatureBlock
                  title="Self-Evolving Functions"
                  lines={[
                    "Agents write, test, and improve their own code",
                    "at runtime. evolve::generate → eval → feedback.",
                  ]}
                />
                <FeatureBlock
                  title="Memory Reflection"
                  lines={[
                    "Agents curate their own memory. Every 5 turns,",
                    "extract durable facts for future sessions.",
                  ]}
                />
                <FeatureBlock
                  title="Hashline Edits"
                  lines={[
                    "Hash-anchored line references prevent stale edits.",
                    "11#VK|function hello() {",
                    "Agent references hash, not content.",
                  ]}
                />
                <FeatureBlock
                  title="Multi-Agent Orchestration"
                  lines={[
                    "Plan features, decompose tasks, spawn workers,",
                    "monitor progress. Lifecycle state machine.",
                  ]}
                />
                <FeatureBlock
                  title="Session Recovery"
                  lines={[
                    "Health scanning classifies sessions as healthy,",
                    "degraded, dead, or unrecoverable. Auto-recovers.",
                  ]}
                />
                <FeatureBlock
                  title="25 LLM Providers"
                  lines={[
                    "Swap between Anthropic, OpenAI, Google, Ollama",
                    "or 20 others. One config change.",
                  ]}
                />
                <FeatureBlock
                  title="LSP Tools"
                  lines={[
                    "IDE-precision: rename, goto-def, find-refs,",
                    "diagnostics, symbols. In the terminal.",
                  ]}
                />
                <FeatureBlock
                  title="40 Channel Adapters"
                  lines={[
                    "Slack, Discord, WhatsApp, Telegram + 36 more.",
                    "Agents work where your team works.",
                  ]}
                />
              </Section>

              <Section command="agentos architecture">
                <ArchBox
                  label="Rust"
                  count="18 crates"
                  items={[
                    "cli  tui  security  memory  llm-router",
                    "wasm-sandbox  realm  hierarchy  directive",
                    "mission  ledger  council  pulse  bridge",
                  ]}
                />
                <ArchBox
                  label="TypeScript"
                  count="51 workers"
                  items={[
                    "agent-core  tools  channels  security  api",
                    "evolve  eval  feedback  orchestrator",
                    "recovery  lifecycle  hashline  lsp-tools",
                    "memory-reflection  task-decomposer",
                    "context-cache  swarm  knowledge-graph",
                  ]}
                />
                <ArchBox
                  label="Python"
                  count="1 worker"
                  items={["embeddings"]}
                />
              </Section>

              <Section command="agentos install">
                <div className="space-y-3">
                  <div className="bg-[#111] border border-[#333] rounded px-4 py-3 flex items-center justify-between">
                    <code className="text-[#e4e4e7] text-[13px]">
                      curl -fsSL https://raw.githubusercontent.com/
                      <wbr />
                      iii-hq/agentos/main/scripts/install.sh | sh
                    </code>
                    <CopyButton text="curl -fsSL https://raw.githubusercontent.com/iii-hq/agentos/main/scripts/install.sh | sh" />
                  </div>
                  <div className="bg-[#111] border border-[#333] rounded px-4 py-3 flex items-center justify-between">
                    <code className="text-[#e4e4e7] text-[13px]">
                      agentos start
                    </code>
                    <CopyButton text="agentos start" />
                  </div>
                  <p className="text-[#a1a1aa]">Two commands. Zero config.</p>
                </div>
              </Section>

              <Section command="agentos claude-code">
                <div className="space-y-3">
                  <div className="bg-[#111] border border-[#333] rounded px-4 py-3 flex items-center justify-between">
                    <code className="text-[#e4e4e7] text-[13px]">
                      claude mcp add agentos -- npx agentos mcp
                    </code>
                    <CopyButton text="claude mcp add agentos -- npx agentos mcp" />
                  </div>
                  <p className="text-[#a1a1aa]">
                    10 skills · 5 commands · 5 agents · 2 hooks
                  </p>
                  <p className="text-[#a1a1aa]">
                    One command to add AgentOS to Claude Code.
                  </p>
                </div>
              </Section>

              <div className="mt-8 mb-2 flex items-center">
                <Prompt>_</Prompt>
                <Cursor />
              </div>
            </>
          )}
        </div>

        <div className="h-9 px-4 flex items-center justify-between bg-[#1a1a1a] border-t border-[#333] text-[11px] text-[#52525b] font-mono">
          <span>Apache-2.0</span>
          <a
            href="https://github.com/iii-hq/agentos"
            className="hover:text-[#facc15] transition-colors"
          >
            github.com/iii-hq/agentos
          </a>
          <span>agentsos.sh</span>
        </div>
      </div>
    </div>
  );
}
