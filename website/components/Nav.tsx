import { useEffect, useState, useCallback } from "react";
import { Menu, X } from "lucide-react";

const NAV_LINKS = [
  { label: "Why", href: "#why" },
  { label: "Compare", href: "#compare" },
  { label: "Architecture", href: "#architecture" },
  { label: "Code", href: "#code" },
  { label: "Docs", href: "#docs" },
  { label: "Quickstart", href: "#quickstart" },
];

export default function Nav() {
  const [activeSection, setActiveSection] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const ids = NAV_LINKS.map((l) => l.href.slice(1));
    const observers: IntersectionObserver[] = [];

    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) setActiveSection(id);
        },
        { rootMargin: "-50% 0px -50% 0px", threshold: 0 },
      );
      observer.observe(el);
      observers.push(observer);
    });

    return () => observers.forEach((o) => o.disconnect());
  }, []);

  useEffect(() => {
    setScrolled(window.scrollY > 20);
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const handleLinkClick = useCallback(() => setMobileOpen(false), []);

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 backdrop-blur-md bg-black/90 border-b transition-shadow duration-200 ${
        scrolled
          ? "border-white/6 shadow-lg shadow-black/20"
          : "border-transparent"
      }`}
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-14">
          <a href="#" className="font-mono font-bold text-lg shrink-0">
            agents<span className="text-primary">_</span>os
          </a>

          <div className="hidden lg:flex items-center gap-1">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className={`px-2.5 py-1.5 rounded-md text-xs font-mono transition-colors ${
                  activeSection === link.href.slice(1)
                    ? "text-primary bg-primary/10"
                    : "text-muted hover:text-white"
                }`}
              >
                {link.label}
              </a>
            ))}
          </div>

          <div className="hidden lg:flex items-center gap-3 shrink-0">
            <a
              href="https://github.com/iii-hq/agentos"
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
            <a
              href="#quickstart"
              className="bg-primary hover:bg-primary-hover text-black text-sm font-mono font-semibold px-4 py-1.5 rounded-lg transition-colors"
            >
              Get Started
            </a>
          </div>

          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="lg:hidden text-muted hover:text-white p-1.5"
            aria-label="Toggle menu"
            aria-expanded={mobileOpen}
            aria-controls="mobile-menu"
          >
            {mobileOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>

        <div
          id="mobile-menu"
          role="region"
          aria-hidden={!mobileOpen}
          {...(!mobileOpen ? { inert: true } : {})}
          className={`lg:hidden overflow-hidden transition-all duration-200 ease-in-out ${
            mobileOpen ? "max-h-[500px] opacity-100 pb-4" : "max-h-0 opacity-0"
          }`}
        >
          <div className="flex flex-col gap-1 pt-2">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={handleLinkClick}
                className={`px-3 py-2 rounded-lg text-sm font-mono transition-colors ${
                  activeSection === link.href.slice(1)
                    ? "text-primary bg-primary/10"
                    : "text-muted hover:text-white hover:bg-white/5"
                }`}
              >
                {link.label}
              </a>
            ))}
            <div className="flex items-center gap-3 mt-3 pt-3 border-t border-white/6">
              <a
                href="https://github.com/iii-hq/agentos"
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
              <a
                href="#quickstart"
                onClick={handleLinkClick}
                className="bg-primary hover:bg-primary-hover text-black text-sm font-mono font-semibold px-4 py-1.5 rounded-lg transition-colors"
              >
                Get Started
              </a>
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
}
