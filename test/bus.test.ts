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

test("back-pressure DropNewest sheds the incoming envelope like Reject", async () => {
  const bus = new SedaBus();
  const gate = deferred<void>();
  bus.channel("dn", { capacity: 2, concurrency: 1, backpressure: Backpressure.DropNewest });
  bus.subscribe("dn", async () => {
    await gate.promise;
  });

  const results: boolean[] = [];
  for (let i = 0; i < 10; i++) results.push(await bus.publish(makeEnvelope("dn", i)));
  gate.resolve();

  assert.ok(results.filter(Boolean).length <= 3, `accepted ${results.filter(Boolean).length}`);
  await bus.shutdown();
  assert.ok(bus.stats()["dn"]!.dropped >= 7);
});

test("back-pressure DropOldest always admits by evicting the oldest queued envelope", async () => {
  const bus = new SedaBus();
  const gate = deferred<void>();
  const delivered: number[] = [];
  bus.channel("do", { capacity: 2, concurrency: 1, backpressure: Backpressure.DropOldest });
  bus.subscribe("do", async (e) => {
    if (delivered.length === 0) await gate.promise; // hold the one in-flight slot open
    delivered.push(e.content() as number);
  });

  const results: boolean[] = [];
  for (let i = 0; i < 10; i++) results.push(await bus.publish(makeEnvelope("do", i)));
  assert.ok(results.every(Boolean), "DropOldest must never refuse admission");
  gate.resolve();
  await bus.shutdown({ timeoutMs: 10_000 });

  // Only the in-flight envelope plus whatever survived eviction in the
  // 2-slot queue ever gets delivered - proves eviction actually happened
  // rather than the queue silently growing past capacity.
  assert.ok(delivered.length < 10, `expected some eviction, delivered ${delivered.length}`);
  assert.ok(bus.stats()["do"]!.dropped > 0);
});

test("a nack that succeeds on its final allowed attempt is delivered exactly once", async () => {
  const bus = new SedaBus();
  let tries = 0;
  const done = deferred<void>();
  bus.channel("almost", { capacity: 10, maxAttempts: 3 });
  bus.subscribe("almost", () => {
    tries++;
    if (tries < 3) return false;
    done.resolve();
    return true;
  });

  await bus.publish(makeEnvelope("almost", "x"));
  await done.promise;
  await bus.shutdown();
  assert.equal(tries, 3);
  assert.equal(bus.stats()["almost"]!.delivered, 1);
  assert.equal(bus.stats()["almost"]!.nacked, 2);
  assert.equal(bus.stats()["almost"]!.deadLettered, 0);
});

test("a channel with no consumers dead-letters (default maxAttempts=1: on the first attempt)", async () => {
  const bus = new SedaBus();
  const dead = deferred<void>();
  bus.channel("orphan", { capacity: 10 });
  bus.channel("dlq2", { capacity: 10 });
  bus.setDeadLetterChannel("orphan", "dlq2");
  bus.subscribe("dlq2", () => dead.resolve());

  await bus.publish(makeEnvelope("orphan", 1));
  await dead.promise;
  await bus.shutdown();
  assert.equal(bus.stats()["orphan"]!.deadLettered, 1);
});

test("shutdown accounting: every published envelope is delivered or dead-lettered when fully drained", async () => {
  const bus = new SedaBus();
  const total = 20;
  bus.channel("acct", { capacity: 100, concurrency: 4, maxAttempts: 1 });
  bus.subscribe("acct", async () => {
    await sleep(30);
    return true;
  });
  for (let i = 0; i < total; i++) {
    assert.equal(await bus.publish(makeEnvelope("acct", i)), true);
  }

  const drained = await bus.shutdown({ timeoutMs: 10_000 });
  const s = bus.stats()["acct"]!;
  assert.equal(drained, true);
  assert.equal(s.delivered + s.deadLettered, total);
  assert.equal(s.depth, 0);
  assert.equal(s.inFlight, 0);
});

test("shutdown accounting still holds when the timeout elapses before draining", async () => {
  const bus = new SedaBus();
  const total = 20;
  bus.channel("acct2", { capacity: 100, concurrency: 4, maxAttempts: 1 });
  bus.subscribe("acct2", async () => {
    await sleep(200); // deliberately slower than the shutdown timeout below
    return true;
  });
  for (let i = 0; i < total; i++) {
    assert.equal(await bus.publish(makeEnvelope("acct2", i)), true);
  }

  const drained = await bus.shutdown({ timeoutMs: 50 });
  const s = bus.stats()["acct2"]!;
  assert.equal(drained, false, "expected the short timeout to elapse before draining");
  // Every published envelope is accounted for exactly once - finished
  // (delivered/dead-lettered) or still visible as queued/in-flight - never
  // silently lost, and never double-counted, even when shutdown times out.
  assert.equal(s.delivered + s.deadLettered + s.depth + s.inFlight, total);
});

test("channel construction clamps non-positive capacity/concurrency to 1 instead of misbehaving", async () => {
  const bus = new SedaBus();
  const started = deferred<void>();
  const gate = deferred<void>();
  bus.channel("zero", { capacity: 0, concurrency: 0 });
  bus.subscribe("zero", async () => {
    started.resolve();
    await gate.promise;
  });

  // capacity clamped to >= 1: a fresh channel must accept at least one publish.
  assert.equal(await bus.publish(makeEnvelope("zero", 1)), true);
  // concurrency clamped to >= 1: the sole worker slot must actually run it.
  await started.promise;
  gate.resolve();
  await bus.shutdown();
});

test("repeated create/shutdown cycles do not leak active handles", async () => {
  const activeHandles = (): number =>
    (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length;

  // Warm up once outside the measured loop - a first run can lazily
  // initialise globals that aren't part of what we're checking for growth.
  {
    const bus = new SedaBus();
    bus.channel("warmup", { capacity: 10 });
    bus.subscribe("warmup", () => true);
    await bus.publish(makeEnvelope("warmup", 0));
    await bus.shutdown();
  }

  const before = activeHandles();
  for (let i = 0; i < 25; i++) {
    const bus = new SedaBus();
    bus.channel("cycle", { capacity: 10 });
    bus.subscribe("cycle", () => true);
    await bus.publish(makeEnvelope("cycle", i));
    await bus.shutdown();
  }
  const after = activeHandles();

  // process._getActiveHandles() is an internal, undocumented Node API - the
  // only practical way to observe "did this leave a timer/socket/etc.
  // registered with the event loop" from user code. Used deliberately here
  // as the nearest single-threaded-event-loop equivalent of a thread-count
  // check in a threaded port (see CORRECTNESS_SUITE.md's C6).
  assert.ok(
    after <= before + 2,
    `active handles grew from ${before} to ${after} over 25 create/shutdown cycles`,
  );
});

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred() && Date.now() < deadline) await sleep(5);
  if (!pred()) throw new Error("condition not met within timeout");
}
