/**
 * What `watch(c, …)` and `settled(c, …)` register in a call's first moment,
 * and the part that tells them of the rows a write call writes and of its
 * commit. Brought by the `writes` and `deletes` sets: a `call` or an
 * `around` watches with `target(writes)` (or `deletes`), and one that never
 * watches carries none of it.
 */
import type { Application, ExtensionPart } from "./chain";
import { ARRAYS, coordinate } from "./coordination";
import type { CallOrigin } from "./origin";
import { collect } from "./query";
import { type Watching, watchWrite } from "./written";

export type { Watched, Watching } from "./written";

/** The key a first moment's context registers watches through. */
export const REGISTER = Symbol("viborm.watch");

/** What a first moment's context registers watches through, for one call. */
export interface Registering {
  readonly [REGISTER]: (watching: Watching) => boolean;
}

export interface WatchPart extends ExtensionPart {
  /**
   * What one extension's first moment of one model call registers through,
   * keeping it for the call. A context without it (a `call` that brings no
   * watch part, a raw statement) has nothing to register through, which
   * `call-words.ts` refuses.
   */
  readonly registering: (call: CallOrigin, extension: string) => Registering;
}

export const watchPart: WatchPart = {
  registering: (call, extension) => ({
    [REGISTER](watching) {
      (call.watched ??= []).push([extension, watching]);
      return true;
    },
  }),
  join({ next }: Application) {
    // First moments run in chain order: what a call registered is in it.
    next.watch = {
      watch: (written, _values, context, late) =>
        watchWrite(written.call?.watched ?? [], context, late),
    };
    coordinate(next, ARRAYS, collect);
  },
};
