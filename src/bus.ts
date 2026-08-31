/**
 * A small, broker-less, staged message bus.
 *
 * Work is decomposed into stages ({@link SedaBus.channel}) connected by bounded
 * queues. By default the event loop is the shared worker pool and each stage
 * has its own concurrency limit; a stage may instead be configured to run its
 * handler across real Worker threads (see {@link ChannelOptions.worker}), which
 * lets CPU-bound stages parallelise across cores.
 *
 * What this is not: SEDA's original design also included a controller that
 * watched per-stage latency and queue depth at runtime and re-tuned resources
 * and shed load automatically. That adaptive controller is future work (see
 * DESIGN.md).
 */
import { advance, type Envelope } from "./envelope.js";
import {
  Backpressure,
  Delivery,
  type ChannelOptions,
  type ChannelStats,
  type Consumer,
  type PublishOptions,
} from "./policy.js";
import {
  InlineTransport,
  WorkerTransport,
  type StageTransport,
} from "./worker/transport.js";

export { Backpressure, Delivery } from "./policy.js";
export type {
  ChannelOptions,
  ChannelStats,
  Consumer,
  PublishOptions,
  WorkerOptions,
} from "./policy.js";

/** Envelopes one drain turn handles before yielding back to the scheduler. */
const BATCH = 32;

interface Waiter {
  resolve: (ok: boolean) => void;
  env: Envelope;
  timer?: NodeJS.Timeout;
  onAbort?: () => void;
  signal?: AbortSignal;
}

class Channel {
  readonly name: string;
  readonly capacity: number;
  readonly concurrency: number;
  readonly backpressure: Backpressure;
  readonly maxAttempts: number;
  readonly transport: StageTransport;

  private readonly queue: Envelope[] = [];
  private readonly waiters: Waiter[] = [];
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
    this.backpressure = opts.backpressure ?? Backpressure.Block;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 1);

    if (opts.worker) {
      if (opts.delivery === Delivery.PubSub) {
        throw new Error(`channel "${name}": pub/sub is not supported for worker stages`);
      }
      const pool = Math.max(1, opts.worker.pool ?? opts.concurrency ?? 1);
      this.concurrency = pool;
      this.transport = new WorkerTransport({
        module: opts.worker.module,
        export: opts.worker.export,
        pool,
      });
    } else {
      this.concurrency = Math.max(1, opts.concurrency ?? 1);
      this.transport = new InlineTransport(opts.delivery ?? Delivery.PointToPoint);
    }
  }

  get depth(): number {
    return this.queue.length;
  }

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
      const waiter: Waiter = { resolve, env };
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
    if (env !== undefined) this.wakeWaiters();
    return env;
  }

  requeue(env: Envelope): void {
    this.queue.unshift(env);
  }

  private wakeWaiters(): void {
    while (this.queue.length < this.capacity && this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      if (w.timer) clearTimeout(w.timer);
      if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
      this.enqueue(w.env);
      w.resolve(true);
    }
  }

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
  /** Cap total in-flight invocations across all stages. Default: none. */
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
    await Promise.all([...this.channels.values()].map((c) => c.transport.close()));
    return drained;
  }

  /** Stop immediately without draining. */
  async shutdownNow(): Promise<void> {
    this.accepting = false;
    this.running = false;
    for (const ch of this.channels.values()) ch.rejectWaiters();
    await Promise.all([...this.channels.values()].map((c) => c.transport.close()));
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
    this.getOrCreate(name).transport.addConsumer(consumer as Consumer);
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
    env.attempts++;
    const ok = await ch.transport.invoke(env);

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
      if (dlq) void dlq.offer(env, {}).then(() => this.pump(dlq));
    }
    this.callbacks.delete(env.id);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
