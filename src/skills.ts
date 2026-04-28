import { registerWorker } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import { requireAuth } from "@agentos/shared/utils";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "skills",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;

interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  category: string;
  tags: string[];
  version: string;
  source: "bundled" | "installed" | "marketplace";
  installedAt?: number;
  toolScope?: string[];
  effort?: "normal" | "extended";
  model?: string;
  templateOnly?: boolean;
}

const BUNDLED_SKILLS: Omit<Skill, "installedAt">[] = [
  {
    id: "aws",
    name: "AWS Expert",
    description: "AWS services, IAM, Lambda, S3, EC2",
    content: "",
    category: "cloud",
    tags: ["aws", "cloud"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "azure",
    name: "Azure Expert",
    description: "Azure services, AD, Functions, Blob",
    content: "",
    category: "cloud",
    tags: ["azure", "cloud"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "gcp",
    name: "GCP Expert",
    description: "Google Cloud Platform services",
    content: "",
    category: "cloud",
    tags: ["gcp", "cloud"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "docker",
    name: "Docker Expert",
    description: "Containers, Compose, multi-stage builds",
    content: "",
    category: "cloud",
    tags: ["docker", "containers"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "kubernetes",
    name: "Kubernetes Expert",
    description: "K8s orchestration, Helm, operators",
    content: "",
    category: "cloud",
    tags: ["kubernetes", "k8s"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "helm",
    name: "Helm Expert",
    description: "Helm charts, values, templating",
    content: "",
    category: "cloud",
    tags: ["helm", "kubernetes"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "terraform",
    name: "Terraform Expert",
    description: "IaC, providers, state management",
    content: "",
    category: "cloud",
    tags: ["terraform", "iac"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "ci-cd",
    name: "CI/CD Expert",
    description: "GitHub Actions, GitLab CI, pipelines",
    content: "",
    category: "devops",
    tags: ["ci-cd", "automation"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "ansible",
    name: "Ansible Expert",
    description: "Configuration management, playbooks",
    content: "",
    category: "devops",
    tags: ["ansible"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "prometheus",
    name: "Prometheus Expert",
    description: "Monitoring, alerting, PromQL",
    content: "",
    category: "devops",
    tags: ["prometheus", "monitoring"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "sentry",
    name: "Sentry Expert",
    description: "Error tracking, performance monitoring",
    content: "",
    category: "devops",
    tags: ["sentry", "monitoring"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "python-expert",
    name: "Python Expert",
    description: "Python idioms, typing, packaging",
    content: "",
    category: "languages",
    tags: ["python"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "typescript-expert",
    name: "TypeScript Expert",
    description: "TS patterns, generics, type system",
    content: "",
    category: "languages",
    tags: ["typescript"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "golang-expert",
    name: "Go Expert",
    description: "Go concurrency, interfaces, modules",
    content: "",
    category: "languages",
    tags: ["go", "golang"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "rust-expert",
    name: "Rust Expert",
    description: "Rust ownership, lifetimes, async",
    content: "",
    category: "languages",
    tags: ["rust"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "react-expert",
    name: "React Expert",
    description: "React patterns, hooks, state management",
    content: "",
    category: "languages",
    tags: ["react", "frontend"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "nextjs-expert",
    name: "Next.js Expert",
    description: "App Router, RSC, SSR/SSG",
    content: "",
    category: "languages",
    tags: ["nextjs", "react"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "postgres-expert",
    name: "PostgreSQL Expert",
    description: "SQL, indexing, optimization",
    content: "",
    category: "data",
    tags: ["postgres", "sql"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "redis-expert",
    name: "Redis Expert",
    description: "Caching, pub/sub, data structures",
    content: "",
    category: "data",
    tags: ["redis"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "mongodb",
    name: "MongoDB Expert",
    description: "Document modeling, aggregation",
    content: "",
    category: "data",
    tags: ["mongodb", "nosql"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "elasticsearch",
    name: "Elasticsearch Expert",
    description: "Full-text search, mappings",
    content: "",
    category: "data",
    tags: ["elasticsearch"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "api-tester",
    name: "API Tester",
    description: "REST/GraphQL testing, validation",
    content: "",
    category: "web",
    tags: ["api", "testing"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "graphql-expert",
    name: "GraphQL Expert",
    description: "Schema design, resolvers",
    content: "",
    category: "web",
    tags: ["graphql"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "openapi-expert",
    name: "OpenAPI Expert",
    description: "API specs, code generation",
    content: "",
    category: "web",
    tags: ["openapi", "swagger"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "code-reviewer",
    name: "Code Reviewer",
    description: "Code quality, security, patterns",
    content: "",
    category: "devtools",
    tags: ["review", "quality"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "git-expert",
    name: "Git Expert",
    description: "Git workflows, branching, rebasing",
    content: "",
    category: "devtools",
    tags: ["git"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "github",
    name: "GitHub Expert",
    description: "Actions, PRs, issues, releases",
    content: "",
    category: "devtools",
    tags: ["github"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "security-audit",
    name: "Security Auditor",
    description: "OWASP, vulnerability scanning",
    content: "",
    category: "security",
    tags: ["security", "audit"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "crypto-expert",
    name: "Cryptography Expert",
    description: "Encryption, hashing, PKI",
    content: "",
    category: "security",
    tags: ["crypto", "security"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "technical-writer",
    name: "Technical Writer",
    description: "Documentation, READMEs, guides",
    content: "",
    category: "content",
    tags: ["writing", "docs"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "email-writer",
    name: "Email Writer",
    description: "Professional email drafting",
    content: "",
    category: "content",
    tags: ["email", "writing"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "project-manager",
    name: "Project Manager",
    description: "Planning, tracking, sprints",
    content: "",
    category: "productivity",
    tags: ["pm", "planning"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "prompt-engineer",
    name: "Prompt Engineer",
    description: "Prompt optimization, few-shot",
    content: "",
    category: "productivity",
    tags: ["prompts", "llm"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "ml-engineer",
    name: "ML Engineer",
    description: "Model training, evaluation, deployment",
    content: "",
    category: "ai",
    tags: ["ml", "ai"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "vector-db",
    name: "Vector DB Expert",
    description: "Embeddings, similarity search",
    content: "",
    category: "ai",
    tags: ["vectors", "embeddings"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "linux-networking",
    name: "Linux Networking",
    description: "TCP/IP, iptables, DNS",
    content: "",
    category: "systems",
    tags: ["linux", "networking"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "nginx",
    name: "Nginx Expert",
    description: "Reverse proxy, load balancing, TLS",
    content: "",
    category: "systems",
    tags: ["nginx"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "shell-scripting",
    name: "Shell Scripting",
    description: "Bash, zsh, automation scripts",
    content: "",
    category: "systems",
    tags: ["shell", "bash"],
    version: "1.0.0",
    source: "bundled",
  },
  {
    id: "sysadmin",
    name: "System Administrator",
    description: "Server management, troubleshooting",
    content: "",
    category: "systems",
    tags: ["sysadmin"],
    version: "1.0.0",
    source: "bundled",
  },
];

registerFunction(
  {
    id: "skill::list",
    description: "List all available skills",
    metadata: { category: "skills" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { category, tag } = req.body || req;
    const installed = (await trigger({
      function_id: "state::list",
      payload: { scope: "skills" },
    }).catch(() => [])) as any[];
    const installedSkills: Skill[] = installed
      .map((i: any) => i.value)
      .filter(Boolean);

    let all: Skill[] = [
      ...BUNDLED_SKILLS.map((s) => ({ ...s, installedAt: 0 })),
      ...installedSkills,
    ];

    if (category) all = all.filter((s) => s.category === category);
    if (tag) all = all.filter((s) => s.tags.includes(tag));

    return all;
  },
);

registerFunction(
  {
    id: "skill::install",
    description: "Install a skill from content or marketplace",
    metadata: { category: "skills" },
  },
  async (req: any) => {
    requireAuth(req);
    const {
      id,
      name,
      description,
      content,
      category,
      tags,
      signature,
      publicKey,
      toolScope,
      effort,
      model,
      templateOnly,
    } = req.body || req;
    const skillId =
      id || name?.toLowerCase().replace(/\s+/g, "-") || crypto.randomUUID();

    if (content) {
      const pipeline: any = await trigger({
        function_id: "skill::pipeline",
        payload: { content, signature, publicKey },
      }).catch(() => null);

      if (pipeline && !pipeline.approved) {
        return {
          installed: false,
          id: skillId,
          reason: "Security pipeline rejected skill",
          report: pipeline.report,
        };
      }
    }

    const skill: Skill = {
      id: skillId,
      name: name || skillId,
      description: description || "",
      content: content || "",
      category: category || "custom",
      tags: tags || [],
      version: "1.0.0",
      source: "installed",
      installedAt: Date.now(),
      toolScope: toolScope || undefined,
      effort: effort || undefined,
      model: model || undefined,
      templateOnly: templateOnly || undefined,
    };

    await trigger({
      function_id: "state::set",
      payload: { scope: "skills", key: skillId, value: skill },
    });
    return { installed: true, id: skillId };
  },
);

registerFunction(
  {
    id: "skill::uninstall",
    description: "Remove an installed skill",
    metadata: { category: "skills" },
  },
  async (req: any) => {
    requireAuth(req);
    const { id } = req.body || req;
    const skill = BUNDLED_SKILLS.find((s) => s.id === id);
    if (skill) throw new Error(`Cannot uninstall bundled skill: ${id}`);

    await trigger({
      function_id: "state::delete",
      payload: { scope: "skills", key: id },
    });
    return { uninstalled: true, id };
  },
);

registerFunction(
  {
    id: "skill::get",
    description: "Get skill content for injection into agent context",
    metadata: { category: "skills" },
  },
  async ({ id }: { id: string }) => {
    const bundled = BUNDLED_SKILLS.find((s) => s.id === id);
    if (bundled) return bundled;

    return trigger({
      function_id: "state::get",
      payload: { scope: "skills", key: id },
    });
  },
);

registerFunction(
  {
    id: "skill::search",
    description: "Search skills by query",
    metadata: { category: "skills" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { query } = req.body || req;
    const q = query.toLowerCase();
    const allSkills = [...BUNDLED_SKILLS];

    const installed = (await trigger({
      function_id: "state::list",
      payload: { scope: "skills" },
    }).catch(() => [])) as any[];
    for (const i of installed) {
      if (i.value) allSkills.push(i.value);
    }

    return allSkills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.includes(q)),
    );
  },
);

registerFunction(
  {
    id: "skill::parse",
    description: "Parse a SKILL.md file",
    metadata: { category: "skills" },
  },
  async ({ content }: { content: string }) => {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!frontmatterMatch) {
      return { name: "unknown", description: "", content, tags: [] };
    }

    const [, frontmatter, body] = frontmatterMatch;
    const meta: Record<string, string> = {};

    for (const line of frontmatter.split("\n")) {
      const [key, ...rest] = line.split(":");
      if (key && rest.length) {
        meta[key.trim()] = rest.join(":").trim();
      }
    }

    const parsedAllowedTools = meta.toolScope
      ? meta.toolScope
          .replace(/[\[\]]/g, "")
          .split(",")
          .map((t: string) => t.trim())
          .filter(Boolean)
      : undefined;

    const effort = meta.effort === "extended" ? "extended" : meta.effort === "normal" ? "normal" : undefined;

    return {
      name: meta.name || "unknown",
      description: meta.description || "",
      version: meta.version || "1.0.0",
      tags: meta.tags
        ? meta.tags
            .replace(/[\[\]]/g, "")
            .split(",")
            .map((t: string) => t.trim())
        : [],
      toolScope: parsedAllowedTools,
      effort,
      model: meta.model || undefined,
      templateOnly: meta.templateOnly === "true" ? true : undefined,
      content: body.trim(),
    };
  },
);

registerFunction(
  {
    id: "skill::marketplace_search",
    description: "Search the SkillKit marketplace for external skills",
    metadata: { category: "skills" },
  },
  async (req: any) => {
    if (req.headers) requireAuth(req);
    const { query, limit } = req.body || req;
    if (!query || query.length < 2) {
      throw new Error("Query must be at least 2 characters");
    }
    return trigger({
      function_id: "skillkit::search",
      payload: { query, limit: limit || 10 },
    }).catch((e: any) => ({
      results: [],
      error: `SkillKit unavailable: ${e.message}`,
    }));
  },
);

registerTrigger({
  type: "http",
  function_id: "skill::marketplace_search",
  config: { api_path: "api/skills/marketplace", http_method: "GET" },
});

registerTrigger({
  type: "http",
  function_id: "skill::list",
  config: { api_path: "api/skills", http_method: "GET" },
});
registerTrigger({
  type: "http",
  function_id: "skill::install",
  config: { api_path: "api/skills", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "skill::uninstall",
  config: { api_path: "api/skills/:id", http_method: "DELETE" },
});
registerTrigger({
  type: "http",
  function_id: "skill::search",
  config: { api_path: "api/skills/search", http_method: "GET" },
});
