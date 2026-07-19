import type { Receipt } from "./types";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const str = (s: string) => new TextEncoder().encode(s);

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

const u64le = (n: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
};

const cmp = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
};

export interface VerifyResult {
  commitOk: boolean;
  proofOk: boolean;
}

// Recompute both proofs client-side: (1) commitment binds the pick before
// kickoff, (2) Merkle proof chains the result to the posted round root.
export async function verifyReceipt(r: Receipt): Promise<VerifyResult> {
  const commit = await sha256(
    u64le(r.matchId),
    new Uint8Array([r.pick]),
    unhex(r.salt),
    unhex(r.agentPubkey),
  );
  const commitOk = hex(commit) === r.commitment;
  let proofOk = false;
  if (r.root && r.proof && r.result !== undefined) {
    let node = await sha256(str("result"), u64le(r.matchId), new Uint8Array([r.result]));
    for (const sib of r.proof.map(unhex)) {
      node = cmp(node, sib) <= 0 ? await sha256(node, sib) : await sha256(sib, node);
    }
    proofOk = hex(node) === r.root;
  }
  return { commitOk, proofOk };
}
