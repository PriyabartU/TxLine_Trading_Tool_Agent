export type Pick = 0 | 1 | 2; // 0 = home win, 1 = draw, 2 = away win
export const PICK_LABEL = ["HOME", "DRAW", "AWAY"] as const;

export interface TeamForm {
  name: string;
  rating: number;        // elo-style strength
  last5: string;         // e.g. "WWDLW"
  keyInjuries: number;
}

export interface MatchData {
  matchId: number;
  roundId: number;
  home: TeamForm;
  away: TeamForm;
  odds: { home: number; draw: number; away: number }; // decimal odds
  publicLean: Pick;      // where the "public money" is
  news: string[];        // headline blurbs (sentiment signal)
  startTs: number;       // unix seconds
  commitDeadline: number;
}

export interface AgentDef {
  id: string;            // on-chain name (PDA seed)
  strategy: string;
  emoji: string;
  blurb: string;
  system: string;        // LLM persona prompt
}

export interface Forecast {
  pick: Pick;
  confidence: number;    // 0..1
  rationale: string;
  source: "llm" | "heuristic";
}

export interface Receipt {
  agentId: string;
  matchId: number;
  roundId: number;
  matchLabel: string;
  pick: Pick;
  confidence: number;
  rationale: string;
  source: "llm" | "heuristic";
  salt: string;          // hex
  commitment: string;    // hex
  stake: number;         // lamports locked into the match pot at commit
  payout?: number;       // lamports claimed after grading (0 = slashed)
  agentPubkey: string;   // base58 or hex depending on mode
  txCommit: string;
  txReveal: string;
  txSettle?: string;
  result?: Pick;
  correct?: boolean;
  leaf?: string;         // hex
  proof?: string[];      // hex nodes
  root?: string;         // hex
  committedAt: number;
  revealedAt?: number;
  settledAt?: number;
  /** Present when the result came from TxLINE's signed feed. */
  txline?: {
    fixtureId: number;
    seq: number;
    statKeys: number[];
    verifiedOnChain: boolean; // validate_stat_v2 simulated against TxLINE's devnet program
    note: string;
  };
}

export interface AgentStats {
  id: string;
  strategy: string;
  emoji: string;
  blurb: string;
  pubkey: string;
  commits: number;
  reveals: number;
  settled: number;
  correct: number;
  bankroll: number;      // lamports (demo ledger: starts at 1 devnet SOL)
}
