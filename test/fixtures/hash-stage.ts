import { createHash } from "node:crypto";
import type { Envelope } from "../../src/index.js";

interface Job {
  seed: string;
  rounds: number;
}

/** CPU-bound stage: iterated SHA-256, to show real off-thread parallelism. */
export default function hash(env: Envelope<Job>): boolean {
  let acc = Buffer.from(env.payload.seed);
  for (let i = 0; i < env.payload.rounds; i++) {
    acc = createHash("sha256").update(acc).digest();
  }
  env.headers.digest = acc.toString("hex").slice(0, 12);
  return true;
}
