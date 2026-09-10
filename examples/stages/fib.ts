import type { Envelope } from "@resolvingarchitecture/ra-common";

/** Deliberately slow, CPU-bound. Runs in a Worker thread. */
function fib(n: number): number {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

export default function stage(env: Envelope): void {
  const { n } = env.content() as { n: number };
  env.headers["result"] = String(fib(n));
}
