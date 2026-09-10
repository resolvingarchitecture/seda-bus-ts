import type { Envelope } from "@resolvingarchitecture/ra-common";

/** Transform stage: uppercases the payload in the worker, mutation flows back. */
export default function uppercase(env: Envelope): void {
  const s = env.content() as string;
  env.addContent(s.toUpperCase());
  env.headers["transformedBy"] = "worker";
}
