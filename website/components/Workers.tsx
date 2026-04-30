import { useEffect, useRef, useState } from "react";
import SectionHeader from "./SectionHeader";

type Worker = {
  name: string;
  ns: string;
  desc: string;
  badge: "FIRST-PARTY" | "ROUTER" | "DOCKER";
  snippet: string;
};

const workers: Worker[] = [
  {
    name: "agent-core",
    ns: "agent::*",
    desc: "ReAct loop. Routes LLM calls, tools, memory recall.",
    badge: "FIRST-PARTY",
    snippet: `iii.trigger("agent::chat",
  { message: "review PR #42" })`,
  },
  {
    name: "llm-router",
    ns: "llm::*",
    desc: "Provider-agnostic. Routes by cost, latency, or capability.",
    badge: "ROUTER",
    snippet: `iii.trigger("llm::route",
  { tier: "premium",
    prompt: "..." })`,
  },
  {
    name: "memory",
    ns: "memory::*",
    desc: "Store, recall, consolidate, evict. Hash-chained.",
    badge: "FIRST-PARTY",
    snippet: `iii.trigger("memory::search",
  { agentId: "alice",
    query: "deploy" })`,
  },
  {
    name: "wasm-sandbox",
    ns: "wasm::*",
    desc: "wasmtime, fuel-metered, sub-millisecond cold start.",
    badge: "FIRST-PARTY",
    snippet: `iii.trigger("wasm::execute",
  { module, args })`,
  },
  {
    name: "council",
    ns: "council::*",
    desc: "Proposals + hash-chained activity log.",
    badge: "FIRST-PARTY",
    snippet: `iii.trigger("council::submit",
  { realmId, kind: "hire" })`,
  },
  {
    name: "realm",
    ns: "realm::*",
    desc: "Multi-tenant isolation with export/import.",
    badge: "FIRST-PARTY",
    snippet: `iii.trigger("realm::create",
  { name: "prod" })`,
  },
  {
    name: "mcp-client",
    ns: "mcp::*",
    desc: "Speaks Model Context Protocol to external servers.",
    badge: "DOCKER",
    snippet: `iii.trigger("mcp::call",
  { server: "github",
    tool: "list_issues" })`,
  },
  {
    name: "hierarchy",
    ns: "hierarchy::*",
    desc: "Org graph. Cycle-safe DFS, capability search.",
    badge: "FIRST-PARTY",
    snippet: `iii.trigger("hierarchy::set",
  { agentId, title: "CEO" })`,
  },
];

export default function Workers() {
  const [active, setActive] = useState(0);
  const [typed, setTyped] = useState("");
  const trackRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setActive((i) => (i + 1) % workers.length), 4200);
    return () => clearInterval(t);
  }, [paused]);

  useEffect(() => {
    setTyped("");
    const target = workers[active].snippet;
    let i = 0;
    const t = setInterval(() => {
      i++;
      setTyped(target.slice(0, i));
      if (i >= target.length) clearInterval(t);
    }, 22);
    return () => clearInterval(t);
  }, [active]);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const card = el.children[active] as HTMLElement | undefined;
    if (card) {
      el.scrollTo({ left: card.offsetLeft - el.offsetLeft - 16, behavior: "smooth" });
    }
  }, [active]);

  return (
    <section
      id="workers"
      className="py-24 border-b border-line"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="mx-auto px-6" style={{ maxWidth: "min(1240px, 92vw)" }}>
        <SectionHeader num="06" label="Workers" />

        <h2 className="h-display text-[36px] md:text-[48px] mb-4 max-w-[24ch]">
          Every category, <em>one shape</em>.
        </h2>
        <p className="lede text-[15.5px] mb-12">
          65 workers. Each is a Cargo binary plus an iii.worker.yaml. The shape of
          a memory worker, a sandbox worker, and a Slack channel worker is the same.
        </p>

        <div
          ref={trackRef}
          className="flex gap-4 overflow-x-auto pb-4 snap-x snap-mandatory"
          style={{ scrollbarWidth: "none" }}
        >
          {workers.map((w, i) => (
            <div
              key={w.name}
              className="worker-card flex-shrink-0 snap-start cursor-pointer"
              data-active={i === active}
              onClick={() => setActive(i)}
            >
              <div className="flex items-baseline justify-between mb-3">
                <span className="font-mono text-[13px] text-fg">{w.name}</span>
                <span className={w.badge === "FIRST-PARTY" ? "first-party-badge" : "docker-badge"}>
                  {w.badge}
                </span>
              </div>
              <div className="font-mono text-[11px] text-fg-3 mb-3">{w.ns}</div>
              <p className="text-[13.5px] text-fg-2 mb-4 leading-relaxed">{w.desc}</p>
              <div className="bg-2 border border-line rounded-[3px] p-3 font-mono text-[11.5px] text-fg leading-relaxed min-h-[78px]">
                {i === active ? (
                  <span className="typewriter whitespace-pre">{typed}</span>
                ) : (
                  <span className="whitespace-pre opacity-60">{w.snippet}</span>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 flex items-center justify-between">
          <div className="font-mono text-[10.5px] text-fg-3 tracking-[0.18em] uppercase">
            8 of 65 · auto-advances every 4.2s
          </div>
          <div className="flex gap-1.5">
            {workers.map((_, i) => (
              <button
                key={i}
                onClick={() => setActive(i)}
                aria-label={`worker ${i + 1}`}
                className="w-1.5 h-1.5 rounded-full transition-colors"
                style={{
                  background: i === active ? "var(--accent)" : "var(--line-strong)",
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
