/**
 * TypeScript client SDK for the Relay Harness runtime: spawn the
 * `rlh-jsonrpc-agent` runtime as a subprocess and drive agent turns over
 * stdio JSON-RPC. `RelayHarness` is the high-level run API;
 * `HarnessClient` is the lower-level protocol client. A pure library — it
 * registers nothing on a Cordis context; the runtime process it spawns is a
 * complete harness configured by its own `cordis.yml`.
 *
 * @module @relay-harness/rlh-sdk-client
 */

export { RelayHarness, HarnessSession } from './api.ts'
export type { RunOptions } from './api.ts'
export {
  HarnessClient,
  RequestTimeoutError,
  SdkProtocolError,
  TransportClosedError,
} from './client.ts'
export type { NotificationSubscription } from './client.ts'
export { JsonRpcResponseError } from '@relay-harness/rlh-sdk-protocol'
export type {
  ContentBlock,
  RelayHarnessOptions,
  HarnessClientOptions,
  HarnessNotification,
  NotificationFilter,
  RunResult,
} from './types.ts'
