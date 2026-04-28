import { registerWorker, TriggerAction } from "iii-sdk";
import { ENGINE_URL, OTEL_CONFIG, registerShutdown } from "@agentos/shared/config";
import { createVerify } from "crypto";
import { writeFileSync, unlinkSync, rmdirSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const sdk = registerWorker(ENGINE_URL, {
  workerName: "skill-security",
  otel: OTEL_CONFIG,
});
registerShutdown(sdk);
const { registerFunction, registerTrigger, trigger } = sdk;
const triggerVoid = (id: string, payload: unknown) =>
  trigger({ function_id: id, payload, action: TriggerAction.Void() });

interface ScanFinding {
  severity: "critical" | "high" | "medium" | "low";
  pattern: string;
  line: number;
  description: string;
}

interface ScanResult {
  safe: boolean;
  findings: ScanFinding[];
}

interface SandboxResult {
  passed: boolean;
  violations: string[];
}

interface PipelineReport {
  approved: boolean;
  report: {
    signature?: { verified: boolean; signer?: string };
    scan: ScanResult;
    sandbox: SandboxResult;
  };
}

const DANGEROUS_PATTERNS: Array<{
  regex: RegExp;
  severity: ScanFinding["severity"];
  description: string;
}> = [
  {
    regex:
      /(?:atob|btoa|Buffer\.from\(.*?base64)[\s\S]{0,80}(?:exec|eval|spawn|system)/,
    severity: "critical",
    description: "Base64 decode combined with code execution",
  },
  {
    regex:
      /(?:exec|eval|spawn|system)[\s\S]{0,80}(?:atob|btoa|Buffer\.from\(.*?base64)/,
    severity: "critical",
    description: "Code execution combined with base64 decode",
  },
  {
    regex:
      /https?:\/\/[^\s'"]*\/(?:beacon|payload|shell|c2|backdoor|implant)\b/i,
    severity: "critical",
    description: "URL with suspicious C2 path segment",
  },
  {
    regex: /[0-9a-f]{100,}/i,
    severity: "high",
    description: "Hex-encoded payload exceeding 100 characters",
  },
  {
    regex: /[A-Za-z0-9+/=]{200,}/,
    severity: "high",
    description: "Base64-encoded block exceeding 200 characters",
  },
  {
    regex:
      /(?:\.env|~\/\.ssh|\/etc\/passwd|credentials|secrets\.json|\.pem\b)/i,
    severity: "high",
    description: "Access to sensitive file or directory",
  },
  {
    regex:
      /(?:fetch|http\.get|https\.get|request)\s*\(\s*['"`]https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
    severity: "high",
    description: "Network request to hardcoded IP address",
  },
  {
    regex: /`[^`]*\$\(.*?\)[^`]*`/,
    severity: "medium",
    description: "Shell command substitution via backticks",
  },
  {
    regex: /\$\(.*?\)/,
    severity: "medium",
    description: "Shell command substitution via $()",
  },
  {
    regex: /\|\s*(?:bash|sh|zsh|dash)\b/,
    severity: "critical",
    description: "Piping output to shell interpreter",
  },
  {
    regex: /child_process|\.exec\s*\(|\.execSync\s*\(|\.spawn\s*\(/,
    severity: "high",
    description: "Direct process execution API usage",
  },
  {
    regex: /new\s+Function\s*\(/,
    severity: "high",
    description: "Dynamic function construction",
  },
];

registerFunction(
  {
    id: "skill::verify_signature",
    description: "Verify Ed25519 signature on skill content",
    metadata: { category: "skill-security" },
  },
  async ({
    skillContent,
    signature,
    publicKey,
  }: {
    skillContent: string;
    signature: string;
    publicKey: string;
  }) => {
    try {
      const sigBuffer = Buffer.from(signature, "base64");
      const keyBuffer = Buffer.from(publicKey, "base64");

      const verifier = createVerify("ed25519");
      verifier.update(skillContent);
      const verified = verifier.verify(
        { key: keyBuffer, format: "der", type: "spki" },
        sigBuffer,
      );

      return {
        verified,
        signer: verified ? publicKey.slice(0, 16) + "..." : undefined,
      };
    } catch {
      return { verified: false };
    }
  },
);

registerFunction(
  {
    id: "skill::scan_content",
    description: "Static analysis scan for dangerous patterns in skill content",
    metadata: { category: "skill-security" },
  },
  async ({ content }: { content: string }): Promise<ScanResult> => {
    const findings: ScanFinding[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.regex.test(lines[i])) {
          findings.push({
            severity: pattern.severity,
            pattern: pattern.regex.source.slice(0, 60),
            line: i + 1,
            description: pattern.description,
          });
        }
      }
    }

    const hasCritical = findings.some((f) => f.severity === "critical");
    const hasMultipleHigh =
      findings.filter((f) => f.severity === "high").length >= 2;

    return { safe: !hasCritical && !hasMultipleHigh, findings };
  },
);

registerFunction(
  {
    id: "skill::sandbox_test",
    description: "Dry-run skill content in a restricted sandbox",
    metadata: { category: "skill-security" },
  },
  async ({
    skillContent,
  }: {
    skillContent: string;
  }): Promise<SandboxResult> => {
    const violations: string[] = [];
    let tempDir: string | undefined;

    try {
      tempDir = mkdtempSync(join(tmpdir(), "skill-sandbox-"));
      const testFile = join(tempDir, "skill-test.js");
      writeFileSync(testFile, skillContent);

      const blockedGlobals = [
        "require",
        "process",
        "child_process",
        "__dirname",
        "__filename",
      ];
      for (const g of blockedGlobals) {
        const pattern = new RegExp(`\\b${g}\\b`);
        if (pattern.test(skillContent)) {
          violations.push(`References blocked global: ${g}`);
        }
      }

      if (
        /import\s+.*from\s+['"](?:fs|net|http|https|child_process|dgram|cluster|worker_threads)['"]/.test(
          skillContent,
        )
      ) {
        violations.push("Imports restricted Node.js built-in module");
      }

      if (/import\s*\(/.test(skillContent)) {
        violations.push("Uses dynamic import()");
      }

      if (/globalThis|global\[/.test(skillContent)) {
        violations.push("Accesses global scope directly");
      }
    } finally {
      if (tempDir) {
        try {
          unlinkSync(join(tempDir, "skill-test.js"));
          rmdirSync(tempDir);
        } catch {}
      }
    }

    return { passed: violations.length === 0, violations };
  },
);

registerFunction(
  {
    id: "skill::pipeline",
    description: "Run the full skill security pipeline (verify, scan, sandbox)",
    metadata: { category: "skill-security" },
  },
  async ({
    content,
    signature,
    publicKey,
  }: {
    content: string;
    signature?: string;
    publicKey?: string;
  }): Promise<PipelineReport> => {
    let signatureResult: { verified: boolean; signer?: string } | undefined;

    if (signature && publicKey) {
      signatureResult = await trigger({
        function_id: "skill::verify_signature",
        payload: { skillContent: content, signature, publicKey },
      });
    }

    const scanResult: ScanResult = await trigger({
      function_id: "skill::scan_content",
      payload: { content },
    });
    const sandboxResult: SandboxResult = await trigger({
      function_id: "skill::sandbox_test",
      payload: { skillContent: content },
    });

    const signatureOk = !signature || signatureResult?.verified === true;
    const approved = signatureOk && scanResult.safe && sandboxResult.passed;

    triggerVoid("security::audit", {
      type: "skill_security_pipeline",
      detail: {
        approved,
        signatureVerified: signatureResult?.verified,
        scanSafe: scanResult.safe,
        sandboxPassed: sandboxResult.passed,
        findingCount: scanResult.findings.length,
        violationCount: sandboxResult.violations.length,
      },
    });

    return {
      approved,
      report: {
        signature: signatureResult,
        scan: scanResult,
        sandbox: sandboxResult,
      },
    };
  },
);

registerTrigger({
  type: "http",
  function_id: "skill::verify_signature",
  config: { api_path: "api/skills/verify", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "skill::scan_content",
  config: { api_path: "api/skills/scan", http_method: "POST" },
});
registerTrigger({
  type: "http",
  function_id: "skill::pipeline",
  config: { api_path: "api/skills/pipeline", http_method: "POST" },
});
