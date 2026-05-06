import type { SVGProps } from "react";

const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.3,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function IconWorker(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <rect x="2.5" y="3" width="11" height="2.2" />
      <rect x="2.5" y="6.9" width="11" height="2.2" />
      <rect x="2.5" y="10.8" width="11" height="2.2" />
    </svg>
  );
}

export function IconFunction(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M3 12c2 0 2-8 4-8s2 8 4 8 2-3 2-3" />
    </svg>
  );
}

export function IconTrigger(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M8 1.5L4 9h4l-1 5.5L12 7H8z" />
    </svg>
  );
}

export function IconArrow(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M3 8h10" />
      <path d="M9 4l4 4-4 4" />
    </svg>
  );
}

export function IconTerminal(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <rect x="1.5" y="2.5" width="13" height="11" />
      <path d="M4 6l2.5 2L4 10" />
      <path d="M8 11h4" />
    </svg>
  );
}

export function IconRoute(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <circle cx="3" cy="4" r="1.4" />
      <circle cx="13" cy="12" r="1.4" />
      <path d="M3 5.4v3.2c0 1 .8 1.8 1.8 1.8h2.6c1 0 1.8-.8 1.8-1.8V7.4c0-1 .8-1.8 1.8-1.8h2" />
    </svg>
  );
}

export function IconSignal(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M2 13c0-3 1.5-6 6-6s6 3 6 6" />
      <path d="M5 13c0-2 1-4 3-4s3 2 3 4" />
      <circle cx="8" cy="13" r="0.8" fill="currentColor" />
    </svg>
  );
}

export function IconPlug(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <rect x="5" y="2" width="6" height="6" rx="0.4" />
      <path d="M7 2V0.5M9 2V0.5" />
      <path d="M8 8v3M8 11c-1.4 0-2.5 1.1-2.5 2.5h5C10.5 12.1 9.4 11 8 11z" />
    </svg>
  );
}

export function IconBroadcast(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <circle cx="8" cy="8" r="1.4" />
      <path d="M5 5a4.2 4.2 0 0 0 0 6M11 5a4.2 4.2 0 0 1 0 6" />
      <path d="M3 3a7 7 0 0 0 0 10M13 3a7 7 0 0 1 0 10" />
    </svg>
  );
}

export function IconStream(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M2 5c2-1 4 1 6 0s4 1 6 0" />
      <path d="M2 8c2-1 4 1 6 0s4 1 6 0" />
      <path d="M2 11c2-1 4 1 6 0s4 1 6 0" />
    </svg>
  );
}

export function IconShield(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <path d="M8 1.5l5.5 2v4.2c0 3.6-2.6 5.8-5.5 6.8-2.9-1-5.5-3.2-5.5-6.8V3.5z" />
      <path d="M5.8 8.2L7.4 9.8 10.4 6.5" />
    </svg>
  );
}

export function IconClock(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  );
}

export function IconDB(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...p}>
      <ellipse cx="8" cy="3.5" rx="5" ry="1.8" />
      <path d="M3 3.5v9c0 1 2.2 1.8 5 1.8s5-.8 5-1.8v-9" />
      <path d="M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8" />
    </svg>
  );
}

export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1075.74 1075.74"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="0" y="0.05" width="268.94" height="268.94" />
      <rect x="0" y="403.45" width="268.94" height="672.24" />
      <rect x="403.4" y="0.05" width="268.94" height="268.94" />
      <rect x="403.4" y="403.45" width="268.94" height="672.24" />
      <rect x="806.81" y="0.05" width="268.94" height="268.94" />
      <rect x="806.81" y="403.45" width="268.94" height="672.24" />
    </svg>
  );
}
