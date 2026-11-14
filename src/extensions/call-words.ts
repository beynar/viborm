/**
 * The words a `call` handler speaks: `watch` and `settled` in its first
 * moment, `again` and `via` in its second. Each is a function of its own, so
 * a program carries only the words it imports.
 */
import type { AnyDriver } from "@drivers/exports";
import { AGAIN, VIA } from "./call";
import type { Outcome, Run, Watcher } from "./contract";
import { scopeOf } from "./origin";
import { publishWriteOutcomes } from "./query";
import { REGISTER } from "./watch-part";

function registerOn(c: object, watching: object): void {
  const register = REGISTER in c ? c[REGISTER] : undefined;
  if (typeof register !== "function")
    throw new TypeError(
      "watch() and settled() take the context of a call's first moment"
    );
  register(watching);
}

/**
 * Receive the rows the call writes: `wants` says which are to be shown
 * (rows nobody wants are not read), `rows` receives them once every write of
 * the call is made, the call's own first, then those written through its
 * relations (`nested`). The values are the caller's too: copy what is kept.
 */
export function watch(c: object, watcher: Watcher): void {
  registerOn(c, { wants: watcher.wants, rows: watcher.rows });
}

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
    registerOn(target, { settled: listener });
    return;
  }
  const registration = { extension: scope.extension, listener };
  const outcomes = scope.engine.transactionWriteOutcomes;
  if (outcomes === undefined)
    return publishWriteOutcomes([registration], { certainty: "committed" });
  outcomes.stage(registration);
  outcomes.confirm([registration]);
  return Promise.resolve();
}

/**
 * Whether the call may be made again: outside a transaction, not a member of
 * `$transaction([...])`, and nothing of it written or maybe written. Only
 * then may `run()` be called once more.
 */
export function again(run: Run<unknown, unknown>): boolean {
  const asked = AGAIN in run ? run[AGAIN] : undefined;
  return typeof asked === "function" && asked() === true;
}

/**
 * Run the call on another driver: a read outside a transaction only; any
 * other call runs where it would. The driver must be of the client's dialect
 * and schema.
 */
export function via<R>(run: Run<unknown, R>, driver: AnyDriver): Promise<R> {
  const routed = VIA in run ? run[VIA] : undefined;
  if (typeof routed !== "function") return run();
  // The routed run resolves to what `run()` would: the call's own result.
  return routed(driver) as Promise<R>;
}
