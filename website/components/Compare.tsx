import { useEffect, useState } from "react";
import FadeIn from "./shared/FadeIn";
import SectionHeader from "./shared/SectionHeader";

interface Benchmark {
  metric: string;
  unit: string;
  direction: "lower" | "higher";
  data: { name: string; value: number }[];
}

const benchmarks: Benchmark[] = [
  {
    metric: "Cold Start",
    unit: "ms",
    direction: "lower",
    data: [
      { name: "AgentOS", value: 48 },
      { name: "OpenClaw", value: 5980 },
      { name: "CrewAI", value: 3000 },
      { name: "LangGraph", value: 2500 },
      { name: "AutoGen", value: 4000 },
    ],
  },
  {
    metric: "Idle Memory",
    unit: "MB",
    direction: "lower",
    data: [
      { name: "AgentOS", value: 12 },
      { name: "OpenClaw", value: 394 },
      { name: "CrewAI", value: 200 },
      { name: "LangGraph", value: 180 },
      { name: "AutoGen", value: 250 },
    ],
  },
  {
    metric: "Install Size",
    unit: "MB",
    direction: "lower",
    data: [
      { name: "AgentOS", value: 25 },
      { name: "OpenClaw", value: 500 },
      { name: "CrewAI", value: 100 },
      { name: "LangGraph", value: 150 },
      { name: "AutoGen", value: 200 },
    ],
  },
  {
    metric: "Security Layers",
    unit: "",
    direction: "higher",
    data: [
      { name: "AgentOS", value: 18 },
      { name: "OpenClaw", value: 3 },
      { name: "CrewAI", value: 1 },
      { name: "LangGraph", value: 2 },
      { name: "AutoGen", value: 2 },
    ],
  },
  {
    metric: "Channel Adapters",
    unit: "",
    direction: "higher",
    data: [
      { name: "AgentOS", value: 40 },
      { name: "OpenClaw", value: 15 },
      { name: "CrewAI", value: 4 },
      { name: "LangGraph", value: 1 },
      { name: "AutoGen", value: 3 },
    ],
  },
  {
    metric: "LLM Providers",
    unit: "",
    direction: "higher",
    data: [
      { name: "AgentOS", value: 25 },
      { name: "OpenClaw", value: 20 },
      { name: "CrewAI", value: 5 },
      { name: "LangGraph", value: 15 },
      { name: "AutoGen", value: 10 },
    ],
  },
];

function formatValue(value: number, unit: string): string {
  if (unit === "ms" && value >= 1000) {
    return `${(value / 1000).toFixed(1)}s`;
  }
  return `${value}${unit ? ` ${unit}` : ""}`;
}

function TransitionBar({
  width,
  isUs,
  delay,
}: {
  width: number;
  isUs: boolean;
  delay: number;
}) {
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    setRendered(false);
    const timer = setTimeout(() => setRendered(true), 30);
    return () => clearTimeout(timer);
  }, [width]);

  return (
    <div className="h-5 rounded-sm overflow-hidden bg-white/[0.03]">
      <div
        className={`h-full rounded-sm transition-all duration-700 ease-out ${isUs ? "bg-primary" : "bg-white/10"}`}
        style={{
          width: rendered ? `${width}%` : "0%",
          transitionDelay: `${delay}ms`,
        }}
      />
    </div>
  );
}

const rows: { feature: string; values: string[] }[] = [
  {
    feature: "Language",
    values: [
      "Rust + TS + Python",
      "TypeScript",
      "Python only",
      "Python + TS",
      "Python + .NET",
    ],
  },
  {
    feature: "Multi-agent",
    values: [
      "Swarms, crews, hierarchies",
      "Sub-agents (depth-limited)",
      "Crews + Flows",
      "Supervisor + Swarm",
      "Swarm, FSM, hierarchy",
    ],
  },
  {
    feature: "Memory",
    values: [
      "Knowledge graph + vector",
      "File-based markdown",
      "Unified memory (LanceDB)",
      "Checkpoints + stores",
      "ChromaDB + GraphRAG",
    ],
  },
  {
    feature: "Observability",
    values: [
      "Session replay built-in",
      "ClawMetry (third-party)",
      "AgentOps (third-party)",
      "LangSmith + Studio",
      "OpenTelemetry export",
    ],
  },
  {
    feature: "Security",
    values: [
      "RBAC + WASM sandbox + vault",
      "Opt-in Docker sandbox",
      "Enterprise only",
      "Enterprise only",
      "Docker sandbox",
    ],
  },
  {
    feature: "Tools",
    values: [
      "60+ built-in + MCP + A2A",
      "50+ tools",
      "31 built-in tools",
      "LangChain tools",
      "MCP tools",
    ],
  },
  {
    feature: "Skill ecosystem",
    values: [
      "SkillKit (universal)",
      "ClawHub (13K+)",
      "31 built-in tools",
      "LangChain Hub (prompts)",
      "No marketplace",
    ],
  },
  {
    feature: "Desktop app",
    values: ["Tauri 2.0", "None", "None", "None", "Studio (web)"],
  },
  {
    feature: "License",
    values: ["Apache-2.0", "MIT", "MIT", "MIT", "CC-BY-4.0"],
  },
];

const columns = ["AgentOS", "OpenClaw", "CrewAI", "LangGraph", "AutoGen"];

export default function Compare() {
  const [active, setActive] = useState(0);
  const current = benchmarks[active];
  const max = Math.max(...current.data.map((d) => d.value));
  const sorted = [...current.data].sort((a, b) =>
    current.direction === "lower" ? a.value - b.value : b.value - a.value,
  );

  return (
    <section id="compare" className="py-24">
      <div className="max-w-6xl mx-auto px-6">
        <SectionHeader
          badge="COMPARE"
          title="Measured, Not Marketed"
          subtitle="All data from official documentation and public repositories."
        />

        <FadeIn>
          <div className="flex justify-center gap-2 mb-10 flex-wrap">
            {benchmarks.map((b, i) => (
              <button
                key={b.metric}
                onClick={() => setActive(i)}
                className={`px-4 py-2 text-xs font-mono rounded-lg transition-colors ${
                  active === i
                    ? "bg-primary/20 text-primary border border-primary/30"
                    : "bg-card border border-white/6 text-muted hover:text-white"
                }`}
              >
                {b.metric}
              </button>
            ))}
          </div>

          <div className="max-w-2xl mx-auto space-y-3">
            {sorted.map((d, i) => {
              const isUs = d.name === "AgentOS";
              const pct = (d.value / max) * 100;
              return (
                <div key={d.name} className="flex items-center gap-3">
                  <span
                    className={`w-24 text-xs font-mono text-right shrink-0 ${isUs ? "text-primary font-semibold" : "text-muted"}`}
                  >
                    {d.name}
                  </span>
                  <div className="flex-1">
                    <TransitionBar
                      width={Math.max(pct, 2)}
                      isUs={isUs}
                      delay={i * 80}
                    />
                  </div>
                  <span
                    className={`w-16 text-xs font-mono text-right ${isUs ? "text-primary font-semibold" : "text-zinc-400"}`}
                  >
                    {formatValue(d.value, current.unit)}
                  </span>
                </div>
              );
            })}
          </div>

          <p className="text-center text-muted text-[10px] font-mono mt-4">
            {current.direction === "lower"
              ? "lower is better"
              : "higher is better"}
          </p>
        </FadeIn>

        <FadeIn delay={200}>
          <div className="mt-20">
            <h3 className="font-mono font-semibold text-lg text-center mb-2">
              Feature-by-Feature
            </h3>
            <p className="text-center text-muted text-xs font-mono mb-8">
              AgentOS vs OpenClaw vs CrewAI vs LangGraph vs AutoGen
            </p>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse font-mono text-sm">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="text-left py-3 pr-4 text-muted font-medium text-xs sticky left-0 bg-black z-10 min-w-[110px]" />
                    {columns.map((name) => (
                      <th
                        key={name}
                        className={`py-3 px-3 text-center text-xs min-w-[130px] ${name === "AgentOS" ? "text-primary font-semibold" : "text-muted font-medium"}`}
                      >
                        {name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.feature}
                      className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors"
                    >
                      <td className="py-3 pr-4 text-zinc-300 text-xs font-medium sticky left-0 bg-black z-10">
                        {row.feature}
                      </td>
                      {row.values.map((val, j) => (
                        <td
                          key={columns[j]}
                          className={`py-3 px-3 text-center text-[11px] leading-tight ${j === 0 ? "text-primary" : "text-zinc-400"}`}
                        >
                          {val}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
