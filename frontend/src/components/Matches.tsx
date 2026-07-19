import type { Match } from "../types";

export function Matches({ matches }: { matches: Match[] }) {
  if (!matches.length) {
    return (
      <div id="matches">
        <span className="dim">between rounds…</span>
      </div>
    );
  }
  return (
    <div id="matches">
      {matches.map((m, i) => (
        <div className="matchcard" key={i}>
          <b>{m.home.name}</b> vs <b>{m.away.name}</b>
          <div className="odds">
            odds {m.odds.home} / {m.odds.draw} / {m.odds.away} · form {m.home.last5} v{" "}
            {m.away.last5}
          </div>
          {m.news.map((n, j) => (
            <div className="newsline" key={j}>
              📰 {n}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
