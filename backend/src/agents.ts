// Four LLM forecasting personas. Each gets the same match context but a
// different lens. If ANTHROPIC_API_KEY is unset (or a call fails), each
// persona falls back to a deterministic heuristic implementing the same
// strategy — the demo never stalls on a missing key.
import Anthropic from "@anthropic-ai/sdk";
import { AgentDef, Forecast, MatchData, Pick } from "./types.js";

const MODEL = process.env.ORACLE_MODEL ?? "claude-haiku-4-5";
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

export const AGENTS: AgentDef[] = [
  {
    id: "stat-sage",
    strategy: "stats-driven",
    emoji: "📊",
    blurb: "Pure numbers: ratings, form, home edge. Ignores narratives.",
    system:
      "You are Stat Sage, a purely quantitative football forecaster. Decide only from team " +
      "ratings, recent form, injuries, and home advantage. Ignore news tone and market odds. " +
      "Be decisive; a draw pick needs genuinely balanced numbers.",
  },
  {
    id: "line-hunter",
    strategy: "odds-arbitrage",
    emoji: "📉",
    blurb: "Compares model probabilities to market odds and picks the value side.",
    system:
      "You are Line Hunter, a value bettor. Convert the decimal odds to implied probabilities, " +
      "form your own probability estimate from ratings/form, and pick the outcome where the " +
      "market most underprices the true chance — even if it's not the likely winner.",
  },
  {
    id: "wire-sentinel",
    strategy: "news-sentiment",
    emoji: "📰",
    blurb: "Reads the wire: injuries, morale, travel chaos. Trades on narrative.",
    system:
      "You are Wire Sentinel, a news-driven forecaster. Weight the headline blurbs heavily — " +
      "injuries, morale, travel disruption — and use ratings only as a weak prior. If the news " +
      "clearly favors one side, follow it.",
  },
  {
    id: "devils-advocate",
    strategy: "contrarian",
    emoji: "😈",
    blurb: "Fades the public. When everyone piles on the favourite, takes the other side.",
    system:
      "You are Devil's Advocate, a contrarian forecaster. Identify where the public money is " +
      "leaning and look for reasons the crowd is wrong (overpriced favourites, ignored injuries). " +
      "You fade the public lean unless the favourite's edge is overwhelming.",
  },
];

const FORECAST_SCHEMA = {
  type: "object",
  properties: {
    pick: { type: "string", enum: ["home", "draw", "away"] },
    confidence: { type: "number" },
    rationale: { type: "string" },
  },
  required: ["pick", "confidence", "rationale"],
  additionalProperties: false,
} as const;

const PICK_FROM_LABEL: Record<string, Pick> = { home: 0, draw: 1, away: 2 };

function matchContext(m: MatchData): string {
  return JSON.stringify({
    fixture: `${m.home.name} (home) vs ${m.away.name} (away)`,
    ratings: { home: m.home.rating, away: m.away.rating, homeAdvantage: "+60" },
    last5: { home: m.home.last5, away: m.away.last5 },
    keyInjuries: { home: m.home.keyInjuries, away: m.away.keyInjuries },
    decimalOdds: m.odds,
    publicMoneyLean: ["home", "draw", "away"][m.publicLean],
    newsWire: m.news,
  });
}

async function llmForecast(agent: AgentDef, m: MatchData): Promise<Forecast> {
  const res = await client!.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: agent.system,
    messages: [
      {
        role: "user",
        content:
          `Forecast this match. Respond with your pick, confidence (0-1), and a 1-2 sentence rationale.\n` +
          matchContext(m),
      },
    ],
    output_config: { format: { type: "json_schema", schema: FORECAST_SCHEMA } },
  });
  const text = res.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("no text block");
  const parsed = JSON.parse(text.text) as { pick: string; confidence: number; rationale: string };
  return {
    pick: PICK_FROM_LABEL[parsed.pick] ?? 0,
    confidence: Math.max(0, Math.min(1, parsed.confidence)),
    rationale: parsed.rationale,
    source: "llm",
  };
}

// --- deterministic fallbacks (same strategies, no LLM) ----------------------

function formScore(last5: string): number {
  return [...last5].reduce((s, c) => s + (c === "W" ? 3 : c === "D" ? 1 : 0), 0);
}

function modelProbs(m: MatchData): [number, number, number] {
  const diff = m.home.rating + 60 - m.home.keyInjuries * 40 - (m.away.rating - m.away.keyInjuries * 40);
  const pH = (1 / (1 + Math.pow(10, -diff / 400))) * 0.76;
  const pD = 0.24;
  return [pH, pD, 1 - pH - pD];
}

function heuristic(agent: AgentDef, m: MatchData): Forecast {
  const [pH, pD, pA] = modelProbs(m);
  let pick: Pick;
  let rationale: string;
  let confidence: number;

  switch (agent.strategy) {
    case "stats-driven": {
      const h = m.home.rating + 60 + formScore(m.home.last5) * 8 - m.home.keyInjuries * 50;
      const a = m.away.rating + formScore(m.away.last5) * 8 - m.away.keyInjuries * 50;
      pick = Math.abs(h - a) < 25 ? 1 : h > a ? 0 : 2;
      confidence = Math.min(0.9, 0.5 + Math.abs(h - a) / 400);
      rationale = `Composite rating ${h.toFixed(0)} vs ${a.toFixed(0)} including form and injuries.`;
      break;
    }
    case "odds-arbitrage": {
      const implied = [1 / m.odds.home, 1 / m.odds.draw, 1 / m.odds.away];
      const norm = implied.map((x) => x / (implied[0] + implied[1] + implied[2]));
      const edges = [pH - norm[0], pD - norm[1], pA - norm[2]];
      pick = edges.indexOf(Math.max(...edges)) as Pick;
      confidence = Math.min(0.85, 0.45 + Math.max(...edges) * 3);
      rationale = `Model edge over implied odds: ${edges.map((e) => (e * 100).toFixed(1) + "%").join(" / ")}.`;
      break;
    }
    case "news-sentiment": {
      let tilt = 0;
      for (const n of m.news) {
        const bad = /ruled out|strain|chaos|unrest|delays/i.test(n);
        const aboutHome = n.includes(m.home.name);
        tilt += (bad ? -1 : 1) * (aboutHome ? 1 : -1);
      }
      pick = tilt > 0 ? 0 : tilt < 0 ? 2 : pH >= pA ? 0 : 2;
      confidence = 0.5 + Math.min(0.35, Math.abs(tilt) * 0.15);
      rationale = `Wire tilt ${tilt > 0 ? "favors" : tilt < 0 ? "against" : "neutral on"} the home side (${m.news.length} headlines).`;
      break;
    }
    default: {
      // contrarian: fade the public lean unless the favourite is overwhelming
      const fav: Pick = pH >= pA ? 0 : 2;
      const favProb = Math.max(pH, pA);
      if (m.publicLean === fav && favProb < 0.62) {
        pick = fav === 0 ? 2 : 0;
        rationale = `Public is piling on the favourite at only ${(favProb * 100).toFixed(0)}% true odds — taking the other side.`;
        confidence = 0.55;
      } else {
        pick = fav;
        rationale = `Favourite's edge is real (${(favProb * 100).toFixed(0)}%); no value in fading it.`;
        confidence = 0.6;
      }
    }
  }
  return { pick, confidence, rationale, source: "heuristic" };
}

export async function forecast(agent: AgentDef, m: MatchData): Promise<Forecast> {
  if (client) {
    try {
      return await llmForecast(agent, m);
    } catch (err) {
      console.warn(`[agents] LLM call failed for ${agent.id} (${(err as Error).message}); using heuristic`);
    }
  }
  return heuristic(agent, m);
}
