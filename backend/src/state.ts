// Shared app state — written by whichever league orchestrator is active
// (sim or txline), read by the /api/state endpoint.
import { AGENTS } from "./agents.js";
import { AgentStats, MatchData, Receipt } from "./types.js";

export interface State {
  mode: string;
  roundId: number;
  phase: string;
  currentMatches: MatchData[];
  agents: AgentStats[];
  receipts: Receipt[];
  log: { ts: number; msg: string }[];
}

export const MAX_RECEIPTS = 400;

export const state: State = {
  mode: "starting",
  roundId: 0,
  phase: "boot",
  currentMatches: [],
  agents: AGENTS.map((a) => ({
    id: a.id, strategy: a.strategy, emoji: a.emoji, blurb: a.blurb,
    pubkey: "", commits: 0, reveals: 0, settled: 0, correct: 0, bankroll: 0,
  })),
  receipts: [],
  log: [],
};

export function log(msg: string) {
  console.log(msg);
  state.log.unshift({ ts: Date.now(), msg });
  state.log = state.log.slice(0, 60);
}
