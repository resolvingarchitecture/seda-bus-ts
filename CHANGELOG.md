# Changelog

## 0.2.0 — unreleased

- **The bus now carries `Envelope` from `@resolvingarchitecture/ra-common`**
  instead of a bespoke minimal envelope, matching `seda-bus-java` (which depends
  on `ra-common-java`).
  - New dependency: `@resolvingarchitecture/ra-common`.
  - Routing follows the envelope's `DynamicRoutingSlip` (LIFO, keyed by
    `route.service`) rather than a `slip: string[]` of channel names.
  - `makeEnvelope(to, payload, { slip })` and `targetService(env)` replace the
    old `envelope()` / `advance()` helpers; the payload is the document
    `CONTENT` value (`env.content()` / `env.addContent()`).
  - Per-hop retry counts moved from `env.attempts` onto the channel (a `Map`
    keyed by envelope id), mirroring `SEDAMessageChannel.attempts`.
  - Worker stages exchange the envelope as JSON (`toJSON` / `fromJSON`) across the
    thread boundary; the harness rehydrates it to a real `Envelope` before
    calling the handler.
  - `Consumer` is no longer generic.
- Public API otherwise unchanged: `SedaBus`, `Delivery`, `Backpressure`, and the
  `channel` / `subscribe` / `publish` / `stats` / `setDeadLetterChannel` methods.

## 0.1.0

Initial release — static-configuration SEDA core (stages, bounded queues, the
event loop as the shared worker pool, per-stage concurrency, back-pressure,
routing slips, retry/dead-letter, optional Worker-thread stages).
