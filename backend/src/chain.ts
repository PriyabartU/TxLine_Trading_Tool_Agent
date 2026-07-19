// Chain adapter. Two implementations behind one interface:
//
//   MemoryChain  — default. An honest local simulation: it enforces the SAME
//                  rules as the on-chain program (commit deadline, hash check
//                  on reveal, Merkle proof verification on settle, bankroll
//                  and parimutuel pot math on stake/claim) so the demo is a
//                  faithful dry-run, not a mock that always says yes.
//   AnchorChain  — CHAIN=devnet. Drives the deployed Anchor program via
//                  @coral-xyz/anchor. Requires anchor build output (IDL) and a
//                  funded keypair.
//
// The orchestrator only talks to this interface, so flipping CHAIN=devnet
// changes nothing else in the app.
//
// Staking (devnet SOL only — demo prototype, not a wagering service): every
// commit locks a stake into the match pot. Wrong picks are slashed; correct
// picks claim stake + pro-rata share of the losers' stakes once the whole
// match is graded. Unrevealed commitments are forfeited (slashed).
import { randomBytes } from "crypto";
import { commitment as commitHash, resultLeaf, sha256, verifyProof } from "./merkle.js";

/** Every agent starts with this demo bankroll (1 devnet SOL). */
export const START_BANKROLL = 1_000_000_000;

export interface ChainAgentRef {
  id: string;
  pubkey: Buffer; // 32 bytes used in the commitment preimage
}

export interface Chain {
  mode: "memory" | "devnet";
  registerAgent(id: string, strategy: string): Promise<{ agent: ChainAgentRef; tx: string }>;
  createMatch(matchId: number, roundId: number, home: string, away: string, startTs: number, commitDeadline: number): Promise<string>;
  /** Commit the sealed pick AND lock `stakeLamports` into the match pot. */
  commit(agent: ChainAgentRef, matchId: number, commitment: Buffer, stakeLamports: number): Promise<string>;
  reveal(agent: ChainAgentRef, matchId: number, pick: number, salt: Buffer): Promise<string>;
  postRoot(roundId: number, root: Buffer): Promise<string>;
  settle(agent: ChainAgentRef, matchId: number, roundId: number, result: number, proof: Buffer[]): Promise<string>;
  /** Slash an agent that committed but never revealed (results must be posted). */
  forfeit(agent: ChainAgentRef, matchId: number, roundId: number): Promise<string>;
  /**
   * Parimutuel payout once every commitment on the match is graded.
   * Returns lamports credited back to the agent (0 = stake slashed).
   */
  claim(agent: ChainAgentRef, matchId: number): Promise<{ tx: string; payout: number }>;
  /** Current bankroll in lamports (demo ledger). */
  bankroll(agentId: string): number;
  /**
   * Re-sync bankrolls from chain state (devnet: vault equity per agent).
   * Picks up human backer deposits/withdrawals between rounds.
   */
  refresh?(): Promise<void>;
  /**
   * Close a fully-claimed round's spent accounts (matches, pots, round) so
   * their rent flows back to the keeper instead of bleeding into dead PDAs.
   */
  closeRound?(matchIds: number[], roundId: number): Promise<void>;
  explorerUrl(tx: string): string | null;
}

// ---------------------------------------------------------------------------
// MemoryChain
// ---------------------------------------------------------------------------

interface MemPrediction {
  commitment: Buffer;
  revealed: boolean;
  pick?: number;
  settled: boolean;
  correct: boolean;
  stake: bigint;
  paidOut: boolean;
}

interface MemMatch {
  commitDeadline: number;
  startTs: number;
  stakedTotal: bigint;
  commitCount: number;
  gradedCount: number;
  winningStake: bigint;
}

export class MemoryChain implements Chain {
  mode = "memory" as const;
  private matches = new Map<number, MemMatch>();
  private rounds = new Map<number, Buffer>();
  private predictions = new Map<string, MemPrediction>();
  private bankrolls = new Map<string, bigint>();

  private sig(...parts: string[]): string {
    return "local-" + sha256(Buffer.from(parts.join("|")), randomBytes(4)).toString("hex").slice(0, 16);
  }

  async registerAgent(id: string, _strategy: string) {
    const pubkey = sha256(Buffer.from("agent:" + id)); // deterministic 32-byte identity
    if (!this.bankrolls.has(id)) this.bankrolls.set(id, BigInt(START_BANKROLL));
    return { agent: { id, pubkey }, tx: this.sig("register", id) };
  }

  async createMatch(matchId: number, _roundId: number, _h: string, _a: string, startTs: number, commitDeadline: number) {
    this.matches.set(matchId, {
      commitDeadline, startTs,
      stakedTotal: 0n, commitCount: 0, gradedCount: 0, winningStake: 0n,
    });
    return this.sig("match", String(matchId));
  }

  async commit(agent: ChainAgentRef, matchId: number, commitment: Buffer, stakeLamports: number) {
    const m = this.matches.get(matchId);
    if (!m) throw new Error("unknown match");
    if (Date.now() / 1000 >= m.commitDeadline) throw new Error("CommitWindowClosed");
    const stake = BigInt(Math.floor(stakeLamports));
    if (stake <= 0n) throw new Error("StakeRequired");
    const bankroll = this.bankrolls.get(agent.id) ?? 0n;
    if (bankroll < stake) throw new Error("InsufficientBankroll");
    this.bankrolls.set(agent.id, bankroll - stake);
    m.stakedTotal += stake;
    m.commitCount += 1;
    this.predictions.set(`${agent.id}:${matchId}`, {
      commitment, revealed: false, settled: false, correct: false, stake, paidOut: false,
    });
    return this.sig("commit", agent.id, String(matchId));
  }

  async reveal(agent: ChainAgentRef, matchId: number, pick: number, salt: Buffer) {
    const m = this.matches.get(matchId);
    const p = this.predictions.get(`${agent.id}:${matchId}`);
    if (!m || !p) throw new Error("unknown prediction");
    if (Date.now() / 1000 < m.startTs) throw new Error("RevealTooEarly");
    const expected = commitHash(matchId, pick, salt, agent.pubkey);
    if (!expected.equals(p.commitment)) throw new Error("CommitmentMismatch");
    p.revealed = true;
    p.pick = pick;
    return this.sig("reveal", agent.id, String(matchId));
  }

  async postRoot(roundId: number, root: Buffer) {
    this.rounds.set(roundId, root);
    return this.sig("root", String(roundId));
  }

  async settle(agent: ChainAgentRef, matchId: number, roundId: number, result: number, proof: Buffer[]) {
    const m = this.matches.get(matchId);
    const p = this.predictions.get(`${agent.id}:${matchId}`);
    const root = this.rounds.get(roundId);
    if (!m || !p || !root) throw new Error("unknown prediction/round");
    if (!p.revealed) throw new Error("NotRevealed");
    if (p.settled) throw new Error("AlreadySettled");
    if (!verifyProof(resultLeaf(matchId, result), proof, root)) throw new Error("InvalidProof");
    p.settled = true;
    p.correct = p.pick === result;
    m.gradedCount += 1;
    if (p.correct) m.winningStake += p.stake;
    return this.sig("settle", agent.id, String(matchId));
  }

  async forfeit(agent: ChainAgentRef, matchId: number, roundId: number) {
    const m = this.matches.get(matchId);
    const p = this.predictions.get(`${agent.id}:${matchId}`);
    if (!m || !p) throw new Error("unknown prediction");
    if (!this.rounds.has(roundId)) throw new Error("results root not posted");
    if (p.revealed) throw new Error("AlreadyRevealed");
    if (p.settled) throw new Error("AlreadySettled");
    p.settled = true;
    p.correct = false;
    m.gradedCount += 1;
    return this.sig("forfeit", agent.id, String(matchId));
  }

  async claim(agent: ChainAgentRef, matchId: number) {
    const m = this.matches.get(matchId);
    const p = this.predictions.get(`${agent.id}:${matchId}`);
    if (!m || !p) throw new Error("unknown prediction");
    if (!p.settled) throw new Error("NotSettled");
    if (p.paidOut) throw new Error("AlreadyClaimed");
    if (m.gradedCount !== m.commitCount) throw new Error("NotAllGraded");
    p.paidOut = true;
    // Same rule as the on-chain program: winners split the losers' stakes;
    // if nobody won, revealed picks are refunded; no-shows stay slashed.
    let payout = 0n;
    if (m.winningStake === 0n) {
      if (p.revealed) payout = p.stake;
    } else if (p.correct) {
      const losingPool = m.stakedTotal - m.winningStake;
      payout = p.stake + (p.stake * losingPool) / m.winningStake;
    }
    if (payout > 0n) this.bankrolls.set(agent.id, (this.bankrolls.get(agent.id) ?? 0n) + payout);
    return { tx: this.sig("claim", agent.id, String(matchId)), payout: Number(payout) };
  }

  bankroll(agentId: string) {
    return Number(this.bankrolls.get(agentId) ?? 0n);
  }

  explorerUrl(_tx: string) {
    return null; // local mode — nothing to link to
  }
}

// ---------------------------------------------------------------------------
// AnchorChain (CHAIN=devnet)
// ---------------------------------------------------------------------------

export class AnchorChain implements Chain {
  mode = "devnet" as const;
  private program: any;
  private provider: any;
  private anchor: any;
  // Per-agent demo ledger. On devnet all agents share the keeper wallet, so
  // the stake/payout transfers are real lamports moving through the pot PDA,
  // but the per-agent split of the wallet balance is tracked here.
  private bankrolls = new Map<string, number>();

  static async create(): Promise<AnchorChain> {
    const self = new AnchorChain();
    const anchor = await import("@coral-xyz/anchor");
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");

    const idlPath =
      process.env.IDL_PATH ?? path.join(import.meta.dirname, "..", "..", "target", "idl", "oracle_league.json");
    if (!fs.existsSync(idlPath)) {
      throw new Error(
        `IDL not found at ${idlPath}. Run 'anchor build && anchor deploy' (in WSL) first, or set IDL_PATH.`,
      );
    }
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

    const keypairPath =
      process.env.KEYPAIR ?? path.join(os.homedir(), ".config", "solana", "id.json");
    const secret = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8")));
    const wallet = new anchor.Wallet(anchor.web3.Keypair.fromSecretKey(secret));

    const connection = new anchor.web3.Connection(
      process.env.RPC_URL ?? "https://api.devnet.solana.com",
      "confirmed",
    );
    self.provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
    self.anchor = anchor;
    self.program = new anchor.Program(idl, self.provider);

    // Initialize the league once (idempotent: swallow "already in use").
    try {
      await self.program.methods.initialize().rpc();
      console.log("[chain] league initialized");
    } catch (e) {
      console.log("[chain] league already initialized");
    }
    return self;
  }

  private pda(seeds: (Buffer | Uint8Array)[]): any {
    return this.anchor.web3.PublicKey.findProgramAddressSync(seeds, this.program.programId)[0];
  }

  private u64(n: number): Buffer {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  }

  agentPda(id: string) {
    return this.pda([Buffer.from("agent"), Buffer.from(id)]);
  }

  vaultPda(id: string) {
    return this.pda([Buffer.from("vault"), this.agentPda(id).toBytes()]);
  }

  vstatePda(id: string) {
    return this.pda([Buffer.from("vstate"), this.agentPda(id).toBytes()]);
  }

  /** Liquid vault balance — what commit_prediction can actually draw from. */
  async vaultLiquid(id: string): Promise<number> {
    return await this.provider.connection.getBalance(this.vaultPda(id));
  }

  private async backVault(id: string, lamports: number) {
    const agentPda = this.agentPda(id);
    await this.program.methods.backAgent(new this.anchor.BN(lamports)).accounts({
      agent: agentPda,
      vault: this.vaultPda(id),
      vaultState: this.vstatePda(id),
      backerPosition: this.pda([
        Buffer.from("backer"),
        agentPda.toBytes(),
        this.provider.wallet.publicKey.toBytes(),
      ]),
      backer: this.provider.wallet.publicKey,
    }).rpc();
  }

  async registerAgent(id: string, strategy: string) {
    const agentPda = this.agentPda(id);
    let tx = "already-registered";
    try {
      tx = await this.program.methods.registerAgent(id, strategy).rpc();
    } catch (e: any) {
      if (!/already in use/i.test(String(e))) throw e;
    }
    // Startup is the one moment no stake of ours is legitimately in flight,
    // so any staked_outstanding left over is stranded in dead pots by an
    // aborted round. Write it off so equity/share pricing match reality.
    try {
      const vs = await this.program.account.vaultState.fetch(this.vstatePda(id));
      if (Number(vs.stakedOutstanding.toString()) > 0) {
        await this.program.methods.reconcileVault(new this.anchor.BN(0)).accounts({
          agent: agentPda,
          vaultState: this.vstatePda(id),
          authority: this.provider.wallet.publicKey,
        }).rpc();
        console.log(`[chain] ${id}: wrote off stale in-flight stakes (aborted rounds)`);
      }
    } catch {
      /* no vault state yet — nothing to reconcile */
    }
    // The keeper is each agent's first backer: seed the vault to the same
    // floor refresh() maintains. Agents stake from this vault; humans who
    // back an agent later buy shares of the same vault and ride the same P&L.
    const liquid = await this.vaultLiquid(id);
    if (liquid < AnchorChain.TOP_UP_FLOOR) {
      await this.backVault(id, AnchorChain.TOP_UP_FLOOR - liquid);
    }
    this.bankrolls.set(id, await this.vaultLiquid(id));
    return { agent: { id, pubkey: Buffer.from(agentPda.toBytes()) }, tx };
  }

  /** Below this liquid balance the keeper tops the vault back up (◎0.3). */
  static readonly TOP_UP_FLOOR = 300_000_000;

  /**
   * Re-sync bankrolls from the chain. Bankroll = LIQUID vault balance: it is
   * the only thing commit_prediction can spend, so sizing stakes off it makes
   * VaultInsufficient stalls impossible. Vaults that ran dry (stranded pots,
   * cold streaks) are topped back up by the keeper so the league never stalls.
   */
  async refresh() {
    for (const id of this.bankrolls.keys()) {
      // Round start means no stake of ours is legitimately in flight: any
      // nonzero staked_outstanding was stranded by an aborted round. Write it
      // off so equity and share pricing stay honest.
      try {
        const vs = await this.program.account.vaultState.fetch(this.vstatePda(id));
        if (Number(vs.stakedOutstanding.toString()) > 0) {
          await this.program.methods.reconcileVault(new this.anchor.BN(0)).accounts({
            agent: this.agentPda(id),
            vaultState: this.vstatePda(id),
            authority: this.provider.wallet.publicKey,
          }).rpc();
          console.log(`[chain] ${id}: wrote off stranded in-flight stakes from an aborted round`);
        }
      } catch {
        /* no vault state yet */
      }
      let liquid = await this.vaultLiquid(id);
      if (liquid < AnchorChain.TOP_UP_FLOOR) {
        await this.backVault(id, AnchorChain.TOP_UP_FLOOR - liquid);
        liquid = await this.vaultLiquid(id);
        console.log(`[chain] ${id}: vault topped up to ◎${(liquid / 1e9).toFixed(3)} by keeper`);
      }
      this.bankrolls.set(id, liquid);
    }
  }

  async createMatch(matchId: number, roundId: number, home: string, away: string, startTs: number, commitDeadline: number) {
    const tx = await this.program.methods
      .createMatch(
        new this.anchor.BN(matchId),
        new this.anchor.BN(roundId),
        home,
        away,
        new this.anchor.BN(startTs),
        new this.anchor.BN(commitDeadline),
      )
      .rpc();
    // Pre-fund the pot PDA with the rent-exempt minimum: after the last
    // winner's claim empties the stakes, the account must keep a valid
    // balance or the runtime rejects the claim ("insufficient funds for
    // rent"). ~0.0009 SOL per match, paid by the keeper.
    const pot = this.pda([Buffer.from("pot"), this.u64(matchId)]);
    const rentMin = await this.provider.connection.getMinimumBalanceForRentExemption(0);
    const prefund = new this.anchor.web3.Transaction().add(
      this.anchor.web3.SystemProgram.transfer({
        fromPubkey: this.provider.wallet.publicKey,
        toPubkey: pot,
        lamports: rentMin,
      }),
    );
    await this.provider.sendAndConfirm(prefund);
    return tx;
  }

  async commit(agent: ChainAgentRef, matchId: number, commitment: Buffer, stakeLamports: number) {
    const tx = await this.program.methods
      .commitPrediction([...commitment], new this.anchor.BN(stakeLamports))
      .accounts({
        agent: this.agentPda(agent.id),
        matchAccount: this.pda([Buffer.from("match"), this.u64(matchId)]),
        pot: this.pda([Buffer.from("pot"), this.u64(matchId)]),
        vault: this.vaultPda(agent.id),
        vaultState: this.vstatePda(agent.id),
      })
      .rpc();
    this.bankrolls.set(agent.id, (this.bankrolls.get(agent.id) ?? 0) - stakeLamports);
    return tx;
  }

  async reveal(agent: ChainAgentRef, matchId: number, pick: number, salt: Buffer) {
    return await this.program.methods
      .revealPrediction(pick, [...salt])
      .accounts({
        agent: this.agentPda(agent.id),
        matchAccount: this.pda([Buffer.from("match"), this.u64(matchId)]),
      })
      .rpc();
  }

  async postRoot(roundId: number, root: Buffer) {
    return await this.program.methods.postResultsRoot(new this.anchor.BN(roundId), [...root]).rpc();
  }

  async settle(agent: ChainAgentRef, matchId: number, _roundId: number, result: number, proof: Buffer[]) {
    return await this.program.methods
      .settlePrediction(result, proof.map((p) => [...p]))
      .accounts({
        agent: this.agentPda(agent.id),
        matchAccount: this.pda([Buffer.from("match"), this.u64(matchId)]),
      })
      .rpc();
  }

  async forfeit(agent: ChainAgentRef, matchId: number, _roundId: number) {
    return await this.program.methods
      .forfeitUnrevealed()
      .accounts({
        agent: this.agentPda(agent.id),
        matchAccount: this.pda([Buffer.from("match"), this.u64(matchId)]),
      })
      .rpc();
  }

  async claim(agent: ChainAgentRef, matchId: number) {
    const agentPda = this.agentPda(agent.id);
    const matchPda = this.pda([Buffer.from("match"), this.u64(matchId)]);
    // Snapshot BEFORE claiming: the claim closes the prediction account.
    // Settlement is final at this point, so the payout math is stable.
    const predictionPda = this.pda([Buffer.from("prediction"), agentPda.toBytes(), this.u64(matchId)]);
    const p = await this.program.account.prediction.fetch(predictionPda);
    const m = await this.program.account.matchAccount.fetch(matchPda);
    const tx = await this.program.methods
      .claimPayout()
      .accounts({
        agent: agentPda,
        matchAccount: matchPda,
        pot: this.pda([Buffer.from("pot"), this.u64(matchId)]),
        vault: this.vaultPda(agent.id),
        vaultState: this.vstatePda(agent.id),
      })
      .rpc();
    // Mirror the program's payout rule: winners split the losers' stakes;
    // if nobody won, revealed picks are refunded; no-shows stay slashed.
    let payout = 0;
    const winning = BigInt(m.winningStake.toString());
    const stake = BigInt(p.stake.toString());
    if (winning === 0n) {
      payout = p.revealed ? Number(stake) : 0;
    } else if (p.correct) {
      const losing = BigInt(m.stakedTotal.toString()) - winning;
      payout = Number(stake + (stake * losing) / winning);
    }
    this.bankrolls.set(agent.id, (this.bankrolls.get(agent.id) ?? 0) + payout);
    return { tx, payout };
  }

  bankroll(agentId: string) {
    return this.bankrolls.get(agentId) ?? 0;
  }

  async closeRound(matchIds: number[], roundId: number) {
    for (const matchId of matchIds) {
      await this.program.methods.closeMatch().accounts({
        matchAccount: this.pda([Buffer.from("match"), this.u64(matchId)]),
        pot: this.pda([Buffer.from("pot"), this.u64(matchId)]),
        cranker: this.provider.wallet.publicKey,
      }).rpc();
    }
    await this.program.methods.closeRound().accounts({
      round: this.pda([Buffer.from("round"), this.u64(roundId)]),
      authority: this.provider.wallet.publicKey,
    }).rpc();
  }

  explorerUrl(tx: string) {
    return `https://explorer.solana.com/tx/${tx}?cluster=devnet`;
  }
}

export async function createChain(): Promise<Chain> {
  if ((process.env.CHAIN ?? "memory") === "devnet") {
    return await AnchorChain.create();
  }
  return new MemoryChain();
}
