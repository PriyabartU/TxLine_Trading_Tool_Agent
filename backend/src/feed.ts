// Simulated sports feed — hackathon rules allow simulated feeds for the demo.
// Generates rounds of matches with team ratings, form, market odds, and news
// blurbs, then simulates results from the (hidden) true strengths, so agents
// with better signal genuinely accumulate better records over time.
import { MatchData, Pick, TeamForm } from "./types.js";

const TEAMS: { name: string; rating: number }[] = [
  { name: "Meridian FC", rating: 1720 },
  { name: "Port Vale Utd", rating: 1585 },
  { name: "Calder Rovers", rating: 1650 },
  { name: "Ironbridge City", rating: 1698 },
  { name: "Northgate Ath.", rating: 1540 },
  { name: "Solace Town", rating: 1610 },
  { name: "Kestrel SC", rating: 1670 },
  { name: "Harbour Wolves", rating: 1560 },
];

const GOOD_NEWS = [
  "%T's star striker returns to full training ahead of kickoff",
  "%T unbeaten in their last four; dressing room morale reported high",
  "Manager confirms %T's first-choice XI is fully fit",
];
const BAD_NEWS = [
  "%T's captain ruled out late with a hamstring strain",
  "Travel chaos: %T arrived past midnight after flight delays",
  "Unrest at %T as board dispute leaks to the press",
];

let rng = 42;
function rand(): number {
  // deterministic LCG so demo runs are reproducible; reseed with seedFeed()
  rng = (rng * 1103515245 + 12345) & 0x7fffffff;
  return rng / 0x7fffffff;
}
export function seedFeed(seed: number) {
  rng = seed;
}

function form(): string {
  return Array.from({ length: 5 }, () => "WDL"[Math.floor(rand() * 3)]).join("");
}

function probs(home: TeamForm, away: TeamForm): [number, number, number] {
  const diff = home.rating + 60 - away.rating; // +60 home advantage
  const pHomeRaw = 1 / (1 + Math.pow(10, -diff / 400));
  const pDraw = 0.24;
  const pHome = pHomeRaw * (1 - pDraw);
  const pAway = (1 - pHomeRaw) * (1 - pDraw);
  return [pHome, pDraw, pAway];
}

// Unique per run: match PDAs are seeded by matchId alone, so restarting a
// devnet league must never reuse an id from a previous run.
let nextMatchId = Math.floor(Date.now() / 1000);

export function generateRound(roundId: number, size: number, commitWindowS: number, playS: number): MatchData[] {
  const pool = [...TEAMS].sort(() => rand() - 0.5);
  const now = Math.floor(Date.now() / 1000);
  const matches: MatchData[] = [];
  for (let i = 0; i + 1 < pool.length && matches.length < size; i += 2) {
    const injHome = rand() < 0.3 ? 1 : 0;
    const injAway = rand() < 0.3 ? 1 : 0;
    const home: TeamForm = { name: pool[i].name, rating: pool[i].rating, last5: form(), keyInjuries: injHome };
    const away: TeamForm = { name: pool[i + 1].name, rating: pool[i + 1].rating, last5: form(), keyInjuries: injAway };
    const [pH, pD, pA] = probs(home, away);
    const margin = 1.06;
    const noise = () => 0.97 + rand() * 0.06;
    const odds = {
      home: +(noise() / (pH * margin)).toFixed(2),
      draw: +(noise() / (pD * margin)).toFixed(2),
      away: +(noise() / (pA * margin)).toFixed(2),
    };
    const news: string[] = [];
    if (injHome) news.push(BAD_NEWS[Math.floor(rand() * BAD_NEWS.length)].replace("%T", home.name));
    else if (rand() < 0.5) news.push(GOOD_NEWS[Math.floor(rand() * GOOD_NEWS.length)].replace("%T", home.name));
    if (injAway) news.push(BAD_NEWS[Math.floor(rand() * BAD_NEWS.length)].replace("%T", away.name));
    else if (rand() < 0.5) news.push(GOOD_NEWS[Math.floor(rand() * GOOD_NEWS.length)].replace("%T", away.name));

    // public money chases the favourite ~70% of the time
    const fav: Pick = pH >= pA ? 0 : 2;
    const publicLean: Pick = rand() < 0.7 ? fav : ((rand() < 0.5 ? 1 : fav === 0 ? 2 : 0) as Pick);

    matches.push({
      matchId: nextMatchId++,
      roundId,
      home,
      away,
      odds,
      publicLean,
      news,
      commitDeadline: now + commitWindowS,
      startTs: now + commitWindowS,
    });
  }
  return matches;
}

/** Simulate the final result from true strengths + injury/news effects. */
export function simulateResult(m: MatchData): Pick {
  const home = { ...m.home, rating: m.home.rating - m.home.keyInjuries * 40 };
  const away = { ...m.away, rating: m.away.rating - m.away.keyInjuries * 40 };
  const [pH, pD] = probs(home, away);
  const r = rand();
  if (r < pH) return 0;
  if (r < pH + pD) return 1;
  return 2;
}
