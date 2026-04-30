import { useEffect, useState } from "react";
import EngineDiagram from "./EngineDiagram";
import { IconArrow, IconTerminal } from "./Icons";

const INSTALL = "curl -fsSL https://install.iii.dev/iii/main/install.sh | sh";

export default function Hero() {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(INSTALL);
      setCopied(true);
    } catch {
      /* no-op */
    }
  }

  return (
    <section id="thesis" className="pt-20 pb-28 border-b border-line">
      <div className="mx-auto px-6" style={{ maxWidth: "min(1240px, 92vw)" }}>
        <div className="flex items-baseline justify-between mb-10 pb-3 border-b border-line">
          <span className="eyebrow">§ 01 · Thesis</span>
          <span className="page-counter">01 / 11</span>
        </div>

        <div className="grid lg:grid-cols-[1.4fr_1fr] gap-14 items-start">
          <div>
            <h1 className="h-display text-[44px] sm:text-[56px] md:text-[68px]">
              An agent OS<br />
              built as <em>narrow workers</em><br />
              on iii primitives.
            </h1>

            <p className="lede mt-8 text-[16.5px]">
              65 Rust binaries, one domain each. Every capability — reasoning, state,
              sandboxing, channels — is a Function on a Worker, bound to a Trigger.
              The engine carries the rest.
            </p>

            <div className="mt-10 flex items-center gap-3 flex-wrap">
              <button onClick={copy} className="btn font-mono">
                <IconTerminal />
                <span>{copied ? "copied" : INSTALL}</span>
              </button>
              <a href="#primitives" className="btn btn-primary">
                read primitives <span className="arrow"><IconArrow /></span>
              </a>
            </div>

            <div className="mt-12 flex items-center gap-8 text-[12px] font-mono text-fg-3">
              <span>65 workers</span>
              <span className="opacity-50">·</span>
              <span>257 functions</span>
              <span className="opacity-50">·</span>
              <span>1281 tests</span>
              <span className="opacity-50">·</span>
              <span>iii-sdk 0.11.4-next.4</span>
            </div>
          </div>

          <div className="hidden lg:flex items-center justify-center">
            <EngineDiagram size={380} />
          </div>
        </div>
      </div>
    </section>
  );
}
