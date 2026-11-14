/**
 * What a part that wraps a call's execution brings beside its own state: how
 * a prepared call runs (under write-outcome registrations, under `around`
 * parts), and, for the parts an array member can be intercepted by, how the
 * one executor of `$transaction([...])` (`@client/array-transaction`)
 * admits its members. A chain of none of those parts carries none of it.
 *
 * The write rail (`WRITE_RAIL`) collects a transaction's write outcomes and
 * publishes them after its commit. It comes with the parts whose work is to
 * hear writes: the part that watches a set of writes (`watch-part.ts`) and
 * `unit` parts. A chain of `around` parts alone runs its transactions as an
 * unextended client does; a `settled` registered on a raw statement or a
 * method's scope inside one of its transactions is refused, since nothing
 * would hold it until the commit.
 */
import type { ArraySlot } from "@client/array-transaction";
import { admitArray, interceptsArray, stageArray } from "./array-admission";
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

/** What collects and publishes the write outcomes of a transaction. */
export interface Rail {
  /** A collector for the write outcomes of one transaction scope. */
  readonly outcomes: () => TransactionWriteOutcomes;
  readonly runTransaction: typeof runOutcomeTransaction;
}

export const WRITE_RAIL: Rail = {
  outcomes: () => new TransactionWriteOutcomes(),
  runTransaction: runOutcomeTransaction,
};

export interface Coordination {
  /** What it adds to the one before it: a chain keeps the highest it needs. */
  readonly rank: number;
  /** The write rail it brings to the chain, whatever its rank. */
  readonly rail?: Rail;
  readonly executePreparedQuery: typeof executePreparedQuery;
  /** Present with `admit`: whether a part intercepts one of the members. */
  readonly intercepts?: typeof interceptsArray;
  /**
   * Present where a member of `$transaction([...])` may be intercepted:
   * starts every member's handlers and waits until each reached `run()`,
   * before anything is sent. Resolves to the failures that abort the array.
   */
  readonly admit?: (
    slots: readonly ArraySlot[],
    outcomes: TransactionWriteOutcomes | undefined
  ) => ReturnType<typeof admitArray>;
}

/**
 * For `unit` parts: a transaction collects its write outcomes, so a unit
 * inside one never reports a write as committed before its commit. Nothing
 * of the chain wraps a call: the prepared call runs as it is.
 */
export const UNITS: Coordination = {
  rank: -1,
  rail: WRITE_RAIL,
  executePreparedQuery: (_context, _handlers, child) => child(),
};

/**
 * For the part that watches writes: an array member it hears runs under its
 * registration, and nothing waits, since no handler wraps it.
 */
export const ARRAYS: Coordination = {
  rank: 1,
  rail: WRITE_RAIL,
  executePreparedQuery: executeRegisteredQuery,
  intercepts: interceptsArray,
  admit: stageArray,
};

/** For `around` parts: what runs their second moments around a call, too. */
export const QUERIES: Coordination = {
  rank: 2,
  executePreparedQuery,
  intercepts: interceptsArray,
  admit: (slots, outcomes) => admitArray(slots, outcomes, executePreparedQuery),
};

/**
 * The chain being built coordinated as `needed` asks, never less than it
 * was, with the write rail `needed` brings.
 */
export function coordinate(
  next: { coordination?: Coordination; rail?: Rail },
  needed: Coordination
): void {
  if (needed.rail) next.rail = needed.rail;
  if (next.coordination === undefined || needed.rank > next.coordination.rank)
    next.coordination = needed;
}

/** The write rail a chain runs its transactions with, if a part brought one. */
export function railOf(
  chain: ResolvedExtensionChain | undefined
): Rail | undefined {
  return chain?.rail;
}
