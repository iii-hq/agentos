import { useState, useRef } from "react";
import { ArrowRight } from "lucide-react";
import FadeIn from "./shared/FadeIn";
import SectionHeader from "./shared/SectionHeader";
import CodeBlock from "./shared/CodeBlock";

const tabs = [
  {
    label: "TypeScript",
    lang: "typescript",
    filename: "agent.ts",
    code: `import { registerWorker } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "./shared/config.js";

const sdk = registerWorker(ENGINE_URL, { workerName: "coder", otel: OTEL_CONFIG });
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

registerFunction(
  {
    id: "review::analyze",
    description: "Review a PR",
    metadata: { category: "tools" },
    request_format: [
      { name: "pr", type: "number", required: true, description: "PR number" },
    ],
  },
  async (input: { pr: number }) => {
    const diff = await trigger({
      function_id: "tool::git_diff",
      payload: { pr: input.pr },
    });
    const issues = await trigger({
      function_id: "llm::chat",
      payload: { prompt: "Find bugs in this diff", context: diff },
    });
    return { issues, count: issues.length };
  }
);

registerTrigger({
  type: "http",
  function_id: "review::analyze",
  config: { api_path: "api/review", http_method: "POST" },
});`,
  },
  {
    label: "Rust",
    lang: "rust",
    filename: "worker.rs",
    code: `use iii_sdk::{register_worker, InitOptions};
use serde_json::{json, Value};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let iii = register_worker("ws://localhost:49134", InitOptions::default());

    iii.register_function("review::analyze", |input: Value| async move {
        Ok(json!({
            "status_code": 200,
            "body": { "ok": true, "input": input }
        }))
    });

    iii.register_trigger(
        "http",
        "review::analyze",
        json!({ "api_path": "api/review", "http_method": "POST" })
    )?;

    tokio::signal::ctrl_c().await?;
    Ok(())
}`,
  },
  {
    label: "Python",
    lang: "python",
    filename: "embed.py",
    code: `from iii import register_worker

iii = register_worker("ws://localhost:49134")

async def generate_embedding(input: dict) -> dict:
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer("all-MiniLM-L6-v2")
    vec = model.encode(input["text"]).tolist()
    return {"embedding": vec, "dimensions": len(vec)}

iii.register_function("embed::generate", generate_embedding)

iii.register_trigger(
    type="http",
    function_id="embed::generate",
    config={"api_path": "api/embed", "http_method": "POST"},
)

iii.listen()`,
  },
];

const flow = [
  { label: "Trigger", sub: "HTTP POST" },
  { label: "Function", sub: "review::analyze" },
  { label: "trigger()", sub: "tool::git_diff" },
  { label: "trigger()", sub: "llm::chat" },
];

export default function CodeExamples() {
  const [active, setActive] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const selectTab = (index: number) => {
    setActive(index);
    tabRefs.current[index]?.focus();
  };

  return (
    <section id="code" className="py-24">
      <div className="max-w-6xl mx-auto px-6">
        <SectionHeader
          badge="CODE"
          title="This is an Agent"
          subtitle="Worker, Function, Trigger. That's it. No chains, no DAGs, no prompt templates."
        />

        <FadeIn>
          <div role="tablist" className="flex gap-1 mb-4">
            {tabs.map((tab, i) => (
              <button
                key={tab.label}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                role="tab"
                aria-selected={active === i}
                aria-controls={`tabpanel-${i}`}
                id={`tab-${i}`}
                onClick={() => setActive(i)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight") {
                    selectTab((active + 1) % tabs.length);
                  } else if (e.key === "ArrowLeft") {
                    selectTab((active - 1 + tabs.length) % tabs.length);
                  }
                }}
                className={`px-4 py-2 text-sm font-mono transition-colors rounded-t-lg ${
                  active === i
                    ? "bg-primary/20 text-primary border-b-2 border-primary"
                    : "text-muted hover:text-white"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div
            role="tabpanel"
            id={`tabpanel-${active}`}
            aria-labelledby={`tab-${active}`}
          >
            <CodeBlock
              code={tabs[active].code}
              lang={tabs[active].lang}
              filename={tabs[active].filename}
            />
          </div>
        </FadeIn>

        <FadeIn delay={200} className="mt-8">
          <div className="flex items-center justify-center gap-3 flex-wrap">
            {flow.map((step, i) => (
              <div key={`${step.label}-${i}`} className="flex items-center gap-3">
                <div className="border border-primary/30 rounded-lg px-4 py-2 bg-card text-center">
                  <div className="font-mono font-semibold text-sm text-primary">
                    {step.label}
                  </div>
                  <div className="text-muted text-xs font-mono">{step.sub}</div>
                </div>
                {i < flow.length - 1 && (
                  <ArrowRight size={14} className="text-zinc-600" />
                )}
              </div>
            ))}
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
