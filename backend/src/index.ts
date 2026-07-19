// Sealed League orchestrator + API server.
//
// FEED=sim (default)  — simulated match feed, fast demo rounds
// FEED=txline         — real World Cup fixtures/odds/results from TxLINE's
//                       signed devnet feed, settled with TxLINE Merkle proofs
//                       (see txline-league.ts)
//
// Sim loop per round:
//   generate matches → agents forecast → COMMIT hashes on-chain →
//   (commit window closes = kickoff) → REVEAL picks → match "plays" →
//   keeper builds the results Merkle tree, posts the root → SETTLE each
//   prediction with its proof → leaderboard updates → next round.
import "./env.js"; // must stay first: loads .env before other modules read process.env
import express from "express";
import { randomBytes } from "crypto";
import { AGENTS, forecast } from "./agents.js";
import { createChain, Chain, ChainAgentRef, START_BANKROLL } from "./chain.js";
import { generateRound, simulateResult, seedFeed } from "./feed.js";
import { buildTree, commitment, resultLeaf } from "./merkle.js";
import { runTxlineLeague } from "./txline-league.js";
import { MAX_RECEIPTS, log, state } from "./state.js";
import { Receipt } from "./types.js";

const PORT = Number(process.env.PORT ?? 3000);
const COMMIT_WINDOW_S = Number(process.env.COMMIT_WINDOW_S ?? 20);
const PLAY_S = Number(process.env.PLAY_S ?? 12);
const PAUSE_S = Number(process.env.PAUSE_S ?? 8);
const MATCHES_PER_ROUND = Number(process.env.MATCHES_PER_ROUND ?? 3);

seedFeed(Date.now() & 0x7fffffff);

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const sol = (lamports: number) => "◎" + (lamports / 1e9).toFixed(3);

// Stake sizing: 2% of bankroll baseline, up to 10% at full confidence.
// Bankroll-proportional so hot streaks compound and cold streaks shrink.
function stakeFor(bankroll: number, confidence: number): number {
  return Math.max(1_000_000, Math.floor(bankroll * (0.02 + 0.08 * confidence)));
}

async function runSimLeague(chain: Chain) {
  state.mode = chain.mode;

  // Register the swarm once.
  const refs = new Map<string, ChainAgentRef>();
  for (const a of AGENTS) {
    const { agent, tx } = await chain.registerAgent(a.id, a.strategy);
    refs.set(a.id, agent);
    const stats = state.agents.find((s) => s.id === a.id)!;
    stats.pubkey = agent.pubkey.toString("hex");
    stats.bankroll = chain.bankroll(a.id);
    log(`🤖 registered ${a.id} (${a.strategy}) — tx ${tx}`);
  }
  log(`💰 keeper seeded each agent's backing vault with ${sol(START_BANKROLL)} devnet-SOL — every pick is staked from the vault, wins grow backers' shares, wrong picks slash them`);

  let roundId = Math.floor(Date.now() / 1000); // unique per run, avoids PDA collisions on devnet

  for (;;) {
    roundId += 1;
    // The public devnet RPC rate-limits and hiccups; a failed round is
    // abandoned and the league carries on with the next one. (Body kept at
    // its original indent to keep the diff reviewable.)
    try {
    // Human backers may have deposited/withdrawn since last round — re-sync
    // each agent's bankroll (vault equity) so stakes size off real capital.
    if (chain.refresh) {
      await chain.refresh();
      for (const s of state.agents) s.bankroll = chain.bankroll(s.id);
    }
    state.roundId = roundId;
    state.phase = "forecasting";
    const matches = generateRound(roundId, MATCHES_PER_ROUND, COMMIT_WINDOW_S, PLAY_S);
    state.currentMatches = matches;
    log(`🏟️  round ${roundId}: ${matches.map((m) => `${m.home.name} v ${m.away.name}`).join(" · ")}`);

    for (const m of matches) {
      await chain.createMatch(m.matchId, roundId, m.home.name, m.away.name, m.startTs, m.commitDeadline);
    }

    // --- COMMIT phase: every agent forecasts and commits a hash ------------
    // In memory mode commits run in parallel; on devnet they run one at a
    // time — the public RPC rate-limits bursts of transactions (429s).
    const roundReceipts: Receipt[] = [];
    const commitJobs = matches.flatMap((m) =>
      AGENTS.map((a) => async () => {
          const ref = refs.get(a.id)!;
          const f = await forecast(a, m);
          const salt = randomBytes(32);
          const c = commitment(m.matchId, f.pick, salt, ref.pubkey);
          const stake = stakeFor(chain.bankroll(a.id), f.confidence);
          const tx = await chain.commit(ref, m.matchId, c, stake);
          const stats = state.agents.find((s) => s.id === a.id)!;
          stats.commits += 1;
          stats.bankroll = chain.bankroll(a.id);
          const r: Receipt = {
            agentId: a.id, matchId: m.matchId, roundId,
            matchLabel: `${m.home.name} v ${m.away.name}`,
            pick: f.pick, confidence: f.confidence, rationale: f.rationale, source: f.source,
            salt: salt.toString("hex"), commitment: c.toString("hex"), stake,
            agentPubkey: ref.pubkey.toString("hex"),
            txCommit: tx, txReveal: "", committedAt: Date.now(),
          };
          roundReceipts.push(r);
          state.receipts.unshift(r);
        }),
    );
    if (chain.mode === "devnet") {
      for (const job of commitJobs) await job();
    } else {
      await Promise.all(commitJobs.map((job) => job()));
    }
    state.receipts = state.receipts.slice(0, MAX_RECEIPTS);
    const roundPot = roundReceipts.reduce((n, r) => n + r.stake, 0);
    log(`🔒 ${roundReceipts.length} sealed commitments on-chain, ${sol(roundPot)} staked into match pots — picks hidden until kickoff`);

    // --- wait for kickoff ---------------------------------------------------
    state.phase = "commit-window";
    const untilKickoff = matches[0].startTs - Date.now() / 1000;
    if (untilKickoff > 0) await sleep(untilKickoff + 1);

    // --- REVEAL phase --------------------------------------------------------
    state.phase = "revealing";
    for (const r of roundReceipts) {
      const ref = refs.get(r.agentId)!;
      // Devnet's cluster clock can trail wall clock by a few seconds; if the
      // program says the match hasn't kicked off yet, wait and retry rather
      // than aborting the round.
      for (let attempt = 0; ; attempt++) {
        try {
          r.txReveal = await chain.reveal(ref, r.matchId, r.pick, Buffer.from(r.salt, "hex"));
          break;
        } catch (err) {
          if (!/RevealTooEarly/.test(String(err)) || attempt >= 5) throw err;
          await sleep(4);
        }
      }
      r.revealedAt = Date.now();
      state.agents.find((s) => s.id === r.agentId)!.reveals += 1;
    }
    log(`📣 all picks revealed — hash-checked against pre-kickoff commitments`);

    // --- matches play out ----------------------------------------------------
    state.phase = "playing";
    await sleep(PLAY_S);

    // --- SETTLE: keeper builds Merkle tree over results, posts root, settles -
    state.phase = "settling";
    const results = new Map(matches.map((m) => [m.matchId, simulateResult(m)]));
    const ordered = [...matches].sort((x, y) => x.matchId - y.matchId);
    const leaves = ordered.map((m) => resultLeaf(m.matchId, results.get(m.matchId)!));
    const tree = buildTree(leaves);
    const rootTx = await chain.postRoot(roundId, tree.root);
    log(`🌳 results Merkle root posted for round ${roundId} — tx ${rootTx}`);

    for (const r of roundReceipts) {
      const idx = ordered.findIndex((m) => m.matchId === r.matchId);
      const result = results.get(r.matchId)!;
      const proof = tree.proof(idx);
      const ref = refs.get(r.agentId)!;
      r.txSettle = await chain.settle(ref, r.matchId, roundId, result, proof);
      r.result = result;
      r.correct = r.pick === result;
      r.leaf = resultLeaf(r.matchId, result).toString("hex");
      r.proof = proof.map((p) => p.toString("hex"));
      r.root = tree.root.toString("hex");
      r.settledAt = Date.now();
      const stats = state.agents.find((s) => s.id === r.agentId)!;
      stats.settled += 1;
      if (r.correct) stats.correct += 1;
    }
    const correctCount = roundReceipts.filter((r) => r.correct).length;
    log(`✅ round ${roundId} settled trustlessly: ${correctCount}/${roundReceipts.length} predictions correct`);

    // --- CLAIM: parimutuel payouts — winners split the losers' stakes -------
    state.phase = "paying out";
    let redistributed = 0;
    for (const r of roundReceipts) {
      const { payout } = await chain.claim(refs.get(r.agentId)!, r.matchId);
      r.payout = payout;
      if (payout > 0) redistributed += payout - r.stake;
      const stats = state.agents.find((s) => s.id === r.agentId)!;
      stats.bankroll = chain.bankroll(r.agentId);
    }
    const slashed = roundReceipts.filter((r) => r.payout === 0).length;
    log(`💸 pots claimed: ${slashed} wrong picks slashed, ${sol(redistributed)} redistributed to correct pickers`);

    // --- CLEANUP: close spent PDAs so their rent flows back to the keeper ----
    if (chain.closeRound) {
      try {
        await chain.closeRound(matches.map((m) => m.matchId), roundId);
        log(`🧹 spent match/prediction/round accounts closed — rent reclaimed by keeper`);
      } catch (err: any) {
        log(`⚠️  cleanup skipped (${String(err?.message ?? err).slice(0, 80)}) — rent stays parked, league unaffected`);
      }
    }

    state.phase = "idle";
    await sleep(PAUSE_S);
    } catch (err: any) {
      log(`⚠️  round ${roundId} aborted (${String(err?.message ?? err).slice(0, 140)}) — resuming in 20s`);
      state.phase = "recovering";
      await sleep(20);
    }
  }
}

// The public devnet RPC drops requests under load; web3.js sometimes surfaces
// that outside any awaited chain. Log and keep the league alive — the next
// round re-syncs all state from chain.
process.on("unhandledRejection", (err: any) => {
  log(`⚠️  unhandled RPC rejection: ${String(err?.message ?? err).slice(0, 140)}`);
});
process.on("uncaughtException", (err: any) => {
  log(`⚠️  uncaught RPC exception: ${String(err?.message ?? err).slice(0, 140)}`);
});

// --- API server (frontend is served separately from frontend/) ---------------

const app = express();

// CORS: the frontend runs on a different port/process.
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.WEB_ORIGIN ?? "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  next();
});

// Friendly root: this process is API-only; the dashboard runs on WEB_PORT.
app.get("/", (_req, res) => {
  const webPort = process.env.WEB_PORT ?? 8080;
  res
    .type("html")
    .send(
      `<body style="font-family:system-ui;background:#0e0a14;color:#f2ecf9;padding:40px">
        <h2>⚡ Sealed League API — running</h2>
        <p>This port serves the API only. State: <a style="color:#ffb454" href="/api/state">/api/state</a></p>
        <p>The dashboard UI is at <a style="color:#ffb454" href="http://localhost:${webPort}">http://localhost:${webPort}</a></p>
      </body>`,
    );
});

app.get("/api/state", (_req, res) => {
  res.json(state);
});

app.listen(PORT, () => {
  console.log(
    `\n⚡ Sealed League API at http://localhost:${PORT}  (chain: ${process.env.CHAIN ?? "memory"}, feed: ${process.env.FEED ?? "sim"})\n`,
  );
});

createChain()
  .then((chain) => ((process.env.FEED ?? "sim") === "txline" ? runTxlineLeague(chain) : runSimLeague(chain)))
  .catch((err) => {
    console.error("fatal:", err);
    state.phase = "error: " + err.message;
  });
