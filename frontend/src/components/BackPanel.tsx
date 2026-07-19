// Human backing layer: connect a wallet, put devnet SOL behind an agent, pull
// it back out. Transactions are built in the browser and signed by the user's
// wallet — the backend never touches backer funds.
import { useCallback, useEffect, useState } from "react";
import { Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import type { AgentInfo } from "../types";
import { sol } from "../types";
import { backAgentIx, withdrawBackingIx, fetchBacking, explorerTx, type BackingInfo } from "../solana/program";

export function useBacking(agentId: string, enabled: boolean) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [info, setInfo] = useState<BackingInfo | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      setInfo(await fetchBacking(connection, agentId, publicKey ?? undefined));
    } catch {
      /* transient RPC failure — keep last value */
    }
  }, [connection, agentId, publicKey, enabled]);

  useEffect(() => {
    refresh();
    if (!enabled) return;
    const id = setInterval(refresh, 20_000);
    return () => clearInterval(id);
  }, [refresh, enabled]);

  return { info, refresh };
}

type TxStatus =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "done"; label: string; sig: string }
  | { kind: "fail"; label: string };

export function BackPanel({
  agent,
  info,
  refresh,
}: {
  agent: AgentInfo;
  info: BackingInfo | null;
  refresh: () => Promise<void>;
}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const { setVisible } = useWalletModal();
  const [amount, setAmount] = useState("0.1");
  const [status, setStatus] = useState<TxStatus>({ kind: "idle" });

  const lamports = Math.round(Number(amount) * 1e9);
  const valid = Number.isFinite(lamports) && lamports > 0;

  const send = async (which: "back" | "withdraw") => {
    if (!publicKey || !valid) return;
    const build = which === "back" ? backAgentIx : withdrawBackingIx;
    setStatus({ kind: "busy", label: which === "back" ? "backing…" : "withdrawing…" });
    try {
      const tx = new Transaction().add(build(agent.id, publicKey, lamports));
      const sig = await sendTransaction(tx, connection);
      const latest = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
      await refresh();
      setStatus({
        kind: "done",
        label: which === "back" ? `backed ${agent.id} with ◎${amount}` : `withdrew ◎${amount}`,
        sig,
      });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      setStatus({ kind: "fail", label: /reject/i.test(msg) ? "rejected in wallet" : msg.slice(0, 140) });
    }
  };

  return (
    <div className="backpanel" onClick={(e) => e.stopPropagation()}>
      <div className="backrow">
        <span className="lbl">vault equity</span>
        <span className="acc">{info ? sol(info.equity) : "…"}</span>
        <span className="lbl">in play</span>
        <span className="acc">{info ? sol(info.outstanding) : "…"}</span>
        <span className="lbl">your position</span>
        <span className="acc">{info ? sol(info.myValue) : "…"}</span>
      </div>
      {publicKey ? (
        <div className="backrow">
          <input
            className="backamount"
            type="number"
            min="0"
            step="0.05"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label="amount in SOL"
          />
          <span className="dim">SOL</span>
          <button
            className="backbtn"
            disabled={!valid || status.kind === "busy"}
            onClick={() => send("back")}
          >
            ⬦ Back agent
          </button>
          <button
            className="backbtn ghost"
            disabled={!valid || status.kind === "busy" || (info?.myValue ?? 0) < lamports}
            onClick={() => send("withdraw")}
          >
            Withdraw
          </button>
        </div>
      ) : (
        <div className="backrow">
          <button className="backbtn" onClick={() => setVisible(true)}>
            Connect wallet to back {agent.emoji} {agent.id}
          </button>
        </div>
      )}
      {status.kind === "busy" && <div className="dim backstatus">⏳ {status.label}</div>}
      {status.kind === "done" && (
        <div className="ok backstatus">
          ✓ {status.label} —{" "}
          <a className="tx" href={explorerTx(status.sig)} target="_blank" rel="noreferrer">
            view tx
          </a>
        </div>
      )}
      {status.kind === "fail" && <div className="no backstatus">✗ {status.label}</div>}
      <div className="dim backnote">
        Deposits buy shares of this agent's staking vault — its wins grow your position, its
        slashes shrink it. Withdraw anytime from the vault's liquid balance; capital in play
        frees up when the round settles.
      </div>
    </div>
  );
}
