import { Link } from "react-router-dom";
import {
  Rocket,
  Layers,
  Terminal,
  Code,
  Cpu,
  Shield,
  Radio,
  Bot,
  Puzzle,
  Network,
  Workflow,
  BookOpen,
  Server,
  Monitor,
  FileCode,
} from "lucide-react";
import { docs, categories } from "./docs-data";

const iconMap: Record<string, React.ElementType> = {
  "getting-started": Rocket,
  primitives: Layers,
  architecture: Cpu,
  configuration: Terminal,
  security: Shield,
  "llm-providers": Bot,
  channels: Radio,
  agents: Code,
  skills: Puzzle,
  "mcp-a2a": Network,
  workflows: Workflow,
  cli: BookOpen,
  api: Server,
  desktop: Monitor,
  examples: FileCode,
};

const grouped = categories.map((cat) => ({
  category: cat,
  items: docs.filter((d) => d.category === cat),
}));

const stats = [
  { label: "Rust Crates", value: "10" },
  { label: "Channels", value: "40+" },
  { label: "CLI Commands", value: "50+" },
  { label: "API Endpoints", value: "60+" },
];

export default function DocsHome() {
  return (
    <div>
      <h1 className="font-mono font-bold text-3xl mb-3">AgentOS Docs</h1>
      <p className="text-muted font-mono text-sm mb-8 max-w-xl">
        Everything you need to install, configure, and operate AgentOS.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-12">
        {stats.map((s) => (
          <div
            key={s.label}
            className="bg-card border border-white/6 rounded-xl p-4 text-center"
          >
            <div className="font-mono font-bold text-xl text-primary">
              {s.value}
            </div>
            <div className="font-mono text-[11px] text-muted mt-1">
              {s.label}
            </div>
          </div>
        ))}
      </div>

      <div className="bg-card border border-white/6 rounded-xl p-4 mb-12">
        <p className="font-mono text-xs text-muted mb-2">Quick install</p>
        <code className="font-mono text-sm text-primary">
          curl -fsSL https://agentos.dev/install -o install.sh && sh install.sh
        </code>
      </div>

      {grouped.map((group) => (
        <div key={group.category} className="mb-10">
          <h2 className="font-mono font-semibold text-sm text-muted uppercase tracking-wider mb-4">
            {group.category}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {group.items.map((doc) => {
              const Icon = iconMap[doc.slug] || FileCode;
              return (
                <Link
                  key={doc.slug}
                  to={`/docs/${doc.slug}`}
                  className="bg-card border border-white/6 rounded-xl p-4 card-hover group"
                >
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0 mt-0.5">
                      <Icon size={16} />
                    </div>
                    <div>
                      <h3 className="font-mono font-semibold text-sm group-hover:text-primary transition-colors">
                        {doc.title}
                      </h3>
                      <p className="text-muted text-xs font-mono mt-1 leading-relaxed">
                        {doc.desc}
                      </p>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
