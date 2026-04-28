import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";

type Token = { text: string; className: string };

const keywords: Record<string, Set<string>> = {
  rust: new Set([
    "fn",
    "let",
    "mut",
    "pub",
    "struct",
    "impl",
    "use",
    "async",
    "await",
    "match",
    "return",
    "self",
    "crate",
    "mod",
    "const",
    "type",
    "where",
    "trait",
    "enum",
    "if",
    "else",
    "for",
    "in",
    "loop",
    "while",
    "break",
    "continue",
    "move",
  ]),
  typescript: new Set([
    "const",
    "let",
    "function",
    "async",
    "await",
    "return",
    "import",
    "from",
    "export",
    "type",
    "interface",
    "class",
    "new",
    "if",
    "else",
    "for",
    "of",
    "in",
    "while",
    "break",
    "continue",
    "switch",
    "case",
    "default",
    "throw",
    "try",
    "catch",
  ]),
  python: new Set([
    "def",
    "class",
    "import",
    "from",
    "return",
    "async",
    "await",
    "if",
    "else",
    "elif",
    "for",
    "in",
    "while",
    "break",
    "continue",
    "with",
    "as",
    "try",
    "except",
    "raise",
    "pass",
    "yield",
    "lambda",
    "not",
    "and",
    "or",
    "is",
    "None",
    "True",
    "False",
  ]),
};

function tokenize(code: string, lang: string): Token[][] {
  const kws = keywords[lang] || keywords.typescript;
  return code.split("\n").map((line) => {
    const tokens: Token[] = [];
    const commentStart =
      lang === "python" ? line.indexOf("#") : line.indexOf("//");

    const isLineComment =
      commentStart >= 0 && !isInsideString(line, commentStart);
    const codePart = isLineComment ? line.slice(0, commentStart) : line;
    const commentPart = isLineComment ? line.slice(commentStart) : "";

    const re =
      /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+\b|\b[a-zA-Z_]\w*\b|[^\s\w"'`]+|\s+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(codePart)) !== null) {
      const t = m[0];
      if (/^["'`]/.test(t)) {
        tokens.push({ text: t, className: "text-green-400" });
      } else if (/^\d+$/.test(t)) {
        tokens.push({ text: t, className: "text-amber-400" });
      } else if (kws.has(t)) {
        tokens.push({ text: t, className: "text-purple-400" });
      } else if (/^[a-zA-Z_]/.test(t)) {
        tokens.push({ text: t, className: "text-white" });
      } else {
        tokens.push({ text: t, className: "text-zinc-400" });
      }
    }

    if (commentPart) {
      tokens.push({ text: commentPart, className: "text-zinc-500" });
    }

    return tokens;
  });
}

function isInsideString(line: string, pos: number): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < pos; i++) {
    if (line[i] === '"' && !inSingle) inDouble = !inDouble;
    if (line[i] === "'" && !inDouble) inSingle = !inSingle;
  }
  return inSingle || inDouble;
}

export default function CodeBlock({
  code,
  lang = "typescript",
  filename,
}: {
  code: string;
  lang?: string;
  filename?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lines = useMemo(() => tokenize(code, lang), [code, lang]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Clipboard write failed:", err);
    }
  };

  const langColors: Record<string, string> = {
    rust: "text-primary",
    typescript: "text-primary",
    python: "text-primary",
  };

  return (
    <div className="rounded-xl border border-white/6 bg-[#0a0a0a] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/6">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-primary/60" />
            <div className="w-3 h-3 rounded-full bg-white/20" />
            <div className="w-3 h-3 rounded-full bg-white/10" />
          </div>
          {filename && (
            <span
              className={`text-xs font-mono ${langColors[lang] || "text-zinc-400"}`}
            >
              {filename}
            </span>
          )}
        </div>
        <button
          onClick={copy}
          aria-label={copied ? "Copied to clipboard" : "Copy code"}
          className="text-zinc-500 hover:text-white transition-colors p-1 rounded"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto text-sm leading-relaxed">
        <code className="font-mono">
          {lines.map((lineTokens, i) => (
            <span key={i} className="block">
              {lineTokens.length === 0
                ? "\n"
                : lineTokens.map((token, j) => (
                    <span key={j} className={token.className}>
                      {token.text}
                    </span>
                  ))}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
