import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Backpressure,
  Delivery,
  SedaBus,
  makeEnvelope,
  type Envelope,
} from "../src/index.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("point-to-point round-robins across consumers", async () => {
  const bus = new SedaBus();
  let a = 0;
  let b = 0;
  const done = deferred<void>();
  bus.channel("work", { capacity: 100 });
  bus.subscribe("work", () => {
    a++;
    check();
  });
  bus.subscribe("work", () => {
    b++;
    check();
  });
  function check() {
    if (a + b === 20) done.resolve();
  }

  for (let i = 0; i < 20; i++) {
    assert.equal(await bus.publish(makeEnvelope("work", i)), true);
  }
  await done.promise;
  await bus.shutdown();
  assert.equal(a, 10);
  assert.equal(b, 10);
});

test("pub/sub fans out to every consumer", async () => {
  const bus = new SedaBus();
  const seenA: number[] = [];
  const seenB: number[] = [];
  bus.channel("events", { capacity: 100, delivery: Delivery.PubSub });
  bus.subscribe("events", (e) => {
    seenA.push(e.content() as number);
  });
  bus.subscribe("events", (e) => {
    seenB.push(e.content() as number);
  });

  for (let i = 0; i < 5; i++) await bus.publish(makeEnvelope("events", i));
  await waitFor(() => seenA.length === 5 && seenB.length === 5);
  await bus.shutdown();
  assert.deepEqual([...seenA].sort(), [0, 1, 2, 3, 4]);
  assert.deepEqual([...seenB].sort(), [0, 1, 2, 3, 4]);
});

test("routing slip visits every stage in order", async () => {
  const bus = new SedaBus();
  const trail: string[] = [];
  for (const name of ["one", "two", "three"]) {
    bus.channel(name, { capacity: 50 });
    bus.subscribe(name, () => {
      trail.push(name);
    });
  }
  const done = deferred<Envelope>();
  await bus.publish(makeEnvelope("one", "x", { slip: ["two", "three"] }), {
    onComplete: (e) => done.resolve(e),
  });
  await done.promise;
  await bus.shutdown();
  assert.deepEqual(trail, ["one", "two", "three"]);
});

test("back-pressure Reject sheds when the queue is full", async () => {
  const bus = new SedaBus();
  const gate = deferred<void>();
  bus.channel("slow", {
    capacity: 2,
    concurrency: 1,
    backpressure: Backpressure.Reject,
  });
  bus.subscribe("slow", async () => {
    await gate.promise;
  });

  const results: boolean[] = [];
  for (let i = 0; i < 10; i++) results.push(await bus.publish(makeEnvelope("slow", i)));
  gate.resolve();

  assert.ok(results.filter(Boolean).length <= 3, `accepted ${results.filter(Boolean).length}`);
  assert.ok(results.filter((r) => !r).length >= 7);
  await bus.shutdown();
  assert.ok(bus.stats()["slow"]!.dropped >= 7);
});

test("back-pressure Block waits for room then resolves", async () => {
  const bus = new SedaBus();
  const gate = deferred<void>();
  bus.channel("bp", { capacity: 1, concurrency: 1, backpressure: Backpressure.Block });
  let handled = 0;
  bus.subscribe("bp", async () => {
    await gate.promise;
    handled++;
  });

  // 1 taken in-flight, 1 queued, this one must block until a slot frees.
  await bus.publish(makeEnvelope("bp", 0));
  await bus.publish(makeEnvelope("bp", 1));
  const blocked = bus.publish(makeEnvelope("bp", 2), { timeoutMs: 2_000 });
  gate.resolve();
  assert.equal(await blocked, true);
  await bus.shutdown();
  assert.equal(handled, 3);
});

test("nack retries up to maxAttempts then dead-letters", async () => {
  const bus = new SedaBus();
  let tries = 0;
  const dead = deferred<void>();
  bus.channel("flaky", { capacity: 10, maxAttempts: 3 });
  bus.channel("dead", { capacity: 10 });
  bus.setDeadLetterChannel("flaky", "dead");
  bus.subscribe("dead", () => dead.resolve());
  bus.subscribe("flaky", () => {
    tries++;
    return false;
  });

  await bus.publish(makeEnvelope("flaky", "boom"));
  await dead.promise;
  await bus.shutdown();
  assert.equal(tries, 3);
  assert.equal(bus.stats()["flaky"]!.deadLettered, 1);
});

test("shutdown drains queued work", async () => {
  const bus = new SedaBus();
  let done = 0;
  bus.channel("drain", { capacity: 200, concurrency: 4 });
  bus.subscribe("drain", async () => {
    await sleep(10);
    done++;
  });
  for (let i = 0; i < 50; i++) await bus.publish(makeEnvelope("drain", i));
  assert.equal(await bus.shutdown({ timeoutMs: 10_000 }), true);
  assert.equal(done, 50);
});

test("publish is rejected while paused, accepted after resume", async () => {
  const bus = new SedaBus();
  bus.channel("p", { capacity: 10 });
  const got = deferred<void>();
  bus.subscribe("p", () => got.resolve());
  bus.pause();
  assert.equal(await bus.publish(makeEnvelope("p", 1)), false);
  bus.resume();
  assert.equal(await bus.publish(makeEnvelope("p", 2)), true);
  await got.promise;
  await bus.shutdown();
});

test("unknown channel returns false", async () => {
  const bus = new SedaBus();
  assert.equal(await bus.publish(makeEnvelope("nope", 1)), false);
  await bus.shutdown();
});

test("per-stage concurrency limit is respected", async () => {
  const bus = new SedaBus();
  let active = 0;
  let peak = 0;
  bus.channel("limited", { capacity: 100, concurrency: 3 });
  bus.subscribe("limited", async () => {
    active++;
    peak = Math.max(peak, active);
    await sleep(15);
    active--;
  });
  for (let i = 0; i < 30; i++) await bus.publish(makeEnvelope("limited", i));
  await bus.shutdown({ timeoutMs: 10_000 });
  assert.equal(peak, 3);
});

test("a throwing consumer nacks instead of killing the scheduler", async () => {
  const bus = new SedaBus();
  const dead = deferred<void>();
  bus.channel("boom", { capacity: 10, maxAttempts: 2 });
  bus.channel("dlq", { capacity: 10 });
  bus.setDeadLetterChannel("boom", "dlq");
  bus.subscribe("dlq", () => dead.resolve());
  bus.subscribe("boom", () => {
    throw new Error("kaboom");
  });
  await bus.publish(makeEnvelope("boom", 1));
  await dead.promise;
  await bus.shutdown();
  assert.equal(bus.stats()["boom"]!.deadLettered, 1);
});

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) await sleep(5);
  if (!pred()) throw new Error("condition not met within timeout");
}
