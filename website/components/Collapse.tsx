import SectionHeader from "./SectionHeader";
import { Wordmark } from "./Icons";

const NODE_LABELS = [
  "orchestrator",
  "db",
  "cache",
  "queue",
  "stream",
  "agent",
  "http",
  "cron",
  "obs",
  "memory",
];
const N = NODE_LABELS.length;
const SIZE = 400;
const cx = SIZE / 2;
const cy = SIZE / 2;
const R = 144;
const LR = R + 24;

type Node = { x: number; y: number; angle: number; label: string };

const nodes: Node[] = NODE_LABELS.map((label, i) => {
  const angle = (i * 2 * Math.PI) / N - Math.PI / 2;
  return {
    x: cx + R * Math.cos(angle),
    y: cy + R * Math.sin(angle),
    angle,
    label,
  };
});

const allEdges: [number, number][] = [];
for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) allEdges.push([i, j]);

function NodeLayer() {
  return (
    <>
      {nodes.map((n, i) => (
        <g key={`n${i}`}>
          <circle
            cx={n.x}
            cy={n.y}
            r={8}
            fill="var(--bg)"
            stroke="var(--fg)"
            strokeWidth={1.2}
          />
          <circle cx={n.x} cy={n.y} r={2.2} fill="var(--fg)" />
        </g>
      ))}
      {nodes.map((n, i) => {
        const lx = cx + LR * Math.cos(n.angle);
        const ly = cy + LR * Math.sin(n.angle);
        const cosA = Math.cos(n.angle);
        const anchor =
          Math.abs(cosA) < 0.2 ? "middle" : cosA > 0 ? "start" : "end";
        return (
          <text
            key={`l${i}`}
            x={lx}
            y={ly}
            textAnchor={anchor}
            dominantBaseline="middle"
            fontFamily="var(--font-mono)"
            fontSize="10.5"
            fill="var(--fg-3)"
          >
            {n.label}
          </text>
        );
      })}
    </>
  );
}

function MeshDiagram() {
  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
      {allEdges.map(([i, j], k) => (
        <line
          key={k}
          x1={nodes[i].x}
          y1={nodes[i].y}
          x2={nodes[j].x}
          y2={nodes[j].y}
          stroke="var(--line-strong)"
          strokeWidth={0.7}
          strokeDasharray="2 3"
          opacity={0.55}
        />
      ))}
      <NodeLayer />
    </svg>
  );
}

function HubDiagram() {
  const hubR = 30;
  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
      {nodes.map((n, i) => (
        <line
          key={`l${i}`}
          x1={cx + hubR * Math.cos(n.angle)}
          y1={cy + hubR * Math.sin(n.angle)}
          x2={n.x}
          y2={n.y}
          stroke="var(--line-strong)"
          strokeWidth={1}
          strokeDasharray="3 4"
        />
      ))}
      {nodes.map((n, i) => (
        <line
          key={`p${i}`}
          x1={n.x}
          y1={n.y}
          x2={cx + (hubR + 4) * Math.cos(n.angle)}
          y2={cy + (hubR + 4) * Math.sin(n.angle)}
          stroke="var(--accent)"
          strokeWidth={1.4}
          strokeDasharray="4 76"
          className="ping-flow"
          style={{ animationDelay: `${i * 0.36}s` }}
        />
      ))}
      <NodeLayer />
      <circle
        cx={cx}
        cy={cy}
        r={hubR}
        fill="var(--bg)"
        stroke="var(--accent)"
        strokeWidth={1.6}
      />
      <g transform={`translate(${cx - 11} ${cy - 11})`} color="var(--fg)">
        <Wordmark size={22} />
      </g>
    </svg>
  );
}

export default function Collapse() {
  return (
    <section id="collapse" className="py-24 border-b border-line">
      <div className="mx-auto px-6" style={{ maxWidth: "min(1240px, 92vw)" }}>
        <SectionHeader num="09" label="Category collapse" />

        <h2 className="h-display text-[36px] md:text-[48px] mb-12 max-w-[24ch]">
          Assemble<span className="text-fg-3"> →</span> <em>Collapse</em>.
        </h2>

        <div className="grid md:grid-cols-2 border-t border-l border-line">
          <div className="border-r border-b border-line p-8 flex flex-col items-center">
            <div className="eyebrow mb-6">Problem space</div>
            <MeshDiagram />
            <div className="mt-6 text-center">
              <div className="font-mono text-[11px] text-fg-3 mb-2">
                {allEdges.length} edges · n(n−1)/2
              </div>
              <div className="font-serif italic text-[15px] text-fg-2">
                Every category, every other category. Custom glue between each
                pair.
              </div>
            </div>
          </div>

          <div className="border-r border-b border-line p-8 flex flex-col items-center">
            <div className="eyebrow mb-6 text-accent">iii</div>
            <HubDiagram />
            <div className="mt-6 text-center">
              <div className="font-mono text-[11px] text-fg-3 mb-2">
                0 edges · O(0)
              </div>
              <div className="font-serif italic text-[15px] text-fg-2">
                Every worker, one bus. Live discovery, no glue.
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
