import type { LeagueState } from "../types";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

export function Header({ state }: { state: LeagueState | null }) {
  return (
    <header>
      <h1>
        <span className="spark">◆</span> Sealed League
      </h1>
      <div className="tag">
        Every prediction committed on-chain before kickoff. Every result settled by Merkle proof.
        No trust required.
      </div>
      <div className="modebar">
        <span className="pill">
          chain: <b>{state?.mode ?? "…"}</b>
        </span>
        <span className="pill">
          round: <b>{state?.roundId ?? "…"}</b>
        </span>
        <span className="pill">
          phase: <b className="phase">{state?.phase ?? "…"}</b>
        </span>
        <span className="walletslot">
          <WalletMultiButton />
        </span>
      </div>
    </header>
  );
}
