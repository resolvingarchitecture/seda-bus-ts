/**
 * A three-stage pipeline: ingest -> transform -> sink, via a routing slip.
 *
 *   npm run example
 */
import { SedaBus, makeEnvelope, type Envelope } from "../src/index.js";

async function main() {
  const bus = new SedaBus();

  bus.channel("ingest", { capacity: 100 });
  bus.channel("transform", { capacity: 100, concurrency: 2 });
  bus.channel("sink", { capacity: 100 });

  bus.subscribe("ingest", (e) => {
    e.headers["seen_by"] = "ingest";
  });
  bus.subscribe("transform", (e) => {
    e.addContent((e.content() as string).toUpperCase());
  });

  const seen: string[] = [];
  bus.subscribe("sink", (e) => {
    seen.push(e.content() as string);
  });

  let done = 0;
  const onComplete = (_e: Envelope) => {
    done++;
  };

  for (const word of ["alpha", "bravo", "charlie", "delta", "echo"]) {
    await bus.publish(makeEnvelope("ingest", word, { slip: ["transform", "sink"] }), {
      onComplete,
    });
  }

  const deadline = Date.now() + 5_000;
  while (done < 5 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }

  await bus.shutdown();
  console.log("completed:", done, "sink saw:", seen.sort());
  for (const [name, s] of Object.entries(bus.stats())) {
    console.log(`  ${name.padEnd(10)}`, s);
  }
}

main();
