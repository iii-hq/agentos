import { registerWorker } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "../src/shared/config.js";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "crew-demo-runner",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { trigger: rawTrigger } = sdk;
const trigger = (id: string, payload: unknown, timeoutMs?: number) =>
  rawTrigger(
    timeoutMs !== undefined
      ? { function_id: id, payload, timeoutMs }
      : { function_id: id, payload },
  );

const AGENTS_DIR = "./agents";

async function loadAgents() {
  const agentDirs = readdirSync(AGENTS_DIR);
  let loaded = 0;

  for (const dir of agentDirs) {
    const tomlPath = join(AGENTS_DIR, dir, "agent.toml");
    if (!existsSync(tomlPath)) continue;

    const content = readFileSync(tomlPath, "utf-8");

    const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
    const descMatch = content.match(/^description\s*=\s*"([^"]+)"/m);
    const providerMatch = content.match(/^provider\s*=\s*"([^"]+)"/m);
    const modelMatch = content.match(/^model\s*=\s*"([^"]+)"/m);
    const maxTokensMatch = content.match(/^max_tokens\s*=\s*(\d+)/m);
    const promptMatch = content.match(/system_prompt\s*=\s*"""([\s\S]*?)"""/);

    const config = {
      name: nameMatch?.[1] || dir,
      description: descMatch?.[1] || "",
      model: {
        provider: providerMatch?.[1] || "anthropic",
        model: modelMatch?.[1] || "claude-sonnet-4-6",
        max_tokens: maxTokensMatch ? parseInt(maxTokensMatch[1]) : 4096,
      },
      capabilities: { tools: ["tool::*"] },
      system_prompt: promptMatch?.[1]?.trim() || "",
      tags: [],
    };

    try {
      await trigger("state::set", { scope: "agents", key: dir, value: config });
      loaded++;
    } catch {
      console.error(`  Failed to load: ${dir}`);
    }
  }

  console.log(`Loaded ${loaded} agents into state\n`);
  return loaded;
}

async function runDemo() {
  console.log("=== AgentOS Crew Demo ===\n");

  console.log("[1] Loading agent configs...");
  await loadAgents();

  console.log("[2] Running Startup Analyzer crew...");
  console.log("    (3 parallel analysts + orchestrator + security auditor)\n");

  const startTime = Date.now();

  try {
    const result: any = await trigger("crew::startup_analyzer", {
      idea: "An AI-powered code review tool that learns from team patterns and catches bugs before CI/CD",
      industry: "developer tools",
    }, 300_000);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n=== RESULT (${elapsed}s) ===`);
    console.log(`Agents used: ${result.agentsUsed?.join(", ")}`);
    console.log(`\n--- Synthesis ---`);
    console.log(result.synthesis?.substring(0, 2000));
    console.log("\n=== Demo Complete ===");
  } catch (e: any) {
    console.error(`\nCrew execution failed: ${e.message}`);
    console.error("This likely means the LLM provider (Anthropic) isn't configured.");
    console.error("Set ANTHROPIC_API_KEY environment variable to enable real LLM calls.\n");

    console.log("--- Showing system architecture instead ---\n");
    await showArchitecture();
  }

  process.exit(0);
}

async function showArchitecture() {
  console.log("AgentOS Running Infrastructure:\n");

  try {
    const functions = await trigger("functions::list", {});
    if (Array.isArray(functions)) {
      console.log(`  Registered functions: ${functions.length}`);
      const categories = new Map<string, number>();
      for (const f of functions) {
        const cat = (f.id || "").split("::")[0] || "other";
        categories.set(cat, (categories.get(cat) || 0) + 1);
      }
      for (const [cat, count] of [...categories.entries()].sort()) {
        console.log(`    ${cat}: ${count} functions`);
      }
    }
  } catch {
    console.log("  (Could not list functions)");
  }

  const agents = readdirSync(AGENTS_DIR).filter((d) =>
    existsSync(join(AGENTS_DIR, d, "agent.toml")),
  );
  console.log(`\n  Agent templates loaded: ${agents.length}`);
  console.log(`  Agents: ${agents.slice(0, 15).join(", ")}...`);

  console.log("\n  Crew patterns available:");
  console.log("    - Sequential (blog-writer): researcher -> writer -> reviewer -> writer");
  console.log("    - Parallel (startup-analyzer): 3 analysts || -> orchestrator -> security");
  console.log("    - Swarm (debate): observe -> propose -> vote -> synthesize");

  console.log("\n  Workers running: 19 (9 core + 7 extended + 3 crew)");
  console.log("  Engine: iii-engine on ws://localhost:49134");
  console.log("  REST API: http://localhost:3111");
}

runDemo();
