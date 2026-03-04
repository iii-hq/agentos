import { useState } from "react";
import { ArrowRight } from "lucide-react";
import FadeIn from "./shared/FadeIn";
import SectionHeader from "./shared/SectionHeader";
import CodeBlock from "./shared/CodeBlock";

const tabs = [
  {
    label: "TypeScript",
    lang: "typescript",
    filename: "agent.ts",
    code: `import { worker, fn } from "iii-sdk";

const review = fn("review", async (pr: string) => {
  const diff = await tools.git.diff(pr);
  const issues = await llm.complete("find bugs", diff);
  return { issues, count: issues.length };
});

export default worker("coder", {
  tools: ["git", "code", "search"],
  channels: ["slack", "github"],
}, async (req) => {
  const result = await review(req.body.pr);
  await channels.slack.send(result);
  return result;
});`,
  },
  {
    label: "Rust",
    lang: "rust",
    filename: "worker.rs",
    code: `use iii_sdk::worker;

#[worker]
async fn coder(input: Request) -> Response {
    let task = input.body::<Task>().await?;
    let result = tools::code::review(&task.pr_url).await?;
    let summary = llm::complete("summarize", &result).await?;
    Response::json(&summary)
}`,
  },
  {
    label: "Python",
    lang: "python",
    filename: "embed.py",
    code: `from iii_sdk import worker, fn

@fn("embed")
async def generate_embedding(text: str) -> list[float]:
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer("all-MiniLM-L6-v2")
    return model.encode(text).tolist()

@worker("embedder")
async def handle(request):
    text = request.body["text"]
    embedding = await generate_embedding(text)
    return {"embedding": embedding, "dimensions": len(embedding)}`,
  },
];

const flow = [
  { label: "Trigger", sub: "HTTP" },
  { label: "Worker", sub: "coder" },
  { label: "Function", sub: "review" },
  { label: "Channel", sub: "slack" },
];

export default function CodeExamples() {
  const [active, setActive] = useState(0);

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
                role="tab"
                aria-selected={active === i}
                aria-controls={`tabpanel-${i}`}
                id={`tab-${i}`}
                onClick={() => setActive(i)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight") {
                    setActive((active + 1) % tabs.length);
                  } else if (e.key === "ArrowLeft") {
                    setActive((active - 1 + tabs.length) % tabs.length);
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
              <div key={step.label} className="flex items-center gap-3">
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
