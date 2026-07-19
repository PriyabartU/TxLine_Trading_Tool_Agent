// One-shot probe: authenticate with TxLINE devnet, then dump real schemas for
// schedule/fixtures/odds/scores so the feed adapter parses actual field names.
import { TxlineClient, epochDayNow } from "./txline.js";

const short = (o: any, n = 1600) => JSON.stringify(o)?.slice(0, n);

async function main() {
  const tx = new TxlineClient();
  await tx.connect();
  console.log("\n=== AUTH OK ===\n");

  const today = epochDayNow();
  for (const day of [today, today + 1]) {
    try {
      const sched = await tx.schedule(day);
      console.log(`schedule(${day}) count=${Array.isArray(sched) ? sched.length : "?"}\n`, short(sched), "\n");
      break;
    } catch (e) {
      console.log(`schedule(${day}) failed:`, (e as Error).message.slice(0, 200));
    }
  }

  try {
    const fx = await tx.fixturesSnapshot(72, today);
    console.log(`fixtures(comp=72, day=${today}) count=${Array.isArray(fx) ? fx.length : "?"}\n`, short(fx), "\n");
  } catch (e) {
    console.log("fixtures failed:", (e as Error).message.slice(0, 300));
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
