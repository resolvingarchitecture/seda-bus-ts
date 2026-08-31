/** The unit of work that moves through the bus. */
export interface Envelope<T = unknown> {
  /** Unique id, stable across every hop of the itinerary. */
  id: string;
  /** The channel this envelope is currently headed for. */
  to: string;
  /** Optional originator. */
  sender?: string;
  /** Free-form string headers. */
  headers: Record<string, string>;
  /** The message body. */
  payload: T;
  /**
   * Routing slip: channels to visit after the current one, in order (FIFO).
   * Each consumed hop is shifted off; when empty the itinerary is complete.
   */
  slip: string[];
  /** Delivery attempts on the current hop (used for retry / dead-lettering). */
  attempts: number;
}

export interface EnvelopeInit<T> {
  sender?: string;
  headers?: Record<string, string>;
  /** Channels to visit after `to`, in order. */
  slip?: string[];
}

/** Create an envelope addressed to `to`. */
export function envelope<T>(
  to: string,
  payload: T,
  init: EnvelopeInit<T> = {},
): Envelope<T> {
  return {
    id: crypto.randomUUID(),
    to,
    sender: init.sender,
    headers: { ...(init.headers ?? {}) },
    payload,
    slip: [...(init.slip ?? [])],
    attempts: 0,
  };
}

/** Advance to the next hop. Returns true if there was one. */
export function advance(env: Envelope): boolean {
  const next = env.slip.shift();
  if (next === undefined) return false;
  env.to = next;
  env.attempts = 0;
  return true;
}
