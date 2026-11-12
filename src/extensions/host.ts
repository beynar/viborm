/**
 * The code that admits and runs extensions, brought by what builds a
 * definition and never by the client (`host-slot.ts`).
 */
import {
  executeInterceptedArray,
  runOutcomeTransaction,
} from "@client/array-transaction-intercepted";
import {
  admitArrayQueries,
  createArrayDeferred,
  readArrayQuery,
} from "./array-admission";
import { appendResolvedExtension } from "./chain";
import { admitControls, bindControls, uncacheableRead } from "./controls";
import { installExtensionHost } from "./host-slot";
import { bindExtensionMethods } from "./methods";
import {
  getOfficialInstrumentationChainCapability,
  prewarmProtectedObservers,
  runProtectedObservers,
} from "./observation";
import {
  decomposeQueryCoordinationFailure,
  decomposeWriteOutcomePublicationFailure,
  executePreparedQuery,
  TransactionWriteOutcomes,
} from "./query";
import { applyRequestTransforms } from "./request";
import { planResultFields } from "./result";
import { applyStatementTransforms } from "./statement";
import { sendUnit } from "./units";
import { watchWrite } from "./written";

export const EXTENSION_HOST = Object.freeze({
  admitArrayQueries,
  admitControls,
  appendResolvedExtension,
  applyRequestTransforms,
  applyStatementTransforms,
  bindControls,
  bindExtensionMethods,
  createArrayDeferred,
  decomposeQueryCoordinationFailure,
  decomposeWriteOutcomePublicationFailure,
  executeInterceptedArray,
  executePreparedQuery,
  getOfficialInstrumentationChainCapability,
  planResultFields,
  prewarmProtectedObservers,
  readArrayQuery,
  runOutcomeTransaction,
  runProtectedObservers,
  sendUnit,
  TransactionWriteOutcomes,
  uncacheableRead,
  watchWrite,
});

/** Brings what admits and runs extensions to every client of this program. */
export const withHost = (): void => installExtensionHost(EXTENSION_HOST);

/**
 * Brings the code that runs extensions into a program that passes object
 * literals to `$extends` and builds no definition with `defineExtension()` or
 * `defineHooks()`. Call it once.
 */
export const enableExtensions = withHost;
