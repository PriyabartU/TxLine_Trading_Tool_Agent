# ◆ Sealed League

**A verifiable track-record protocol for AI forecasting agents — sports as the first vertical.**

Pundits and AI models claim accuracy. Nobody can verify them. Sealed League is a forecasting
league where every prediction is **committed on-chain before the event** (commit–reveal, so no
edits after kickoff) and **settled by Merkle proof** — no human judge, no trusted oracle. What
accumulates is a cryptographically auditable performance ledger per agent: a credit score for
AI forecasters.

Four autonomous LLM agents with distinct strategies compete every round:

| Agent | Strategy |
|---|---|
| 📊 stat-sage | Pure quant: ratings, form, home edge |
| 📉 line-hunter | Odds-arbitrage: model probability vs implied odds |
| 📰 wire-sentinel | News/sentiment-driven |
| 😈 devils-advocate | Contrarian: fades the public money |

## Architecture

```
programs/oracle-league   Anchor program: commit-reveal registry, Merkle settlement,
                         agent record accounts, SOL backing vaults
backend/                 API + orchestrator (port 3000): simulated feed, LLM agent
                         swarm (Claude API), keeper bot
frontend/                Leaderboard UI (port 8080): separate process/folder,
                         independently deployable
```

Protocol flow per match:

1. **commit** — agent posts `sha256(match_id ‖ pick ‖ salt ‖ agent_pubkey)` before the deadline
2. **reveal** — after kickoff, program recomputes the hash; mismatches are rejected
3. **root** — keeper posts the round's results Merkle root
   *(production: replaced by CPI into TxLINE `validate_stat` — root proven, not trusted)*
4. **settle** — permissionless: anyone with a valid proof settles a prediction; the agent's
   immutable on-chain record updates

Every leaderboard row expands into per-prediction **receipts** (commitment, salt, reveal,
leaf, proof path, root, tx signatures) — and the proof can be **re-verified in your browser**
with WebCrypto.

## Quickstart (no chain toolchain needed)

Two terminals:

```sh
# terminal 1 — API + agents + keeper
cd backend && npm install && npm run dev     # → http://localhost:3000 (API)

# terminal 2 — leaderboard UI
cd frontend && npm install && npm run dev    # → http://localhost:8080 (open this)
```

Runs in `memory` mode: an honest local simulation enforcing the same rules as the on-chain
program (commit deadlines, hash checks, Merkle verification). Without an `ANTHROPIC_API_KEY`,
agents use deterministic heuristics implementing the same strategies.

To use real LLM agents:

```sh
cp .env.example .env      # set ANTHROPIC_API_KEY (model defaults to claude-haiku-4-5)
```

## Devnet deployment (WSL)

Install the toolchain inside WSL (once, ~15 min):

```sh
# inside: wsl
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && . "$HOME/.cargo/env"
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cargo install --git https://github.com/coral-xyz/anchor avm --force && avm install 0.31.1 && avm use 0.31.1

solana-keygen new --no-bip39-passphrase
solana config set --url devnet
solana airdrop 5
```

Build & deploy (from the repo root, inside WSL — `cd /mnt/d/TxLine_Trading_tool\ and\ Agents`):

```sh
anchor keys sync      # writes the real program id into lib.rs + Anchor.toml
anchor build
anchor deploy
```

Then flip the backend onto devnet (from Windows or WSL):

```sh
cd backend
CHAIN=devnet npm run dev
```

Receipts now carry real transaction signatures with Solana Explorer links.

## TxLINE integration point

`post_results_root` is the single trusted step in the demo build and is deliberately isolated:
in the production integration its body is replaced by a CPI into TxLINE's `validate_stat`,
so the results root is proven by TxLINE's attestation rather than posted by our keeper.
Settlement, grading, and the agent ledger are unchanged either way.

## Human layer

`back_agent` / `withdraw_backing`: deposit into a per-agent vault PDA — effectively backing
the forecaster whose *verified* record you trust. Demo build uses native SOL; the SPL-USDC
swap is mechanical. Payout routing on settlement is the designed next step.

## Cost & ops

- Devnet: free. LLM agents: ~$4 total on `claude-haiku-4-5` for a full demo cycle.
- Demo pacing (commit window, match length, matches/round) is configurable in `.env`.
