import { Wordmark } from "./Icons";

type Props = {
  size?: number;
  ringColor?: string;
  showPings?: boolean;
};

const SPOKES = 8;

export default function EngineDiagram({ size = 360, ringColor = "var(--accent)", showPings = true }: Props) {
  const cx = size / 2;
  const cy = size / 2;
  const ringR = size * 0.42;
  const hubR = 28;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block">
      {Array.from({ length: SPOKES }).map((_, i) => {
        const angle = (i * 2 * Math.PI) / SPOKES - Math.PI / 2;
        const x = cx + ringR * Math.cos(angle);
        const y = cy + ringR * Math.sin(angle);
        return (
          <g key={i}>
            <line
              x1={cx + hubR * Math.cos(angle)}
              y1={cy + hubR * Math.sin(angle)}
              x2={x}
              y2={y}
              stroke="var(--line-strong)"
              strokeWidth={1}
              strokeDasharray="3 4"
            />
            <circle cx={x} cy={y} r={3.5} fill="var(--fg)" />
          </g>
        );
      })}

      {showPings &&
        Array.from({ length: SPOKES }).map((_, i) => {
          const angle = (i * 2 * Math.PI) / SPOKES - Math.PI / 2;
          const startX = cx + (hubR + 4) * Math.cos(angle);
          const startY = cy + (hubR + 4) * Math.sin(angle);
          const endX = cx + ringR * Math.cos(angle);
          const endY = cy + ringR * Math.sin(angle);
          return (
            <line
              key={`p${i}`}
              x1={startX}
              y1={startY}
              x2={endX}
              y2={endY}
              stroke={ringColor}
              strokeWidth={1.4}
              strokeDasharray="4 76"
              className="ping-flow"
              style={{ animationDelay: `${i * 0.45}s` }}
            />
          );
        })}

      <circle cx={cx} cy={cy} r={hubR} fill="var(--bg)" stroke={ringColor} strokeWidth={1.6} />
      <g transform={`translate(${cx - 10} ${cy - 10})`} color="var(--fg)">
        <Wordmark size={20} />
      </g>
    </svg>
  );
}
