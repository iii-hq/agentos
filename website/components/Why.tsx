import { Shield, Cpu, Network, Layers, Plug, Gauge } from "lucide-react";
import FadeIn from "./shared/FadeIn";
import SectionHeader from "./shared/SectionHeader";

const reasons = [
  {
    icon: Cpu,
    title: "Rust binaries, not wrappers",
    description:
      "65 Rust workers handle reasoning, state, sandboxing, and channel I/O. Each is a single binary. The engine starts them, the SDK speaks to them, that's it.",
  },
  {
    icon: Layers,
    title: "Three primitives",
    description:
      "Worker, Function, Trigger. That is the entire model. No DAGs, no chains, no prompt templates. Every agent composes from the same three building blocks.",
  },
  {
    icon: Shield,
    title: "Security as workers",
    description:
      "Approval, vault, RBAC realm, WASM sandbox, hashline ledger, security-headers, security-zeroize, skill-security. Each is its own worker, swappable, deny-by-default.",
  },
  {
    icon: Network,
    title: "Channels are workers too",
    description:
      "Slack, Discord, Email, Telegram, Matrix, Reddit, Webex, and seven more. Same Worker shape. Add one by dropping a binary into config.yaml.",
  },
  {
    icon: Plug,
    title: "Provider-agnostic LLM router",
    description:
      "One worker (`llm-router`) routes by cost, latency, or capability. Same agent code regardless of which provider answers.",
  },
  {
    icon: Gauge,
    title: "Engine handles the rest",
    description:
      "iii-engine routes Functions, dispatches Triggers, persists state, ships traces. Workers stay narrow because the engine carries the plumbing.",
  },
];

export default function Why() {
  return (
    <section id="why" className="py-24">
      <div className="max-w-6xl mx-auto px-6">
        <SectionHeader
          badge="WHY AGENTOS"
          title="An OS, Not a Framework"
          subtitle="Routing, memory, sandboxing, and channels live in the kernel as workers — not in your agent code."
        />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {reasons.map((reason, i) => {
            const Icon = reason.icon;
            return (
              <FadeIn key={reason.title} delay={i * 80}>
                <div className="flex gap-4">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0 mt-0.5">
                    <Icon size={20} />
                  </div>
                  <div>
                    <h3 className="font-mono font-semibold text-base mb-1.5">
                      {reason.title}
                    </h3>
                    <p className="text-muted text-sm font-mono leading-relaxed">
                      {reason.description}
                    </p>
                  </div>
                </div>
              </FadeIn>
            );
          })}
        </div>
      </div>
    </section>
  );
}
