import { IconArrow, Wordmark } from "./Icons";

const tiles = [
  {
    roman: "i",
    title: "Read the source",
    meta: "github.com/iii-experimental/agentos",
    href: "https://github.com/iii-experimental/agentos",
    primary: true,
  },
  {
    roman: "ii",
    title: "Build a worker",
    meta: "rust · node · python",
    href: "https://github.com/iii-experimental/agentos/tree/main/workers",
    primary: false,
  },
  {
    roman: "iii",
    title: "Talk to the team",
    meta: "discussions · rfcs",
    href: "https://github.com/iii-experimental/agentos/discussions",
    primary: false,
  },
];

export default function Footer() {
  return (
    <footer className="border-b border-line">
      <section className="py-24 border-b border-line">
        <div className="mx-auto px-6" style={{ maxWidth: "min(1240px, 92vw)" }}>
          <div className="grid md:grid-cols-2 gap-12 items-start mb-16">
            <div>
              <div className="eyebrow mb-4">Manifesto</div>
              <p className="h-display text-[26px] md:text-[32px]">
                AgentOS isn't competing with one agent framework. It's competing with{" "}
                <em>the need to assemble a runtime from category-shaped tools</em> —
                queues, sandboxes, schedulers, observers — every time you ship an agent.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-2">
              <div className="grid grid-cols-[10ch_1fr] gap-4 py-2 border-b border-line">
                <span className="struck font-mono text-[12px]">add another platform</span>
                <span className="font-serif italic text-fg">collapse the categories</span>
              </div>
              <div className="grid grid-cols-[10ch_1fr] gap-4 py-2 border-b border-line">
                <span className="struck font-mono text-[12px]">teach the model your DSL</span>
                <span className="font-serif italic text-fg">teach it three nouns</span>
              </div>
              <div className="grid grid-cols-[10ch_1fr] gap-4 py-2 border-b border-line">
                <span className="struck font-mono text-[12px]">bespoke agent runtime</span>
                <span className="font-serif italic text-fg">narrow workers on iii</span>
              </div>
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            {tiles.map((t) => (
              <a
                key={t.roman}
                href={t.href}
                target="_blank"
                rel="noopener noreferrer"
                className={`cta-tile ${t.primary ? "primary" : ""}`}
              >
                <div className="flex items-baseline justify-between mb-4">
                  <span className="font-serif text-[28px]">{t.roman}</span>
                  <span className="arrow"><IconArrow /></span>
                </div>
                <div className="font-mono text-[12.5px] mb-2">{t.title}</div>
                <div className="font-mono text-[10.5px] tracking-[0.12em] uppercase opacity-70">
                  {t.meta}
                </div>
              </a>
            ))}
          </div>
        </div>
      </section>

      <div className="py-8">
        <div className="mx-auto px-6 flex items-center justify-between flex-wrap gap-4" style={{ maxWidth: "min(1240px, 92vw)" }}>
          <div className="flex items-center gap-3 text-fg-3">
            <Wordmark size={20} />
            <span className="font-mono text-[10.5px] tracking-[0.18em] uppercase">
              agentos · apache-2.0 · v0.0.1
            </span>
          </div>
          <div className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-fg-3">
            65 workers · 257 functions · iii-sdk 0.11.4-next.4
          </div>
        </div>
      </div>
    </footer>
  );
}
