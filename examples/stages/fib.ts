import type { Envelope } from "../../src/index.js";

/** Deliberately slow, CPU-bound. Runs in a Worker thread. */
function fib(n: number): number {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

export default function stage(env: Envelope<{ n: number }>): void {
  env.headers.result = String(fib(env.payload.n));
}
