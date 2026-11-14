/**
 * The word `settled`. On a call it registers through what the call's part
 * brought; on a method's scope it publishes at once outside a transaction,
 * and inside one in the transaction's scope, installing its collector
 * (`collect`) if nothing registered there yet: the word brings that code,
 * whatever else the chain holds.
 */

import { registerOn } from "./call-words";
import type { Outcome } from "./contract";
import { scopeOf } from "./origin";
import { collect, publishWriteOutcomes } from "./query";

/**
 * Be told when the call's write is durable: after its commit, after the
 * outermost commit inside a transaction, never after a rollback. Awaited
 * before the call's promise settles; what it throws rejects that promise.
 *
 * On a method's scope, `fn` runs when the work of that view is durable:
 * outside a transaction at once, and the promise returned is its own;
 * inside one, after the outermost commit, its failure rejecting that
 * transaction's promise. An error of viborm's own rejects as it is, any
 * other as the cause of a `QueryError`.
 */
export function settled(
  c: { readonly kind: "model" | "raw" },
  listener: (outcome: Outcome) => unknown
): void;
export function settled(
  scope: { readonly $bind: unknown },
  listener: (outcome: Outcome) => unknown
): Promise<void>;
export function settled(
  target: object,
  listener: (outcome: Outcome) => unknown
): Promise<void> | undefined {
  const scope = scopeOf(target);
  if (scope === undefined) {
    registerOn(target, { settled: listener, collect });
    return;
  }
  const registration = { extension: scope.extension, listener };
  const transaction = scope.engine.transaction;
  if (transaction === undefined)
    return publishWriteOutcomes([registration], { certainty: "committed" });
  const outcomes = collect(transaction);
  outcomes.stage(registration);
  outcomes.confirm([registration]);
  return Promise.resolve();
}
