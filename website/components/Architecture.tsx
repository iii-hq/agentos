import FadeIn from "./shared/FadeIn";
import SectionHeader from "./shared/SectionHeader";

const groups = [
  {
    label: "Reasoning",
    workers: ["agent-core", "llm-router", "council", "swarm", "directive", "mission"],
  },
  {
    label: "State",
    workers: ["realm", "memory", "ledger", "vault", "context-manager", "context-cache"],
  },
  {
    label: "Coordination",
    workers: ["orchestrator", "workflow", "hierarchy", "coordination", "task-decomposer"],
  },
  {
    label: "Execution",
    workers: ["wasm-sandbox", "browser", "code-agent", "hand-runner", "lsp-tools"],
  },
  {
    label: "Safety",
    workers: ["security", "security-headers", "security-map", "security-zeroize", "skill-security", "approval", "approval-tiers", "rate-limiter", "loop-guard"],
  },
  {
    label: "Surfaces",
    workers: ["a2a", "a2a-cards", "mcp-client", "skillkit-bridge", "bridge", "streaming"],
  },
  {
    label: "Channels",
    workers: ["channel-bluesky", "channel-discord", "channel-email", "channel-linkedin", "channel-mastodon", "channel-matrix", "channel-reddit", "channel-signal", "channel-slack", "channel-teams", "channel-telegram", "channel-twitch", "channel-webex", "channel-whatsapp"],
  },
  {
    label: "Telemetry",
    workers: ["telemetry", "pulse", "session-lifecycle", "session-replay", "feedback", "eval", "evolve", "hashline", "hooks", "cron"],
  },
  {
    label: "Embeddings",
    workers: ["embedding (python)"],
  },
];

export default function Architecture() {
  return (
    <section id="architecture" className="py-24">
      <div className="max-w-6xl mx-auto px-6">
        <SectionHeader
          badge="ARCHITECTURE"
          title="One Worker Per Domain"
          subtitle="65 narrow workers grouped by responsibility. Each is a single binary."
        />

        <div className="grid md:grid-cols-3 gap-3">
          {groups.map((g, i) => (
            <FadeIn key={g.label} delay={i * 60}>
              <div className="border border-white/6 rounded-xl p-5 bg-card">
                <div className="flex items-baseline justify-between mb-3">
                  <span className="font-mono font-semibold text-primary text-sm">
                    {g.label}
                  </span>
                  <span className="font-mono text-xs text-muted">
                    {g.workers.length}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {g.workers.map((w) => (
                    <span
                      key={w}
                      className="border border-white/10 bg-white/5 text-zinc-400 rounded-md px-2 py-0.5 text-[11px] font-mono"
                    >
                      {w}
                    </span>
                  ))}
                </div>
              </div>
            </FadeIn>
          ))}
        </div>

        <FadeIn delay={600}>
          <div className="mt-8 bg-primary/10 border border-primary/30 rounded-xl p-3 text-center">
            <span className="font-mono text-sm text-primary">
              iii-engine — Worker / Function / Trigger
            </span>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
