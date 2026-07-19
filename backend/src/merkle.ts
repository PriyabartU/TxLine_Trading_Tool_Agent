// Merkle tree with sorted-pair sha256 hashing.
// MUST stay byte-identical to the on-chain verifier in programs/oracle-league:
//   leaf   = sha256("result" || match_id_le_u64 || result_u8)
//   parent = sha256(min(a,b) || max(a,b))
import { createHash } from "crypto";

export function sha256(...parts: Buffer[]): Buffer {
  return createHash("sha256").update(Buffer.concat(parts)).digest();
}

export function u64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

export function resultLeaf(matchId: number, result: number): Buffer {
  return sha256(Buffer.from("result"), u64le(matchId), Buffer.from([result]));
}

/** Commitment preimage: match_id_le || pick || salt(32) || agent_pubkey(32) */
export function commitment(matchId: number, pick: number, salt: Buffer, agentPubkey: Buffer): Buffer {
  return sha256(u64le(matchId), Buffer.from([pick]), salt, agentPubkey);
}

function parent(a: Buffer, b: Buffer): Buffer {
  return Buffer.compare(a, b) <= 0 ? sha256(a, b) : sha256(b, a);
}

export interface MerkleTree {
  root: Buffer;
  proof(index: number): Buffer[];
}

export function buildTree(leaves: Buffer[]): MerkleTree {
  if (leaves.length === 0) throw new Error("empty tree");
  const layers: Buffer[][] = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next: Buffer[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      // odd node is paired with itself
      next.push(parent(prev[i], prev[i + 1] ?? prev[i]));
    }
    layers.push(next);
  }
  return {
    root: layers[layers.length - 1][0],
    proof(index: number): Buffer[] {
      const out: Buffer[] = [];
      let idx = index;
      for (let l = 0; l < layers.length - 1; l++) {
        const layer = layers[l];
        const sibling = idx % 2 === 0 ? (layer[idx + 1] ?? layer[idx]) : layer[idx - 1];
        out.push(sibling);
        idx = Math.floor(idx / 2);
      }
      return out;
    },
  };
}

export function verifyProof(leaf: Buffer, proof: Buffer[], root: Buffer): boolean {
  let node = leaf;
  for (const sib of proof) node = parent(node, sib);
  return node.equals(root);
}
