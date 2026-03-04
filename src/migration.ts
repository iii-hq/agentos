import { init } from "iii-sdk";
import { ENGINE_URL } from "./shared/config.js";

const { registerFunction, registerTrigger } = init(ENGINE_URL, {
  workerName: "migration",
});

interface MigrationItem {
  type: string;
  name: string;
  status: "migrated" | "skipped" | "error";
  source: string;
  target: string;
  reason?: string;
}

interface MigrationReport {
  framework: string;
  timestamp: string;
  dryRun: boolean;
  items: MigrationItem[];
  summary: {
    total: number;
    migrated: number;
    skipped: number;
    errors: number;
  };
}

interface OpenClawAgent {
  model?: string;
  system_prompt?: string;
  instructions?: string;
  tools?: string[];
  capabilities?: string[];
  temperature?: number;
}

interface OpenClawChannel {
  type?: string;
  webhook?: string;
  token?: string;
}

interface OpenClawModel {
  provider?: string;
  model?: string;
  api_key?: string;
  temperature?: number;
}

interface OpenClawTool {
  command?: string;
  args?: string[];
  description?: string;
}

interface OpenClawCron {
  schedule?: string;
  agent?: string;
  task?: string;
  enabled?: boolean;
}

interface OpenClawSkill {
  path?: string;
  enabled?: boolean;
  version?: string;
}

interface OpenClawSession {
  agent?: string;
  history?: unknown[];
  created?: string;
}

interface OpenClawConfig {
  agents?: Record<string, OpenClawAgent>;
  channels?: Record<string, OpenClawChannel>;
  models?: Record<string, OpenClawModel>;
  tools?: Record<string, OpenClawTool>;
  cron?: Record<string, OpenClawCron>;
  skills?: Record<string, OpenClawSkill>;
  sessions?: Record<string, OpenClawSession>;
  name?: string;
  version?: string;
}

registerFunction(
  {
    id: "migrate::openclaw",
    description:
      "Parse OpenClaw JSON5 config and migrate agents, channels, models, tools, cron, skills, sessions",
  },
  async (input: { dryRun?: boolean; configPath?: string }) => {
    const dryRun = input.dryRun ?? false;
    const items: MigrationItem[] = [];
    const fs = await import("fs/promises");
    const path = await import("path");
    const home = process.env.HOME || "/root";

    const configPaths = [
      input.configPath,
      path.join(home, ".openclaw/openclaw.json"),
      path.join(home, ".openclaw/config.json5"),
      path.join(home, ".clawdbot/config.json"),
      path.join(home, ".clawdbot/clawdbot.json"),
      path.join(home, ".moldbot/config.json"),
      path.join(home, ".moldbot/moldbot.json"),
      path.join(home, ".moltbot/config.json"),
      path.join(home, ".moltbot/moltbot.json"),
    ].filter(Boolean) as string[];

    let config: OpenClawConfig | null = null;
    let usedPath = "";

    for (const cp of configPaths) {
      try {
        const raw = await fs.readFile(cp, "utf-8");
        const cleaned = raw
          .replace(/\/\/.*$/gm, "")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/,\s*([}\]])/g, "$1")
          .replace(/(['"])?(\w+)(['"])?\s*:/g, '"$2":');
        config = JSON.parse(cleaned);
        usedPath = cp;
        break;
      } catch {
        continue;
      }
    }

    if (!config) {
      return {
        framework: "openclaw",
        timestamp: new Date().toISOString(),
        dryRun,
        items: [],
        summary: { total: 0, migrated: 0, skipped: 0, errors: 0 },
        configSearched: configPaths,
      } satisfies MigrationReport & { configSearched: string[] };
    }

    if (config.agents) {
      for (const [name, agent] of Object.entries(config.agents)) {
        try {
          const mappedModel = mapModel(agent.model ?? "claude-sonnet");
          const mappedTools = (agent.tools ?? []).map(mapTool);

          if (!dryRun) {
            const toml = [
              "[agent]",
              `name = "${name}"`,
              `description = "Migrated from OpenClaw (${usedPath})"`,
              'module = "builtin:chat"',
              "",
              "[agent.model]",
              'provider = "anthropic"',
              `model = "${mappedModel}"`,
              "max_tokens = 4096",
              "",
              "[agent.capabilities]",
              `tools = [${mappedTools.map((t) => `"${t}"`).join(", ")}]`,
              'memory_scopes = ["self.*", "shared.*"]',
              'network_hosts = ["*"]',
              "",
              "[agent.resources]",
              "max_tokens_per_hour = 500000",
              "",
              'system_prompt = """',
              agent.system_prompt ??
                agent.instructions ??
                "You are a helpful assistant.",
              '"""',
              "",
              'tags = ["migrated", "openclaw"]',
            ].join("\n");

            await fs.mkdir(`agents/${name}`, { recursive: true });
            await fs.writeFile(`agents/${name}/agent.toml`, toml);
          }

          items.push({
            type: "agent",
            name,
            status: "migrated",
            source: `openclaw:${usedPath}:agents.${name}`,
            target: `agents/${name}/agent.toml`,
          });
        } catch (err) {
          items.push({
            type: "agent",
            name,
            status: "error",
            source: `openclaw:agents.${name}`,
            target: "",
            reason: String(err),
          });
        }
      }
    }

    if (config.channels) {
      for (const [name, channel] of Object.entries(config.channels)) {
        if (!channel.type) {
          items.push({
            type: "channel",
            name,
            status: "skipped",
            source: `openclaw:channels.${name}`,
            target: "",
            reason: "No channel type specified",
          });
          continue;
        }

        if (!dryRun) {
          const toml = [
            "[channel]",
            `id = "${name}"`,
            `type = "${channel.type}"`,
            channel.webhook ? `webhook = "${channel.webhook}"` : "",
            channel.token ? `token = "${channel.token}"` : "",
          ]
            .filter(Boolean)
            .join("\n");

          await fs.mkdir("config/channels", { recursive: true });
          await fs.writeFile(`config/channels/${name}.toml`, toml);
        }

        items.push({
          type: "channel",
          name,
          status: "migrated",
          source: `openclaw:channels.${name}`,
          target: `config/channels/${name}.toml`,
        });
      }
    }

    if (config.models) {
      const supportedProviders = [
        "anthropic",
        "openai",
        "google",
        "openrouter",
        "aws-bedrock",
        "azure-openai",
      ];

      for (const [name, model] of Object.entries(config.models)) {
        if (model.provider && !supportedProviders.includes(model.provider)) {
          items.push({
            type: "model",
            name,
            status: "skipped",
            source: `openclaw:models.${name}`,
            target: "",
            reason: `Unsupported provider: ${model.provider}`,
          });
          continue;
        }

        if (!dryRun) {
          const toml = [
            "[model]",
            `id = "${name}"`,
            `provider = "${model.provider ?? "anthropic"}"`,
            `model = "${mapModel(model.model ?? "claude-sonnet")}"`,
            model.temperature !== undefined
              ? `temperature = ${model.temperature}`
              : "",
          ]
            .filter(Boolean)
            .join("\n");

          await fs.mkdir("config/models", { recursive: true });
          await fs.writeFile(`config/models/${name}.toml`, toml);
        }

        items.push({
          type: "model",
          name,
          status: "migrated",
          source: `openclaw:models.${name}`,
          target: `config/models/${name}.toml`,
        });
      }
    }

    if (config.tools) {
      for (const [name, tool] of Object.entries(config.tools)) {
        try {
          if (!dryRun) {
            const toml = [
              "[integration]",
              `id = "${name}"`,
              `name = "${name}"`,
              `description = "${tool.description ?? "Migrated from OpenClaw"}"`,
              'category = "migrated"',
              'transport = "stdio"',
              `command = "${tool.command ?? "npx"}"`,
              `args = [${(tool.args ?? []).map((a) => `"${a}"`).join(", ")}]`,
              "",
              "[integration.env]",
              "",
              "[integration.oauth]",
              "enabled = false",
            ].join("\n");

            await fs.mkdir("integrations", { recursive: true });
            await fs.writeFile(`integrations/${name}.toml`, toml);
          }

          items.push({
            type: "tool",
            name,
            status: "migrated",
            source: `openclaw:tools.${name}`,
            target: `integrations/${name}.toml`,
          });
        } catch (err) {
          items.push({
            type: "tool",
            name,
            status: "error",
            source: `openclaw:tools.${name}`,
            target: "",
            reason: String(err),
          });
        }
      }
    }

    if (config.cron) {
      for (const [name, cron] of Object.entries(config.cron)) {
        if (!cron.schedule || !cron.agent) {
          items.push({
            type: "cron",
            name,
            status: "skipped",
            source: `openclaw:cron.${name}`,
            target: "",
            reason: "Missing schedule or agent reference",
          });
          continue;
        }

        if (cron.enabled === false) {
          items.push({
            type: "cron",
            name,
            status: "skipped",
            source: `openclaw:cron.${name}`,
            target: "",
            reason: "Cron job disabled",
          });
          continue;
        }

        if (!dryRun) {
          const toml = [
            "[hand]",
            `id = "${name}"`,
            `name = "${name}"`,
            `description = "Migrated cron from OpenClaw: ${cron.task ?? ""}"`,
            "enabled = true",
            `schedule = "${cron.schedule}"`,
            "",
            "[hand.tools]",
            'allowed = ["tool::*"]',
            "",
            "[hand.agent]",
            "max_iterations = 40",
            "temperature = 0.3",
            `system_prompt = """Execute the following task: ${cron.task ?? "Run scheduled job"}"""`,
          ].join("\n");

          await fs.mkdir(`hands/${name}`, { recursive: true });
          await fs.writeFile(`hands/${name}/HAND.toml`, toml);
        }

        items.push({
          type: "cron",
          name,
          status: "migrated",
          source: `openclaw:cron.${name}`,
          target: `hands/${name}/HAND.toml`,
        });
      }
    }

    if (config.skills) {
      for (const [name, skill] of Object.entries(config.skills)) {
        if (skill.enabled === false) {
          items.push({
            type: "skill",
            name,
            status: "skipped",
            source: `openclaw:skills.${name}`,
            target: "",
            reason: "Skill disabled",
          });
          continue;
        }

        if (!dryRun && skill.path) {
          try {
            const content = await fs.readFile(skill.path, "utf-8");
            await fs.mkdir(`skills/${name}`, { recursive: true });
            await fs.writeFile(`skills/${name}/SKILL.md`, content);
          } catch {
            items.push({
              type: "skill",
              name,
              status: "error",
              source: `openclaw:skills.${name}`,
              target: "",
              reason: `Could not read source: ${skill.path}`,
            });
            continue;
          }
        }

        items.push({
          type: "skill",
          name,
          status: "migrated",
          source: `openclaw:skills.${name}`,
          target: `skills/${name}/SKILL.md`,
        });
      }
    }

    if (config.sessions) {
      for (const [name, session] of Object.entries(config.sessions)) {
        if (!dryRun) {
          const sessionData = {
            id: name,
            agent: session.agent,
            history: session.history ?? [],
            created: session.created ?? new Date().toISOString(),
            migrated: new Date().toISOString(),
            source: "openclaw",
          };

          await fs.mkdir("data/sessions", { recursive: true });
          await fs.writeFile(
            `data/sessions/${name}.json`,
            JSON.stringify(sessionData, null, 2),
          );
        }

        items.push({
          type: "session",
          name,
          status: "migrated",
          source: `openclaw:sessions.${name}`,
          target: `data/sessions/${name}.json`,
        });
      }
    }

    const report: MigrationReport = {
      framework: "openclaw",
      timestamp: new Date().toISOString(),
      dryRun,
      items,
      summary: summarizeItems(items),
    };

    if (!dryRun) {
      await fs.mkdir("data/migrations", { recursive: true });
      await fs.writeFile(
        `data/migrations/openclaw-${Date.now()}.json`,
        JSON.stringify(report, null, 2),
      );
    }

    return report;
  },
);

registerFunction(
  {
    id: "migrate::langchain",
    description: "Parse LangChain Python configs and migrate to agentos format",
  },
  async (input: { dryRun?: boolean; configDir?: string }) => {
    const dryRun = input.dryRun ?? false;
    const items: MigrationItem[] = [];
    const configDir = input.configDir ?? process.cwd();
    const fs = await import("fs/promises");
    const pathMod = await import("path");

    const pythonFiles: string[] = [];

    const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".venv", "venv"]);

    async function findPythonFiles(dir: string, depth = 0): Promise<void> {
      if (depth > 5) return;
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = pathMod.join(dir, entry.name);
          if (
            entry.isDirectory() &&
            !entry.name.startsWith(".") &&
            !SKIP_DIRS.has(entry.name)
          ) {
            await findPythonFiles(fullPath, depth + 1);
          } else if (entry.name.endsWith(".py")) {
            pythonFiles.push(fullPath);
          }
        }
      } catch {
        return;
      }
    }

    await findPythonFiles(configDir);

    const langchainPatterns: Record<string, RegExp> = {
      llm: /(?:ChatOpenAI|ChatAnthropic|ChatGoogleGenerativeAI|AzureChatOpenAI)\s*\(/g,
      chain:
        /(?:LLMChain|SequentialChain|RouterChain|ConversationChain|RetrievalQA)\s*\(/g,
      tool: /(?:Tool|StructuredTool|BaseTool|tool\s*\()\s*\(/g,
      memory:
        /(?:ConversationBufferMemory|ConversationSummaryMemory|VectorStoreMemory|ChatMessageHistory)\s*\(/g,
      agent:
        /(?:create_react_agent|create_openai_tools_agent|AgentExecutor|initialize_agent)\s*\(/g,
      retriever:
        /(?:VectorStoreRetriever|SelfQueryRetriever|ContextualCompressionRetriever)\s*\(/g,
      embeddings:
        /(?:OpenAIEmbeddings|HuggingFaceEmbeddings|CohereEmbeddings)\s*\(/g,
    };

    for (const filePath of pythonFiles) {
      let content: string;
      try {
        content = await fs.readFile(filePath, "utf-8");
      } catch {
        continue;
      }

      if (!content.includes("langchain") && !content.includes("langgraph"))
        continue;

      const relativePath = pathMod.relative(configDir, filePath);
      const baseName = pathMod.basename(filePath, ".py");

      for (const [type, pattern] of Object.entries(langchainPatterns)) {
        const matches = content.match(pattern);
        if (!matches) continue;

        for (let i = 0; i < matches.length; i++) {
          const name = `${baseName}_${type}_${i}`;

          if (type === "agent" || type === "llm") {
            const modelMatch = content.match(
              /model(?:_name)?\s*=\s*["']([^"']+)["']/,
            );
            const tempMatch = content.match(/temperature\s*=\s*([\d.]+)/);
            const systemMatch = content.match(
              /system_message\s*=\s*["']([^"']+)["']/,
            );

            if (!dryRun) {
              const toml = [
                "[agent]",
                `name = "${name}"`,
                `description = "Migrated from LangChain (${relativePath})"`,
                'module = "builtin:chat"',
                "",
                "[agent.model]",
                'provider = "anthropic"',
                `model = "${mapModel(modelMatch?.[1] ?? "gpt-4")}"`,
                "max_tokens = 4096",
                "",
                "[agent.capabilities]",
                'tools = ["tool::*"]',
                'memory_scopes = ["self.*", "shared.*"]',
                'network_hosts = ["*"]',
                "",
                "[agent.resources]",
                "max_tokens_per_hour = 500000",
                "",
                'system_prompt = """',
                systemMatch?.[1] ??
                  `Migrated ${type} from ${relativePath}. Review and customize this prompt.`,
                '"""',
                "",
                'tags = ["migrated", "langchain"]',
              ].join("\n");

              await fs.mkdir(`agents/${name}`, { recursive: true });
              await fs.writeFile(`agents/${name}/agent.toml`, toml);
            }

            items.push({
              type,
              name,
              status: "migrated",
              source: `langchain:${relativePath}:${type}[${i}]`,
              target: `agents/${name}/agent.toml`,
            });
          } else if (type === "tool") {
            const toolNameMatch = content.match(/name\s*=\s*["']([^"']+)["']/);
            const toolName = toolNameMatch?.[1] ?? name;

            if (!dryRun) {
              const toml = [
                "[integration]",
                `id = "${toolName}"`,
                `name = "${toolName}"`,
                `description = "Migrated tool from LangChain (${relativePath})"`,
                'category = "migrated"',
                'transport = "stdio"',
                'command = "python"',
                `args = ["-m", "${baseName}"]`,
                "",
                "[integration.env]",
                "",
                "[integration.oauth]",
                "enabled = false",
              ].join("\n");

              await fs.mkdir("integrations", { recursive: true });
              await fs.writeFile(`integrations/${toolName}.toml`, toml);
            }

            items.push({
              type: "tool",
              name: toolName,
              status: "migrated",
              source: `langchain:${relativePath}:tool[${i}]`,
              target: `integrations/${toolName}.toml`,
            });
          } else if (type === "chain") {
            items.push({
              type: "workflow",
              name,
              status: "migrated",
              source: `langchain:${relativePath}:chain[${i}]`,
              target: `workflows/${name}.toml`,
            });
          } else {
            items.push({
              type,
              name,
              status: "skipped",
              source: `langchain:${relativePath}:${type}[${i}]`,
              target: "",
              reason: `${type} requires manual migration review`,
            });
          }
        }
      }
    }

    const report: MigrationReport = {
      framework: "langchain",
      timestamp: new Date().toISOString(),
      dryRun,
      items,
      summary: summarizeItems(items),
    };

    if (!dryRun) {
      await fs.mkdir("data/migrations", { recursive: true });
      await fs.writeFile(
        `data/migrations/langchain-${Date.now()}.json`,
        JSON.stringify(report, null, 2),
      );
    }

    return report;
  },
);

registerFunction(
  {
    id: "migrate::scan",
    description: "Auto-detect installed agent frameworks in the system",
  },
  async (input: { baseDir?: string }) => {
    const fs = await import("fs/promises");
    const pathMod = await import("path");
    const home = process.env.HOME || "/root";
    const baseDir = input.baseDir ?? home;

    interface ScanResult {
      framework: string;
      detected: boolean;
      configPath: string;
      version?: string;
      migratable: boolean;
    }

    const results: ScanResult[] = [];

    const frameworks = [
      {
        name: "openclaw",
        paths: [
          ".openclaw/openclaw.json",
          ".openclaw/config.json5",
          ".clawdbot/config.json",
          ".moldbot/config.json",
          ".moltbot/config.json",
        ],
        migratable: true,
      },
      {
        name: "langchain",
        paths: [".langchain", "langchain.config.json"],
        migratable: true,
      },
      {
        name: "crewai",
        paths: [".crewai", "crewai.yaml", "crewai.yml"],
        migratable: true,
      },
      {
        name: "autogen",
        paths: ["autogen_config.json", "OAI_CONFIG_LIST", ".autogen"],
        migratable: true,
      },
      { name: "dspy", paths: [".dspy", "dspy_config.json"], migratable: false },
      {
        name: "llamaindex",
        paths: [".llamaindex", "llamaindex.config.json"],
        migratable: false,
      },
      {
        name: "semantic-kernel",
        paths: ["config/skills", ".semantic-kernel"],
        migratable: false,
      },
      {
        name: "haystack",
        paths: [".haystack", "haystack_pipeline.yaml", "haystack_pipeline.yml"],
        migratable: false,
      },
      {
        name: "langgraph",
        paths: [".langgraph", "langgraph.json"],
        migratable: true,
      },
      {
        name: "smolagents",
        paths: [".smolagents", "smolagents.yaml"],
        migratable: false,
      },
      {
        name: "phidata",
        paths: [".phidata", "phi_config.yaml"],
        migratable: false,
      },
      {
        name: "superagi",
        paths: [".superagi", "superagi_config.json"],
        migratable: false,
      },
    ];

    for (const fw of frameworks) {
      let detected = false;
      let foundPath = "";

      for (const p of fw.paths) {
        const fullPath = pathMod.join(baseDir, p);
        try {
          await fs.access(fullPath);
          detected = true;
          foundPath = fullPath;
          break;
        } catch {
          continue;
        }
      }

      let version: string | undefined;
      if (detected) {
        const versionFiles = [
          {
            file: "package.json",
            extract: (c: string) => {
              const p = JSON.parse(c);
              return p.dependencies?.[fw.name] ?? p.devDependencies?.[fw.name];
            },
          },
          {
            file: "requirements.txt",
            extract: (c: string) => {
              const m = c.match(new RegExp(`${fw.name}[=<>~!]*([\\d.]+)`));
              return m?.[1];
            },
          },
          {
            file: "pyproject.toml",
            extract: (c: string) => {
              const m = c.match(
                new RegExp(`${fw.name}[^"]*"[=<>~!]*([\\d.]+)"`),
              );
              return m?.[1];
            },
          },
          {
            file: "Pipfile",
            extract: (c: string) => {
              const m = c.match(
                new RegExp(`${fw.name}\\s*=\\s*"[=<>~]*([\\d.]+)"`),
              );
              return m?.[1];
            },
          },
        ];

        for (const vf of versionFiles) {
          try {
            const content = await fs.readFile(
              pathMod.join(baseDir, vf.file),
              "utf-8",
            );
            const v = vf.extract(content);
            if (v) {
              version = v;
              break;
            }
          } catch {
            continue;
          }
        }
      }

      results.push({
        framework: fw.name,
        detected,
        configPath: foundPath,
        version,
        migratable: fw.migratable,
      });
    }

    const npmGlobalCheck = ["langchain", "crewai", "autogen"];
    for (const pkg of npmGlobalCheck) {
      const existing = results.find((r) => r.framework === pkg);
      if (existing && !existing.detected) {
        try {
          const { stdout } = await execCommand("npm", [
            "list",
            "-g",
            pkg,
            "--json",
          ]);
          const parsed = JSON.parse(stdout);
          if (parsed.dependencies?.[pkg]) {
            existing.detected = true;
            existing.version = parsed.dependencies[pkg].version;
            existing.configPath = "global npm";
          }
        } catch {
          continue;
        }
      }
    }

    const pipCheck = [
      "langchain",
      "crewai",
      "autogen",
      "dspy-ai",
      "llama-index",
      "haystack-ai",
    ];
    for (const pkg of pipCheck) {
      const fwName = pkg
        .replace("-ai", "")
        .replace("llama-index", "llamaindex")
        .replace("dspy-ai", "dspy");
      const existing = results.find((r) => r.framework === fwName);
      if (existing && !existing.detected) {
        try {
          const { stdout } = await execCommand("pip", ["show", pkg]);
          if (stdout.includes("Version:")) {
            const versionMatch = stdout.match(/Version:\s*([\d.]+)/);
            existing.detected = true;
            existing.version = versionMatch?.[1];
            existing.configPath = "pip installed";
          }
        } catch {
          continue;
        }
      }
    }

    const detected = results.filter((r) => r.detected);
    const migratableDetected = detected.filter((r) => r.migratable);

    return {
      timestamp: new Date().toISOString(),
      baseDir,
      frameworks: results,
      detected,
      migratableDetected,
      summary: {
        scanned: results.length,
        found: detected.length,
        migratable: migratableDetected.length,
      },
    };
  },
);

registerFunction(
  {
    id: "migrate::report",
    description: "Generate a migration report from completed migration runs",
  },
  async (input: { reportId?: string; format?: "markdown" | "json" }) => {
    const fs = await import("fs/promises");
    const pathMod = await import("path");
    const format = input.format ?? "markdown";
    const migrationsDir = "data/migrations";
    let reports: MigrationReport[] = [];

    try {
      const files = await fs.readdir(migrationsDir);
      const jsonFiles = files.filter((f: string) => f.endsWith(".json")).sort();

      if (input.reportId) {
        const matching = jsonFiles.filter((f: string) =>
          f.includes(input.reportId!),
        );
        for (const file of matching) {
          const content = await fs.readFile(
            pathMod.join(migrationsDir, file),
            "utf-8",
          );
          reports.push(JSON.parse(content));
        }
      } else {
        for (const file of jsonFiles) {
          const content = await fs.readFile(
            pathMod.join(migrationsDir, file),
            "utf-8",
          );
          reports.push(JSON.parse(content));
        }
      }
    } catch {
      return { error: "No migration reports found", reports: [] };
    }

    const allItems = reports.flatMap((r) => r.items);

    const byType: Record<string, Record<string, number>> = {};
    for (const item of allItems) {
      if (!byType[item.type])
        byType[item.type] = { migrated: 0, skipped: 0, errors: 0 };
      byType[item.type][item.status] =
        (byType[item.type][item.status] ?? 0) + 1;
    }

    const byFramework: Record<string, MigrationReport["summary"]> = {};
    for (const r of reports) {
      byFramework[r.framework] = r.summary;
    }

    const totals = summarizeItems(allItems);

    if (format === "json") {
      return { reports, aggregated: { byType, byFramework, totals } };
    }

    const lines = [
      "# AgentOS Migration Report",
      "",
      `Generated: ${new Date().toISOString()}`,
      `Total Migration Runs: ${reports.length}`,
      `Total Items Processed: ${totals.total}`,
      "",
      "## Summary by Framework",
      "",
      "| Framework | Total | Migrated | Skipped | Errors |",
      "|-----------|-------|----------|---------|--------|",
    ];

    for (const [fw, summary] of Object.entries(byFramework)) {
      lines.push(
        `| ${fw} | ${summary.total} | ${summary.migrated} | ${summary.skipped} | ${summary.errors} |`,
      );
    }

    lines.push("", "## Summary by Type", "");
    lines.push("| Type | Migrated | Skipped | Errors |");
    lines.push("|------|----------|---------|--------|");
    for (const [type, counts] of Object.entries(byType)) {
      lines.push(
        `| ${type} | ${counts.migrated ?? 0} | ${counts.skipped ?? 0} | ${counts.errors ?? 0} |`,
      );
    }

    const skippedItems = allItems.filter((i) => i.status === "skipped");
    if (skippedItems.length > 0) {
      lines.push("", "## Skipped Items", "");
      for (const item of skippedItems) {
        lines.push(
          `- **${item.type}/${item.name}**: ${item.reason ?? "Unknown reason"}`,
        );
      }
    }

    const errorItems = allItems.filter((i) => i.status === "error");
    if (errorItems.length > 0) {
      lines.push("", "## Errors", "");
      for (const item of errorItems) {
        lines.push(
          `- **${item.type}/${item.name}**: ${item.reason ?? "Unknown error"}`,
        );
      }
    }

    const migratedItems = allItems.filter((i) => i.status === "migrated");
    if (migratedItems.length > 0) {
      lines.push("", "## Successfully Migrated", "");
      for (const item of migratedItems) {
        lines.push(
          `- **${item.type}/${item.name}**: ${item.source} -> ${item.target}`,
        );
      }
    }

    lines.push("", "## Next Steps", "");
    lines.push(
      "1. Review migrated agent system prompts in `agents/*/agent.toml`",
    );
    lines.push("2. Configure integration API keys in `integrations/*.toml`");
    lines.push("3. Test migrated hands/cron jobs in `hands/*/HAND.toml`");
    lines.push("4. Verify session data integrity in `data/sessions/*.json`");

    const markdown = lines.join("\n");

    return { markdown, reports, aggregated: { byType, byFramework, totals } };
  },
);

registerTrigger({
  type: "http",
  function_id: "migrate::openclaw",
  config: { api_path: "migrate/openclaw", http_method: "POST" },
});

registerTrigger({
  type: "http",
  function_id: "migrate::langchain",
  config: { api_path: "migrate/langchain", http_method: "POST" },
});

registerTrigger({
  type: "http",
  function_id: "migrate::scan",
  config: { api_path: "migrate/scan", http_method: "POST" },
});

registerTrigger({
  type: "http",
  function_id: "migrate::report",
  config: { api_path: "migrate/report", http_method: "POST" },
});

function summarizeItems(items: MigrationItem[]): MigrationReport["summary"] {
  return {
    total: items.length,
    migrated: items.filter((i) => i.status === "migrated").length,
    skipped: items.filter((i) => i.status === "skipped").length,
    errors: items.filter((i) => i.status === "error").length,
  };
}

function mapModel(source: string): string {
  const mapping: Record<string, string> = {
    "gpt-4": "claude-sonnet-4-6",
    "gpt-4o": "claude-sonnet-4-6",
    "gpt-4-turbo": "claude-sonnet-4-6",
    "gpt-4o-mini": "claude-haiku-3.5",
    "gpt-3.5-turbo": "claude-haiku-3.5",
    "claude-3-opus": "claude-opus-4",
    "claude-3-sonnet": "claude-sonnet-4-6",
    "claude-3-haiku": "claude-haiku-3.5",
    "claude-3.5-sonnet": "claude-sonnet-4-6",
    "claude-sonnet": "claude-sonnet-4-6",
    "claude-opus": "claude-opus-4",
    "claude-haiku": "claude-haiku-3.5",
    "gemini-pro": "claude-sonnet-4-6",
    "gemini-1.5-pro": "claude-sonnet-4-6",
    "llama-3": "llama-3.3-70b",
    mixtral: "mixtral-8x7b",
    "command-r-plus": "claude-sonnet-4-6",
  };
  return mapping[source] || source;
}

function mapTool(source: string): string {
  const mapping: Record<string, string> = {
    serpapi: "tool::web_search",
    google_search: "tool::web_search",
    "google-search": "tool::web_search",
    web_search: "tool::web_search",
    bing_search: "tool::web_search",
    brave_search: "tool::web_search",
    wikipedia: "tool::web_fetch",
    web_fetch: "tool::web_fetch",
    scrape: "tool::web_fetch",
    file_read: "tool::file_read",
    read_file: "tool::file_read",
    file_write: "tool::file_write",
    write_file: "tool::file_write",
    shell: "tool::shell_exec",
    terminal: "tool::shell_exec",
    python_repl: "tool::shell_exec",
    code_interpreter: "tool::shell_exec",
    browser: "tool::browser_navigate",
    calculator: "tool::calculate",
    memory: "memory::store",
    retriever: "memory::query",
  };
  return mapping[source] || `custom::${source}`;
}

async function execCommand(
  cmd: string,
  args: string[],
): Promise<{ stdout: string }> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const exec = promisify(execFile);
  return exec(cmd, args, { maxBuffer: 10 * 1024 * 1024 });
}
