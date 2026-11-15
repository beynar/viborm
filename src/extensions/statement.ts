/**
 * The rewriting units of a chain (`unit(fn, kinds, { rewrites: true })`).
 * Each is a unit around one logical statement: `statement(unit)` reads the
 * statement as the earlier rewrites left it, `next(sql)` hands on what is
 * sent (unchanged without an argument), and resolves with how the statement
 * ended. Inside the innermost `next()` the statement is rendered and sent,
 * as its own `statement` unit around the provider call. A chain with one is
 * never served by the cache, and verbatim unsafe raw queries are never
 * rewritten.
 */
import type { ExtensionPart } from "./chain";
import { observationOf } from "./observation";
import type { UnitHandler } from "./unit-source";

/** The host part of `unit(handler, kinds, { rewrites: true })`. */
export function rewritePart(handler: UnitHandler): ExtensionPart {
  return {
    join({ next, owner }) {
      next.rewrites = observationOf([
        ...(next.rewrites?.handlers ?? []),
        { extension: owner.name, handler },
      ]);
    },
  };
}
