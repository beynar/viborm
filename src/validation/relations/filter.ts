// Relation Filter Schemas

import type { AnyModel } from "@schema/model";
import { slotMayBeEmpty } from "@schema/relation/clearability";
import type { SlotMayBeEmpty } from "@schema/relation/static-membership";
import type { RelationState } from "@schema/relation/types";
import type { ResolvedSlot } from "@schema/validation/relation-resolution";
import { createSchema, fail, ok, validateSchema } from "../primitives/helpers";
import { type V, v } from "../primitives/v";
import type { VibSchema } from "../types";
import { isRecord } from "../value-guards";
import type { GetTargetSchemas, SchemaGetter } from "./helpers";

/**
 * To-one filter. Two spellings are accepted (Prisma parity):
 *
 *   explicit    { author: { is: {...}, isNot: {...} } }
 *   shorthand   { author: { name: "x" } }  ===  { author: { is: { name: "x" } } }
 *
 * DISAMBIGUATION (Prisma's rule): if EVERY key of the object is `is` or
 * `isNot`, the object is the explicit filter; otherwise the whole object is a
 * target-model `where` and desugars to `{ is: <object> }`. An empty object has
 * no key outside that set, so `{}` reads as the (vacuous) explicit filter.
 *
 * COLLISION RULE: a target model with a scalar field literally named `is` or
 * `isNot` cannot be filtered on that field through the shorthand — an object
 * whose only keys are `is`/`isNot` always reads as the explicit filter. Reach
 * such a field through the explicit spelling instead:
 *   { author: { is: { is: "x" } } }
 * Prisma has the same ambiguity and resolves it the same way. The shorthand's
 * input type marks `is`/`isNot` as `never` (Prisma spells this `XOR<…>`), so a
 * collision is a type error rather than a silent reinterpretation.
 *
 * For optional relations, `is` can also be null, and the bare `null`
 * shorthand normalizes to `{ is: null }` (unchanged by the object shorthand).
 *
 * Dispatch is DETERMINISTIC — the key rule selects exactly one member and that
 * member's error is what surfaces — rather than `v.union`'s try-each-in-order,
 * which would report a union-wide miss for a merely malformed explicit filter.
 * Uses thunks for lazy evaluation to avoid circular reference issues.
 */

type NullToIsNull = V.Schema<null, { is: null }>;
const nullToIsNull: NullToIsNull = createSchema("object", () =>
  ok({ is: null })
);

/**
 * May this slot be empty? The DERIVED answer, not a declared flag: `is: null`
 * exists exactly where the membership can be absent, which for a stored
 * reference is its own nullable tuple and for every non-owner is always.
 */
type MayBeEmpty<Source extends AnyModel, Key, S extends RelationState> =
  SlotMayBeEmpty<Source, Key, S> extends false ? false : true;

type ToOneFilterObjectSchema<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = V.Object<{
  is: () => V.MaybeNullable<
    GetTargetSchemas<S>["core"]["where"],
    MayBeEmpty<Source, Key, S>
  >;
  isNot: () => V.MaybeNullable<
    GetTargetSchemas<S>["core"]["where"],
    MayBeEmpty<Source, Key, S>
  >;
}>;

type TargetWhereSchema<S extends RelationState> =
  GetTargetSchemas<S>["core"]["where"];

/**
 * The shorthand member: a target-model `where` whose parsed value is wrapped
 * into the explicit `{ is }` shape. Its input type excludes `is`/`isNot` so the
 * two spellings stay mutually exclusive at the type level exactly as the key
 * rule makes them at runtime.
 */
type ToOneShorthandFilterSchema<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = V.Transform<
  V.Input<TargetWhereSchema<S>> & { is?: never; isNot?: never },
  V.Output<ToOneFilterObjectSchema<Source, Key, S>>
> & { wrapped: TargetWhereSchema<S> };

export type ToOneFilterSchema<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> =
  MayBeEmpty<Source, Key, S> extends true
    ? V.Union<
        readonly [
          NullToIsNull,
          ToOneFilterObjectSchema<Source, Key, S>,
          ToOneShorthandFilterSchema<Source, Key, S>,
        ]
      >
    : V.Union<
        readonly [
          ToOneFilterObjectSchema<Source, Key, S>,
          ToOneShorthandFilterSchema<Source, Key, S>,
        ]
      >;

/** The keys that spell the explicit `{ is, isNot }` filter. */
const EXPLICIT_TO_ONE_FILTER_KEYS = new Set(["is", "isNot"]);

const isExplicitToOneFilter = (value: object): boolean => {
  for (const key in value) {
    if (!EXPLICIT_TO_ONE_FILTER_KEYS.has(key)) {
      return false;
    }
  }
  return true;
};

export const toOneFilterFactory = <
  Source extends AnyModel,
  Key,
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  resolved: ResolvedSlot,
  targetSchemas: T
): ToOneFilterSchema<Source, Key, S> => {
  const isOptional = slotMayBeEmpty(resolved);
  const filterObject = v.object({
    is: () =>
      v.maybeNullable(
        targetSchemas().core.where,
        isOptional as MayBeEmpty<Source, Key, S>
      ),
    isNot: () =>
      v.maybeNullable(
        targetSchemas().core.where,
        isOptional as MayBeEmpty<Source, Key, S>
      ),
  });

  // The target `where` is reached through a thunk: building it here would
  // resolve the target model's schemas while this one is still under
  // construction, which never terminates for a self-referential relation.
  // The cast narrows the shorthand's INPUT to exclude `is`/`isNot` (see the
  // collision rule above); the runtime value is exactly this transform.
  const shorthand = v.lazy(() =>
    v.coerce(targetSchemas().core.where, (where) => ({ is: where }))
  ) as unknown as ToOneShorthandFilterSchema<Source, Key, S>;

  const members: readonly VibSchema<unknown, unknown>[] = isOptional
    ? [nullToIsNull, filterObject, shorthand]
    : [filterObject, shorthand];

  // A genuine union of the members above, but with deterministic dispatch
  // instead of first-match-wins. `type`/`options` mirror `v.union` so
  // introspection (JSON Schema conversion) sees the alternatives it expects.
  const schema = createSchema<unknown, unknown>("union", (value) => {
    if (value === null) {
      return isOptional
        ? validateSchema(nullToIsNull, value)
        : fail("Expected object");
    }
    if (!isRecord(value)) {
      return fail("Expected object");
    }
    return isExplicitToOneFilter(value)
      ? validateSchema(filterObject, value)
      : validateSchema(shorthand, value);
  });
  (schema as { options?: unknown }).options = members;

  return schema as unknown as ToOneFilterSchema<Source, Key, S>;
};

/**
 * To-many filter: { some?, every?, none? }
 * Uses thunks for lazy evaluation - getTargetWhereSchema already returns thunk
 */

export type ToManyFilterSchema<S extends RelationState> = V.Object<{
  some: () => GetTargetSchemas<S>["core"]["where"];
  every: () => GetTargetSchemas<S>["core"]["where"];
  none: () => GetTargetSchemas<S>["core"]["where"];
}>;

export const toManyFilterFactory = <
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  _state: S,
  targetSchemas: T
): ToManyFilterSchema<S> => {
  return v.object({
    some: () => targetSchemas().core.where,
    every: () => targetSchemas().core.where,
    none: () => targetSchemas().core.where,
  });
};
