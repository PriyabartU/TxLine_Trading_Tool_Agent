//! Sealed League — a verifiable track-record protocol for AI forecasting agents.
//!
//! Flow per match:
//!   1. `commit_prediction`  — before the commit deadline, an agent posts
//!      sha256(match_id || pick || salt || agent_pubkey). The pick is hidden.
//!   2. `reveal_prediction`  — after kickoff, the agent reveals (pick, salt);
//!      the program recomputes the hash and rejects mismatches. No editing
//!      predictions after the fact — ever.
//!   3. `post_results_root`  — the keeper posts the Merkle root of the round's
//!      results. NOTE: in the production integration this instruction is
//!      replaced by a CPI into TxLINE's `validate_stat`, so the root is proven
//!      rather than trusted. The settlement path below is unchanged either way.
//!   4. `settle_prediction`  — anyone supplies a Merkle proof for
//!      leaf = sha256("result" || match_id || result). The program verifies the
//!      proof against the round root, grades the prediction, and updates the
//!      agent's immutable on-chain record.
//!
//! What accumulates is the product: a cryptographically auditable forecasting
//! ledger per agent — commitments timestamped before the event, settlement
//! bound to a proof, stats no one (including us) can retroactively edit.
//!
//! Skin in the game (devnet SOL only — this is a prototype, not a wagering
//! service): every commitment locks a stake into a per-match pot PDA.
//! Wrong picks are slashed (stake stays in the pot); correct picks claim
//! their stake back plus a pro-rata share of the losers' stakes via
//! `claim_payout` once the whole match is graded. Agents that commit but
//! never reveal are slashed permissionlessly via `forfeit_unrevealed`.

// Anchor 0.31's #[program] expansion calls AccountInfo::realloc, which newer
// toolchains mark deprecated; nothing in this file uses deprecated APIs.
#![allow(deprecated)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_lang::system_program::{self, Transfer};

declare_id!("AJdsHnwJ4WEz3zUFdpC7duedN9Ry2mQPB2gai8AiqVku");

/// Picks are a closed enum: 0 = home win, 1 = draw, 2 = away win.
pub const PICK_MAX: u8 = 2;

#[program]
pub mod oracle_league {
    use super::*;

    /// One-time league setup. `authority` becomes the keeper identity allowed
    /// to create matches and post results roots.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let league = &mut ctx.accounts.league;
        league.authority = ctx.accounts.authority.key();
        league.agents = 0;
        league.matches = 0;
        Ok(())
    }

    /// Register a forecasting agent. The agent PDA is seeded by name, so
    /// names are unique and the address is derivable by anyone auditing.
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        name: String,
        strategy: String,
    ) -> Result<()> {
        require!(name.len() <= 32, LeagueError::NameTooLong);
        require!(strategy.len() <= 32, LeagueError::NameTooLong);
        let agent = &mut ctx.accounts.agent;
        agent.authority = ctx.accounts.authority.key();
        agent.name = name;
        agent.strategy = strategy;
        agent.commits = 0;
        agent.reveals = 0;
        agent.settled = 0;
        agent.correct = 0;
        agent.total_backed = 0;
        agent.bump = ctx.bumps.agent;
        ctx.accounts.league.agents += 1;
        Ok(())
    }

    /// Keeper opens a match window. `commit_deadline` must precede kickoff so
    /// no prediction can be informed by in-game events.
    pub fn create_match(
        ctx: Context<CreateMatch>,
        match_id: u64,
        round_id: u64,
        home: String,
        away: String,
        start_ts: i64,
        commit_deadline: i64,
    ) -> Result<()> {
        require!(home.len() <= 32 && away.len() <= 32, LeagueError::NameTooLong);
        require!(commit_deadline <= start_ts, LeagueError::BadSchedule);
        let m = &mut ctx.accounts.match_account;
        m.match_id = match_id;
        m.round_id = round_id;
        m.home = home;
        m.away = away;
        m.start_ts = start_ts;
        m.commit_deadline = commit_deadline;
        m.paid_count = 0;
        m.bump = ctx.bumps.match_account;
        ctx.accounts.league.matches += 1;
        Ok(())
    }

    /// Phase 1 — COMMIT. Stores only the hash, and locks the agent's stake
    /// into the match pot in the same transaction: skin in the game is bound
    /// to the sealed pick, so no one can size a stake after seeing a result.
    /// The clock check is the integrity core of the protocol: after
    /// `commit_deadline`, this instruction is unreachable for this match.
    ///
    /// The stake is drawn from the agent's backing vault — backer capital is
    /// the agent's ammunition, and backers ride the agent's wins and slashes
    /// pro-rata. The keeper seeds each vault as the first backer.
    pub fn commit_prediction(
        ctx: Context<CommitPrediction>,
        commitment: [u8; 32],
        stake: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            now < ctx.accounts.match_account.commit_deadline,
            LeagueError::CommitWindowClosed
        );
        require!(stake > 0, LeagueError::StakeRequired);
        require!(
            ctx.accounts.vault.lamports() >= stake,
            LeagueError::VaultInsufficient
        );

        let agent_key = ctx.accounts.agent.key();
        let vault_seeds: &[&[u8]] = &[b"vault", agent_key.as_ref(), &[ctx.bumps.vault]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.pot.to_account_info(),
                },
                &[vault_seeds],
            ),
            stake,
        )?;
        ctx.accounts.vault_state.staked_outstanding += stake;

        let p = &mut ctx.accounts.prediction;
        p.agent = ctx.accounts.agent.key();
        p.match_id = ctx.accounts.match_account.match_id;
        p.commitment = commitment;
        p.committed_at = now;
        p.revealed = false;
        p.settled = false;
        p.stake = stake;
        p.paid_out = false;
        p.bump = ctx.bumps.prediction;
        ctx.accounts.agent.commits += 1;
        let m = &mut ctx.accounts.match_account;
        m.staked_total += stake;
        m.commit_count += 1;
        Ok(())
    }

    /// Phase 2 — REVEAL. Only valid after kickoff, and only if
    /// sha256(match_id_le || pick || salt || agent_pubkey) equals the stored
    /// commitment. Binding the agent pubkey into the preimage prevents one
    /// agent replaying another agent's commitment.
    pub fn reveal_prediction(ctx: Context<RevealPrediction>, pick: u8, salt: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &ctx.accounts.match_account;
        let p = &mut ctx.accounts.prediction;

        require!(now >= m.start_ts, LeagueError::RevealTooEarly);
        require!(!p.revealed, LeagueError::AlreadyRevealed);
        require!(pick <= PICK_MAX, LeagueError::InvalidPick);

        let expected = hashv(&[
            &m.match_id.to_le_bytes(),
            &[pick],
            &salt,
            ctx.accounts.agent.key().as_ref(),
        ]);
        require!(expected.to_bytes() == p.commitment, LeagueError::CommitmentMismatch);

        p.pick = pick;
        p.salt = salt;
        p.revealed = true;
        p.revealed_at = now;
        ctx.accounts.agent.reveals += 1;
        Ok(())
    }

    /// Keeper posts the results Merkle root for a round.
    ///
    /// >>> PRODUCTION NOTE: this is the single trusted step in the demo build,
    /// >>> and it is exactly the step TxLINE removes. The integration replaces
    /// >>> this instruction body with a CPI into TxLINE's `validate_stat`,
    /// >>> which proves the root instead of accepting it from the keeper.
    /// >>> Nothing downstream (settlement, grading, stats) changes.
    pub fn post_results_root(ctx: Context<PostResultsRoot>, round_id: u64, root: [u8; 32]) -> Result<()> {
        let r = &mut ctx.accounts.round;
        r.round_id = round_id;
        r.results_root = root;
        r.posted_at = Clock::get()?.unix_timestamp;
        r.bump = ctx.bumps.round;
        Ok(())
    }

    /// Phase 3 — SETTLE. Permissionless: anyone holding a valid Merkle proof
    /// can settle any revealed prediction. The leaf commits to the match and
    /// its result; the proof chains to the round root with sorted-pair
    /// hashing (proofs carry no index bits).
    pub fn settle_prediction(ctx: Context<SettlePrediction>, result: u8, proof: Vec<[u8; 32]>) -> Result<()> {
        let p = &mut ctx.accounts.prediction;
        require!(p.revealed, LeagueError::NotRevealed);
        require!(!p.settled, LeagueError::AlreadySettled);
        require!(result <= PICK_MAX, LeagueError::InvalidPick);

        // leaf = sha256("result" || match_id_le || result)
        let mut node = hashv(&[b"result", &p.match_id.to_le_bytes(), &[result]]).to_bytes();
        for sibling in proof.iter() {
            node = if node <= *sibling {
                hashv(&[&node, sibling]).to_bytes()
            } else {
                hashv(&[sibling, &node]).to_bytes()
            };
        }
        require!(node == ctx.accounts.round.results_root, LeagueError::InvalidProof);

        p.result = result;
        p.correct = p.pick == result;
        p.settled = true;
        p.settled_at = Clock::get()?.unix_timestamp;

        let agent = &mut ctx.accounts.agent;
        agent.settled += 1;
        if p.correct {
            agent.correct += 1;
        }
        let m = &mut ctx.accounts.match_account;
        m.graded_count += 1;
        if p.correct {
            m.winning_stake += p.stake;
        }
        Ok(())
    }

    /// Slash a no-show. Once the round's results root is on-chain, any agent
    /// that committed but never revealed can be forfeited permissionlessly:
    /// its prediction is graded incorrect and its stake stays in the pot.
    /// Without this, a silent agent could hold every honest winner's payout
    /// hostage (claims require the full match to be graded).
    pub fn forfeit_unrevealed(ctx: Context<ForfeitUnrevealed>) -> Result<()> {
        let p = &mut ctx.accounts.prediction;
        require!(!p.revealed, LeagueError::AlreadyRevealed);
        require!(!p.settled, LeagueError::AlreadySettled);

        p.correct = false;
        p.settled = true;
        p.settled_at = Clock::get()?.unix_timestamp;
        ctx.accounts.agent.settled += 1;
        ctx.accounts.match_account.graded_count += 1;
        Ok(())
    }

    /// Phase 4 — CLAIM. Parimutuel payout, permissionless to crank once every
    /// commitment on the match is graded. Winners take their stake back plus
    /// a pro-rata share of the losers' stakes; losers were already slashed at
    /// settlement (their stake never leaves the pot). If nobody was right,
    /// revealed stakes are refunded to their vaults — stranding the pot would
    /// just bleed backer capital with no winner to pay it to.
    /// The spent prediction account is closed and its rent returned to the
    /// cranker, so a settled round costs only transaction fees.
    pub fn claim_payout(ctx: Context<ClaimPayout>) -> Result<()> {
        let p = &mut ctx.accounts.prediction;
        require!(p.settled, LeagueError::NotSettled);
        require!(!p.paid_out, LeagueError::AlreadyClaimed);
        let (staked_total, winning_stake, match_id_le) = {
            let m = &ctx.accounts.match_account;
            require!(m.graded_count == m.commit_count, LeagueError::NotAllGraded);
            (m.staked_total, m.winning_stake, m.match_id.to_le_bytes())
        };

        p.paid_out = true;
        ctx.accounts.match_account.paid_count += 1;
        // The stake's fate is final either way — it is no longer in flight.
        let vs = &mut ctx.accounts.vault_state;
        vs.staked_outstanding = vs.staked_outstanding.saturating_sub(p.stake);

        let payout = if winning_stake == 0 {
            // Nobody won. Refund revealed picks; no-shows stay slashed.
            if p.revealed { p.stake } else { 0 }
        } else if p.correct {
            let losing_pool = (staked_total - winning_stake) as u128;
            p.stake + u64::try_from(p.stake as u128 * losing_pool / winning_stake as u128).unwrap()
        } else {
            0 // slashed — backers eat the loss pro-rata
        };

        if payout > 0 {
            let seeds: &[&[u8]] = &[b"pot", match_id_le.as_ref(), &[ctx.bumps.pot]];
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.pot.to_account_info(),
                        to: ctx.accounts.vault.to_account_info(),
                    },
                    &[seeds],
                ),
                payout,
            )?;
        }
        Ok(())
    }

    /// Housekeeping: once every commitment on a match is claimed, anyone may
    /// close the match account (rent → cranker) and sweep the pot's leftover
    /// lamports (prefund + rounding dust). Keeps long-running leagues from
    /// bleeding rent into dead PDAs.
    pub fn close_match(ctx: Context<CloseMatch>) -> Result<()> {
        let m = &ctx.accounts.match_account;
        require!(
            m.commit_count == m.graded_count && m.commit_count == m.paid_count,
            LeagueError::NotAllGraded
        );
        let dust = ctx.accounts.pot.lamports();
        if dust > 0 {
            let match_id = m.match_id.to_le_bytes();
            let seeds: &[&[u8]] = &[b"pot", match_id.as_ref(), &[ctx.bumps.pot]];
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.pot.to_account_info(),
                        to: ctx.accounts.cranker.to_account_info(),
                    },
                    &[seeds],
                ),
                dust,
            )?;
        }
        Ok(())
    }

    /// Housekeeping: keeper reclaims a spent round account's rent once its
    /// matches are fully claimed and closed. Authority-gated because closing
    /// drops the results root this round's proofs verified against.
    pub fn close_round(_ctx: Context<CloseRound>) -> Result<()> {
        Ok(())
    }

    /// Human layer: back an agent with lamports (devnet SOL stands in for
    /// USDC in the demo build; swapping to an SPL-token vault is mechanical).
    /// Deposits buy shares of the agent's vault at its current equity, like a
    /// fund: equity = vault balance + stakes currently in flight. The vault is
    /// the agent's staking bankroll — wins grow every backer's share value,
    /// slashes shrink it. Withdrawable only via `withdraw_backing`.
    pub fn back_agent(ctx: Context<BackAgent>, amount: u64) -> Result<()> {
        require!(amount > 0, LeagueError::StakeRequired);
        let vs = &mut ctx.accounts.vault_state;
        // Equity is read BEFORE the deposit lands so shares price correctly.
        let equity = ctx.accounts.vault.lamports() + vs.staked_outstanding;

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.backer.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            amount,
        )?;

        // First deposit prices 1 share = 1 lamport; later deposits buy in at
        // the prevailing share value so existing backers' P&L is untouched.
        let shares = if vs.total_shares == 0 || equity == 0 {
            amount
        } else {
            u64::try_from(amount as u128 * vs.total_shares as u128 / equity as u128).unwrap()
        };
        require!(shares > 0, LeagueError::StakeRequired);

        vs.total_shares += shares;
        vs.bump = ctx.bumps.vault_state;
        let pos = &mut ctx.accounts.backer_position;
        pos.backer = ctx.accounts.backer.key();
        pos.agent = ctx.accounts.agent.key();
        pos.shares += shares;
        pos.bump = ctx.bumps.backer_position;
        ctx.accounts.agent.total_backed = ctx.accounts.agent.total_backed.saturating_add(amount);
        Ok(())
    }

    /// Withdraw backing by lamport amount: burns the shares that amount is
    /// worth at current equity (rounded up, so the vault never overpays).
    /// Only the vault's liquid balance is withdrawable — capital locked in
    /// live match pots frees up when the round's claims are cranked.
    pub fn withdraw_backing(ctx: Context<WithdrawBacking>, amount: u64) -> Result<()> {
        require!(amount > 0, LeagueError::StakeRequired);
        let vs = &mut ctx.accounts.vault_state;
        let pos = &mut ctx.accounts.backer_position;
        let equity = ctx.accounts.vault.lamports() + vs.staked_outstanding;
        require!(vs.total_shares > 0 && equity > 0, LeagueError::InsufficientBacking);
        require!(ctx.accounts.vault.lamports() >= amount, LeagueError::VaultInsufficient);

        let burn = u64::try_from(
            (amount as u128 * vs.total_shares as u128 + equity as u128 - 1) / equity as u128,
        )
        .unwrap();
        require!(burn > 0 && pos.shares >= burn, LeagueError::InsufficientBacking);

        let agent_key = ctx.accounts.agent.key();
        let seeds: &[&[u8]] = &[b"vault", agent_key.as_ref(), &[ctx.bumps.vault]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.backer.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        pos.shares -= burn;
        vs.total_shares -= burn;
        ctx.accounts.agent.total_backed = ctx.accounts.agent.total_backed.saturating_sub(amount);
        Ok(())
    }

    /// Keeper-only bookkeeping repair. A round that dies mid-flight (RPC
    /// outage) strands its stakes in match pots: the lamports are gone from
    /// the vault but `staked_outstanding` still counts them, inflating equity
    /// and mis-pricing shares. This writes off stale in-flight stakes so
    /// equity reflects reality. It moves no funds and cannot touch balances —
    /// gated to the league authority.
    pub fn reconcile_vault(ctx: Context<ReconcileVault>, staked_outstanding: u64) -> Result<()> {
        ctx.accounts.vault_state.staked_outstanding = staked_outstanding;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct League {
    pub authority: Pubkey,
    pub agents: u64,
    pub matches: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Agent {
    pub authority: Pubkey,
    #[max_len(32)]
    pub name: String,
    #[max_len(32)]
    pub strategy: String,
    /// The verifiable record. Monotonic; only mutated by the instructions above.
    pub commits: u64,
    pub reveals: u64,
    pub settled: u64,
    pub correct: u64,
    pub total_backed: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct MatchAccount {
    pub match_id: u64,
    pub round_id: u64,
    #[max_len(32)]
    pub home: String,
    #[max_len(32)]
    pub away: String,
    pub start_ts: i64,
    pub commit_deadline: i64,
    /// Parimutuel bookkeeping: lamports locked in the pot, how many
    /// commitments exist, how many are graded/claimed, and the correct-side
    /// stake.
    pub staked_total: u64,
    pub commit_count: u64,
    pub graded_count: u64,
    pub winning_stake: u64,
    pub paid_count: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Prediction {
    pub agent: Pubkey,
    pub match_id: u64,
    pub commitment: [u8; 32],
    pub committed_at: i64,
    pub revealed: bool,
    pub pick: u8,
    pub salt: [u8; 32],
    pub revealed_at: i64,
    pub settled: bool,
    pub result: u8,
    pub correct: bool,
    pub settled_at: i64,
    /// Lamports locked at commit time; released or slashed by `claim_payout`.
    pub stake: u64,
    pub paid_out: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Round {
    pub round_id: u64,
    pub results_root: [u8; 32],
    pub posted_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BackerPosition {
    pub backer: Pubkey,
    pub agent: Pubkey,
    /// Vault shares, not lamports: value = shares × equity / total_shares.
    pub shares: u64,
    pub bump: u8,
}

/// Per-agent vault bookkeeping. `staked_outstanding` counts lamports the vault
/// has locked into live match pots — part of equity, but not yet withdrawable.
#[account]
#[derive(InitSpace)]
pub struct VaultState {
    pub total_shares: u64,
    pub staked_outstanding: u64,
    pub bump: u8,
}

// ---------------------------------------------------------------------------
// Instruction contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + League::INIT_SPACE, seeds = [b"league"], bump)]
    pub league: Account<'info, League>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(name: String)]
pub struct RegisterAgent<'info> {
    #[account(mut, seeds = [b"league"], bump)]
    pub league: Account<'info, League>,
    #[account(
        init,
        payer = authority,
        space = 8 + Agent::INIT_SPACE,
        seeds = [b"agent", name.as_bytes()],
        bump
    )]
    pub agent: Account<'info, Agent>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct CreateMatch<'info> {
    #[account(mut, seeds = [b"league"], bump, has_one = authority)]
    pub league: Account<'info, League>,
    #[account(
        init,
        payer = authority,
        space = 8 + MatchAccount::INIT_SPACE,
        seeds = [b"match", match_id.to_le_bytes().as_ref()],
        bump
    )]
    pub match_account: Account<'info, MatchAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CommitPrediction<'info> {
    #[account(mut, has_one = authority)]
    pub agent: Account<'info, Agent>,
    #[account(mut, seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()], bump = match_account.bump)]
    pub match_account: Account<'info, MatchAccount>,
    /// CHECK: program-derived system account holding the match's staked
    /// lamports; validated by seeds, holds no data.
    #[account(mut, seeds = [b"pot", match_account.match_id.to_le_bytes().as_ref()], bump)]
    pub pot: SystemAccount<'info>,
    /// CHECK: the agent's backing vault — the stake is drawn from here.
    #[account(mut, seeds = [b"vault", agent.key().as_ref()], bump)]
    pub vault: SystemAccount<'info>,
    #[account(mut, seeds = [b"vstate", agent.key().as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        init,
        payer = authority,
        space = 8 + Prediction::INIT_SPACE,
        seeds = [b"prediction", agent.key().as_ref(), match_account.match_id.to_le_bytes().as_ref()],
        bump
    )]
    pub prediction: Account<'info, Prediction>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevealPrediction<'info> {
    #[account(mut, has_one = authority)]
    pub agent: Account<'info, Agent>,
    #[account(seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()], bump = match_account.bump)]
    pub match_account: Account<'info, MatchAccount>,
    #[account(
        mut,
        seeds = [b"prediction", agent.key().as_ref(), match_account.match_id.to_le_bytes().as_ref()],
        bump = prediction.bump
    )]
    pub prediction: Account<'info, Prediction>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct PostResultsRoot<'info> {
    #[account(seeds = [b"league"], bump, has_one = authority)]
    pub league: Account<'info, League>,
    #[account(
        init,
        payer = authority,
        space = 8 + Round::INIT_SPACE,
        seeds = [b"round", round_id.to_le_bytes().as_ref()],
        bump
    )]
    pub round: Account<'info, Round>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettlePrediction<'info> {
    #[account(mut)]
    pub agent: Account<'info, Agent>,
    #[account(mut, seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()], bump = match_account.bump)]
    pub match_account: Account<'info, MatchAccount>,
    /// The round the match belongs to — enforced by seed derivation.
    #[account(
        seeds = [b"round", match_account.round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,
    #[account(
        mut,
        seeds = [b"prediction", agent.key().as_ref(), match_account.match_id.to_le_bytes().as_ref()],
        bump = prediction.bump,
        constraint = prediction.agent == agent.key()
    )]
    pub prediction: Account<'info, Prediction>,
    /// Settlement is permissionless — any payer may crank it.
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
pub struct ForfeitUnrevealed<'info> {
    #[account(mut)]
    pub agent: Account<'info, Agent>,
    #[account(mut, seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()], bump = match_account.bump)]
    pub match_account: Account<'info, MatchAccount>,
    /// Forfeit is only possible once results are final — the round root's
    /// existence (enforced by seed derivation) is the proof of that.
    #[account(
        seeds = [b"round", match_account.round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,
    #[account(
        mut,
        seeds = [b"prediction", agent.key().as_ref(), match_account.match_id.to_le_bytes().as_ref()],
        bump = prediction.bump,
        constraint = prediction.agent == agent.key()
    )]
    pub prediction: Account<'info, Prediction>,
    /// Forfeiture is permissionless — any payer may crank it.
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimPayout<'info> {
    pub agent: Account<'info, Agent>,
    #[account(mut, seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()], bump = match_account.bump)]
    pub match_account: Account<'info, MatchAccount>,
    /// CHECK: program-derived system account holding the match's staked
    /// lamports; validated by seeds, holds no data.
    #[account(mut, seeds = [b"pot", match_account.match_id.to_le_bytes().as_ref()], bump)]
    pub pot: SystemAccount<'info>,
    #[account(
        mut,
        close = cranker,
        seeds = [b"prediction", agent.key().as_ref(), match_account.match_id.to_le_bytes().as_ref()],
        bump = prediction.bump,
        constraint = prediction.agent == agent.key()
    )]
    pub prediction: Account<'info, Prediction>,
    /// CHECK: winnings flow back into the agent's backing vault, growing
    /// every backer's share value — no matter who cranks the claim.
    #[account(mut, seeds = [b"vault", agent.key().as_ref()], bump)]
    pub vault: SystemAccount<'info>,
    #[account(mut, seeds = [b"vstate", agent.key().as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    /// Claiming is permissionless — any payer may crank it (and receives the
    /// closed prediction account's rent).
    #[account(mut)]
    pub cranker: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseMatch<'info> {
    #[account(
        mut,
        close = cranker,
        seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()],
        bump = match_account.bump
    )]
    pub match_account: Account<'info, MatchAccount>,
    /// CHECK: the match's pot; validated by seeds, holds no data.
    #[account(mut, seeds = [b"pot", match_account.match_id.to_le_bytes().as_ref()], bump)]
    pub pot: SystemAccount<'info>,
    #[account(mut)]
    pub cranker: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseRound<'info> {
    #[account(seeds = [b"league"], bump, has_one = authority)]
    pub league: Account<'info, League>,
    #[account(
        mut,
        close = authority,
        seeds = [b"round", round.round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct BackAgent<'info> {
    #[account(mut)]
    pub agent: Account<'info, Agent>,
    /// CHECK: program-derived system account holding backing lamports;
    /// validated by seeds, holds no data.
    #[account(mut, seeds = [b"vault", agent.key().as_ref()], bump)]
    pub vault: SystemAccount<'info>,
    #[account(
        init_if_needed,
        payer = backer,
        space = 8 + VaultState::INIT_SPACE,
        seeds = [b"vstate", agent.key().as_ref()],
        bump
    )]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        init_if_needed,
        payer = backer,
        space = 8 + BackerPosition::INIT_SPACE,
        seeds = [b"backer", agent.key().as_ref(), backer.key().as_ref()],
        bump
    )]
    pub backer_position: Account<'info, BackerPosition>,
    #[account(mut)]
    pub backer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawBacking<'info> {
    #[account(mut)]
    pub agent: Account<'info, Agent>,
    /// CHECK: program-derived system account holding backing lamports;
    /// validated by seeds, holds no data.
    #[account(mut, seeds = [b"vault", agent.key().as_ref()], bump)]
    pub vault: SystemAccount<'info>,
    #[account(mut, seeds = [b"vstate", agent.key().as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    #[account(
        mut,
        seeds = [b"backer", agent.key().as_ref(), backer.key().as_ref()],
        bump = backer_position.bump,
        has_one = backer
    )]
    pub backer_position: Account<'info, BackerPosition>,
    #[account(mut)]
    pub backer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReconcileVault<'info> {
    #[account(seeds = [b"league"], bump, has_one = authority)]
    pub league: Account<'info, League>,
    pub agent: Account<'info, Agent>,
    #[account(mut, seeds = [b"vstate", agent.key().as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    pub authority: Signer<'info>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum LeagueError {
    #[msg("Name or strategy exceeds 32 bytes")]
    NameTooLong,
    #[msg("Commit deadline must not be after kickoff")]
    BadSchedule,
    #[msg("Commit window has closed for this match")]
    CommitWindowClosed,
    #[msg("Cannot reveal before kickoff")]
    RevealTooEarly,
    #[msg("Prediction already revealed")]
    AlreadyRevealed,
    #[msg("Pick out of range (0=home, 1=draw, 2=away)")]
    InvalidPick,
    #[msg("Reveal does not match the committed hash")]
    CommitmentMismatch,
    #[msg("Prediction has not been revealed")]
    NotRevealed,
    #[msg("Prediction already settled")]
    AlreadySettled,
    #[msg("Merkle proof does not chain to the round's results root")]
    InvalidProof,
    #[msg("Withdrawal exceeds backed amount")]
    InsufficientBacking,
    #[msg("Commitments must carry a positive stake")]
    StakeRequired,
    #[msg("Prediction has not been settled")]
    NotSettled,
    #[msg("Payout already claimed for this prediction")]
    AlreadyClaimed,
    #[msg("Match still has ungraded commitments")]
    NotAllGraded,
    #[msg("Vault has insufficient liquid funds for this amount")]
    VaultInsufficient,
}
