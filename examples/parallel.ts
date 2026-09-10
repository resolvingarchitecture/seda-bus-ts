/**
 * A CPU-bound stage backed by Worker threads. Compare pool sizes:
 *
 *   npm run example:parallel
 */
import { availableParallelism } from "node:os";
import { SedaBus, makeEnvelope, type Envelope } from "../src/index.js";

const fibStage = new URL("./stages/fib.ts", import.meta.url);

async function run(pool: number, jobs: number, n: number): Promise<number> {
  const bus = new SedaBus();
  bus.channel("fib", { capacity: jobs, worker: { module: fibStage, pool } });

  let done = 0;
  let resolveAll!: () => void;
  const all = new Promise<void>((r) => (resolveAll = r));
  const started = Date.now();

  for (let i = 0; i < jobs; i++) {
    await bus.publish(makeEnvelope("fib", { n }), {
      onComplete: (_e: Envelope) => {
        if (++done === jobs) resolveAll();
      },
    });
  }
  await all;
  const elapsed = Date.now() - started;
  await bus.shutdown();
  return elapsed;
}

async function main() {
  const cores = availableParallelism();
  console.log(`cores: ${cores}`);
  const jobs = 12;
  const n = 38;
  for (const pool of [1, Math.min(4, cores), cores]) {
    const ms = await run(pool, jobs, n);
    console.log(`  pool=${String(pool).padStart(2)}  ${jobs} jobs (fib ${n})  ${ms} ms`);
  }
}

main();
