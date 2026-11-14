/**
 * What `watch(c, …)` and `settled(c, …)` register in a call's first moment,
 * and the part that tells them of the rows a write call writes and of its
 * commit. Brought by `around` and by the `writes` and `deletes` sets: a
 * `call` watches with `target(writes)` (or `deletes`).
 */
import type { Application, ExtensionPart } from "./chain";
import { ARRAYS, coordinate } from "./coordination";
import { type WrittenCall, type WrittenWatch, watchWrite } from "./written";

/** The key a first moment's context registers watches through. */
export const REGISTER = Symbol("viborm.watch");

/** What `watch(c, …)` and `settled(c, …)` register for one call. */
export interface Watching {
  readonly wants?: WrittenWatch["wants"];
  readonly rows?: WrittenWatch["rows"];
  readonly settled?: WrittenWatch["settled"];
}

/** Per call, what each extension's first moments registered to watch. */
export const watched = new WeakMap<object, Map<string, Watching[]>>();

/** What one extension's first moments registered for a write call, as one watch. */
function watchOf(
  extension: string,
  written: WrittenCall
): WrittenWatch | undefined {
  const own =
    written.call === undefined
      ? undefined
      : watched.get(written.call)?.get(extension);
  if (own === undefined) return undefined;
  return {
    wants: (model, kind) =>
      own.some((watching) => watching.wants?.(model, kind) === true),
    rows(model, kind, rows, nested) {
      for (const watching of own)
        if (watching.wants?.(model, kind) === true)
          watching.rows?.(model, kind, rows, nested);
    },
    async settled(outcome) {
      for (const watching of own) await watching.settled?.(outcome);
    },
  };
}

/**
 * What tells the watches `watch` and `settled` register of the rows a write
 * writes and of its commit: brought by `around` and by the `writes` and
 * `deletes` sets.
 */
export const watchPart: ExtensionPart = {
  join({ next, chain, owner }: Application) {
    const name = owner.name;
    if (chain?.written?.handlers.some((handler) => handler.extension === name))
      return;
    const handlers = Object.freeze([
      ...(chain?.written?.handlers ?? []),
      Object.freeze({
        extension: name,
        handler: (written: WrittenCall) => watchOf(name, written),
      }),
    ]);
    next.written = Object.freeze({
      handlers,
      watch: (call, controls, context, cached, late) =>
        watchWrite(handlers, call, controls, context, cached, late),
    });
    coordinate(next, ARRAYS);
  },
};
