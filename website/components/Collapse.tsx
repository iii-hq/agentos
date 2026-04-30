import SectionHeader from "./SectionHeader";
import { Wordmark } from "./Icons";

const NODES = 10;
const SIZE = 360;

function MeshDiagram() {
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const r = SIZE * 0.42;
  const points = Array.from({ length: NODES }).map((_, i) => {
    const a = (i * 2 * Math.PI) / NODES - Math.PI / 2;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });

  const edges: [number, number][] = [];
  for (let i = 0; i < NODES; i++) for (let j = i + 1; j < NODES; j++) edges.push([i, j]);

  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
      {edges.map(([i, j], k) => (
        <line
          key={k}
          x1={points[i].x}
          y1={points[i].y}
          x2={points[j].x}
          y2={points[j].y}
          stroke="var(--line-strong)"
          strokeWidth={0.7}
          opacity={0.55}
        />
      ))}
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={3.5} fill="var(--fg)" />
      ))}
    </svg>
  );
}

function HubDiagram() {
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const r = SIZE * 0.42;
  const hubR = 28;
  const points = Array.from({ length: NODES }).map((_, i) => {
    const a = (i * 2 * Math.PI) / NODES - Math.PI / 2;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), a };
  });

  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
      {points.map((p, i) => (
        <line
          key={`l${i}`}
          x1={cx + hubR * Math.cos(p.a)}
          y1={cy + hubR * Math.sin(p.a)}
          x2={p.x}
          y2={p.y}
          stroke="var(--line-strong)"
          strokeWidth={1}
          strokeDasharray="3 4"
        />
      ))}
      {points.map((p, i) => (
        <line
          key={`p${i}`}
          x1={p.x}
          y1={p.y}
          x2={cx + (hubR + 4) * Math.cos(p.a)}
          y2={cy + (hubR + 4) * Math.sin(p.a)}
          stroke="var(--accent)"
          strokeWidth={1.4}
          strokeDasharray="4 76"
          className="ping-flow"
          style={{ animationDelay: `${i * 0.36}s` }}
        />
      ))}
      {points.map((p, i) => (
        <circle key={`n${i}`} cx={p.x} cy={p.y} r={3.5} fill="var(--fg)" />
      ))}
      <circle cx={cx} cy={cy} r={hubR} fill="var(--bg)" stroke="var(--accent)" strokeWidth={1.6} />
      <g transform={`translate(${cx - 10} ${cy - 10})`} color="var(--fg)">
        <Wordmark size={20} />
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
            <div className="eyebrow mb-6">Assemble</div>
            <MeshDiagram />
            <div className="mt-6 text-center">
              <div className="font-mono text-[11.5px] text-fg-3 tracking-[0.12em] uppercase mb-2">
                Agent framework + queue + sandbox + state + obs + …
              </div>
              <div className="font-mono text-[10.5px] text-fg-3">n(n−1)/2 · custom glue</div>
            </div>
          </div>

          <div className="border-r border-b border-line p-8 flex flex-col items-center">
            <div className="eyebrow mb-6 text-accent">Collapse</div>
            <HubDiagram />
            <div className="mt-6 text-center">
              <div className="font-mono text-[11.5px] text-fg-3 tracking-[0.12em] uppercase mb-2">
                65 workers · one engine · three primitives
              </div>
              <div className="font-mono text-[10.5px] text-fg-3">1 surface · live discovery</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
