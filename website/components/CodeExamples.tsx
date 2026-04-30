import { useState } from "react";
import SectionHeader from "./SectionHeader";

type Lang = "rust" | "node" | "python" | "cli";

const samples: Record<Lang, string> = {
  rust: `use iii_sdk::{InitOptions, RegisterFunction, register_worker};
use iii_sdk::error::IIIError;
use serde_json::{json, Value};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let iii = register_worker("ws://localhost:49134", InitOptions::default());

    iii.register_function(
        RegisterFunction::new_async("analyst::summarize", |input: Value| async move {
            let topic = input["topic"].as_str().unwrap_or("");
            Ok::<Value, IIIError>(json!({ "summary": format!("on {}", topic) }))
        })
        .description("Summarize a topic"),
    );

    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}`,
  node: `import { registerWorker } from "iii-sdk";

const iii = registerWorker("ws://localhost:49134", { workerName: "analyst" });

iii.registerFunction(
  {
    id: "analyst::summarize",
    description: "Summarize a topic",
    request_format: [{ name: "topic", type: "string", required: true }],
  },
  async ({ topic }) => ({ summary: \`on \${topic}\` })
);

iii.registerTrigger({
  type: "http",
  function_id: "analyst::summarize",
  config: { api_path: "v1/summarize", http_method: "POST" },
});`,
  python: `from iii_sdk import III

iii = III("ws://localhost:49134", worker_name="analyst")

@iii.function(id="analyst::summarize", description="Summarize a topic")
async def summarize(input):
    return {"summary": f"on {input['topic']}"}

iii.register_trigger(
    type="http",
    function_id="analyst::summarize",
    config={"api_path": "v1/summarize", "http_method": "POST"},
)`,
  cli: `# from another worker, or a script
iii trigger analyst::summarize --json '{"topic":"category collapse"}'

# inline HTTP
curl -X POST http://127.0.0.1:3111/v1/summarize \\
  -H 'Content-Type: application/json' \\
  -d '{"topic":"category collapse"}'`,
};

const tabs: { id: Lang; label: string }[] = [
  { id: "rust", label: "Rust" },
  { id: "node", label: "Node" },
  { id: "python", label: "Python" },
  { id: "cli", label: "CLI" },
];

export default function CodeExamples() {
  const [tab, setTab] = useState<Lang>("rust");
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(samples[tab]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* no-op */
    }
  }

  return (
    <section id="code" className="py-24 border-b border-line">
      <div className="mx-auto px-6" style={{ maxWidth: "min(1240px, 92vw)" }}>
        <SectionHeader num="07" label="Code" />

        <h2 className="h-display text-[36px] md:text-[48px] mb-12 max-w-[24ch]">
          One surface. <em>Every language.</em>
        </h2>

        <div className="border border-line rounded-[3px] overflow-hidden">
          <div className="flex items-center justify-between border-b border-line bg-2">
            <div className="flex">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  className="tab"
                  data-active={tab === t.id}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <button
              onClick={copy}
              className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-fg-3 hover:text-fg px-4 py-2"
            >
              {copied ? "copied" : "copy"}
            </button>
          </div>
          <pre className="code-block !border-0 !rounded-none !bg-transparent text-[12.5px]">
            {samples[tab]}
          </pre>
        </div>
      </div>
    </section>
  );
}
