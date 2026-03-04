import { Shield, Cpu, Network, Layers, Plug, Gauge } from "lucide-react";
import FadeIn from "./shared/FadeIn";
import SectionHeader from "./shared/SectionHeader";

const reasons = [
  {
    icon: Cpu,
    title: "Rust Core, Not a Wrapper",
    description:
      "10 Rust crates handle security, memory, LLM routing, and WASM sandboxing. Not a Python script calling APIs. Real systems programming where it matters.",
  },
  {
    icon: Layers,
    title: "Three Primitives, Zero Boilerplate",
    description:
      "Worker, Function, Trigger. That's the entire model. No DAGs, no chains, no prompt templates. Every agent composes from the same three building blocks.",
  },
  {
    icon: Shield,
    title: "18 Security Layers, Fail-Closed",
    description:
      "RBAC, Merkle audit trails, WASM sandboxing, encrypted vault, timing-safe HMAC. Every operation denied by default. Not bolted on after the fact.",
  },
  {
    icon: Network,
    title: "40 Channels, Not Just Chat",
    description:
      "Slack, Discord, GitHub, Linear, email, SMS, webhooks, and 32 more. Agents that work where your team works, not trapped in a chat window.",
  },
  {
    icon: Plug,
    title: "25 LLM Providers, No Lock-In",
    description:
      "Swap between Anthropic, OpenAI, Google, Mistral, Ollama, or any of 20 others. One config change. Same agent code.",
  },
  {
    icon: Gauge,
    title: "Built on iii-engine",
    description:
      "18% overhead vs raw function calls. BullMQ has 973%. Real benchmarks, not marketing. Workers that run at infrastructure speed.",
  },
];

export default function Why() {
  return (
    <section id="why" className="py-24">
      <div className="max-w-6xl mx-auto px-6">
        <SectionHeader
          badge="WHY AGENTOS"
          title="Not Another Agent Framework"
          subtitle="An operating system for agents. Security, routing, memory, and channels built into the kernel."
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
