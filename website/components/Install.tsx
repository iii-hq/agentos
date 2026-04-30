import { useState } from "react";
import SectionHeader from "./SectionHeader";

const STEPS = [
  {
    label: "Install iii engine",
    cmd: "curl -fsSL https://install.iii.dev/iii/main/install.sh | sh",
  },
  {
    label: "Clone agentos",
    cmd: "git clone https://github.com/iii-experimental/agentos && cd agentos",
  },
  {
    label: "Build all 64 Rust workers",
    cmd: "cargo build --workspace --release",
  },
  {
    label: "Boot the engine",
    cmd: "iii --config config.yaml &",
  },
  {
    label: "Start workers (background)",
    cmd: "for w in target/release/agentos-*; do \"./$w\" & done",
  },
];

export default function Install() {
  const [copied, setCopied] = useState<number | null>(null);

  async function copy(i: number, cmd: string) {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(i);
      setTimeout(() => setCopied(null), 1400);
    } catch {
      /* no-op */
    }
  }

  return (
    <section id="install" className="py-24 border-b border-line">
      <div className="mx-auto px-6" style={{ maxWidth: "min(1240px, 92vw)" }}>
        <SectionHeader num="11" label="Install" />

        <h2 className="h-display text-[36px] md:text-[48px] mb-12 max-w-[20ch]">
          Five steps. <em>Plug and play.</em>
        </h2>

        <ol className="border-t border-l border-line">
          {STEPS.map((s, i) => (
            <li key={i} className="grid grid-cols-[40px_1fr_auto] border-r border-b border-line items-center">
              <div className="self-stretch flex items-center justify-center border-r border-line py-4 font-mono text-[12px] text-fg-3">
                {String(i + 1).padStart(2, "0")}
              </div>
              <div className="px-5 py-4">
                <div className="eyebrow mb-1.5">{s.label}</div>
                <code className="font-mono text-[12.5px] text-fg break-all">{s.cmd}</code>
              </div>
              <button
                onClick={() => copy(i, s.cmd)}
                className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-fg-3 hover:text-fg px-4 py-2 border-l border-line self-stretch"
              >
                {copied === i ? "copied" : "copy"}
              </button>
            </li>
          ))}
        </ol>

        <div className="mt-8 grid sm:grid-cols-3 gap-6 text-[12.5px] text-fg-3 font-mono">
          <div>
            <div className="eyebrow mb-1">Engine WS</div>
            ws://127.0.0.1:49134
          </div>
          <div>
            <div className="eyebrow mb-1">HTTP triggers</div>
            http://127.0.0.1:3111
          </div>
          <div>
            <div className="eyebrow mb-1">Streams</div>
            ws://127.0.0.1:3112
          </div>
        </div>
      </div>
    </section>
  );
}
