<div align="center">
  <h1>seda-bus (TypeScript)</h1>
  <p><strong>Resolving Architecture &mdash; Clarity in Design</strong></p>
  <p>A small, broker-less, <strong>staged</strong> message bus for Node.</p>
</div>

Work is decomposed into stages (`Channel`s) connected by bounded queues.
There are no threads &mdash; the event loop is the shared worker pool, and each
stage has its own concurrency limit (how many consumer invocations it may have
in flight). Zero runtime dependencies.

```ts
import { SedaBus, envelope, Delivery } from "@resolvingarchitecture/seda-bus";

const bus = new SedaBus();

bus.channel("ingest",    { capacity: 1000 });
bus.channel("transform", { capacity: 1000, concurrency: 4 });
bus.channel("sink",      { capacity: 1000 });

bus.subscribe<string>("ingest",    (e) => { e.headers.receivedAt = String(Date.now()); });
bus.subscribe<string>("transform", (e) => { e.payload = e.payload.toUpperCase(); });
bus.subscribe<string>("sink",      (e) => { console.log(e.payload); });

await bus.publish(
  envelope("ingest", "hello", { slip: ["transform", "sink"] }),
  { onComplete: (e) => console.log("done", e.id) },
);

await bus.shutdown();
```

## Why a bus if Node is single-threaded?

The single JS thread doesn't prevent a staged bus &mdash; it changes what the
bus is *for*. You still get: explicit pipeline stages, **bounded queues**
(admission control), **back-pressure** (`Block` / `Reject` / `DropNewest` /
`DropOldest`), **per-stage concurrency limits** (e.g. "at most 10 concurrent DB
calls in this stage"), routing slips, retry &rarr; dead-letter, and metrics.

You don't get parallel CPU-bound stages &mdash; a synchronous consumer blocks
the loop and the queues just back up. Those belong in `worker_threads`, which is
on the roadmap. For I/O-bound stages (most Node work) the event loop already
gives concurrency; the bus adds structure and control on top. See
[DESIGN.md](./DESIGN.md).

## API

### `new SedaBus(options?)`

| option | default | meaning |
|---|---|---|
| `concurrency` | unbounded | cap on total in-flight consumer invocations across all stages |

Constructing the bus starts it.

### `bus.channel(name, options?)`

| option | default | meaning |
|---|---|---|
| `capacity` | `1024` | max queued envelopes before back-pressure applies |
| `concurrency` | `1` | max consumer invocations in flight for this stage |
| `delivery` | `PointToPoint` | or `PubSub` (fan-out) |
| `backpressure` | `Block` | or `Reject` / `DropNewest` / `DropOldest` |
| `maxAttempts` | `1` | delivery attempts before dead-lettering |

### `bus.subscribe<T>(name, consumer)`

`consumer: (env: Envelope<T>) => boolean | void | Promise<boolean | void>`.
Return `false` to nack (retry, then dead-letter). A thrown error / rejected
promise also nacks &mdash; it never breaks the scheduler.

### `bus.publish(env, options?) => Promise<boolean>`

Resolves `true` if the envelope was accepted. `options`: `timeoutMs` and
`signal` bound a `Block` wait; `onComplete(env)` fires when the envelope
finishes its whole routing slip.

### `bus.setDeadLetterChannel(source, dlq)`

Route exhausted envelopes from `source` to channel `dlq`.

### Lifecycle & introspection

`bus.pause()` / `bus.resume()` &middot; `await bus.shutdown({ timeoutMs })`
(drains, then stops) &middot; `bus.shutdownNow()` &middot; `bus.stats()`
(per-channel `depth`, `inFlight`, `enqueued`, `delivered`, `nacked`, `dropped`,
`deadLettered`).

## Companion implementations

Same design, other languages:

| repo | notes |
|---|---|
| [seda-bus](https://github.com/resolvingarchitecture/seda-bus) | Rust, zero-dependency, real shared thread pool |
| [seda-bus-java](https://github.com/resolvingarchitecture/seda-bus-java) | Java, with optional guaranteed-delivery persistence |
| [seda-bus-python](https://github.com/resolvingarchitecture/seda-bus-python) | Python, built to exercise free-threaded (PEP 703) CPython |

## Develop

```sh
npm install
npm test          # node:test via tsx
npm run example
npm run build     # -> dist/ (js + d.ts)
```

## Status

`0.1.0` &mdash; working core, tested (11 cases). Not published to npm yet.

## Reference

Welsh, Culler, Brewer. *SEDA: An Architecture for Well-Conditioned, Scalable
Internet Services.* SOSP 2001.
