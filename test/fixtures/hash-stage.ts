import { createHash } from "node:crypto";

import type { Envelope } from "@resolvingarchitecture/ra-common";

interface Job {
  seed: string;
  rounds: number;
}

/** CPU-bound stage: iterated SHA-256, to show real off-thread parallelism. */
export default function hash(env: Envelope): boolean {
  const job = env.content() as Job;
  let acc = Buffer.from(job.seed);
  for (let i = 0; i < job.rounds; i++) {
    acc = createHash("sha256").update(acc).digest();
  }
  env.headers["digest"] = acc.toString("hex").slice(0, 12);
  return true;
}
