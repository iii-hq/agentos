import { useParams, Link } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { docs } from "./docs-data";

function renderMarkdown(content: string) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("# ")) {
      elements.push(
        <h1 key={i} className="font-mono font-bold text-2xl mb-6 mt-2">
          {line.slice(2)}
        </h1>,
      );
      i++;
      continue;
    }

    if (line.startsWith("## ")) {
      elements.push(
        <h2 key={i} className="font-mono font-semibold text-lg mt-10 mb-4">
          {line.slice(3)}
        </h2>,
      );
      i++;
      continue;
    }

    if (line.startsWith("### ")) {
      elements.push(
        <h3
          key={i}
          className="font-mono font-semibold text-sm mt-8 mb-3 text-zinc-200"
        >
          {line.slice(4)}
        </h3>,
      );
      i++;
      continue;
    }

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      elements.push(
        <div
          key={`code-${i}`}
          className="my-4 rounded-xl border border-white/6 bg-[#0a0a0a] overflow-hidden"
        >
          {lang && (
            <div className="px-4 py-2 border-b border-white/6">
              <span className="font-mono text-[10px] text-primary">{lang}</span>
            </div>
          )}
          <pre className="p-4 overflow-x-auto text-sm leading-relaxed">
            <code className="font-mono text-zinc-300">
              {codeLines.join("\n")}
            </code>
          </pre>
        </div>,
      );
      continue;
    }

    if (line.startsWith("| ") && lines[i + 1]?.startsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      const headerCells = tableLines[0]
        .split("|")
        .filter((c) => c.trim())
        .map((c) => c.trim());
      const bodyRows = tableLines.slice(2).map((row) =>
        row
          .split("|")
          .filter((c) => c.trim())
          .map((c) => c.trim()),
      );
      elements.push(
        <div key={`table-${i}`} className="my-4 overflow-x-auto">
          <table className="w-full border-collapse font-mono text-sm">
            <thead>
              <tr className="border-b border-white/10">
                {headerCells.map((cell, j) => (
                  <th
                    key={j}
                    className="text-left py-2 pr-4 text-xs text-muted font-medium"
                  >
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, ri) => (
                <tr key={ri} className="border-b border-white/[0.04]">
                  {row.map((cell, ci) => (
                    <td key={ci} className="py-2 pr-4 text-xs text-zinc-300">
                      <code className="text-primary/80">{cell}</code>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (line.startsWith("- **")) {
      const listItems: string[] = [];
      while (i < lines.length && lines[i].startsWith("- ")) {
        listItems.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <ul key={`list-${i}`} className="my-3 space-y-1.5">
          {listItems.map((item, j) => (
            <li key={j} className="font-mono text-sm text-zinc-300 flex gap-2">
              <span className="text-primary mt-1 shrink-0">-</span>
              <span dangerouslySetInnerHTML={{ __html: inlineFormat(item) }} />
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    if (line.startsWith("- ")) {
      const listItems: string[] = [];
      while (i < lines.length && lines[i].startsWith("- ")) {
        listItems.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <ul key={`list-${i}`} className="my-3 space-y-1">
          {listItems.map((item, j) => (
            <li key={j} className="font-mono text-sm text-zinc-400 flex gap-2">
              <span className="text-zinc-600 shrink-0">-</span>
              <span dangerouslySetInnerHTML={{ __html: inlineFormat(item) }} />
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    elements.push(
      <p
        key={i}
        className="font-mono text-sm text-zinc-400 leading-relaxed my-3"
        dangerouslySetInnerHTML={{ __html: inlineFormat(line) }}
      />,
    );
    i++;
  }

  return elements;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sanitizeUrl(url: string): string {
  const trimmed = url.trim().toLowerCase();
  if (
    trimmed.startsWith("javascript:") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("vbscript:")
  ) {
    return "#";
  }
  return url;
}

function inlineFormat(text: string): string {
  const escaped = escapeHtml(text);
  return escaped
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_, linkText, url) =>
        `<a href="${sanitizeUrl(url)}" class="text-cyan-400 hover:text-cyan-300 underline" target="_blank" rel="noopener noreferrer">${linkText}</a>`,
    )
    .replace(
      /`([^`]+)`/g,
      '<code class="bg-white/10 px-1.5 py-0.5 rounded text-cyan-300 text-sm">$1</code>',
    )
    .replace(
      /\*\*([^*]+)\*\*/g,
      '<strong class="text-white font-semibold">$1</strong>',
    );
}

export default function DocsPage() {
  const { slug } = useParams<{ slug: string }>();
  const docIndex = docs.findIndex((d) => d.slug === slug);
  const doc = docs[docIndex];

  if (!doc) {
    return (
      <div className="py-20 text-center">
        <h1 className="font-mono font-bold text-2xl mb-4">Page not found</h1>
        <Link
          to="/docs"
          className="text-primary font-mono text-sm hover:underline"
        >
          Back to docs
        </Link>
      </div>
    );
  }

  const prev = docIndex > 0 ? docs[docIndex - 1] : null;
  const next = docIndex < docs.length - 1 ? docs[docIndex + 1] : null;

  return (
    <div>
      <div className="mb-6">
        <span className="font-mono text-[10px] text-muted uppercase tracking-wider">
          {doc.category}
        </span>
      </div>

      <article>{renderMarkdown(doc.content)}</article>

      <div className="mt-16 pt-8 border-t border-white/6 flex justify-between gap-4">
        {prev ? (
          <Link
            to={`/docs/${prev.slug}`}
            className="flex items-center gap-2 text-muted hover:text-white transition-colors font-mono text-sm group"
          >
            <ChevronLeft
              size={14}
              className="group-hover:-translate-x-0.5 transition-transform"
            />
            {prev.title}
          </Link>
        ) : (
          <div />
        )}
        {next ? (
          <Link
            to={`/docs/${next.slug}`}
            className="flex items-center gap-2 text-muted hover:text-white transition-colors font-mono text-sm group"
          >
            {next.title}
            <ChevronRight
              size={14}
              className="group-hover:translate-x-0.5 transition-transform"
            />
          </Link>
        ) : (
          <div />
        )}
      </div>
    </div>
  );
}
