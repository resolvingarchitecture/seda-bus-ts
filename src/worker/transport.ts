/**
 * How a stage actually runs its work.
 *
 * `InlineTransport` calls consumer functions on the event loop (the default).
 * `WorkerTransport` runs a single handler module across a pool of Worker
 * threads, so CPU-bound stages parallelise across cores.
 */
import { Delivery } from "../policy.js";
import type { Consumer } from "../policy.js";
import { Envelope } from "../envelope.js";
import { WorkerPool, type WorkerSpec } from "./pool.js";

export interface StageTransport {
  /** Process one envelope. May mutate it in place. Returns true to ack. */
  invoke(env: Envelope): Promise<boolean>;
  /** True if the stage has something able to handle envelopes. */
  readonly ready: boolean;
  /** Register an inline consumer (throws for worker stages). */
  addConsumer(consumer: Consumer): void;
  close(): Promise<void>;
}

export class InlineTransport implements StageTransport {
  private readonly consumers: Consumer[] = [];
  private rr = 0;

  constructor(private readonly delivery: Delivery) {}

  get ready(): boolean {
    return this.consumers.length > 0;
  }

  addConsumer(consumer: Consumer): void {
    this.consumers.push(consumer);
  }

  async invoke(env: Envelope): Promise<boolean> {
    if (this.consumers.length === 0) return false;
    if (this.delivery === Delivery.PubSub) {
      const results = await Promise.all(
        this.consumers.map((c) => safeReceive(c, env)),
      );
      return results.every(Boolean);
    }
    const c = this.consumers[this.rr % this.consumers.length]!;
    this.rr = (this.rr + 1) % this.consumers.length;
    return safeReceive(c, env);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export class WorkerTransport implements StageTransport {
  private readonly pool: WorkerPool;

  constructor(spec: WorkerSpec) {
    this.pool = new WorkerPool(spec);
  }

  get ready(): boolean {
    return true;
  }

  addConsumer(): void {
    throw new Error(
      "cannot subscribe() to a worker-backed channel; it is defined by its handler module",
    );
  }

  async invoke(env: Envelope): Promise<boolean> {
    const { ok, envelope } = await this.pool.invoke(env.toJSON());
    if (envelope) {
      // rehydrate the worker's mutations and copy the data props back onto the
      // envelope the scheduler is still holding (methods live on the prototype).
      Object.assign(env, Envelope.fromJSON(envelope as Record<string, unknown>));
    }
    return ok;
  }

  close(): Promise<void> {
    return this.pool.close();
  }
}

export async function safeReceive(c: Consumer, env: Envelope): Promise<boolean> {
  try {
    const r = await c(env);
    return r !== false;
  } catch {
    return false;
  }
}
