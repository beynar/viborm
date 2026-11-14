/**
 * What a part that wraps a call's execution brings beside its own state: how
 * a prepared call runs (under write-outcome registrations, under query
 * handlers), and, for the parts an array member can be intercepted by, how
 * the one executor of `$transaction([...])` (`@client/array-transaction`)
 * admits its members. A chain of none of those parts carries none of it.
 *
 * The write rail (`WRITE_RAIL`) collects a transaction's write outcomes and
 * publishes them after its commit. It comes with what can register an
 * outcome: `watch` (its part), `unit` parts, the `query` member, and the word
 * `settled`, by importing it (`./settled.ts`): what it registers on a raw
 * statement or a method's scope may be in any coordinated chain. A chain of
 * `around` parts alone, in a program that never imports `settled`, runs its
 * transactions as an unextended client does.
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

/** The rail importing `settled` brought, for the chains of `around` parts. */
export const brought: { rail?: Rail } = {};

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

/** For `written`, observers and the cache: an array member is intercepted. */
export const ARRAYS: Coordination = {
  rank: 1,
  rail: WRITE_RAIL,
  executePreparedQuery: executeRegisteredQuery,
  intercepts: interceptsArray,
  admit: (slots, outcomes) =>
    admitArray(slots, outcomes, executeRegisteredQuery),
};

/** For query handlers: what runs them around a call, too. */
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

/**
 * The write rail a coordinated chain runs its transactions with: its own,
 * else the one importing `settled` brought.
 */
export function railOf(
  chain: ResolvedExtensionChain | undefined
): Rail | undefined {
  return chain?.coordination ? (chain.rail ?? brought.rail) : undefined;
}
