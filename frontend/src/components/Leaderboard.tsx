import { Fragment, useState } from "react";
import type { LeagueState, AgentInfo, Receipt } from "../types";
import { sol, START_BANKROLL } from "../types";
import { ReceiptCard } from "./ReceiptCard";
import { BackPanel, useBacking } from "./BackPanel";

function AgentRow({
  agent,
  receipts,
  mode,
}: {
  agent: AgentInfo;
  receipts: Receipt[];
  mode: string;
}) {
  const [open, setOpen] = useState(false);
  const [backOpen, setBackOpen] = useState(false);
  const acc = agent.settled ? (100 * agent.correct) / agent.settled : 0;
  // Backing lives on-chain; only meaningful when the league runs on devnet.
  const onchain = mode === "devnet";
  const { info, refresh } = useBacking(agent.id, onchain);

  return (
    <Fragment>
      <tr className="agent" onClick={() => setOpen((o) => !o)}>
        <td>
          <b>
            {agent.emoji} {agent.id}
          </b>
          <div className="strategy">
            {agent.strategy} — {agent.blurb}
          </div>
        </td>
        <td>
          <span className="acc">{agent.settled ? acc.toFixed(1) + "%" : "—"}</span>
          <div className="bar">
            <i style={{ width: `${acc}%` }} />
          </div>
        </td>
        <td className="acc">
          {agent.correct}/{agent.settled}
        </td>
        <td className="acc">{agent.commits}</td>
        <td>
          {agent.bankroll !== undefined ? (
            <>
              <span className="acc">{sol(agent.bankroll)}</span>
              <div className={`pnl ${agent.bankroll >= START_BANKROLL ? "ok" : "no"}`}>
                {agent.bankroll >= START_BANKROLL ? "+" : "−"}
                {sol(Math.abs(agent.bankroll - START_BANKROLL)).slice(1)}
              </div>
            </>
          ) : (
            <span className="acc">—</span>
          )}
        </td>
        <td>
          {onchain ? (
            <>
              <span className="acc">{info ? sol(info.equity) : "…"}</span>
              <div>
                <button
                  className={`backtoggle ${backOpen ? "on" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setBackOpen((o) => !o);
                  }}
                >
                  ⬦ back
                </button>
              </div>
            </>
          ) : (
            <span className="acc">—</span>
          )}
        </td>
      </tr>
      {backOpen && onchain && (
        <tr className="receipts open">
          <td colSpan={6}>
            <BackPanel agent={agent} info={info} refresh={refresh} />
          </td>
        </tr>
      )}
      <tr className={`receipts ${open ? "open" : ""}`}>
        <td colSpan={6}>
          {receipts.length ? (
            receipts.map((r) => (
              <ReceiptCard key={`${r.agentId}:${r.matchId}`} receipt={r} mode={mode} />
            ))
          ) : (
            <span className="dim">no predictions yet…</span>
          )}
        </td>
      </tr>
    </Fragment>
  );
}

export function Leaderboard({ state }: { state: LeagueState | null }) {
  const agents = state?.agents ?? [];
  const sorted = [...agents].sort(
    (a, b) => (b.settled ? b.correct / b.settled : 0) - (a.settled ? a.correct / a.settled : 0),
  );

  return (
    <table id="board">
      <thead>
        <tr>
          <th>Agent</th>
          <th>Accuracy</th>
          <th>Record</th>
          <th>Commits</th>
          <th>Bankroll</th>
          <th>Backing</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((a) => (
          <AgentRow
            key={a.id}
            agent={a}
            receipts={(state?.receipts ?? []).filter((r) => r.agentId === a.id).slice(0, 12)}
            mode={state?.mode ?? ""}
          />
        ))}
      </tbody>
    </table>
  );
}
