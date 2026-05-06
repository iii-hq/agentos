import SectionHeader from "./SectionHeader";
import EngineDiagram from "./EngineDiagram";

const lanes = [
  { id: "http", label: "iii-http", port: ":3111", note: "REST trigger surface" },
  { id: "ws", label: "iii (engine)", port: ":49134", note: "Worker WebSocket bus" },
  { id: "stream", label: "iii-stream", port: ":3112", note: "Server-sent + WS streams" },
  { id: "pubsub", label: "iii-pubsub", port: "—", note: "Topic broadcast" },
  { id: "cron", label: "iii-cron", port: "—", note: "Scheduled triggers" },
  { id: "state", label: "iii-state", port: "—", note: "Atomic UpdateOp store" },
  { id: "obs", label: "iii-observability", port: "—", note: "OTel traces + metrics" },
];

export default function Protocol() {
  return (
    <section id="protocol" className="py-24 border-b border-line">
      <div className="mx-auto px-6" style={{ maxWidth: "min(1240px, 92vw)" }}>
        <SectionHeader num="05" label="Protocol" />

        <div className="grid lg:grid-cols-[1fr_1.1fr] gap-14 items-center">
          <div>
            <h2 className="h-display text-[34px] md:text-[42px] mb-8 max-w-[22ch]">
              One engine. <em>Seven lanes.</em>
            </h2>
            <p className="lede text-[15.5px] mb-8">
              The iii engine ships seven baseline modules. Workers connect to the bus
              on 49134 and register Functions; everything else — routing, scheduling,
              streaming, telemetry — is already there.
            </p>

            <div className="border-t border-l border-line">
              {lanes.map((l) => (
                <div key={l.id} className="grid grid-cols-[1fr_auto] border-r border-b border-line px-4 py-3">
                  <div>
                    <div className="font-mono text-[12px] text-fg">{l.label}</div>
                    <div className="text-[12.5px] text-fg-3">{l.note}</div>
                  </div>
                  <div className="font-mono text-[11.5px] text-fg-3 self-center">{l.port}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-center">
            <EngineDiagram size={460} showLabels />
          </div>
        </div>
      </div>
    </section>
  );
}
