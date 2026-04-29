import { useState, useEffect, useRef } from "react";
import { ArrowRight } from "lucide-react";
import AnimatedCounter from "./shared/AnimatedCounter";
import FadeIn from "./shared/FadeIn";
import { stats } from "../data/stats";

const TERMINAL_LINES = [
  { text: "$ curl -fsSL https://install.iii.dev/iii/main/install.sh | sh", type: "command" },
  { text: "  > iii v0.11.4 installed", type: "success" },
  { text: "$ iii --config config.yaml", type: "command" },
  { text: "  > engine listening ws://127.0.0.1:49134", type: "success" },
  { text: "  > 65 workers connected, 257 functions registered", type: "info" },
  { text: '$ iii trigger agent::chat \'{"message":"review PR #42"}\'', type: "command" },
  { text: "  Review complete. 3 issues found.", type: "success" },
];

const CHAR_DELAY = 30;
const LINE_PAUSE = 600;

function useTypingAnimation() {
  const [lines, setLines] = useState<string[]>([]);
  const [currentLine, setCurrentLine] = useState(0);
  const [currentChar, setCurrentChar] = useState(0);
  const [done, setDone] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    if (done) return;
    if (currentLine >= TERMINAL_LINES.length) {
      setDone(true);
      return;
    }

    const fullText = TERMINAL_LINES[currentLine].text;

    if (currentChar < fullText.length) {
      timeoutRef.current = setTimeout(() => {
        setLines((prev) => {
          const updated = [...prev];
          updated[currentLine] = fullText.slice(0, currentChar + 1);
          return updated;
        });
        setCurrentChar((c) => c + 1);
      }, CHAR_DELAY);
    } else {
      timeoutRef.current = setTimeout(() => {
        setCurrentLine((l) => l + 1);
        setCurrentChar(0);
        setLines((prev) => [...prev, ""]);
      }, LINE_PAUSE);
    }

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [currentLine, currentChar, done]);

  useEffect(() => {
    setLines([""]);
  }, []);

  return { lines, currentLine, done };
}

function TerminalLine({ text, type }: { text: string; type: string }) {
  if (type === "command") {
    const spaceIndex = text.indexOf(" ");
    const splitAt = spaceIndex === -1 ? text.length : spaceIndex;
    return (
      <div className="font-mono text-sm leading-relaxed">
        <span className="text-muted">{text.slice(0, splitAt)}</span>
        <span className="text-white">{text.slice(splitAt)}</span>
      </div>
    );
  }

  if (type === "success") {
    return (
      <div className="font-mono text-sm leading-relaxed text-primary">
        {text}
      </div>
    );
  }

  return (
    <div className="font-mono text-sm leading-relaxed text-zinc-400">
      {text}
    </div>
  );
}

export default function Hero() {
  const { lines, currentLine, done } = useTypingAnimation();

  return (
    <section className="relative min-h-screen flex items-center overflow-hidden">
      <div className="absolute inset-0 grid-pattern" />
      <div className="absolute inset-0 glow-yellow" />

      <div className="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 w-full pt-20 pb-16">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          <div>
            <FadeIn>
              <h1 className="text-5xl md:text-7xl font-mono font-bold tracking-tight mb-6">
                <span className="text-primary">Agent</span>OS
                <br />
                <span className="text-zinc-400 text-4xl md:text-5xl">
                  The Agent Operating System
                </span>
              </h1>
            </FadeIn>

            <FadeIn delay={100}>
              <p className="text-muted text-base md:text-lg mb-10 max-w-lg leading-relaxed font-mono">
                Narrow workers on iii primitives. Rust binaries. One domain
                each. Plug and play.
              </p>
            </FadeIn>

            <FadeIn delay={200}>
              <div className="flex gap-8 mb-10">
                {stats.map((stat, i) => (
                  <div key={stat.label} className="text-center">
                    <div className="text-2xl md:text-3xl font-mono font-bold text-primary">
                      <AnimatedCounter
                        end={stat.value}
                        duration={1800 + i * 100}
                      />
                    </div>
                    <div className="text-xs text-muted mt-1 font-mono">
                      {stat.label}
                    </div>
                  </div>
                ))}
              </div>
            </FadeIn>

            <FadeIn delay={300}>
              <div className="flex flex-wrap gap-3">
                <a
                  href="#quickstart"
                  className="bg-primary hover:bg-primary-hover text-black rounded-lg px-6 py-3 font-mono font-semibold transition-colors inline-flex items-center gap-2"
                >
                  Get Started <ArrowRight size={16} />
                </a>
                <a
                  href="https://github.com/iii-hq/agentos"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="border border-white/20 hover:border-primary/40 text-white rounded-lg px-6 py-3 font-mono font-medium transition-colors"
                >
                  GitHub
                </a>
              </div>
            </FadeIn>
          </div>

          <FadeIn delay={400} className="hidden lg:block">
            <div className="rounded-xl border border-white/6 bg-card overflow-hidden shadow-2xl shadow-black/50">
              <div className="flex items-center gap-2 px-4 py-3 border-b border-white/6 bg-surface">
                <div className="flex gap-1.5">
                  <span className="w-3 h-3 rounded-full bg-primary/60" />
                  <span className="w-3 h-3 rounded-full bg-white/20" />
                  <span className="w-3 h-3 rounded-full bg-white/10" />
                </div>
                <span className="text-xs text-muted font-mono ml-2">
                  agentos
                </span>
              </div>

              <div className="p-5 min-h-[220px]">
                {lines.map((text, i) => {
                  if (!text && i === lines.length - 1 && !done) {
                    return (
                      <div key={i} className="font-mono text-sm">
                        <span className="typing-cursor">&nbsp;</span>
                      </div>
                    );
                  }
                  if (!text) return null;
                  return (
                    <div key={i} className="flex">
                      <TerminalLine
                        text={text}
                        type={TERMINAL_LINES[i]?.type || "command"}
                      />
                      {i === currentLine && !done && (
                        <span className="typing-cursor">&nbsp;</span>
                      )}
                    </div>
                  );
                })}
                {done && (
                  <div className="font-mono text-sm mt-1">
                    <span className="text-muted">$</span>
                    <span className="typing-cursor">&nbsp;</span>
                  </div>
                )}
              </div>
            </div>
          </FadeIn>
        </div>
      </div>
    </section>
  );
}
