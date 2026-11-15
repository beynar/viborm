/**
 * The words a `call` handler speaks: `watch` in its first moment, `again`
 * and `via` in its second (`settled` has a module of its own,
 * `./settled.ts`). Each is a function of its own, so a program carries only
 * the words it imports.
 */
import type { AnyDriver } from "@drivers/exports";
import type { Run, Watcher } from "./contract";
import { attemptOf } from "./origin";
import { REGISTER } from "./watch-part";
import { watchShown } from "./written";

/**
 * A registration nothing would tell is refused, never dropped: only the
 * first moment of a model call, in a `call` or an `around` on a set that
 * brings what tells the watches (`target(writes)`, `target(deletes)`),
 * registers one.
 */
export function registerOn(c: object, watching: object): void {
  const register = REGISTER in c ? c[REGISTER] : undefined;
  if (typeof register !== "function" || register(watching) !== true)
    throw new TypeError(
      "watch() and settled() take the first moment of a call or an around on target(writes) or target(deletes), of a model call"
    );
}

/**
 * Receive the rows the call writes: `wants` says which are to be shown
 * (rows nobody wants are not read), `rows` receives them once every write of
 * the call is made, the call's own first, then those written through its
 * relations (`nested`). The values are the caller's too: copy what is kept.
 */
export function watch(c: object, watcher: Watcher): void {
  registerOn(c, { wants: watcher.wants, rows: watcher.rows, show: watchShown });
}

/**
 * Whether the call may be made again: outside a transaction, not a member of
 * `$transaction([...])`, and nothing of it written or maybe written. Only
 * then may `run()` be called once more.
 */
export function again(run: Run<unknown, unknown>): boolean {
  const attempt = attemptOf(run);
  if (
    !(attempt.direct && attempt.failed) ||
    attempt.done ||
    attempt.certainty?.() !== undefined
  )
    return false;
  attempt.failed = false;
  attempt.open = true;
  return true;
}

/**
 * Run the call on another driver: a read outside a transaction only; any
 * other call runs where it would. The driver must be of the client's dialect
 * and schema.
 */
export function via<R>(run: Run<unknown, R>, driver: AnyDriver): Promise<R> {
  const attempt = attemptOf(run);
  // The routed run resolves to what `run()` would: the call's own result.
  return attempt.start(attempt.routable ? driver : undefined) as Promise<R>;
}
