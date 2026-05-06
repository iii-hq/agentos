import SectionHeader from "./SectionHeader";

const cases = [
  {
    title: "Conversational agent over channels",
    flow: ["channel-slack", "agent-core", "llm-router", "memory", "channel-slack"],
    body: "A Slack message becomes a Trigger, the agent worker reads memory, llm-router routes the call, the response goes back through the same channel worker.",
  },
  {
    title: "Sandboxed function dispatch",
    flow: ["agent-core", "approval", "wasm-sandbox", "hashline"],
    body: "Function calls pass through approval tiers, run in wasmtime with a fuel cap, and append to a hash-chained ledger.",
  },
  {
    title: "Multi-tenant org with budgets",
    flow: ["realm", "hierarchy", "directive", "ledger", "council"],
    body: "Realms isolate state. Hierarchy declares who reports to whom. Directives propagate goals. Ledger enforces spend. Council records decisions.",
  },
  {
    title: "Streaming completions to a browser",
    flow: ["streaming", "llm-router", "iii-stream"],
    body: "The streaming worker fans tokens out over iii-stream's WebSocket lane. Same Function shape; the engine handles the wire.",
  },
];

export default function UseCases() {
  return (
    <section id="usecases" className="py-24 border-b border-line">
      <div className="mx-auto px-6" style={{ maxWidth: "min(1240px, 92vw)" }}>
        <SectionHeader num="08" label="Use cases" />

        <h2 className="h-display text-[36px] md:text-[48px] mb-12 max-w-[26ch]">
          Concrete shapes the <em>collapse</em> takes.
        </h2>

        <div className="grid md:grid-cols-2 border-t border-l border-line">
          {cases.map((c) => (
            <div key={c.title} className="border-r border-b border-line p-7">
              <h3 className="font-serif text-[22px] mb-4">{c.title}</h3>
              <div className="flex flex-wrap items-center gap-1.5 mb-4">
                {c.flow.map((step, i) => (
                  <span key={i} className="flex items-center gap-1.5">
                    <span className="font-mono text-[11.5px] text-fg-2 border border-line bg-2 px-2 py-0.5 rounded-[3px]">
                      {step}
                    </span>
                    {i < c.flow.length - 1 && <span className="text-fg-3">→</span>}
                  </span>
                ))}
              </div>
              <p className="text-[14px] text-fg-2 leading-relaxed">{c.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
