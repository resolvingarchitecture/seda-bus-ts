/**
 * Runs inside each Worker thread of a worker-backed stage.
 *
 * `workerData` carries `{ module, export }`. This imports that module, then for
 * every envelope posted by the main thread it calls the handler and posts back
 * `{ seq, ok, envelope }` — the envelope is returned so payload/header/slip
 * mutations made in the worker propagate back.
 */
import { parentPort, workerData } from "node:worker_threads";

import { Envelope } from "@resolvingarchitecture/ra-common";

type Handler = (env: Envelope) => unknown | Promise<unknown>;

interface Request {
  seq: number;
  envelope: unknown;
}

const port = parentPort;
if (!port) {
  throw new Error("seda-bus worker harness loaded outside a worker thread");
}

const spec = String((workerData as { module: string }).module);
const exportName = (workerData as { export?: string }).export ?? "default";

let handler: Handler | undefined;
let loadError: unknown;

const ready = import(spec)
  .then((mod: Record<string, unknown>) => {
    const h = mod[exportName];
    if (typeof h !== "function") {
      throw new Error(`worker module ${spec} has no "${exportName}" function export`);
    }
    handler = h as Handler;
  })
  .catch((err) => {
    loadError = err;
  });

port.on("message", async (msg: Request) => {
  await ready;
  if (loadError || !handler) {
    port.postMessage({
      seq: msg.seq,
      ok: false,
      envelope: msg.envelope,
      error: String(loadError ?? "handler not loaded"),
    });
    return;
  }
  try {
    const env = Envelope.fromJSON(msg.envelope as Record<string, unknown>);
    const result = await handler(env);
    port.postMessage({ seq: msg.seq, ok: result !== false, envelope: env.toJSON() });
  } catch (err) {
    port.postMessage({
      seq: msg.seq,
      ok: false,
      envelope: msg.envelope,
      error: String(err),
    });
  }
});
