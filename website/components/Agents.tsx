import SectionHeader from "./SectionHeader";

export default function Agents() {
  return (
    <section id="agents" className="py-24 border-b border-line">
      <div className="mx-auto px-6" style={{ maxWidth: "min(1240px, 92vw)" }}>
        <SectionHeader num="04" label="Agents" />

        <div className="grid lg:grid-cols-[1.4fr_1fr] gap-14 items-start">
          <div>
            <h2 className="h-display text-[36px] md:text-[48px] mb-8 max-w-[24ch]">
              A small surface <em>is the feature</em>.
            </h2>
            <p className="lede text-[16px] mb-6">
              Agent frameworks teach the model their abstractions — chains,
              graphs, prompt templates. AgentOS teaches it three nouns. Every
              capability — the agent's own and its environment's — is a Function
              call.
            </p>
            <p className="lede text-[16px]">
              Workers are discoverable at runtime. Functions self-describe. Triggers
              declare their bindings. The agent reasons about the same surface a
              human reads.
            </p>
          </div>

          <div className="border border-line bg-2 p-7 rounded-[3px]">
            <div className="eyebrow mb-4">What an agent sees</div>
            <ul className="space-y-3 text-[13.5px] font-mono text-fg-2">
              <li><span className="text-fg-3">fn </span>agent::chat(message)</li>
              <li><span className="text-fg-3">fn </span>llm::route(prompt, tier)</li>
              <li><span className="text-fg-3">fn </span>memory::search(query)</li>
              <li><span className="text-fg-3">fn </span>realm::create(name)</li>
              <li><span className="text-fg-3">fn </span>wasm::execute(module, args)</li>
              <li><span className="text-fg-3">fn </span>council::submit(proposal)</li>
              <li className="text-fg-3 italic">… 251 more</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
