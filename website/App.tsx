import { useEffect, useState } from "react";
import TopNav from "./components/TopNav";
import Hero from "./components/Hero";
import Standpoints from "./components/Standpoints";
import Primitives from "./components/Primitives";
import Agents from "./components/Agents";
import Protocol from "./components/Protocol";
import Workers from "./components/Workers";
import CodeExamples from "./components/CodeExamples";
import UseCases from "./components/UseCases";
import Collapse from "./components/Collapse";
import Counts from "./components/Counts";
import Install from "./components/Install";
import Footer from "./components/Footer";

type Theme = "cream" | "dark" | "light";
const ORDER: Theme[] = ["cream", "dark", "light"];
const KEY = "agentos.theme";

export default function App() {
  const [theme, setTheme] = useState<Theme>("cream");

  useEffect(() => {
    const saved = (localStorage.getItem(KEY) as Theme | null) ?? "cream";
    setTheme(saved);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute(
      "data-theme",
      theme === "cream" ? "" : theme,
    );
    localStorage.setItem(KEY, theme);
  }, [theme]);

  function cycle() {
    setTheme((t) => ORDER[(ORDER.indexOf(t) + 1) % ORDER.length]);
  }

  return (
    <div className="min-h-screen">
      <TopNav theme={theme} onCycle={cycle} />
      <main>
        <Hero />
        <Standpoints />
        <Primitives />
        <Agents />
        <Protocol />
        <Workers />
        <CodeExamples />
        <UseCases />
        <Collapse />
        <Counts />
        <Install />
      </main>
      <Footer />
    </div>
  );
}
