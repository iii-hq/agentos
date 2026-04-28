import { useEffect, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
import FadeIn from "./shared/FadeIn";
import SectionHeader from "./shared/SectionHeader";

const steps = [
  {
    cmd: "curl -fsSL https://raw.githubusercontent.com/iii-hq/agentos/main/scripts/install.sh | sh",
    desc: "Install iii-engine + AgentOS binary",
  },
  {
    cmd: "agentos init --quick",
    desc: "Scaffold a new agent project",
  },
  {
    cmd: "agentos config set-key anthropic $ANTHROPIC_API_KEY",
    desc: "Configure your LLM provider",
  },
  {
    cmd: "agentos start",
    desc: "Start the engine and all workers",
  },
  { cmd: "agentos chat default", desc: "Chat with your agent" },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <button
      onClick={copy}
      aria-label={copied ? "Copied to clipboard" : "Copy command"}
      className="text-zinc-500 hover:text-white transition-colors shrink-0 p-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

export default function Quickstart() {
  return (
    <section id="quickstart" className="py-24">
      <div className="max-w-6xl mx-auto px-6">
        <SectionHeader
          badge="GET STARTED"
          title="Up and Running in 60 Seconds"
          subtitle="From zero to agent in five commands"
        />

        <FadeIn>
          <div className="bg-surface border border-white/6 rounded-xl overflow-hidden max-w-2xl mx-auto">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-white/6">
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-primary/60" />
                <div className="w-3 h-3 rounded-full bg-white/20" />
                <div className="w-3 h-3 rounded-full bg-white/10" />
              </div>
              <span className="text-xs text-zinc-500 font-mono">terminal</span>
            </div>

            <div className="p-5 space-y-4">
              {steps.map((step, index) => (
                <div key={step.cmd} className="flex items-start gap-3">
                  <div className="bg-primary/20 text-primary w-6 h-6 rounded-full text-xs font-mono flex items-center justify-center shrink-0 mt-0.5">
                    {index + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <code className="font-mono text-sm text-white">
                        {step.cmd}
                      </code>
                      <CopyButton text={step.cmd} />
                    </div>
                    <p className="text-muted text-xs mt-0.5">{step.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
