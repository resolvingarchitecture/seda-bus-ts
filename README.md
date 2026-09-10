<div align="center">
  <h1>seda-bus (TypeScript)</h1>
  <p><strong>Resolving Architecture &mdash; Clarity in Design</strong></p>
  <p>A small, broker-less, <strong>staged</strong> message bus for Node.</p>
</div>

Work is decomposed into stages (`Channel`s) connected by bounded queues.
There are no threads &mdash; the event loop is the shared worker pool, and each
stage has its own concurrency limit (how many consumer invocations it may have
in flight). The only runtime dependency is
[`@resolvingarchitecture/ra-common`](https://github.com/resolvingarchitecture/ra-common-ts),
whose `Envelope` the bus carries (as `seda-bus-java` does via `ra-common-java`).

```ts
import { SedaBus, makeEnvelope, Delivery } from "@resolvingarchitecture/seda-bus";

const bus = new SedaBus();

bus.channel("ingest",    { capacity: 1000 });
bus.channel("transform", { capacity: 1000, concurrency: 4 });
bus.channel("sink",      { capacity: 1000 });

bus.subscribe("ingest",    (e) => { e.headers["receivedAt"] = String(Date.now()); });
bus.subscribe("transform", (e) => { e.addContent((e.content() as string).toUpperCase()); });
bus.subscribe("sink",      (e) => { console.log(e.content()); });

await bus.publish(
  makeEnvelope("ingest", "hello", { slip: ["transform", "sink"] }),
  { onComplete: (e) => console.log("done", e.id) },
);

await bus.shutdown();
```

Routing follows the envelope's `DynamicRoutingSlip` (LIFO, keyed by
`route.service`). `makeEnvelope(to, payload, { slip })` keeps the ergonomic shape;
`targetService(env)` is the channel an envelope is currently headed for; the
payload is the document `CONTENT` value (`env.content()` / `env.addContent()`).

## Why a bus if Node is single-threaded?

The single JS thread doesn't prevent a staged bus &mdash; it changes what the
bus is *for*. You get: explicit pipeline stages, **bounded queues** (admission
control), **back-pressure** (`Block` / `Reject` / `DropNewest` / `DropOldest`),
**per-stage concurrency limits** (e.g. "at most 10 concurrent DB calls in this
stage"), routing slips, retry &rarr; dead-letter, and metrics. For I/O-bound
stages &mdash; most Node work &mdash; the event loop already gives concurrency;
the bus adds structure and control on top.

For **CPU-bound stages**, configure the stage to run in `worker_threads` (below)
and it parallelises across cores. See [DESIGN.md](./DESIGN.md).

## Worker-backed stages

A stage whose handler lives in its own module can run across a pool of Worker
threads instead of on the event loop:

```ts
// stages/hash.ts  — the handler, loaded by each worker
import { createHash } from "node:crypto";
import type { Envelope } from "@resolvingarchitecture/ra-common";

export default function hash(env: Envelope) {
  const { data, rounds } = env.content() as { data: string; rounds: number };
  let acc = Buffer.from(data);
  for (let i = 0; i < rounds; i++) acc = createHash("sha256").update(acc).digest();
  env.headers["digest"] = acc.toString("hex");   // mutations flow back to the caller
}
```

```ts
bus.channel("hash", {
  capacity: 1000,
  worker: {
    module: new URL("./stages/hash.js", import.meta.url), // URL, abs path, or specifier
    pool: 8,            // Worker threads (default: the channel's concurrency)
    export: "default",  // named export to use as the handler
  },
});
```

Notes:

- The handler is a **module**, not a closure &mdash; `subscribe()` on a worker
  channel throws. The envelope crosses as JSON (`env.toJSON()` / `Envelope.fromJSON`),
  so its `CONTENT` payload must be JSON-serialisable.
- Envelope mutations (content, `headers`, routing slip) made in the worker
  propagate back, so worker stages compose in routing slips.
- A handler that returns `false` / throws nacks &rarr; retried, then
  dead-lettered, like any stage.
- `pub/sub` delivery is not supported for worker stages (one handler module).
- `example:parallel` shows the speedup (`fib(38)` &times; 12, pool 1 vs N).

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
| `delivery` | `PointToPoint` | or `PubSub` (fan-out); not allowed with `worker` |
| `backpressure` | `Block` | or `Reject` / `DropNewest` / `DropOldest` |
| `maxAttempts` | `1` | delivery attempts before dead-lettering |
| `worker` | &mdash; | `{ module, pool?, export? }` &mdash; run the handler in Worker threads |

### `bus.subscribe<T>(name, consumer)`

`consumer: (env: Envelope) => boolean | void | Promise<boolean | void>`.
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
npm test               # node:test via tsx  (16 cases)
npm run example        # 3-stage inline pipeline
npm run example:parallel   # worker_threads CPU stage, pool 1 vs N
npm run build          # -> dist/ (js + d.ts)
```

## Status

`0.1.0` &mdash; working core incl. `worker_threads` stages, tested (16 cases).
Not published to npm yet.

## Reference

Welsh, Culler, Brewer. *SEDA: An Architecture for Well-Conditioned, Scalable
Internet Services.* SOSP 2001.
