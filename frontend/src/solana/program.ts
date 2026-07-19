// Browser-side client for the oracle_league program's human backing layer.
// Builds back_agent / withdraw_backing instructions raw (discriminators from
// target/idl/oracle_league.json) so the frontend doesn't need the Anchor SDK.
import { Buffer } from "buffer";
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey("AJdsHnwJ4WEz3zUFdpC7duedN9Ry2mQPB2gai8AiqVku");
export const RPC_URL = "https://api.devnet.solana.com";

const enc = new TextEncoder();

/** seeds = ["agent", id] — same derivation the keeper uses at registration. */
export const agentPda = (agentId: string) =>
  PublicKey.findProgramAddressSync([enc.encode("agent"), enc.encode(agentId)], PROGRAM_ID)[0];

/** seeds = ["vault", agent] — program-owned system account holding backing lamports. */
export const vaultPda = (agent: PublicKey) =>
  PublicKey.findProgramAddressSync([enc.encode("vault"), agent.toBytes()], PROGRAM_ID)[0];

/** seeds = ["vstate", agent] — share + in-flight-stake bookkeeping. */
export const vstatePda = (agent: PublicKey) =>
  PublicKey.findProgramAddressSync([enc.encode("vstate"), agent.toBytes()], PROGRAM_ID)[0];

/** seeds = ["backer", agent, backer] — one position account per (agent, user). */
export const backerPositionPda = (agent: PublicKey, backer: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [enc.encode("backer"), agent.toBytes(), backer.toBytes()],
    PROGRAM_ID,
  )[0];

const DISC_BACK_AGENT = [28, 12, 95, 85, 115, 225, 18, 63];
const DISC_WITHDRAW_BACKING = [42, 74, 28, 146, 165, 192, 91, 72];

function ixData(disc: number[], lamports: number): Buffer {
  const data = new Uint8Array(16);
  data.set(disc, 0);
  new DataView(data.buffer).setBigUint64(8, BigInt(lamports), true);
  return Buffer.from(data);
}

function backingIx(disc: number[], agentId: string, backer: PublicKey, lamports: number) {
  const agent = agentPda(agentId);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: agent, isSigner: false, isWritable: true },
      { pubkey: vaultPda(agent), isSigner: false, isWritable: true },
      { pubkey: vstatePda(agent), isSigner: false, isWritable: true },
      { pubkey: backerPositionPda(agent, backer), isSigner: false, isWritable: true },
      { pubkey: backer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: ixData(disc, lamports),
  });
}

export const backAgentIx = (agentId: string, backer: PublicKey, lamports: number) =>
  backingIx(DISC_BACK_AGENT, agentId, backer, lamports);

export const withdrawBackingIx = (agentId: string, backer: PublicKey, lamports: number) =>
  backingIx(DISC_WITHDRAW_BACKING, agentId, backer, lamports);

export interface BackingInfo {
  /** Vault equity in lamports: liquid balance + stakes locked in live pots. */
  equity: number;
  /** Lamports currently staked into live match pots (locked until claims). */
  outstanding: number;
  /** Current value of the connected wallet's shares, in lamports. */
  myValue: number;
}

/** VaultState account: 8 disc + u64 total_shares + u64 staked_outstanding. */
function parseVaultState(data: Uint8Array): { totalShares: number; outstanding: number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    totalShares: Number(view.getBigUint64(8, true)),
    outstanding: Number(view.getBigUint64(16, true)),
  };
}

/** BackerPosition account: 8 disc + 32 backer + 32 agent + u64 shares. */
function parsePositionShares(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return Number(view.getBigUint64(8 + 32 + 32, true));
}

export async function fetchBacking(
  connection: Connection,
  agentId: string,
  backer?: PublicKey,
): Promise<BackingInfo> {
  const agent = agentPda(agentId);
  const vault = vaultPda(agent);
  const keys = [vault, vstatePda(agent), ...(backer ? [backerPositionPda(agent, backer)] : [])];
  const [vaultAcc, vsAcc, posAcc] = await connection.getMultipleAccountsInfo(keys);
  const vs = vsAcc ? parseVaultState(vsAcc.data) : { totalShares: 0, outstanding: 0 };
  const equity = (vaultAcc?.lamports ?? 0) + vs.outstanding;
  const myShares = posAcc ? parsePositionShares(posAcc.data) : 0;
  return {
    equity,
    outstanding: vs.outstanding,
    myValue: vs.totalShares > 0 ? Math.floor((myShares * equity) / vs.totalShares) : 0,
  };
}

export const explorerTx = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
