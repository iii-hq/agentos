import FadeIn from "./shared/FadeIn";
import SectionHeader from "./shared/SectionHeader";

const composition = [
  {
    primitive: "Worker",
    role: "One Rust binary per domain",
    examples: ["realm", "llm-router", "memory", "council", "wasm-sandbox"],
    count: 65,
  },
  {
    primitive: "Function",
    role: "Named handler registered per worker",
    examples: ["agent::chat", "llm::route", "memory::search", "realm::create"],
    count: 257,
  },
  {
    primitive: "Trigger",
    role: "HTTP route, cron, or event subscription",
    examples: [
      "POST /v1/chat → agent::chat",
      "cron(*/5) → pulse::tick",
      "subscribe(realm.created) → council::seed",
    ],
    count: null,
  },
];

const principles = [
  {
    title: "Narrow workers",
    body: "Each worker owns one domain and exposes a small function set. Rebuild and redeploy a single binary without touching the rest.",
  },
  {
    title: "iii primitives only",
    body: "No bespoke RPC, no shared bus, no service mesh. Workers register Functions and Triggers; the engine routes everything else.",
  },
  {
    title: "Plug and play",
    body: "Drop a worker into config.yaml. Engine starts it, wires triggers, and exposes its functions. Remove it the same way.",
  },
];

export default function Compare() {
  return (
    <section id="compose" className="py-24">
      <div className="max-w-6xl mx-auto px-6">
        <SectionHeader
          badge="HOW IT COMPOSES"
          title="Three Primitives, 65 Workers"
          subtitle="Worker, Function, Trigger. The engine handles the rest."
        />

        <FadeIn>
          <div className="grid md:grid-cols-3 gap-4 mb-16">
            {composition.map((c) => (
              <div
                key={c.primitive}
                className="rounded-lg border border-white/6 bg-card p-6"
              >
                <div className="flex items-baseline justify-between mb-3">
                  <h3 className="font-mono font-semibold text-primary">
                    {c.primitive}
                  </h3>
                  {c.count !== null && (
                    <span className="font-mono text-xs text-muted">
                      {c.count}
                    </span>
                  )}
                </div>
                <p className="text-zinc-300 text-sm font-mono mb-4 leading-relaxed">
                  {c.role}
                </p>
                <div className="space-y-1">
                  {c.examples.map((ex) => (
                    <div
                      key={ex}
                      className="font-mono text-[11px] text-zinc-400"
                    >
                      {ex}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </FadeIn>

        <FadeIn delay={150}>
          <div className="grid md:grid-cols-3 gap-6">
            {principles.map((p) => (
              <div key={p.title}>
                <h4 className="font-mono font-semibold text-sm text-white mb-2">
                  {p.title}
                </h4>
                <p className="text-muted text-xs font-mono leading-relaxed">
                  {p.body}
                </p>
              </div>
            ))}
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
