/**
 * What a part that wraps a call's execution brings beside its own state: how
 * a prepared call runs under write-outcome registrations (and query
 * handlers, where a chain has some), how a transaction collects the outcomes
 * of its writes, and, for the parts an array member can be intercepted by,
 * how the one executor of `$transaction([...])` (`@client/array-transaction`)
 * admits its members. A chain of none of those parts carries none of it.
 */
import type { ArraySlot } from "@client/array-transaction";
import { admitArray, interceptsArray } from "./array-admission";
import type { ResolvedExtensionChain } from "./chain-state";
import {
  executePreparedQuery,
  executeRegisteredQuery,
  runOutcomeTransaction,
  TransactionWriteOutcomes,
  type WriteOutcome,
} from "./query";

/** The commit certainty one array reports to its `batch` unit. */
export interface ArrayCertainty {
  certainty?: WriteOutcome["certainty"];
}

export interface Coordination {
  /** What it adds to the one before it: a chain keeps the highest it needs. */
  readonly rank: number;
  /** A collector for the write outcomes of one transaction scope. */
  readonly outcomes: () => TransactionWriteOutcomes;
  readonly runTransaction: typeof runOutcomeTransaction;
  readonly executePreparedQuery: typeof executePreparedQuery;
  /**
   * Present where a member of `$transaction([...])` may be intercepted:
   * starts every member's handlers and waits until each reached `run()`,
   * before anything is sent. Resolves to the failures that abort the array.
   */
  /** Present with `admit`: whether a part intercepts one of the members. */
  readonly intercepts?: typeof interceptsArray;
  readonly admit?: (
    slots: readonly ArraySlot[],
    outcomes: TransactionWriteOutcomes
  ) => ReturnType<typeof admitArray>;
}

/**
 * For `unit` parts: a transaction collects its write outcomes, so a unit
 * inside one never reports a write as committed before its commit. Nothing
 * of the chain wraps a call: the prepared call runs as it is.
 */
export const UNITS: Coordination = {
  rank: -1,
  outcomes: () => new TransactionWriteOutcomes(),
  runTransaction: runOutcomeTransaction,
  executePreparedQuery: (_context, _handlers, child) => child(),
};

/** For `written`, observers and the cache: an array member is intercepted. */
export const ARRAYS: Coordination = {
  rank: 1,
  outcomes: () => new TransactionWriteOutcomes(),
  runTransaction: runOutcomeTransaction,
  executePreparedQuery: executeRegisteredQuery,
  intercepts: interceptsArray,
  admit: (slots, outcomes) =>
    admitArray(slots, outcomes, executeRegisteredQuery),
};

/** For query handlers: what runs them around a call, too. */
export const QUERIES: Coordination = {
  rank: 2,
  outcomes: () => new TransactionWriteOutcomes(),
  runTransaction: runOutcomeTransaction,
  executePreparedQuery,
  intercepts: interceptsArray,
  admit: (slots, outcomes) => admitArray(slots, outcomes, executePreparedQuery),
};

/** The chain being built coordinated as `needed` asks, never less than it was. */
export function coordinate(
  next: { coordination?: ResolvedExtensionChain["coordination"] },
  needed: Coordination
): void {
  if (next.coordination === undefined || needed.rank > next.coordination.rank)
    next.coordination = needed;
}
