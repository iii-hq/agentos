import { Wordmark } from "./Icons";

type Props = {
  size?: number;
  showPings?: boolean;
  showLabels?: boolean;
};

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

export default function EngineDiagram({
  size = 400,
  showPings = true,
  showLabels = false,
}: Props) {
  const cx = size / 2;
  const cy = size / 2;
  const ringR = size * 0.36;
  const labelR = ringR + 24;
  const hubR = 30;
  const N = NODE_LABELS.length;

  const nodes = Array.from({ length: N }).map((_, i) => {
    const angle = (i * 2 * Math.PI) / N - Math.PI / 2;
    return {
      x: cx + ringR * Math.cos(angle),
      y: cy + ringR * Math.sin(angle),
      angle,
      label: NODE_LABELS[i],
    };
  });

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block">
      {nodes.map((n, i) => (
        <line
          key={`s${i}`}
          x1={cx + hubR * Math.cos(n.angle)}
          y1={cy + hubR * Math.sin(n.angle)}
          x2={n.x}
          y2={n.y}
          stroke="var(--line-strong)"
          strokeWidth={1}
          strokeDasharray="3 4"
        />
      ))}

      {showPings &&
        nodes.map((n, i) => (
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

      {showLabels &&
        nodes.map((n, i) => {
          const lx = cx + labelR * Math.cos(n.angle);
          const ly = cy + labelR * Math.sin(n.angle);
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

      <circle cx={cx} cy={cy} r={hubR} fill="var(--bg)" stroke="var(--accent)" strokeWidth={1.6} />
      <g transform={`translate(${cx - 11} ${cy - 11})`} color="var(--fg)">
        <Wordmark size={22} />
      </g>
    </svg>
  );
}
