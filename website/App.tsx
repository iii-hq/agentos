import Nav from "./components/Nav";
import Hero from "./components/Hero";
import Why from "./components/Why";
import Intelligence from "./components/Intelligence";
import Compare from "./components/Compare";
import Architecture from "./components/Architecture";
import CodeExamples from "./components/CodeExamples";
import Docs from "./components/Docs";
import Quickstart from "./components/Quickstart";
import Footer from "./components/Footer";

export default function App() {
  return (
    <div className="min-h-screen bg-black text-white">
      <Nav />
      <main>
        <Hero />
        <Why />
        <Intelligence />
        <Compare />
        <Architecture />
        <CodeExamples />
        <Docs />
        <Quickstart />
      </main>
      <Footer />
    </div>
  );
}
