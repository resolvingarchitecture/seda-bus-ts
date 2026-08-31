/**
 * A fixed pool of Worker threads that all run the same stage handler module.
 */
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";

// `.ts` when running from source (tsx / ts-node), `.js` from the built package.
const HARNESS = new URL(
  import.meta.url.endsWith(".ts") ? "./harness.ts" : "./harness.js",
  import.meta.url,
);

export interface WorkerSpec {
  /** Module exporting the stage handler. A `URL`, absolute path, or specifier. */
  module: string | URL;
  /** Named export to use as the handler. Default `"default"`. */
  export?: string;
  /** Number of Worker threads. */
  pool: number;
}

interface Reply {
  seq: number;
  ok: boolean;
  envelope: unknown;
  error?: string;
}

interface Pending {
  resolve: (r: Reply) => void;
}

function resolveModule(module: string | URL): string {
  if (module instanceof URL) return module.href;
  if (/^[a-z0-9@]/i.test(module) && !module.startsWith("file:") && !isAbsolute(module)) {
    // bare specifier (npm package) — leave for the worker's resolver
    return module;
  }
  const abs = isAbsolute(module) ? module : resolve(process.cwd(), module);
  return pathToFileURL(abs).href;
}

class PooledWorker {
  readonly worker: Worker;
  private pending: Pending | null = null;
  private readonly onDead: (self: PooledWorker) => void;

  constructor(spec: WorkerSpec, onDead: (self: PooledWorker) => void) {
    this.onDead = onDead;
    this.worker = new Worker(HARNESS, {
      workerData: { module: resolveModule(spec.module), export: spec.export },
    });
    this.worker.on("message", (r: Reply) => {
      const p = this.pending;
      this.pending = null;
      p?.resolve(r);
    });
    this.worker.on("error", (err) => this.fail(err));
    this.worker.on("exit", (code) => {
      if (code !== 0) this.fail(new Error(`worker exited with code ${code}`));
    });
  }

  private fail(err: unknown): void {
    const p = this.pending;
    this.pending = null;
    p?.resolve({ seq: -1, ok: false, envelope: undefined, error: String(err) });
    this.onDead(this);
  }

  send(seq: number, envelope: unknown): Promise<Reply> {
    return new Promise<Reply>((resolve) => {
      this.pending = { resolve };
      this.worker.postMessage({ seq, envelope });
    });
  }

  async terminate(): Promise<void> {
    await this.worker.terminate();
  }
}

export class WorkerPool {
  private readonly spec: WorkerSpec;
  private workers: PooledWorker[] = [];
  private readonly free: PooledWorker[] = [];
  private readonly acquireWaiters: Array<(w: PooledWorker) => void> = [];
  private seq = 0;
  private closed = false;

  constructor(spec: WorkerSpec) {
    this.spec = spec;
    for (let i = 0; i < Math.max(1, spec.pool); i++) {
      this.spawn();
    }
  }

  private spawn(): void {
    const w = new PooledWorker(this.spec, (dead) => this.replace(dead));
    this.workers.push(w);
    this.release(w);
  }

  private replace(dead: PooledWorker): void {
    this.workers = this.workers.filter((w) => w !== dead);
    const i = this.free.indexOf(dead);
    if (i >= 0) this.free.splice(i, 1);
    void dead.terminate();
    if (!this.closed) this.spawn();
  }

  private acquire(): Promise<PooledWorker> {
    const w = this.free.pop();
    if (w) return Promise.resolve(w);
    return new Promise((resolve) => this.acquireWaiters.push(resolve));
  }

  private release(w: PooledWorker): void {
    const waiter = this.acquireWaiters.shift();
    if (waiter) waiter(w);
    else this.free.push(w);
  }

  /** Run one envelope on a free worker. Returns `{ ok, envelope }`. */
  async invoke(envelope: unknown): Promise<{ ok: boolean; envelope: unknown }> {
    if (this.closed) return { ok: false, envelope };
    const w = await this.acquire();
    try {
      const reply = await w.send(this.seq++, envelope);
      return { ok: reply.ok, envelope: reply.envelope ?? envelope };
    } finally {
      if (this.workers.includes(w)) this.release(w);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const all = this.workers.slice();
    this.workers = [];
    this.free.length = 0;
    await Promise.all(all.map((w) => w.terminate()));
  }
}
