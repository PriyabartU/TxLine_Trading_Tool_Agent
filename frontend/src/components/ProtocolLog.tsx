import type { LogEntry } from "../types";

export function ProtocolLog({ log }: { log: LogEntry[] }) {
  return (
    <div id="log">
      {log.map((l, i) => (
        <div key={`${l.ts}-${i}`}>
          {new Date(l.ts).toLocaleTimeString()} — {l.msg}
        </div>
      ))}
    </div>
  );
}
