import type { Envelope } from "./envelope.js";

/** Return `false` to nack (retry, then dead-letter). `true`/`void` acks. */
export type Consumer<T = unknown> = (
  env: Envelope<T>,
) => boolean | void | Promise<boolean | void>;

export enum Delivery {
  /** One consumer handles each envelope (round-robin across consumers). */
  PointToPoint = "p2p",
  /** Every consumer handles every envelope. */
  PubSub = "pubsub",
}

export enum Backpressure {
  /** `publish` stays pending until there is room (or its timeout elapses). */
  Block = "block",
  /** `publish` resolves `false` immediately when the queue is full. */
  Reject = "reject",
  /** Silently discard the envelope being offered. */
  DropNewest = "drop-newest",
  /** Evict the oldest queued envelope to make room. */
  DropOldest = "drop-oldest",
}

/** Run a stage's work across a pool of Worker threads instead of the event loop. */
export interface WorkerOptions {
  /**
   * Module exporting the stage handler `(env) => boolean | void | Promise<...>`.
   * Pass a `URL` (`new URL("./stage.js", import.meta.url)`), an absolute path,
   * or a bare package specifier. Relative strings resolve against `process.cwd()`.
   */
  module: string | URL;
  /** Named export to use as the handler. Default `"default"`. */
  export?: string;
  /** Number of Worker threads. Default: the channel's `concurrency`. */
  pool?: number;
}

export interface ChannelOptions {
  /** Max queued envelopes before back-pressure applies. Default 1024. */
  capacity?: number;
  /** Max invocations in flight for this stage. Default 1. */
  concurrency?: number;
  /** Point-to-point (default) or pub/sub fan-out. Ignored for worker stages. */
  delivery?: Delivery;
  /** What to do when the queue is full. Default `Block`. */
  backpressure?: Backpressure;
  /** Delivery attempts before an envelope is dead-lettered. Default 1. */
  maxAttempts?: number;
  /** Run this stage's handler in Worker threads. See {@link WorkerOptions}. */
  worker?: WorkerOptions;
}

export interface PublishOptions {
  /** For `Block` back-pressure: give up waiting for room after this long. */
  timeoutMs?: number;
  /** Abort a pending `Block` publish. */
  signal?: AbortSignal;
  /** Invoked once the envelope finishes its whole itinerary. */
  onComplete?: (env: Envelope) => void;
}

export interface ChannelStats {
  depth: number;
  inFlight: number;
  enqueued: number;
  delivered: number;
  nacked: number;
  dropped: number;
  deadLettered: number;
}
