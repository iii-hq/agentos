import FadeIn from "./shared/FadeIn";
import SectionHeader from "./shared/SectionHeader";

const layers = [
  {
    lang: "Rust",
    count: "18 crates",
    items: ["cli", "tui", "security", "memory", "llm-router", "wasm-sandbox", "realm", "hierarchy", "directive", "mission", "ledger", "council", "pulse", "bridge"],
    accent: "border-primary/30 bg-primary/5",
    pill: "bg-primary/10 border-primary/20 text-primary/80",
    label: "text-primary",
  },
  {
    lang: "TypeScript",
    count: "39 workers",
    items: ["agent-core", "tools", "channels", "security", "api", "integrations", "swarm", "knowledge-graph"],
    accent: "border-white/10 bg-white/[0.02]",
    pill: "bg-white/5 border-white/10 text-zinc-400",
    label: "text-white",
  },
  {
    lang: "Python",
    count: "1 worker",
    items: ["embeddings"],
    accent: "border-white/10 bg-white/[0.02]",
    pill: "bg-white/5 border-white/10 text-zinc-400",
    label: "text-white",
  },
];

export default function Architecture() {
  return (
    <section id="architecture" className="py-24">
      <div className="max-w-6xl mx-auto px-6">
        <SectionHeader
          badge="ARCHITECTURE"
          title="Three Languages, One System"
          subtitle="Rust for performance. TypeScript for flexibility. Python for AI."
        />

        <div className="space-y-0">
          {layers.map((layer, i) => (
            <FadeIn key={layer.lang} delay={i * 120}>
              {i > 0 && <div className="w-px h-3 bg-white/10 mx-auto" />}
              <div className={`border rounded-xl p-5 ${layer.accent}`}>
                <div className="flex items-center gap-3 mb-3">
                  <span className={`font-mono font-semibold ${layer.label}`}>{layer.lang}</span>
                  <span className="text-xs font-mono bg-white/5 text-muted px-2 py-0.5 rounded-full">{layer.count}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {layer.items.map((item) => (
                    <span key={item} className={`border rounded-md px-2.5 py-1 text-xs font-mono ${layer.pill}`}>
                      {item}
                    </span>
                  ))}
                </div>
              </div>
            </FadeIn>
          ))}

          <div className="w-px h-3 bg-white/10 mx-auto" />

          <FadeIn delay={400}>
            <div className="bg-primary/10 border border-primary/30 rounded-xl p-3 text-center">
              <span className="font-mono text-sm text-primary">
                iii-engine (Worker / Function / Trigger)
              </span>
            </div>
          </FadeIn>
        </div>
      </div>
    </section>
  );
}
