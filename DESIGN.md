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
| "One thread pool drains every stage" | The **event loop** is the shared pool. |
| Per-stage worker allocation | A per-stage **concurrency limit**: max consumer invocations in flight for that stage. Optionally a bus-wide limit too. |
| Parallel CPU-bound stages | **Not in this version** — see *Roadmap: worker_threads*. |
| Adaptive controller (runtime re-tuning, auto load-shedding) | Not implemented (same as the other three). |

For **I/O-bound stages** — the overwhelming majority of Node work — the event
loop already gives concurrency via async. What the bus adds on top is
*structure and control*: named stages, explicit per-stage concurrency caps,
explicit back-pressure, routing slips, retry/dead-letter, and metrics. In that
sense it occupies the same space as `p-queue` / `bottleneck`, formalised into a
staged pipeline.

For **CPU-bound stages**, a synchronous consumer blocks the whole loop; the
queues simply back up while nothing else runs. Those belong in
`worker_threads` — see the roadmap.

## Core types

### `Envelope<T>`

The unit of work. `id` is stable across every hop. `slip` is a routing slip
(itinerary) held as a plain array and consumed **FIFO** — `slip: ["a","b","c"]`
visits `a → b → c` in order. (This differs from `seda-bus-java`, whose slip
comes from `ra.common` and is a LIFO stack.)

### `Consumer<T>`

```ts
type Consumer<T> = (env: Envelope<T>) => boolean | void | Promise<boolean | void>;
```

Return `false` to **nack** (retry, then dead-letter). `true` or `void` acks.
A thrown error or a rejected promise counts as a nack; it never breaks the
scheduler.

### `Channel`

A stage. Holds:

- a bounded FIFO `queue` (array)
- a list of pending `Block` publishers (`waiters`) — resolved in FIFO order as
  slots free up
- its `consumers`
- `inFlight` — how many drain turns are currently running for this stage
- `stats`

`Channel` is not exported; you interact with it through the bus.

## The scheduler

There is no thread pool. Scheduling is a function, `pump(channel)`:

```
while channel.depth > 0
   and channel.inFlight < channel.concurrency
   and bus.globalInFlight < bus.globalLimit:
       channel.inFlight++; bus.globalInFlight++
       drain(channel)          // async, not awaited
```

`pump` is called after every `publish` and at the end of every `drain`. Because
JS is single-threaded, the `inFlight` / `globalInFlight` counters need no locks.

`drain(channel)` pulls up to `BATCH` (32) envelopes, `await`ing each consumer,
then decrements the counters and calls `pump` again. Multiple `drain` turns for
the same stage run concurrently up to `concurrency`, each interleaved by the
event loop while its consumer is awaiting I/O.

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

## Delivery

- **PointToPoint**: round-robin across the channel's own consumers; one handles
  each envelope.
- **PubSub**: `Promise.all` over every consumer; ack only if all ack.

## Routing slips

On ack, `completeHop`:

1. if `slip` is non-empty: `env.to = slip.shift()`, reset `attempts`, re-publish
   (with a 5s `Block` timeout so an in-flight itinerary is not lost to a full
   downstream queue);
2. else: fire the `onComplete` callback registered at publish time.

## Retry & dead-letter

A nacked envelope with `attempts < maxAttempts` is `unshift`ed back to the head
of its queue. Once attempts are exhausted it is routed to the source channel's
dead-letter channel (if `setDeadLetterChannel` was called) and the `onComplete`
callback, if any, is dropped.

## Lifecycle

- Constructing a `SedaBus` starts it.
- `pause()` stops accepting `publish`es; in-flight work finishes.
- `resume()` re-enables publishing.
- `shutdown({ timeoutMs })` stops accepting, waits until every channel has
  `depth === 0 && inFlight === 0` (or the timeout), fails pending `Block`
  publishers, and resolves `true` if fully drained.
- `shutdownNow()` skips the drain.

## Metrics

Per channel: `depth`, `inFlight`, `enqueued`, `delivered`, `nacked`, `dropped`,
`deadLettered`. Plain counters — single-threaded, no synchronisation needed.
`bus.stats()` returns a snapshot. (SEDA's point is that you measure stages so you
*can* tune them; the adaptive tuner that would consume these is future work.)

## Packaging

- ESM only (`"type": "module"`), `NodeNext` resolution. Internal imports use the
  `.js` extension so the emitted JS resolves without a bundler.
- `tsc` emits `dist/` with `.js`, `.d.ts`, and source maps.
- Zero runtime dependencies. Dev-only: `typescript`, `tsx`, `@types/node`.
- Tests use the built-in `node:test` runner via `tsx`; no test framework
  dependency.

## Roadmap

### worker_threads transport (parallel CPU-bound stages)

The bus core is transport-agnostic in principle: `process()` calls the consumer
directly today (`InlineTransport`). A `WorkerTransport` would run a stage's
consumers in a pool of `Worker`s, passing envelopes by:

- **structured clone** (`postMessage`) — simple, serialization cost;
- **transferables** (`ArrayBuffer`, `MessagePort`) — move ownership, zero-copy;
- **`SharedArrayBuffer` + `Atomics`** — shared-memory queue with
  `Atomics.wait` / `Atomics.notify`, the closest analogue to the Rust/Java
  shared-thread design and to free-threaded Python.

This is the equivalent of the "adaptive controller" line in the other repos: the
part that would make the SEDA name fully earned, deferred until the core is
proven.

### Adaptive controller

Watch per-stage latency and queue depth, re-allocate the bus-wide concurrency
budget between stages, and shed load automatically past a high-water mark.
Not implemented in any of the four implementations.
