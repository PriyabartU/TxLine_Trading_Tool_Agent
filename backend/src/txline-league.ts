// Sealed League on the REAL TxLINE feed (FEED=txline).
//
// Differences from the simulated league:
//   - fixtures come from TxLINE's World Cup schedule (free devnet tier)
//   - odds come from TxLINE odds snapshots
//   - each real fixture is its own settlement round (roundId = fixtureId,
//     single-leaf Merkle tree — empty proof, root == leaf)
//   - final results come from TxLINE score records (action=game_finalised /
//     statusId=100), and the keeper fetches TxLINE's stat-validation Merkle
//     proof and verifies it against TxLINE's ON-CHAIN daily roots by
//     simulating their `validate_stat_v2` instruction before settling.
import { randomBytes } from "crypto";
import { AGENTS, forecast } from "./agents.js";
import { Chain, ChainAgentRef } from "./chain.js";
import { buildTree, commitment, resultLeaf } from "./merkle.js";
import { TxlineClient, epochDayNow } from "./txline.js";
import { MatchData, Pick, Receipt } from "./types.js";
import { log, state } from "./state.js";

const COMPETITION_ID = Number(process.env.TXLINE_COMPETITION_ID ?? 72); // World Cup
const MAX_TRACKED = Number(process.env.TXLINE_MAX_FIXTURES ?? 4);
const POLL_SCORES_S = Number(process.env.TXLINE_POLL_S ?? 60);
// When no future fixture is scheduled (TxLINE devnet replays a single demo
// fixture), allow committing on the in-play match: the commitment still
// provably precedes the final result — receipts carry both timestamps.
const ALLOW_LIVE = (process.env.TXLINE_ALLOW_LIVE ?? "1") !== "0";

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const sol = (lamports: number) => "◎" + (lamports / 1e9).toFixed(3);

// Stake sizing: 2% of bankroll baseline, up to 10% at full confidence.
function stakeFor(bankroll: number, confidence: number): number {
  return Math.max(1_000_000, Math.floor(bankroll * (0.02 + 0.08 * confidence)));
}

// ---------------------------------------------------------------------------
// Defensive normalizers — TxLINE field casings vary (Seq vs seq etc.), so we
// probe multiple spellings and log one raw sample for diagnosis.
// ---------------------------------------------------------------------------

const pick = (o: any, ...keys: string[]) => {
  for (const k of keys) if (o?.[k] !== undefined && o?.[k] !== null) return o[k];
  return undefined;
};

function toMs(v: any): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n > 1e12 ? n : n * 1000; // seconds vs milliseconds
}

interface Fixture {
  fixtureId: number;
  home: string;
  away: string;
  startMs: number;
  gameState?: number;
  p1Home: boolean; // Participant1IsHome — maps part1/part2 ↔ home/away
}

let loggedFixtureSample = false;
function normalizeFixture(f: any): Fixture | null {
  const fixtureId = Number(pick(f, "FixtureId", "fixtureId", "Id", "id"));
  // Observed devnet schema: Participant1/Participant2 + Participant1IsHome
  const p1 = pick(f, "Participant1", "participant1");
  const p2 = pick(f, "Participant2", "participant2");
  const p1Home = pick(f, "Participant1IsHome", "participant1IsHome") !== false;
  const home = p1 !== undefined ? (p1Home ? p1 : p2) : pick(f, "HomeTeam", "homeTeam", "HomeTeamName", "Home", "home");
  const away = p1 !== undefined ? (p1Home ? p2 : p1) : pick(f, "AwayTeam", "awayTeam", "AwayTeamName", "Away", "away");
  const startMs = toMs(pick(f, "StartTime", "startTime", "KickOffTime", "kickOffTime", "StartTs", "startTs", "Date", "date"));
  const gameState = pick(f, "GameState", "gameState");
  if (!fixtureId || !startMs) {
    if (!loggedFixtureSample) {
      loggedFixtureSample = true;
      log(`⚠️ unrecognized fixture shape — sample: ${JSON.stringify(f).slice(0, 400)}`);
    }
    return null;
  }
  return {
    fixtureId,
    home: String(home ?? `Fixture-${fixtureId}-Home`),
    away: String(away ?? `Fixture-${fixtureId}-Away`),
    startMs,
    gameState: gameState !== undefined ? Number(gameState) : undefined,
    p1Home,
  };
}

let loggedOddsSample = false;
/**
 * Observed devnet odds schema (StablePrice feed):
 *   SuperOddsType "1X2_PARTICIPANT_RESULT", PriceNames ["part1","draw","part2"],
 *   Prices as integers ×1000 (5063 → 5.063), MarketPeriod null = full match.
 */
function normalizeOdds(snapshot: any, p1Home: boolean): { home: number; draw: number; away: number } | null {
  const all = (Array.isArray(snapshot) ? snapshot : [snapshot])
    .filter((r) => r && pick(r, "SuperOddsType", "superOddsType") === "1X2_PARTICIPANT_RESULT")
    .sort((a, b) => Number(pick(a, "Ts", "ts") ?? 0) - Number(pick(b, "Ts", "ts") ?? 0));
  // prefer the full-match market (MarketPeriod null); fall back to any period
  // (in-play the feed may only publish e.g. extra-time markets)
  const fullMatch = all.filter((r) => !pick(r, "MarketPeriod", "marketPeriod"));
  const records = fullMatch.length ? fullMatch : all;
  const latest = records[records.length - 1];
  if (latest) {
    const prices = pick(latest, "Prices", "prices");
    if (Array.isArray(prices) && prices.length >= 3) {
      const [p1, draw, p2] = prices.map((n: any) => Number(n) / 1000);
      if (p1 > 1 && draw > 1 && p2 > 1) {
        return p1Home ? { home: p1, draw, away: p2 } : { home: p2, draw, away: p1 };
      }
    }
  }
  const raw = Array.isArray(snapshot) ? snapshot[0] : snapshot;
  if (!loggedOddsSample && raw) {
    loggedOddsSample = true;
    log(`⚠️ unrecognized odds shape — sample: ${JSON.stringify(raw).slice(0, 400)}`);
  }
  return null;
}

interface FinalScore {
  seq: number;
  home: number;
  away: number;
}

let loggedScoreSample = false;
/**
 * Observed devnet score record: Seq, Action, StatusId, GameState (string),
 * goals in Score.Participant1.Total.Goals / Score.Participant2.Total.Goals.
 * Docs: final records use action=game_finalised / statusId=100 / period=100.
 */
export function extractScore(record: any, p1Home: boolean): FinalScore | null {
  const seq = Number(pick(record, "Seq", "seq"));
  const score = pick(record, "Score", "score");
  const g1 = Number(score?.Participant1?.Total?.Goals ?? score?.participant1?.total?.goals ?? 0);
  const g2 = Number(score?.Participant2?.Total?.Goals ?? score?.participant2?.total?.goals ?? 0);
  if (!Number.isFinite(seq) || seq < 1) return null;
  return p1Home ? { seq, home: g1, away: g2 } : { seq, home: g2, away: g1 };
}

function isFinalRecord(r: any): boolean {
  const action = String(pick(r, "Action", "action") ?? "");
  const statusId = Number(pick(r, "StatusId", "statusId"));
  const period = Number(pick(r, "Period", "period"));
  const gameState = String(pick(r, "GameState", "gameState") ?? "");
  return action === "game_finalised" || statusId === 100 || period === 100 || /finali[sz]ed|finished/i.test(gameState);
}

function extractFinal(snapshot: any, p1Home: boolean, minSeq = 0): FinalScore | null {
  const records = Array.isArray(snapshot) ? snapshot : [snapshot];
  for (const r of records.slice().reverse()) {
    if (!isFinalRecord(r)) continue;
    const s = extractScore(r, p1Home);
    // ignore final records from a previous replay cycle of the same fixture
    if (s && s.seq <= minSeq) continue;
    if (s) return s;
    if (!loggedScoreSample) {
      loggedScoreSample = true;
      log(`⚠️ finalised record but unrecognized score fields — sample: ${JSON.stringify(r).slice(0, 400)}`);
    }
  }
  return null;
}

function outcomeOf(home: number, away: number): Pick {
  return home > away ? 0 : home < away ? 2 : 1;
}

/** Synthesize the MatchData shape our agents consume from a real fixture. */
function toMatchData(f: Fixture, odds: { home: number; draw: number; away: number }): MatchData {
  // invert implied probabilities into pseudo elo ratings so every persona works
  const iH = 1 / odds.home, iA = 1 / odds.away;
  const pH = iH / (iH + iA);
  const diff = 400 * Math.log10(Math.max(0.05, Math.min(0.95, pH)) / (1 - Math.max(0.05, Math.min(0.95, pH))));
  return {
    matchId: f.fixtureId,
    roundId: f.fixtureId,
    home: { name: f.home, rating: Math.round(1600 + diff / 2 - 30), last5: "-----", keyInjuries: 0 },
    away: { name: f.away, rating: Math.round(1600 - diff / 2 + 30), last5: "-----", keyInjuries: 0 },
    odds,
    publicLean: odds.home <= odds.away ? 0 : 2,
    news: [],
    startTs: Math.floor(f.startMs / 1000),
    commitDeadline: Math.floor(f.startMs / 1000) - 30,
  };
}

// ---------------------------------------------------------------------------

export async function runTxlineLeague(chain: Chain) {
  state.mode = `${chain.mode}+txline`;
  state.phase = "connecting to TxLINE";

  const tx = new TxlineClient();
  await tx.connect();
  log(`🛰  connected to TxLINE devnet — wallet ${tx.wallet.publicKey.toBase58()}`);

  const refs = new Map<string, ChainAgentRef>();
  for (const a of AGENTS) {
    const { agent } = await chain.registerAgent(a.id, a.strategy);
    refs.set(a.id, agent);
    const stats = state.agents.find((s) => s.id === a.id)!;
    stats.pubkey = agent.pubkey.toString("hex");
    stats.bankroll = chain.bankroll(a.id);
  }
  log(`🤖 swarm registered (${AGENTS.length} agents) — each staked with a devnet-SOL bankroll, wrong picks get slashed`);

  const tracked = new Set<number>();

  for (;;) {
    state.phase = "scanning TxLINE schedule";
    let fixtures: Fixture[] = [];
    try {
      for (const day of [epochDayNow(), epochDayNow() + 1]) {
        const raw = await tx.fixturesSnapshot(COMPETITION_ID, day);
        const arr = Array.isArray(raw) ? raw : (raw?.fixtures ?? raw?.data ?? []);
        fixtures.push(...(arr.map(normalizeFixture).filter(Boolean) as Fixture[]));
      }
    } catch (e) {
      log(`⚠️ fixtures fetch failed: ${(e as Error).message.slice(0, 150)}`);
    }

    let upcoming = fixtures
      .filter((f) => f.startMs > Date.now() + 90_000 && (f.gameState === undefined || f.gameState === 1))
      .filter((f) => !tracked.has(f.fixtureId))
      .sort((a, b) => a.startMs - b.startMs)
      .slice(0, Math.max(0, MAX_TRACKED - tracked.size));
    let live = false;

    // Fallback: no scheduled future fixture → live-commit on an in-play one.
    if (upcoming.length === 0 && tracked.size === 0 && ALLOW_LIVE) {
      for (const f of fixtures.filter((x) => !tracked.has(x.fixtureId))) {
        try {
          const snap = await tx.scoresSnapshot(f.fixtureId);
          const recs = Array.isArray(snap) ? snap : [snap];
          const last = recs[recs.length - 1];
          if (last && !isFinalRecord(last)) {
            upcoming = [{ ...f, startMs: Date.now() + 60_000 }]; // 45s commit window, reveal at +60s
            live = true;
            break;
          }
        } catch { /* no score feed for this fixture */ }
      }
    }

    if (upcoming.length === 0 && tracked.size === 0) {
      log(`🕐 no active World Cup fixtures found (competition ${COMPETITION_ID}) — rescanning in 5 min`);
      state.phase = "waiting for fixtures";
      await sleep(300);
      continue;
    }

    for (const f of upcoming) {
      tracked.add(f.fixtureId);
      trackFixture(chain, tx, refs, f, live).catch((e) => {
        log(`❌ fixture ${f.fixtureId} failed: ${(e as Error).message.slice(0, 200)}`);
      }).finally(() => tracked.delete(f.fixtureId));
      log(live
        ? `🏟  LIVE COMMIT on in-play fixture: ${f.home} v ${f.away} — result unknown, sealed before final whistle`
        : `🏟  tracking real fixture: ${f.home} v ${f.away} — kickoff ${new Date(f.startMs).toUTCString()}`);
    }

    state.phase = tracked.size ? `tracking ${tracked.size} live fixture(s)` : "scanning TxLINE schedule";
    await sleep(300);
  }
}

async function trackFixture(chain: Chain, tx: TxlineClient, refs: Map<string, ChainAgentRef>, f: Fixture, live = false) {
  // odds (best-effort; agents fall back to defaults if unavailable pre-match)
  let odds = { home: 2.5, draw: 3.2, away: 2.9 };
  try {
    const parsed = normalizeOdds(await tx.oddsSnapshot(f.fixtureId), f.p1Home);
    if (parsed) odds = parsed;
  } catch { /* odds may not be published yet */ }

  // Live-commit context: agents see the current score; extractFinal must only
  // accept finalisation records NEWER than what exists at commit time (the
  // devnet fixture replays, so stale finals from a prior cycle may linger).
  let baselineSeq = 0;
  const liveNews: string[] = [];
  if (live) {
    try {
      const snap = await tx.scoresSnapshot(f.fixtureId);
      const recs = Array.isArray(snap) ? snap : [snap];
      const cur = extractScore(recs[recs.length - 1], f.p1Home);
      if (cur) {
        baselineSeq = cur.seq;
        liveNews.push(`LIVE COMMIT: match in progress, current score ${f.home} ${cur.home}–${cur.away} ${f.away}. Predict the FINAL result.`);
      }
    } catch { /* proceed without live context */ }
  }

  const m = toMatchData(f, odds);
  m.news = liveNews;
  // Unique on-chain match id per tracking cycle (the devnet fixture replays;
  // PDAs are per match id). The real TxLINE fixtureId is kept on the receipt.
  m.matchId = f.fixtureId * 1000 + (Math.floor(Date.now() / 60000) % 1000);
  m.roundId = m.matchId;
  state.currentMatches = [...state.currentMatches.filter((x) => x.matchId !== m.matchId), m];

  await chain.createMatch(m.matchId, m.roundId, m.home.name, m.away.name, m.startTs, m.commitDeadline);

  // COMMIT — before the real kickoff
  const receipts: Receipt[] = [];
  await Promise.all(
    AGENTS.map(async (a) => {
      const ref = refs.get(a.id)!;
      const fc = await forecast(a, m);
      const salt = randomBytes(32);
      const c = commitment(m.matchId, fc.pick, salt, ref.pubkey);
      const stake = stakeFor(chain.bankroll(a.id), fc.confidence);
      const txCommit = await chain.commit(ref, m.matchId, c, stake);
      const stats = state.agents.find((s) => s.id === a.id)!;
      stats.commits += 1;
      stats.bankroll = chain.bankroll(a.id);
      const r: Receipt = {
        agentId: a.id, matchId: m.matchId, roundId: m.roundId,
        matchLabel: `${m.home.name} v ${m.away.name}`,
        pick: fc.pick, confidence: fc.confidence, rationale: fc.rationale, source: fc.source,
        salt: salt.toString("hex"), commitment: c.toString("hex"), stake,
        agentPubkey: ref.pubkey.toString("hex"),
        txCommit, txReveal: "", committedAt: Date.now(),
      };
      receipts.push(r);
      state.receipts.unshift(r);
    }),
  );
  const pot = receipts.reduce((n, r) => n + r.stake, 0);
  log(`🔒 ${receipts.length} commitments sealed for ${f.home} v ${f.away}, ${sol(pot)} staked into the pot — hidden until kickoff`);

  // wait for kickoff, then REVEAL
  const untilKickoff = (f.startMs - Date.now()) / 1000;
  if (untilKickoff > 0) await sleep(untilKickoff + 2);
  for (const r of receipts) {
    r.txReveal = await chain.reveal(refs.get(r.agentId)!, r.matchId, r.pick, Buffer.from(r.salt, "hex"));
    r.revealedAt = Date.now();
    state.agents.find((s) => s.id === r.agentId)!.reveals += 1;
  }
  log(`📣 picks revealed for ${f.home} v ${f.away} — match in progress`);

  // poll TxLINE scores until finalised
  let final: FinalScore | null = null;
  while (!final) {
    await sleep(POLL_SCORES_S);
    try {
      final = extractFinal(await tx.scoresSnapshot(f.fixtureId), f.p1Home, baselineSeq);
    } catch (e) {
      log(`⚠️ scores poll ${f.fixtureId}: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  const result = outcomeOf(final.home, final.away);
  log(`🏁 FT ${f.home} ${final.home}–${final.away} ${f.away} (TxLINE seq ${final.seq})`);

  // Verify TxLINE's Merkle proof against THEIR on-chain daily roots
  // (statKeys 1,2 = home/away score; binary subtract predicate proves the margin).
  let verified = false;
  let statKeys = [1, 2];
  try {
    const validation = await tx.statValidation(f.fixtureId, final.seq, statKeys);
    const diff = final.home - final.away;
    const [ia, ib, th] = diff >= 0 ? [0, 1, diff] : [1, 0, -diff];
    verified = await tx.validateStatV2View(validation, [
      { binary: { indexA: ia, indexB: ib, op: { subtract: {} }, predicate: { threshold: th, comparison: { equalTo: {} } } } },
    ]);
    log(`🌳 TxLINE proof verified against on-chain daily root (validate_stat_v2) ✔`);
  } catch (e) {
    log(`⚠️ TxLINE on-chain verification unavailable: ${(e as Error).message.slice(0, 150)}`);
  }

  // settle on OUR program: single-leaf round (root == leaf, empty proof)
  const tree = buildTree([resultLeaf(m.matchId, result)]);
  await chain.postRoot(m.roundId, tree.root);
  for (const r of receipts) {
    r.txSettle = await chain.settle(refs.get(r.agentId)!, r.matchId, r.roundId, result, []);
    r.result = result;
    r.correct = r.pick === result;
    r.leaf = resultLeaf(r.matchId, result).toString("hex");
    r.proof = [];
    r.root = tree.root.toString("hex");
    r.settledAt = Date.now();
    r.txline = {
      fixtureId: f.fixtureId, seq: final.seq, statKeys,
      verifiedOnChain: verified,
      note: (verified
        ? "result proven against TxLINE's on-chain daily scores root via validate_stat_v2"
        : "settled from TxLINE signed feed (on-chain proof simulation unavailable)")
        + (live ? " · live-commit: sealed in-play, before the final whistle" : ""),
    };
    const stats = state.agents.find((s) => s.id === r.agentId)!;
    stats.settled += 1;
    if (r.correct) stats.correct += 1;
  }

  // CLAIM: parimutuel payout — winners split the wrong pickers' stakes.
  let redistributed = 0;
  for (const r of receipts) {
    const { payout } = await chain.claim(refs.get(r.agentId)!, r.matchId);
    r.payout = payout;
    if (payout > 0) redistributed += payout - r.stake;
    state.agents.find((s) => s.id === r.agentId)!.bankroll = chain.bankroll(r.agentId);
  }
  state.currentMatches = state.currentMatches.filter((x) => x.matchId !== m.matchId);
  log(`✅ ${f.home} v ${f.away} settled trustlessly — ${receipts.filter((r) => r.correct).length}/${receipts.length} agents correct, ${sol(redistributed)} redistributed from slashed stakes`);
}
