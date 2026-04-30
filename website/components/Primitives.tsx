import SectionHeader from "./SectionHeader";
import { IconWorker, IconFunction, IconTrigger } from "./Icons";

const primitives = [
  {
    Icon: IconWorker,
    name: "Worker",
    desc: "One Rust binary per domain. Connects to the engine over WebSocket. Stays narrow.",
    example: "agentos-llm-router · agentos-memory · agentos-realm",
  },
  {
    Icon: IconFunction,
    name: "Function",
    desc: "A named handler registered by a worker. Returns Value or IIIError.",
    example: "agent::chat · llm::route · memory::search",
  },
  {
    Icon: IconTrigger,
    name: "Trigger",
    desc: "Binds a Function to HTTP, cron, or pub/sub. Declared per Function.",
    example: "POST /v1/chat → agent::chat",
  },
];

export default function Primitives() {
  return (
    <section id="primitives" className="py-24 border-b border-line">
      <div className="mx-auto px-6" style={{ maxWidth: "min(1240px, 92vw)" }}>
        <SectionHeader num="03" label="Primitives" />

        <h2 className="h-display text-[36px] md:text-[48px] mb-14 max-w-[20ch]">
          Three primitives. <em>That's the whole protocol.</em>
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 border-t border-l border-line">
          {primitives.map((p) => {
            const Icon = p.Icon;
            return (
              <div key={p.name} className="border-r border-b border-line p-7">
                <div className="flex items-center gap-3 mb-4">
                  <Icon />
                  <span className="eyebrow">{p.name}</span>
                </div>
                <h3 className="font-serif text-[24px] mb-3">{p.name}</h3>
                <p className="text-[14.5px] text-fg-2 mb-5 leading-relaxed">{p.desc}</p>
                <div className="font-mono text-[11.5px] text-fg-3 break-words">
                  {p.example}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
