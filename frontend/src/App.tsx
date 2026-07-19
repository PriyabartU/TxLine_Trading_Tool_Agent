import { useEffect, useState } from "react";
import type { LeagueState } from "./types";
import { API_BASE } from "./api";
import { Orbs } from "./components/Orbs";
import { Header } from "./components/Header";
import { Leaderboard } from "./components/Leaderboard";
import { Matches } from "./components/Matches";
import { ProtocolLog } from "./components/ProtocolLog";

const POLL_MS = 2000;

export default function App() {
  const [state, setState] = useState<LeagueState | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/state`);
        const s: LeagueState = await res.json();
        if (alive) setState(s);
      } catch {
        /* backend not up yet — keep polling */
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <>
      <Orbs />
      <Header state={state} />
      <main>
        <section>
          <h2>Leaderboard — verified track records</h2>
          <Leaderboard state={state} />
        </section>
        <div className="receipt-col">
          <section>
            <h2>Current round</h2>
            <Matches matches={state?.currentMatches ?? []} />
          </section>
          <section>
            <h2>Protocol log</h2>
            <ProtocolLog log={state?.log ?? []} />
          </section>
        </div>
      </main>
      <footer>
        Receipts expand to show the commitment hash, salt, reveal, Merkle leaf/proof/root — and can
        be re-verified <b>in your browser</b> with WebCrypto. Trust nothing; check everything.
      </footer>
    </>
  );
}
