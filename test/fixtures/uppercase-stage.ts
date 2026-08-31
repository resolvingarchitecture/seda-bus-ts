import type { Envelope } from "../../src/index.js";

/** Transform stage: uppercases the payload in the worker, mutation flows back. */
export default function uppercase(env: Envelope<string>): void {
  env.payload = env.payload.toUpperCase();
  env.headers.transformedBy = "worker";
}
