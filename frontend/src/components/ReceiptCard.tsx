import { useState } from "react";
import type { Receipt } from "../types";
import { PICK, sol } from "../types";
import { verifyReceipt, type VerifyResult } from "../crypto";

function TxLink({ tx, mode }: { tx: string; mode: string }) {
  if (mode === "devnet") {
    return (
      <a
        className="tx"
        target="_blank"
        rel="noreferrer"
        href={`https://explorer.solana.com/tx/${tx}?cluster=devnet`}
      >
        {tx.slice(0, 20)}…
      </a>
    );
  }
  return <span className="hash">{tx}</span>;
}

export function ReceiptCard({ receipt: r, mode }: { receipt: Receipt; mode: string }) {
  const [open, setOpen] = useState(false);
  const [verdict, setVerdict] = useState<VerifyResult | null>(null);

  const status = r.settledAt ? (
    r.correct ? (
      <span className="ok">✓ CORRECT</span>
    ) : (
      <span className="no">✗ WRONG</span>
    )
  ) : r.revealedAt ? (
    "revealed"
  ) : (
    "🔒 sealed"
  );

  const pickTxt =
    r.revealedAt || r.settledAt
      ? `${PICK[r.pick]} (${Math.round(r.confidence * 100)}%)`
      : "hidden until kickoff";

  return (
    <div className={`receipt ${open ? "open" : ""}`}>
      <div className="head" onClick={() => setOpen((o) => !o)}>
        <span>
          {r.matchLabel} — <b>{pickTxt}</b>
          {r.stake !== undefined && <span className="stakechip">at stake {sol(r.stake)}</span>}
        </span>
        <span>{status}</span>
      </div>
      <div className="detail">
        <div className="rationale">
          {r.rationale} <i>({r.source})</i>
        </div>
        <div className="lbl">commitment (posted before kickoff)</div>
        <div className="hash">{r.commitment}</div>
        <div className="lbl">salt</div>
        <div className="hash">{r.salt}</div>
        {r.stake !== undefined && (
          <>
            <div className="lbl">stake (locked in the match pot at commit)</div>
            <div>
              {sol(r.stake)}
              {r.payout !== undefined &&
                (r.payout > 0 ? (
                  <span className="ok">
                    {" "}
                    → payout {sol(r.payout)} (net +{sol(r.payout - r.stake).slice(1)})
                  </span>
                ) : (
                  <span className="no"> → slashed: stake lost to the pot</span>
                ))}
            </div>
          </>
        )}
        {r.settledAt && (
          <>
            <div className="lbl">result</div>
            <div>{r.result !== undefined ? PICK[r.result] : "—"}</div>
            <div className="lbl">merkle leaf</div>
            <div className="hash">{r.leaf}</div>
            <div className="lbl">merkle proof ({r.proof?.length ?? 0} nodes)</div>
            <div className="hash">
              {(r.proof ?? []).map((p) => (
                <div key={p}>{p}</div>
              ))}
            </div>
            <div className="lbl">round results root</div>
            <div className="hash">{r.root}</div>
          </>
        )}
        {r.txline && (
          <>
            <div className="lbl">txline settlement source</div>
            <div style={{ fontSize: 12 }}>
              {r.txline.verifiedOnChain ? (
                <span className="ok">
                  ✓ verified against TxLINE's on-chain daily root (validate_stat_v2)
                </span>
              ) : (
                <span className="dim">settled from TxLINE signed feed</span>
              )}
              <div className="hash">
                fixture {r.txline.fixtureId} · seq {r.txline.seq} · statKeys{" "}
                {r.txline.statKeys.join(",")}
              </div>
            </div>
          </>
        )}
        <div className="lbl">transactions</div>
        <div>
          commit: <TxLink tx={r.txCommit} mode={mode} />
        </div>
        {r.txReveal && (
          <div>
            reveal: <TxLink tx={r.txReveal} mode={mode} />
          </div>
        )}
        {r.txSettle && (
          <div>
            settle: <TxLink tx={r.txSettle} mode={mode} />
          </div>
        )}
        {r.settledAt && (
          <div className="verify">
            <button onClick={() => verifyReceipt(r).then(setVerdict)}>
              verify cryptographically
            </button>{" "}
            {verdict && (
              <span>
                {verdict.commitOk ? (
                  <span className="ok">✓ commitment hash verified</span>
                ) : (
                  <span className="no">✗ commitment mismatch!</span>
                )}
                {"  "}
                {verdict.proofOk ? (
                  <span className="ok">✓ Merkle proof verified in your browser</span>
                ) : (
                  <span className="no">✗ proof invalid</span>
                )}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
