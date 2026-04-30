import SectionHeader from "./SectionHeader";

const groups = [
  { label: "Reasoning", workers: ["agent-core", "llm-router", "council", "swarm", "directive", "mission"] },
  { label: "State", workers: ["realm", "memory", "ledger", "vault", "context-manager", "context-cache"] },
  { label: "Coordination", workers: ["orchestrator", "workflow", "hierarchy", "coordination", "task-decomposer"] },
  { label: "Execution", workers: ["wasm-sandbox", "browser", "code-agent", "hand-runner", "lsp-tools"] },
  { label: "Safety", workers: ["security", "security-headers", "security-map", "security-zeroize", "skill-security", "approval", "approval-tiers", "rate-limiter", "loop-guard"] },
  { label: "Surfaces", workers: ["a2a", "a2a-cards", "mcp-client", "skillkit-bridge", "bridge", "streaming"] },
  { label: "Channels", workers: ["bluesky", "discord", "email", "linkedin", "mastodon", "matrix", "reddit", "signal", "slack", "teams", "telegram", "twitch", "webex", "whatsapp"] },
  { label: "Telemetry", workers: ["telemetry", "pulse", "session-lifecycle", "session-replay", "feedback", "eval", "evolve", "hashline", "hooks", "cron"] },
  { label: "Embeddings", workers: ["embedding (python)"] },
];

export default function Counts() {
  return (
    <section id="counts" className="py-24 border-b border-line">
      <div className="mx-auto px-6" style={{ maxWidth: "min(1240px, 92vw)" }}>
        <SectionHeader num="10" label="Inventory" />

        <h2 className="h-display text-[36px] md:text-[48px] mb-12 max-w-[26ch]">
          The <em>full inventory</em>.
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 border-t border-l border-line">
          {groups.map((g) => (
            <div key={g.label} className="border-r border-b border-line p-6">
              <div className="flex items-baseline justify-between mb-4">
                <span className="eyebrow">{g.label}</span>
                <span className="font-mono text-[11.5px] text-fg-3">{g.workers.length}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {g.workers.map((w) => (
                  <span
                    key={w}
                    className="font-mono text-[11px] text-fg-2 border border-line bg-2 px-2 py-0.5 rounded-[3px]"
                  >
                    {w}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
