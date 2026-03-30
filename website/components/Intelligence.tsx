import { Brain, RefreshCw, GitBranch, HeartPulse, Workflow, Zap } from "lucide-react";
import FadeIn from "./shared/FadeIn";
import SectionHeader from "./shared/SectionHeader";

const capabilities = [
  {
    icon: Brain,
    title: "Memory Reflection",
    description:
      "Agents curate their own memory. Every 5 turns, a background reflection extracts durable facts and stores them for future sessions.",
    functions: ["reflect::check_turn", "reflect::curate_memory", "reflect::discover_skills"],
  },
  {
    icon: RefreshCw,
    title: "Structured Compression",
    description:
      "5-phase context compression: prune tool results, fix orphan pairs, merge system messages, protect recent context, generate structured summaries.",
    functions: ["context::compress"],
  },
  {
    icon: Workflow,
    title: "Session Lifecycle",
    description:
      "Formal state machine tracks sessions through spawning, working, blocked, and done. Declarative reaction rules auto-fire on transitions.",
    functions: ["lifecycle::transition", "lifecycle::add_reaction", "lifecycle::check_all"],
  },
  {
    icon: GitBranch,
    title: "Task Decomposition",
    description:
      "Recursive breakdown of complex tasks into subtasks with hierarchical IDs. Status propagates up the ancestor chain automatically.",
    functions: ["task::decompose", "task::update_status", "task::spawn_workers"],
  },
  {
    icon: HeartPulse,
    title: "Session Recovery",
    description:
      "Health scanning classifies sessions as healthy, degraded, dead, or unrecoverable. Auto-recovery wakes stale agents and resets circuit breakers.",
    functions: ["recovery::scan", "recovery::classify", "recovery::recover"],
  },
  {
    icon: Zap,
    title: "Signal Injection",
    description:
      "Push CI failures, review comments, and external events directly into agent sessions. Agents react without polling.",
    functions: ["feedback::inject_signal", "feedback::register_source"],
  },
];

export default function Intelligence() {
  return (
    <section id="intelligence" className="py-24">
      <div className="max-w-6xl mx-auto px-6">
        <SectionHeader
          badge="INTELLIGENCE"
          title="Agents That Improve Themselves"
          subtitle="Self-curating memory, structured compression, lifecycle management, and multi-agent orchestration. All through iii primitives."
        />

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {capabilities.map((cap, i) => (
            <FadeIn key={cap.title} delay={i * 80}>
              <div className="border border-white/[0.06] rounded-xl p-5 bg-card hover:border-primary/20 transition-colors h-full">
                <div className="flex items-center gap-2.5 mb-3">
                  <cap.icon className="w-4 h-4 text-primary shrink-0" />
                  <span className="font-mono font-semibold text-sm">{cap.title}</span>
                </div>
                <p className="text-muted text-xs leading-relaxed mb-3">{cap.description}</p>
                <div className="flex flex-wrap gap-1">
                  {cap.functions.map((fn) => (
                    <span
                      key={fn}
                      className="bg-white/5 border border-white/10 rounded-md px-2 py-0.5 text-[10px] font-mono text-zinc-500"
                    >
                      {fn}
                    </span>
                  ))}
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}
