import { Link, Outlet, useLocation } from "react-router-dom";
import { useState } from "react";
import { Menu, X, ChevronRight } from "lucide-react";
import { docs, categories } from "./docs-data";

const grouped = categories.map((cat) => ({
  category: cat,
  items: docs.filter((d) => d.category === cat),
}));

export default function DocsLayout() {
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const currentSlug = location.pathname.split("/docs/")[1] || "";

  return (
    <div className="min-h-screen bg-black text-white">
      <nav className="fixed top-0 left-0 right-0 z-50 backdrop-blur-md bg-black/90 border-b border-white/6">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-4">
              <button
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className="lg:hidden text-muted hover:text-white p-1.5"
                aria-label="Toggle sidebar"
                aria-expanded={sidebarOpen}
                aria-controls="docs-sidebar"
              >
                {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
              </button>
              <Link to="/" className="font-mono font-bold text-lg">
                agents<span className="text-primary">_</span>os
              </Link>
              <ChevronRight size={14} className="text-zinc-600" />
              <span className="font-mono text-sm text-muted">docs</span>
            </div>
            <div className="flex items-center gap-3">
              <a
                href="https://github.com/rohitg00/agentsos"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="GitHub repository"
                className="text-muted hover:text-white transition-colors"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
              </a>
              <Link
                to="/"
                className="text-muted text-xs font-mono hover:text-white transition-colors"
              >
                Home
              </Link>
            </div>
          </div>
        </div>
      </nav>

      <div className="pt-14 flex">
        <aside
          id="docs-sidebar"
          role="navigation"
          className={`fixed lg:sticky top-14 left-0 z-40 h-[calc(100vh-3.5rem)] w-64 shrink-0 border-r border-white/6 bg-black overflow-y-auto transition-transform duration-200 ${
            sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
          }`}
        >
          <div className="p-4 space-y-6">
            {grouped.map((group) => (
              <div key={group.category}>
                <h4 className="font-mono text-[10px] font-semibold text-muted uppercase tracking-wider mb-2">
                  {group.category}
                </h4>
                <div className="space-y-0.5">
                  {group.items.map((doc) => (
                    <Link
                      key={doc.slug}
                      to={`/docs/${doc.slug}`}
                      onClick={() => setSidebarOpen(false)}
                      className={`block px-3 py-1.5 rounded-lg text-xs font-mono transition-colors ${
                        currentSlug === doc.slug
                          ? "text-primary bg-primary/10"
                          : "text-zinc-400 hover:text-white hover:bg-white/5"
                      }`}
                    >
                      {doc.title}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </aside>

        {sidebarOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/60 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <main className="flex-1 min-w-0 px-6 py-10 lg:px-12 max-w-4xl">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
