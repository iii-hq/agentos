import { Wordmark } from "./Icons";

type Theme = "cream" | "dark" | "light";

type Props = {
  theme: Theme;
  onCycle: () => void;
};

const links = [
  { id: "thesis", label: "01 Thesis" },
  { id: "primitives", label: "03 Primitives" },
  { id: "workers", label: "06 Workers" },
  { id: "code", label: "07 Code" },
  { id: "collapse", label: "09 Collapse" },
  { id: "install", label: "11 Install" },
];

export default function TopNav({ theme, onCycle }: Props) {
  return (
    <header className="sticky top-0 z-30 border-b border-line backdrop-blur-sm bg-base/85">
      <div className="mx-auto px-6 h-14 flex items-center justify-between" style={{ maxWidth: "min(1240px, 92vw)" }}>
        <a href="#thesis" className="flex items-center gap-3">
          <Wordmark size={22} />
          <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-fg-2">agentos</span>
        </a>
        <nav className="hidden md:flex items-center gap-5">
          {links.map((l) => (
            <a
              key={l.id}
              href={`#${l.id}`}
              className="font-mono text-[11px] tracking-[0.06em] uppercase text-fg-3 hover:text-fg transition-colors"
            >
              {l.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <button
            onClick={onCycle}
            aria-label="cycle theme"
            className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-fg-3 hover:text-fg border border-line px-2 py-1 rounded-[3px]"
          >
            {theme}
          </button>
          <a
            href="https://github.com/iii-experimental/agentos"
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-fg-3 hover:text-fg"
          >
            github
          </a>
        </div>
      </div>
    </header>
  );
}
