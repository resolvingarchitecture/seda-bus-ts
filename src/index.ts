/**
 * seda-bus: a small, broker-less, staged message bus for TypeScript / Node.
 *
 * @packageDocumentation
 */
export { SedaBus, type SedaBusOptions } from "./bus.js";
export {
  Backpressure,
  Delivery,
  type ChannelOptions,
  type ChannelStats,
  type Consumer,
  type PublishOptions,
  type WorkerOptions,
} from "./policy.js";
export { advance, envelope, type Envelope, type EnvelopeInit } from "./envelope.js";

export const version = "0.1.0";
