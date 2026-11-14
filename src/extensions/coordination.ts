/**
 * What a part that wraps a call's execution brings beside its own state: how
 * a prepared call runs under write-outcome registrations (and query
 * handlers, where a chain has some), how a transaction collects the outcomes
 * of its writes, and, for the parts an array member can be intercepted by,
 * the intercepted array transaction. A chain of none of those parts carries
 * none of it.
 */
import {
  executeInterceptedArray,
  runOutcomeTransaction,
} from "@client/array-transaction-intercepted";
import type { ResolvedExtensionChain } from "./chain-state";
import {
  executePreparedQuery,
  executeRegisteredQuery,
  TransactionWriteOutcomes,
} from "./query";

export interface Coordination {
  /** What it adds to the one before it: a chain keeps the highest it needs. */
  readonly rank: number;
  /** A collector for the write outcomes of one transaction scope. */
  readonly outcomes: () => TransactionWriteOutcomes;
  readonly runTransaction: typeof runOutcomeTransaction;
  readonly executePreparedQuery: typeof executePreparedQuery;
  /** Present where a member of `$transaction([...])` may be intercepted. */
  readonly executeArray?: typeof executeInterceptedArray;
}

/** For `retry` and `route`: they wrap a call, never an array member. */
export const OUTCOMES: Coordination = {
  rank: 0,
  outcomes: () => new TransactionWriteOutcomes(),
  runTransaction: runOutcomeTransaction,
  executePreparedQuery: executeRegisteredQuery,
};

/** For `written`, observers and the cache: an array member is intercepted. */
export const ARRAYS: Coordination = {
  rank: 1,
  outcomes: () => new TransactionWriteOutcomes(),
  runTransaction: runOutcomeTransaction,
  executePreparedQuery: executeRegisteredQuery,
  executeArray: executeInterceptedArray,
};

/** For query handlers: what runs them around a call, too. */
export const QUERIES: Coordination = {
  rank: 2,
  outcomes: () => new TransactionWriteOutcomes(),
  runTransaction: runOutcomeTransaction,
  executePreparedQuery,
  executeArray: executeInterceptedArray,
};

/** The chain being built coordinated as `needed` asks, never less than it was. */
export function coordinate(
  next: { coordination?: ResolvedExtensionChain["coordination"] },
  needed: Coordination
): void {
  if (next.coordination === undefined || needed.rank > next.coordination.rank)
    next.coordination = needed;
}
