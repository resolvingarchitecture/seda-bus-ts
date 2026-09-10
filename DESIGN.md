# seda-bus-ts — Design

## Purpose

A small, broker-less, **staged** message bus, matching the design of the
companion implementations:

- [seda-bus](https://github.com/resolvingarchitecture/seda-bus) — Rust
- [seda-bus-java](https://github.com/resolvingarchitecture/seda-bus-java) — Java
- [seda-bus-python](https://github.com/resolvingarchitecture/seda-bus-python) — Python

Work is decomposed into **stages** (`Channel`s) connected by **bounded queues**.
Producers are decoupled from consumers by the queues. Each stage has a
concurrency limit so no stage can starve the others. Everything is in-process;
there is no broker.

## The Node concurrency model, and what it means here

Node runs JavaScript on a single thread (the event loop). libuv has a small
background thread pool, but it only serves specific built-ins (fs, dns, crypto,
zlib); it does not run your JS. So the constraint that matters is: **one thread
executes application code.**

That does *not* prevent a SEDA bus — it changes what the bus is *for*.

| SEDA element | In this implementation |
|---|---|
| Stages + queues | Kept as-is. Explicit pipeline structure. |
| Admission control (bounded queues) | Kept. `capacity` per channel. |
| Back-pressure / load shedding | Kept. `Block` / `Reject` / `DropNewest` / `DropOldest`. |
| "One thread pool drains every stage" | The **event loop** is the shared pool for inline stages; a **`Worker` pool** for worker stages. |
| Per-stage worker allocation | Inline: a concurrency limit (max invocations in flight). Worker: a fixed pool of `Worker` threads. Optionally a bus-wide limit too. |
| Parallel CPU-bound stages | **Supported** — set `worker` on the channel (see *Transports*). |
| Adaptive controller (runtime re-tuning, auto load-shedding) | Not implemented (same as the other three). |

For **I/O-bound stages** — the overwhelming majority of Node work — the event
loop already gives concurrency via async. What the bus adds on top is
*structure and control*: named stages, explicit per-stage concurrency caps,
explicit back-pressure, routing slips, retry/dead-letter, and metrics. In that
sense it occupies the same space as `p-queue` / `bottleneck`, formalised into a
staged pipeline.

For **CPU-bound stages**, a synchronous consumer would block the whole loop.
Configure the stage with `worker` and its handler runs across a pool of `Worker`
threads instead — see *Transports* below.

## Core types

### `Envelope`

The unit of work — `Envelope` from `@resolvingarchitecture/ra-common`, the same
wrapper `seda-bus-java` carries via `ra-common-java`. `id` is stable across every
hop. Routing is driven by the envelope's `DynamicRoutingSlip`: each hop targets
`route.service`, and the slip is a **LIFO** stack walked with `env.ratchet()`.
`makeEnvelope(to, payload, { slip })` builds one so `nextRoute()` yields `to`,
then `slip[0]`, `slip[1]`, … ; `targetService(env)` reads the current target; the
payload is the document `CONTENT` value.

### `Consumer`

```ts
type Consumer = (env: Envelope) => boolean | void | Promise<boolean | void>;
```

Return `false` to **nack** (retry, then dead-letter). `true` or `void` acks.
A thrown error or a rejected promise counts as a nack; it never breaks the
scheduler.

### `Channel`

A stage. Holds:

- a bounded FIFO `queue` (array)
- a list of pending `Block` publishers (`waiters`) — resolved in FIFO order as
  slots free up
- a `transport` (see *Transports*) — `InlineTransport` by default, or
  `WorkerTransport` when `worker` is configured
- `inFlight` — how many drain turns are currently running for this stage
- `stats`

`Channel` is not exported; you interact with it through the bus.

## The scheduler

Inline stages have no thread pool. Scheduling is a function, `pump(channel)`:

```
while channel.depth > 0
   and channel.inFlight < channel.concurrency
   and bus.globalInFlight < bus.globalLimit:
       channel.inFlight++; bus.globalInFlight++
       drain(channel)          // async, not awaited
```

`pump` is called after every `publish` and at the end of every `drain`. Because
JS is single-threaded, the `inFlight` / `globalInFlight` counters need no locks.

`drain(channel)` pulls up to `BATCH` (32) envelopes, `await`ing
`transport.invoke` for each, then decrements the counters and calls `pump`
again. Multiple `drain` turns for the same stage run concurrently up to
`concurrency`, each interleaved by the event loop while it awaits (a consumer's
I/O, or a worker round-trip). For a worker stage, `concurrency` == pool size, so
each in-flight `drain` turn maps to one busy `Worker`.

### Why a batch

Without a batch, every envelope costs a fresh `pump` + microtask hop. With one,
a drain turn processes a run of envelopes before yielding. The cap keeps one
busy stage from monopolising a `drain` turn indefinitely.

## Back-pressure

`publish` returns `Promise<boolean>` — `true` if the envelope was accepted.

- **Reject / DropNewest**: full queue → resolves `false` immediately.
- **DropOldest**: evicts the head, enqueues the new one, resolves `true`.
- **Block**: the promise stays pending. The publisher is parked in the channel's
  `waiters` list with its envelope. When `poll()` frees a slot, the oldest waiter
  is enqueued and its promise resolves `true`. `timeoutMs` and an `AbortSignal`
  can end the wait early (resolving `false`).

On `shutdown`, all pending `Block` publishers resolve `false`.

## Transports

A stage's actual work runs through a `StageTransport`:

```ts
interface StageTransport {
  invoke(env: Envelope): Promise<boolean>;  // process one; may mutate env in place
  readonly ready: boolean;
  addConsumer(consumer: Consumer): void;
  close(): Promise<void>;
}
```

`process()` in the bus is transport-agnostic — it does `env.attempts++`, `await
ch.transport.invoke(env)`, then the retry / dead-letter logic. Only *how a stage
runs* differs.

### `InlineTransport` (default)

Consumers are functions on the event loop. Holds the `consumers` list and does
the delivery:

- **PointToPoint**: round-robin across consumers; one handles each envelope.
- **PubSub**: `Promise.all` over every consumer; ack only if all ack.

`invoke` awaits the consumer and catches throws / rejections as a nack.

### `WorkerTransport` (`worker` option)

The stage handler is a **module** (not a closure — closures can't cross a thread
boundary), run across a fixed pool of `Worker` threads.

- **`WorkerPool`** spawns N workers of `worker/harness.ts`, each given
  `{ module, export }` via `workerData`. It keeps a free-list and an acquire
  queue; `invoke()` grabs a free worker, `postMessage`s `{ seq, envelope }`,
  awaits the reply, releases the worker. A worker that errors or exits non-zero
  is terminated and replaced (its in-flight envelope resolves as a nack).
- **`worker/harness.ts`** runs inside each thread: `import()`s the module once,
  then for every request rehydrates the envelope (`Envelope.fromJSON`), calls the
  handler, and posts back `{ seq, ok, envelope: env.toJSON() }`.
- The envelope crosses as **JSON** (`env.toJSON()` — a plain, structured-clone-safe
  object). It is returned in the reply, and `WorkerTransport` rehydrates it and
  `Object.assign`s the data props back onto the main-thread envelope — so worker
  stages compose in routing slips. Per-hop `attempts` stay on the channel,
  main-thread-controlled.
- The queue, waiters, back-pressure, retry, and metrics all stay on the main
  thread. Only the handler call is off-thread.
- `addConsumer` throws. `pub/sub` + `worker` throws at channel registration.
- The channel's `concurrency` becomes the pool size (`worker.pool` wins if set).
  There is always a free worker because concurrent `drain` turns ≤ pool size.

The harness URL is resolved as `./harness.ts` when running from source (tsx /
ts-node) and `./harness.js` from the built package, keyed off `import.meta.url`.
User modules are resolved: `URL` as-is, bare specifier passed through, path
made absolute against `process.cwd()` then `pathToFileURL`.

## Routing slips

On ack, `completeHop`:

1. if `dynamicRoutingSlip.peekAtNextRoute()` is set: `env.ratchet()` and
   re-publish (with a 5s `Block` timeout so an in-flight itinerary is not lost to
   a full downstream queue);
2. else: fire the `onComplete` callback registered at publish time.

## Retry & dead-letter

Per-hop delivery attempts live on the `Channel` (a `Map` keyed by envelope id,
mirroring `SEDAMessageChannel.attempts` in `seda-bus-java`). A nacked envelope
with `attempt < maxAttempts` is `unshift`ed back to the head of its queue. Once
attempts are exhausted its count is cleared, it is routed to the source channel's
dead-letter channel (if `setDeadLetterChannel` was called), and the `onComplete`
callback, if any, is dropped.

## Lifecycle

- Constructing a `SedaBus` starts it.
- `pause()` stops accepting `publish`es; in-flight work finishes.
- `resume()` re-enables publishing.
- `shutdown({ timeoutMs })` stops accepting, waits until every channel has
  `depth === 0 && inFlight === 0` (or the timeout), fails pending `Block`
  publishers, closes every transport (terminating Worker pools), and resolves
  `true` if fully drained.
- `shutdownNow()` skips the drain (still closes transports).

## Metrics

Per channel: `depth`, `inFlight`, `enqueued`, `delivered`, `nacked`, `dropped`,
`deadLettered`. Plain counters — single-threaded, no synchronisation needed.
`bus.stats()` returns a snapshot. (SEDA's point is that you measure stages so you
*can* tune them; the adaptive tuner that would consume these is future work.)

## Packaging

- ESM only (`"type": "module"`), `NodeNext` resolution. Internal imports use the
  `.js` extension so the emitted JS resolves without a bundler.
- `tsc` emits `dist/` with `.js`, `.d.ts`, and source maps. `dist/worker/` holds
  the harness the `Worker` pool loads.
- Zero runtime dependencies. Dev-only: `typescript`, `tsx`, `@types/node`.
- Tests use the built-in `node:test` runner via `tsx`; no test framework
  dependency. `tsx` also lets `Worker` load `.ts` handler modules in dev.

## Roadmap

### Zero-copy / shared-memory worker transport

`WorkerTransport` uses structured clone today. For large or high-rate payloads:

- **transferables** (`ArrayBuffer`, `MessagePort`) — move ownership, no copy;
- **`SharedArrayBuffer` + `Atomics`** — a shared-memory ring buffer with
  `Atomics.wait` / `Atomics.notify`, the closest analogue to the Rust/Java
  shared-thread design and to free-threaded Python.

### Adaptive controller

Watch per-stage latency and queue depth, re-allocate the bus-wide concurrency
budget between stages, and shed load automatically past a high-water mark.
Not implemented in any of the four implementations.
