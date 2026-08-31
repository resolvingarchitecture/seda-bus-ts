/**
 * A small, broker-less, staged message bus.
 *
 * Work is decomposed into stages ({@link Channel}s) connected by bounded queues.
 * There are no threads: the event loop is the shared worker pool, and each stage
 * has its own concurrency limit (how many consumer invocations it may have in
 * flight at once). An optional bus-wide limit caps total in-flight work.
 *
 * What this is not: SEDA's original design also included a controller that
 * watched per-stage latency and queue depth at runtime and re-tuned resources
 * and shed load automatically. That adaptive controller is future work, as is a
 * worker_threads transport for parallel CPU-bound stages (see DESIGN.md).
 */
import { advance, type Envelope } from "./envelope.js";

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

export interface ChannelOptions {
  /** Max queued envelopes before back-pressure applies. Default 1024. */
  capacity?: number;
  /** Max consumer invocations in flight for this stage. Default 1. */
  concurrency?: number;
  /** Point-to-point (default) or pub/sub fan-out. */
  delivery?: Delivery;
  /** What to do when the queue is full. Default `Block`. */
  backpressure?: Backpressure;
  /** Delivery attempts before an envelope is dead-lettered. Default 1. */
  maxAttempts?: number;
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

interface Waiter {
  resolve: (ok: boolean) => void;
  timer?: NodeJS.Timeout;
  onAbort?: () => void;
  signal?: AbortSignal;
}

/** Envelopes one drain turn handles before yielding back to the scheduler. */
const BATCH = 32;

class Channel {
  readonly name: string;
  readonly capacity: number;
  readonly concurrency: number;
  readonly delivery: Delivery;
  readonly backpressure: Backpressure;
  readonly maxAttempts: number;

  private readonly queue: Envelope[] = [];
  private readonly waiters: Waiter[] = [];
  readonly consumers: Consumer[] = [];
  private rr = 0;
  inFlight = 0;

  readonly stats: ChannelStats = {
    depth: 0,
    inFlight: 0,
    enqueued: 0,
    delivered: 0,
    nacked: 0,
    dropped: 0,
    deadLettered: 0,
  };

  constructor(name: string, opts: ChannelOptions) {
    this.name = name;
    this.capacity = Math.max(1, opts.capacity ?? 1024);
    this.concurrency = Math.max(1, opts.concurrency ?? 1);
    this.delivery = opts.delivery ?? Delivery.PointToPoint;
    this.backpressure = opts.backpressure ?? Backpressure.Block;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 1);
  }

  get depth(): number {
    return this.queue.length;
  }

  nextConsumer(): Consumer | undefined {
    if (this.consumers.length === 0) return undefined;
    const c = this.consumers[this.rr % this.consumers.length];
    this.rr = (this.rr + 1) % this.consumers.length;
    return c;
  }

  /** Offer an envelope. Resolves true if queued, false if shed. */
  offer(env: Envelope, opts: PublishOptions): Promise<boolean> {
    if (this.queue.length < this.capacity) {
      this.enqueue(env);
      return Promise.resolve(true);
    }
    switch (this.backpressure) {
      case Backpressure.Reject:
      case Backpressure.DropNewest:
        this.stats.dropped++;
        return Promise.resolve(false);
      case Backpressure.DropOldest:
        this.queue.shift();
        this.stats.dropped++;
        this.enqueue(env);
        return Promise.resolve(true);
      case Backpressure.Block:
        return this.block(env, opts);
    }
  }

  private block(env: Envelope, opts: PublishOptions): Promise<boolean> {
    if (opts.signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = { resolve };
      if (opts.timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          this.removeWaiter(waiter);
          this.stats.dropped++;
          resolve(false);
        }, opts.timeoutMs);
      }
      if (opts.signal) {
        waiter.signal = opts.signal;
        waiter.onAbort = () => {
          this.removeWaiter(waiter);
          if (waiter.timer) clearTimeout(waiter.timer);
          this.stats.dropped++;
          resolve(false);
        };
        opts.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      // Attach the pending envelope so a freed slot can take it.
      (waiter as Waiter & { env: Envelope }).env = env;
      this.waiters.push(waiter);
    });
  }

  private enqueue(env: Envelope): void {
    this.queue.push(env);
    this.stats.enqueued++;
  }

  private removeWaiter(w: Waiter): void {
    const i = this.waiters.indexOf(w);
    if (i >= 0) this.waiters.splice(i, 1);
  }

  poll(): Envelope | undefined {
    const env = this.queue.shift();
    if (env !== undefined) this.wakeOneWaiter();
    return env;
  }

  requeue(env: Envelope): void {
    this.queue.unshift(env);
  }

  private wakeOneWaiter(): void {
    while (this.queue.length < this.capacity && this.waiters.length > 0) {
      const w = this.waiters.shift() as Waiter & { env: Envelope };
      if (w.timer) clearTimeout(w.timer);
      if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
      this.enqueue(w.env);
      w.resolve(true);
    }
  }

  /** Fail every pending Block publish (used on shutdown). */
  rejectWaiters(): void {
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      if (w.timer) clearTimeout(w.timer);
      if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
      w.resolve(false);
    }
  }

  syncStats(): ChannelStats {
    this.stats.depth = this.queue.length;
    this.stats.inFlight = this.inFlight;
    return this.stats;
  }
}

export interface SedaBusOptions {
  /** Cap total in-flight consumer invocations across all stages. Default: none. */
  concurrency?: number;
}

export class SedaBus {
  private readonly channels = new Map<string, Channel>();
  private readonly dlq = new Map<string, string>();
  private readonly callbacks = new Map<string, (env: Envelope) => void>();
  private readonly globalLimit: number;
  private globalInFlight = 0;
  private running = false;
  private accepting = false;

  constructor(opts: SedaBusOptions = {}) {
    this.globalLimit = opts.concurrency ?? Number.POSITIVE_INFINITY;
    this.start();
  }

  // -- lifecycle -----------------------------------------------------

  start(): void {
    this.running = true;
    this.accepting = true;
  }

  pause(): void {
    this.accepting = false;
  }

  resume(): void {
    if (this.running) this.accepting = true;
  }

  /** Stop accepting, drain queued work (up to `timeoutMs`), then stop. */
  async shutdown({ timeoutMs = 30_000 }: { timeoutMs?: number } = {}): Promise<boolean> {
    this.accepting = false;
    const drained = await this.awaitDrain(timeoutMs);
    this.running = false;
    for (const ch of this.channels.values()) ch.rejectWaiters();
    return drained;
  }

  /** Stop immediately without draining. */
  shutdownNow(): void {
    this.accepting = false;
    this.running = false;
    for (const ch of this.channels.values()) ch.rejectWaiters();
  }

  private async awaitDrain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const idle = () =>
      [...this.channels.values()].every((c) => c.depth === 0 && c.inFlight === 0);
    while (!idle() && Date.now() < deadline) {
      await sleep(5);
    }
    return idle();
  }

  // -- registration ------------------------------------------------

  channel(name: string, opts: ChannelOptions = {}): this {
    if (!this.channels.has(name)) {
      this.channels.set(name, new Channel(name, opts));
    }
    return this;
  }

  subscribe<T = unknown>(name: string, consumer: Consumer<T>): this {
    this.getOrCreate(name).consumers.push(consumer as Consumer);
    return this;
  }

  setDeadLetterChannel(source: string, dlq: string): this {
    this.channel(dlq, { capacity: 4096, backpressure: Backpressure.DropOldest });
    this.dlq.set(source, dlq);
    return this;
  }

  private getOrCreate(name: string): Channel {
    let ch = this.channels.get(name);
    if (!ch) {
      ch = new Channel(name, {});
      this.channels.set(name, ch);
    }
    return ch;
  }

  stats(): Record<string, ChannelStats> {
    const out: Record<string, ChannelStats> = {};
    for (const [name, ch] of this.channels) out[name] = { ...ch.syncStats() };
    return out;
  }

  // -- publishing --------------------------------------------------

  /** Publish an envelope to the channel named by `env.to`. Resolves true if accepted. */
  async publish(env: Envelope, opts: PublishOptions = {}): Promise<boolean> {
    if (!this.running || !this.accepting) return false;
    const ch = this.channels.get(env.to);
    if (!ch) return false;
    if (opts.onComplete) this.callbacks.set(env.id, opts.onComplete);
    const accepted = await ch.offer(env, opts);
    if (!accepted) {
      this.callbacks.delete(env.id);
      return false;
    }
    this.pump(ch);
    return true;
  }

  // -- scheduling -------------------------------------------------

  private pump(ch: Channel): void {
    if (!this.running) return;
    while (
      ch.depth > 0 &&
      ch.inFlight < ch.concurrency &&
      this.globalInFlight < this.globalLimit
    ) {
      ch.inFlight++;
      this.globalInFlight++;
      void this.drain(ch);
    }
  }

  private async drain(ch: Channel): Promise<void> {
    try {
      for (let i = 0; i < BATCH && this.running; i++) {
        const env = ch.poll();
        if (env === undefined) return;
        await this.process(ch, env);
      }
    } finally {
      ch.inFlight--;
      this.globalInFlight--;
      if (this.running) this.pump(ch);
    }
  }

  private async process(ch: Channel, env: Envelope): Promise<void> {
    if (ch.consumers.length === 0) {
      this.deadLetter(ch, env);
      return;
    }
    env.attempts++;

    let ok: boolean;
    if (ch.delivery === Delivery.PubSub) {
      const results = await Promise.all(
        ch.consumers.map((c) => safeReceive(c, env)),
      );
      ok = results.every(Boolean);
    } else {
      ok = await safeReceive(ch.nextConsumer()!, env);
    }

    if (ok) {
      ch.stats.delivered++;
      await this.completeHop(env);
    } else if (env.attempts < ch.maxAttempts) {
      ch.stats.nacked++;
      ch.requeue(env);
    } else {
      ch.stats.nacked++;
      this.deadLetter(ch, env);
    }
  }

  private async completeHop(env: Envelope): Promise<void> {
    if (advance(env)) {
      await this.publish(env, { timeoutMs: 5_000 });
      return;
    }
    const cb = this.callbacks.get(env.id);
    if (cb) {
      this.callbacks.delete(env.id);
      try {
        cb(env);
      } catch {
        /* a callback must not break the scheduler */
      }
    }
  }

  private deadLetter(ch: Channel, env: Envelope): void {
    ch.stats.deadLettered++;
    const dlqName = this.dlq.get(ch.name);
    if (dlqName) {
      const dlq = this.channels.get(dlqName);
      if (dlq) {
        void dlq.offer(env, {}).then(() => this.pump(dlq));
      }
    }
    this.callbacks.delete(env.id);
  }
}

async function safeReceive(c: Consumer, env: Envelope): Promise<boolean> {
  try {
    const r = await c(env);
    return r !== false;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
