import SectionHeader from "./SectionHeader";

const standpoints = [
  {
    role: "Application engineers",
    want: "Code I can write today.",
    body: "Register a Function. Bind a Trigger. Call from anywhere. The shape is the same whether the function is `agent::chat`, `memory::recall`, or your own.",
  },
  {
    role: "Platform teams",
    want: "Publish capabilities without bespoke SDKs.",
    body: "Each worker is a Cargo binary plus an iii.worker.yaml. Drop it into config.yaml. The engine starts it and routes Functions over WebSocket.",
  },
  {
    role: "AI agents",
    want: "A surface small enough to reason about.",
    body: "Three primitives. No DAGs, chains, or graph DSLs. The same Function shape used by humans is the one you call.",
  },
  {
    role: "Decision makers",
    want: "Architectural tax we stop paying.",
    body: "Stop assembling agent runtimes from chat libraries, queue libraries, sandbox libraries, and orchestrators. Run them all as Workers under one engine.",
  },
];

export default function Standpoints() {
  return (
    <section id="standpoints" className="py-24 border-b border-line">
      <div className="mx-auto px-6" style={{ maxWidth: "min(1240px, 92vw)" }}>
        <SectionHeader num="02" label="Standpoints" />

        <blockquote className="h-display text-[28px] sm:text-[34px] md:text-[40px] max-w-[26ch] mb-16">
          AgentOS isn't another agent framework. It's <em>what's left</em> when the
          runtime becomes someone else's problem.
        </blockquote>

        <div className="grid grid-cols-1 md:grid-cols-2 border-t border-l border-line">
          {standpoints.map((s) => (
            <div key={s.role} className="border-r border-b border-line p-7">
              <div className="eyebrow mb-3">{s.role}</div>
              <p className="font-serif italic text-[20px] mb-3 text-fg">"{s.want}"</p>
              <p className="text-[14.5px] text-fg-2 leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
