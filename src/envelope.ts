/**
 * Envelope helpers.
 *
 * The bus carries {@link Envelope} from `@resolvingarchitecture/ra-common` — the
 * same wrapper `seda-bus-java` uses via `ra-common-java`. Routing is driven by
 * the envelope's `DynamicRoutingSlip`: each hop targets `route.service`; the
 * slip is walked one hop at a time with `env.ratchet()`.
 *
 * {@link makeEnvelope} keeps the ergonomic `to` / `payload` / `slip` shape from
 * earlier seda-bus versions on top of the richer ra-common type.
 */
import { Envelope } from "@resolvingarchitecture/ra-common";

export { Envelope };

/** seda-bus routes by service, not operation; ra-common still wants a value. */
const OP = "RECEIVE";

export interface EnvelopeInit {
  sender?: string;
  headers?: Record<string, unknown>;
  /** Channels to visit after `to`, in order. */
  slip?: string[];
}

/** Build a document envelope addressed to `to`, then visiting each `slip` name. */
export function makeEnvelope(to: string, payload?: unknown, init: EnvelopeInit = {}): Envelope {
  const e = Envelope.document();
  // ra-common slips are LIFO: push the itinerary tail-first, then `to` last, so
  // `nextRoute()` yields `to`, then slip[0], slip[1], ...
  for (const name of [...(init.slip ?? [])].reverse()) e.addRoute(name, OP);
  e.addRoute(to, OP);
  if (payload !== undefined) e.addContent(payload);
  if (init.sender !== undefined) e.client = init.sender;
  if (init.headers) Object.assign(e.headers, init.headers);
  return e;
}

/** The channel name the envelope is currently headed for. */
export function targetService(env: Envelope): string | undefined {
  return env.getRoute()?.service;
}

/** The document `CONTENT` value (what {@link makeEnvelope} stored). */
export function envelopePayload(env: Envelope): unknown {
  return env.content();
}
