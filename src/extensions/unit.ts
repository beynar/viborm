/**
 * `unit((u, next) => …, kinds?, options?)`: a function around each unit of
 * real work (an operation, a statement, a batch, a transaction, a savepoint,
 * a connection, or a unit an extension emits with `work`). Observing is
 * calling `next()` and reading how the unit ended; what the handler throws
 * fails the call. A part declared `{ rewrites: true }` sends another
 * statement: `next(sql)`, once per logical statement, before rendering.
 */
import type { Sql } from "@sql";
import { isFunction } from "@validation/value-guards";
import type {
  AnyTarget,
  EmptyFacts,
  Part,
  UnitContext,
  UnitKind,
  UnitOutcome,
} from "./contract";
import { builtPart } from "./extension";
import { unitLayerPart } from "./observation";
import { rewritePart } from "./statement";

const nothing = (): undefined => undefined;

/** A function around each unit of the kinds named (every kind when absent). */
export function unit<T extends AnyTarget>(
  around: (
    unit: UnitContext,
    next: (sql?: Sql) => Promise<UnitOutcome>
  ) => unknown,
  kinds?: readonly UnitKind[],
  options?: { readonly rewrites?: true }
): Part<T, EmptyFacts>;
export function unit(
  handler: (unit: UnitContext, next: () => Promise<UnitOutcome>) => unknown,
  kinds?: readonly UnitKind[],
  options?: { readonly rewrites?: true }
): unknown {
  if (!isFunction(handler))
    throw new TypeError("unit() takes a function of the unit and its next");
  return builtPart(
    [
      options?.rewrites === true
        ? rewritePart(handler)
        : unitLayerPart(handler, kinds),
    ],
    nothing
  );
}
