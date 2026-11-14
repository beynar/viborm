/**
 * What a part that wraps a call's execution brings beside its own state: how
 * a prepared call runs (under write-outcome registrations, under `around`
 * parts), and, for the parts an array member can be intercepted by, how the
 * one executor of `$transaction([...])` (`@client/array-transaction`)
 * admits its members. A chain of none of those parts carries none of it.
 *
 * And how every transaction scope runs (`transact`): what a call registers
 * there waits in its scope, and the first registration installs the
 * collector by value (`collect`, imported by what registers: `settled`, the
 * part that watches writes, `unit` parts), so an extension behaves the same
 * whatever else its chain holds, and a transaction where nothing registers
 * runs none of that code.
 */
import type { ArraySlot } from "@client/array-transaction";
import { appendExecutionTransactionPhases } from "@drivers/execution-context";
import type { AnyDriver, QueryExecutionContext } from "@drivers/exports";
import type { TransactionOptions } from "@drivers/shared/transaction-options";
import type { QueryEngine } from "@query-engine/query-engine";
import { admitArray, interceptsArray, stageArray } from "./array-admission";
import {
  type CommitPhase,
  type collect,
  executePreparedQuery,
  executeRegisteredQuery,
  type TransactionScope,
} from "./query";

/** The commit certainty one array reports to its `batch` unit. */
export type ArrayCertainty = CommitPhase;

export interface Coordination {
  /** What it adds to the one before it: a chain keeps the highest it needs. */
  readonly rank: number;
  /**
   * Where its parts hear writes: the collector installed in each transaction
   * scope from its start, so the scope's failure carries its commit
   * certainty even when nothing registered.
   */
  readonly collect?: typeof collect;
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
    scope: TransactionScope
  ) => ReturnType<typeof admitArray>;
}

/**
 * For `unit` parts: nothing of the chain wraps a call, the prepared call
 * runs as it is.
 */
export const UNITS: Coordination = {
  rank: -1,
  executePreparedQuery: (_context, _handlers, child) => child(),
};

/**
 * For the part that watches writes: an array member it hears runs under its
 * registration, and nothing waits, since no handler wraps it.
 */
export const ARRAYS: Coordination = {
  rank: 1,
  executePreparedQuery: executeRegisteredQuery,
  intercepts: interceptsArray,
  admit: stageArray,
};

/** For `around` parts: what runs their second moments around a call, too. */
export const QUERIES: Coordination = {
  rank: 2,
  executePreparedQuery,
  intercepts: interceptsArray,
  admit: (slots, scope) => admitArray(slots, scope, executePreparedQuery),
};

/**
 * The chain being built coordinated as `needed` asks, never less than it
 * was; `collect` is kept whatever the rank.
 */
export function coordinate(
  next: { coordination?: Coordination; collect?: typeof collect },
  needed: Coordination,
  collects?: typeof collect
): void {
  if (collects) next.collect = collects;
  if (next.coordination === undefined || needed.rank > next.coordination.rank)
    next.coordination = needed;
}

/**
 * Run one transaction scope. A savepoint's scope is a child of its parent's;
 * the outermost one hears its commit phases where a part may register, for
 * the certainty of what was registered in it. What its calls register installs
 * the collector that ends it (`TransactionWriteOutcomes.end`). A body run
 * again (a driver that reruns a callback on a conflict) gets a scope of its
 * own: nothing the failed run registered is told. An array's scope is made
 * before its members are admitted, and passed.
 */
export function transact<T>(
  engine: QueryEngine,
  options: TransactionOptions | undefined,
  context: QueryExecutionContext,
  body: (driver: AnyDriver, scope: TransactionScope) => Promise<T>,
  made?: TransactionScope,
  root: CommitPhase = made?.root ?? {}
): Promise<T> {
  const chain = engine.extensionChain;
  const parent = engine.transaction;
  let scope: TransactionScope | undefined;
  const end =
    (failed?: true) =>
    (settled: T): T | Promise<T> => {
      // A driver that reports no phase still committed what resolved.
      if (!(failed || parent)) root.certainty = "committed";
      return scope?.outcomes
        ? scope.outcomes.end(scope, settled, failed)
        : failed
          ? Promise.reject(settled)
          : settled;
    };
  return engine.driver
    .withTransaction(
      (driver) => {
        scope = made ?? scopeOf(engine, root);
        return body(driver, scope);
      },
      options,
      // Only where a part may register: a chain of `call` parts, rules or
      // defaults alone runs its transactions as an unextended client does.
      parent || !(chain?.coordination || chain?.methods)
        ? context
        : appendExecutionTransactionPhases(context, {
            readyToCommit: () => {
              root.certainty = "may-have-committed";
            },
            committed: () => {
              root.certainty = "committed";
            },
          })
    )
    .then(end(), end(true));
}

/**
 * A transaction scope inside `engine`'s, with the collector of a chain whose
 * parts hear writes installed from its start.
 */
export function scopeOf(
  engine: QueryEngine,
  root: CommitPhase
): TransactionScope {
  const scope = { parent: engine.transaction, root };
  engine.extensionChain?.collect?.(scope);
  return scope;
}
