export default function Footer() {
  return (
    <footer className="border-t border-white/6 bg-surface py-10">
      <div className="max-w-6xl mx-auto px-6">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <span className="font-mono font-bold text-sm">
            agents<span className="text-primary">_</span>os
          </span>
          <div className="flex items-center gap-6">
            <a
              href="https://github.com/rohitg00/agentos"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted text-xs font-mono hover:text-white transition-colors"
            >
              GitHub
            </a>
            <a
              href="#docs"
              className="text-muted text-xs font-mono hover:text-white transition-colors"
            >
              Docs
            </a>
            <a
              href="#compare"
              className="text-muted text-xs font-mono hover:text-white transition-colors"
            >
              Benchmarks
            </a>
          </div>
          <span className="text-muted text-xs font-mono">Apache-2.0</span>
        </div>
      </div>
    </footer>
  );
}
