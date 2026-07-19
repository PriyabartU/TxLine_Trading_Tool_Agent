// TxLINE client — auth, free-tier World Cup subscription, data access, and
// on-chain proof verification against TxLINE's devnet program.
//
// Flow (from TxLINE's official docs + examples repo, github.com/txodds/tx-on-chain):
//   1. POST /auth/guest/start                      → short-lived JWT
//   2. on-chain `subscribe(serviceLevel=1, weeks=4)` on their program (free tier)
//   3. sign `${txSig}:${leagues}:${jwt}` → POST /api/token/activate → API token
//   4. call /api/* with  Authorization: Bearer <jwt>  +  X-Api-Token: <token>
//
// Wallet + tokens are cached under backend/.txline/ so we subscribe once.
import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import fs from "fs";
import path from "path";

const HOST = process.env.TXLINE_HOST ?? "https://txline-dev.txodds.com";
const API = `${HOST}/api`;
const JWT_URL = `${HOST}/auth/guest/start`;
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const TOKEN_MINT = new PublicKey(process.env.TXLINE_TOKEN_MINT ?? "4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG");
const STATE_DIR = path.join(import.meta.dirname, "..", ".txline");

export class TxlineClient {
  private jwt = "";
  private apiToken = "";
  wallet!: Keypair;
  private connection!: Connection;
  private program!: anchor.Program;

  // ---------------------------------------------------------------- auth ---

  async connect(): Promise<void> {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    this.connection = new Connection(RPC_URL, "confirmed");
    this.wallet = this.loadOrCreateWallet();

    const idl = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "idl", "txoracle.json"), "utf8"));
    const provider = new anchor.AnchorProvider(this.connection, new anchor.Wallet(this.wallet), {
      commitment: "confirmed",
    });
    this.program = new anchor.Program(idl, provider);

    await this.renewJwt();

    const cached = this.loadAuth();
    if (cached.apiToken) {
      this.apiToken = cached.apiToken;
      console.log("[txline] using cached API token");
      // Probe: if the cached token is dead, resubscribe.
      try {
        await this.fixturesSnapshot(Number(process.env.TXLINE_COMPETITION_ID ?? 72), epochDayNow());
        return;
      } catch {
        console.log("[txline] cached token rejected — resubscribing");
      }
    }
    await this.subscribeFreeTier();
  }

  private loadOrCreateWallet(): Keypair {
    const p = process.env.TXLINE_WALLET ?? path.join(STATE_DIR, "wallet.json");
    if (fs.existsSync(p)) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
    }
    const kp = Keypair.generate();
    fs.writeFileSync(p, JSON.stringify([...kp.secretKey]));
    console.log(`[txline] generated new devnet wallet ${kp.publicKey.toBase58()} (saved to ${p})`);
    return kp;
  }

  private loadAuth(): { apiToken?: string; pendingTxSig?: string } {
    const p = path.join(STATE_DIR, "auth.json");
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  }

  private saveAuth(data: { apiToken?: string; pendingTxSig?: string }) {
    fs.writeFileSync(path.join(STATE_DIR, "auth.json"), JSON.stringify(data));
  }

  private async renewJwt(): Promise<void> {
    const res = await fetch(JWT_URL, { method: "POST" });
    if (!res.ok) throw new Error(`guest/start failed: ${res.status}`);
    this.jwt = ((await res.json()) as any).token;
  }

  private async ensureFunds(): Promise<void> {
    const bal = await this.connection.getBalance(this.wallet.publicKey);
    if (bal >= 0.05 * LAMPORTS_PER_SOL) return;
    console.log(`[txline] wallet ${this.wallet.publicKey.toBase58()} has ${bal / LAMPORTS_PER_SOL} SOL — requesting devnet airdrop…`);
    try {
      const sig = await this.connection.requestAirdrop(this.wallet.publicKey, 2 * LAMPORTS_PER_SOL);
      await this.connection.confirmTransaction(sig, "confirmed");
      console.log("[txline] airdrop confirmed");
    } catch (e) {
      throw new Error(
        `Devnet airdrop failed (faucet rate-limit?). Fund ${this.wallet.publicKey.toBase58()} manually at https://faucet.solana.com then retry. (${(e as Error).message})`,
      );
    }
  }

  /** Free World Cup tier: serviceLevel=1, 4 weeks, no leagues, no TxL needed. */
  private async subscribeFreeTier(): Promise<void> {
    // If a subscribe tx already confirmed but activation failed, reuse it.
    const pending = this.loadAuth().pendingTxSig;
    if (pending) {
      console.log(`[txline] retrying activation for existing subscription ${pending.slice(0, 20)}…`);
      try {
        await this.activate(pending);
        return;
      } catch (e) {
        console.log(`[txline] pending activation failed (${(e as Error).message.slice(0, 120)}) — subscribing fresh`);
      }
    }
    await this.ensureFunds();

    const ata = getAssociatedTokenAddressSync(TOKEN_MINT, this.wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
    if (!(await this.connection.getAccountInfo(ata))) {
      console.log("[txline] creating Token-2022 ATA");
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          this.wallet.publicKey, ata, this.wallet.publicKey, TOKEN_MINT,
          TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      );
      await anchor.web3.sendAndConfirmTransaction(this.connection, tx, [this.wallet], { commitment: "confirmed" });
    }

    const [pricingMatrixPda] = PublicKey.findProgramAddressSync([Buffer.from("pricing_matrix")], this.program.programId);
    const [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("token_treasury_v2")], this.program.programId);
    const treasuryVault = getAssociatedTokenAddressSync(TOKEN_MINT, treasuryPda, true, TOKEN_2022_PROGRAM_ID);

    console.log("[txline] sending on-chain subscribe (free tier, level 1, 4 weeks)…");
    const tx = await (this.program.methods as any)
      .subscribe(1, 4)
      .accounts({
        user: this.wallet.publicKey,
        pricingMatrix: pricingMatrixPda,
        tokenMint: TOKEN_MINT,
        userTokenAccount: ata,
        tokenTreasuryVault: treasuryVault,
        tokenTreasuryPda: treasuryPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .transaction();

    const bh = await this.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = bh.blockhash;
    tx.feePayer = this.wallet.publicKey;
    tx.sign(this.wallet);
    const txSig = await this.connection.sendRawTransaction(tx.serialize());
    await this.connection.confirmTransaction(
      { signature: txSig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
      "confirmed",
    );
    console.log(`[txline] subscribed on-chain: ${txSig}`);
    this.saveAuth({ pendingTxSig: txSig }); // survive an activation crash
    await this.activate(txSig);
  }

  /** Activation: sign `${txSig}:${leagues}:${jwt}` with the subscribing wallet. */
  private async activate(txSig: string): Promise<void> {
    const leagues: number[] = [];
    const message = new TextEncoder().encode(`${txSig}:${leagues.join(",")}:${this.jwt}`);
    const walletSignature = Buffer.from(nacl.sign.detached(message, this.wallet.secretKey)).toString("base64");

    const res = await fetch(`${API}/token/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.jwt}` },
      body: JSON.stringify({ txSig, walletSignature, leagues }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`token/activate failed: ${res.status} ${text}`);
    // Response may be JSON ({token: ...}) or the bare token string.
    try {
      const body: any = JSON.parse(text);
      this.apiToken = body.token ?? body;
    } catch {
      this.apiToken = text.replace(/^"|"$/g, "").trim();
    }
    this.saveAuth({ apiToken: this.apiToken });
    console.log("[txline] API token activated ✔");
  }

  // ---------------------------------------------------------------- data ---

  async api(pathname: string, retried = false): Promise<any> {
    const res = await fetch(`${API}${pathname}`, {
      headers: {
        Authorization: `Bearer ${this.jwt}`,
        "X-Api-Token": this.apiToken,
        "Content-Type": "application/json",
      },
    });
    if (res.status === 401 && !retried) {
      await this.renewJwt();
      return this.api(pathname, true);
    }
    if (!res.ok) throw new Error(`GET ${pathname} → ${res.status} ${await res.text()}`);
    return res.json();
  }

  fixturesSnapshot(competitionId: number, startEpochDay: number): Promise<any> {
    return this.api(`/fixtures/snapshot?competitionId=${competitionId}&startEpochDay=${startEpochDay}`);
  }

  schedule(epochDay: number): Promise<any> {
    return this.api(`/scores/schedule?epochDay=${epochDay}`);
  }

  oddsSnapshot(fixtureId: number): Promise<any> {
    return this.api(`/odds/snapshot/${fixtureId}?asOf=${Date.now()}`);
  }

  scoresSnapshot(fixtureId: number): Promise<any> {
    return this.api(`/scores/snapshot/${fixtureId}?asOf=${Date.now()}`);
  }

  historical(fixtureId: number): Promise<any> {
    return this.api(`/scores/historical/${fixtureId}`);
  }

  /** Fetch the Merkle proof package for stats of a score record. */
  statValidation(fixtureId: number, seq: number, statKeys: number[]): Promise<any> {
    return this.api(`/scores/stat-validation?fixtureId=${fixtureId}&seq=${seq}&statKeys=${statKeys.join(",")}`);
  }

  /**
   * Verify a stat proof package against TxLINE's on-chain daily Merkle roots
   * by simulating their `validate_stat_v2` instruction (anchor .view()).
   * Throws if the proof does not chain to the root anchored on Solana.
   */
  async validateStatV2View(validation: any, predicates: any[]): Promise<boolean> {
    const toBytes32 = (h: any): number[] => {
      const b = typeof h === "string"
        ? (h.match(/^[0-9a-fA-F]{64}$/) ? Buffer.from(h, "hex") : Buffer.from(h, "base64"))
        : Buffer.from(h);
      if (b.length !== 32) throw new Error(`expected 32 bytes, got ${b.length}`);
      return Array.from(b);
    };
    const mapProof = (nodes: any[]) =>
      nodes.map((n) => ({ hash: toBytes32(n.hash), isRightSibling: n.isRightSibling }));

    const summary = validation.summary;
    const payload = {
      ts: new anchor.BN(summary.updateStats.minTimestamp),
      fixtureSummary: {
        fixtureId: new anchor.BN(summary.fixtureId),
        updateStats: {
          updateCount: summary.updateStats.updateCount,
          minTimestamp: new anchor.BN(summary.updateStats.minTimestamp),
          maxTimestamp: new anchor.BN(summary.updateStats.maxTimestamp),
        },
        eventsSubTreeRoot: toBytes32(summary.eventStatsSubTreeRoot ?? validation.eventStatRoot),
      },
      fixtureProof: mapProof(validation.subTreeProof),
      mainTreeProof: mapProof(validation.mainTreeProof),
      eventStatRoot: toBytes32(validation.eventStatRoot),
      stats: (validation.statsToProve as any[]).map((stat, i) => ({
        stat,
        statProof: mapProof(validation.statProofs[i]),
      })),
    };
    const strategy = { geometricTargets: [], distancePredicate: null, discretePredicates: predicates };

    const epochDay = Math.floor(Number(summary.updateStats.minTimestamp) / 86400000);
    const [dailyScoresPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("daily_scores_roots"), new anchor.BN(epochDay).toArrayLike(Buffer, "le", 2)],
      this.program.programId,
    );
    const computeIx = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

    await (this.program.methods as any)
      .validateStatV2(payload, strategy)
      .accounts({ dailyScoresMerkleRoots: dailyScoresPda })
      .preInstructions([computeIx])
      .view();
    return true;
  }
}

export function epochDayNow(): number {
  return Math.floor(Date.now() / 86400000);
}
