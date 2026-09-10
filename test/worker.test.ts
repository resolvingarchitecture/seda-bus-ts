import assert from "node:assert/strict";
import { availableParallelism } from "node:os";
import { test } from "node:test";

import { Delivery, SedaBus, makeEnvelope, type Envelope } from "../src/index.js";

const uppercase = new URL("./fixtures/uppercase-stage.ts", import.meta.url);
const hash = new URL("./fixtures/hash-stage.ts", import.meta.url);
const reject = new URL("./fixtures/reject-stage.ts", import.meta.url);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test("a worker stage runs the handler and mutations flow back", async () => {
  const bus = new SedaBus();
  bus.channel("upper", { capacity: 10, worker: { module: uppercase, pool: 2 } });

  const done = deferred<Envelope>();
  await bus.publish(makeEnvelope("upper", "hello"), {
    onComplete: (e) => done.resolve(e),
  });
  const e = await done.promise;
  await bus.shutdown();

  assert.equal(e.content(), "HELLO");
  assert.equal(e.headers["transformedBy"], "worker");
  assert.equal(bus.stats()["upper"]!.delivered, 1);
});

test("subscribe() on a worker channel throws", async () => {
  const bus = new SedaBus();
  bus.channel("w", { worker: { module: uppercase } });
  assert.throws(() => bus.subscribe("w", () => true), /worker-backed channel/);
  await bus.shutdown();
});

test("pub/sub + worker is rejected at registration", async () => {
  const bus = new SedaBus();
  assert.throws(
    () => bus.channel("bad", { delivery: Delivery.PubSub, worker: { module: uppercase } }),
    /pub\/sub is not supported for worker stages/,
  );
  await bus.shutdown();
});

test("a worker handler that nacks is retried then dead-lettered", async () => {
  const bus = new SedaBus();
  bus.channel("flaky", { capacity: 10, maxAttempts: 3, worker: { module: reject, pool: 1 } });
  bus.channel("dead", { capacity: 10 });
  bus.setDeadLetterChannel("flaky", "dead");
  const dead = deferred<void>();
  bus.subscribe("dead", () => dead.resolve());

  await bus.publish(makeEnvelope("flaky", 1));
  await dead.promise;
  await bus.shutdown();
  assert.equal(bus.stats()["flaky"]!.deadLettered, 1);
});

test("a worker stage parallelises CPU-bound work across threads", { timeout: 60_000 }, async (t) => {
  if (availableParallelism() < 4) {
    t.skip("needs >= 4 cores");
    return;
  }
  const rounds = 120_000;
  const count = 16;

  async function run(pool: number): Promise<number> {
    const bus = new SedaBus();
    bus.channel("hash", { capacity: count, worker: { module: hash, pool } });
    let done = 0;
    const all = deferred<void>();
    const started = Date.now();
    for (let i = 0; i < count; i++) {
      await bus.publish(
        makeEnvelope("hash", { seed: `s${i}`, rounds }),
        {
          onComplete: () => {
            if (++done === count) all.resolve();
          },
        },
      );
    }
    await all.promise;
    const elapsed = Date.now() - started;
    await bus.shutdown();
    return elapsed;
  }

  const serial = await run(1);
  const parallel = await run(4);
  assert.ok(
    parallel < serial * 0.6,
    `expected real speedup: serial=${serial}ms parallel=${parallel}ms`,
  );
});
