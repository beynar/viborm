/**
 * The words a `call` handler speaks: `watch` and `settled` in its first
 * moment, `again` and `via` in its second. Each is a function of its own, so
 * a program carries only the words it imports.
 */
import type { AnyDriver } from "@drivers/exports";
import { AGAIN, VIA } from "./call";
import type { Outcome, Run, Watcher } from "./contract";
import { REGISTER } from "./watch-part";

/**
 * A registration nothing would tell is refused, never dropped: only the
 * first moment of `around`, or of a `call` on a set that brings what tells
 * the watches, registers one.
 */
function registerOn(c: object, watching: object): void {
  const register = REGISTER in c ? c[REGISTER] : undefined;
  if (typeof register !== "function" || register(watching) !== true)
    throw new TypeError(
      "watch() and settled() take the first moment of around(), or of a call on target(writes) or target(deletes), of a model call"
    );
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
 */
export function settled(
  c: object,
  listener: (outcome: Outcome) => unknown
): void {
  registerOn(c, { settled: listener });
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
