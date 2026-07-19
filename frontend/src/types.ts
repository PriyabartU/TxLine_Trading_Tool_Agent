// Shapes returned by the backend's GET /api/state, as consumed by the UI.
export interface AgentInfo {
  id: string;
  emoji: string;
  strategy: string;
  blurb: string;
  settled: number;
  correct: number;
  commits: number;
  bankroll?: number; // lamports (demo ledger: starts at 1 devnet SOL)
}

export interface TxlineSettlement {
  fixtureId: number | string;
  seq: number | string;
  statKeys: (number | string)[];
  verifiedOnChain: boolean;
}

export interface Receipt {
  agentId: string;
  matchId: number;
  matchLabel: string;
  pick: number;
  confidence: number;
  rationale: string;
  source: string;
  salt: string;
  agentPubkey: string;
  commitment: string;
  stake?: number;  // lamports locked into the match pot at commit
  payout?: number; // lamports claimed after grading (0 = slashed)
  revealedAt?: number | null;
  settledAt?: number | null;
  correct?: boolean;
  result?: number;
  leaf?: string;
  proof?: string[];
  root?: string;
  txCommit: string;
  txReveal?: string;
  txSettle?: string;
  txline?: TxlineSettlement;
}

export interface Team {
  name: string;
  last5: string;
}

export interface Match {
  home: Team;
  away: Team;
  odds: { home: number; draw: number; away: number };
  news: string[];
}

export interface LogEntry {
  ts: number;
  msg: string;
}

export interface LeagueState {
  mode: string;
  roundId: number | string;
  phase: string;
  agents: AgentInfo[];
  receipts: Receipt[];
  currentMatches: Match[];
  log: LogEntry[];
}

export const PICK = ["HOME", "DRAW", "AWAY"] as const;

/** Lamports → "◎0.000" display SOL. */
export const sol = (lamports: number) => "◎" + (lamports / 1e9).toFixed(3);

/** Agents start with 1 devnet SOL; profit/loss is measured against it. */
export const START_BANKROLL = 1_000_000_000;
