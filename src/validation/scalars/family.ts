import type { ScalarType } from "@schema/scalars/common";
import { lazyScalarSchemas, type ScalarVariantSchemas } from "../lazy";
import type { UnionSchema } from "../primitives/union";
import v, { type V } from "../primitives/v";
import { createScalarInterner } from "./intern";
import {
  buildNegatableFilterSchema,
  type NegatableFilterSchema,
} from "./negatable-filter";

/**
 * The shapes every scalar kind shares, spelled ONCE.
 *
 * Eight of the fourteen scalar modules used to carry their own copy of the same
 * four families — the ordered comparison filter, the list filter, one of the
 * two update bags, and the interned builder tail — differing only in the kind
 * name and the two primitive schemas that kind is made of. This module is the
 * single owner of those four shapes; a kind module names its primitives and
 * calls the family, and keeps its own code only where its language really
 * differs: boolean has no ordering, blob, vector and point have no list arm,
 * enum refuses ordering, decimal and json speak their own, and string's ordered
 * comparisons take the FIELD schema rather than the member schema while its
 * entry order appends `equals` after the text predicates — the
 * compact-identifier narrowing is a third, further difference.
 *
 * ENTRY ORDER IS PART OF THE CONTRACT. The object validator iterates entries in
 * insertion order and returns the FIRST issue, and `toJsonSchema` emits
 * `properties` in that order, so a payload with two invalid operators reports a
 * different key if the order moves. The families therefore keep the
 * `base.extend({ equals })` sequencing that produced today's order rather than
 * spelling one canonical literal: the module-level operator bag first, the
 * field-dependent `equals` appended after it, `not` appended last by
 * {@link buildNegatableFilterSchema}. `tests/unit/scalars/_scalar-shape-census.ts`
 * records the resulting order for all twenty-four cases.
 *
 * A kind's MEMBER and LIST schemas — `v.integer()` and
 * `v.integer({ array: true })`, and so on — carry no nullability and no arity
 * of their own. The FIELD's schema is what `equals`, `set` and the shorthand
 * take, so only those arms accept a `null`; `in`, the ordered comparisons and
 * the list operators compare against a plain value.
 *
 * Each family is a FACTORY that closes over its kind's primitives and returns
 * the per-field builder. That keeps the module-level bag built exactly once per
 * kind, as it was when each module declared its own, and it keeps every
 * validator built inside the factory that hands it to a `v.union` — the
 * capture rule of validation AGENTS Rule 4.
 */

// =============================================================================
// FILTER SHAPES
// =============================================================================

/**
 * `equals` over the FIELD schema, `in`/`notIn` over the kind's list, and the
 * four ordered comparisons over the kind's member schema.
 */
export type ComparisonFilterBase<
  K extends ScalarType,
  S extends V.Schema,
  M extends V.Schema,
  L extends V.Schema,
  C extends V.Operand<any>,
> = {
  equals: V.ComparisonOperand<K, S, C>;
  in: L;
  notIn: L;
  lt: V.ComparisonOperand<K, M, C>;
  lte: V.ComparisonOperand<K, M, C>;
  gt: V.ComparisonOperand<K, M, C>;
  gte: V.ComparisonOperand<K, M, C>;
};

export type ComparisonFilterSchema<
  K extends ScalarType,
  S extends V.Schema,
  M extends V.Schema,
  L extends V.Schema,
  C extends V.Operand<any>,
> = NegatableFilterSchema<
  V.ComparisonOperand<K, S, C>,
  ComparisonFilterBase<K, S, M, L, C>
>;

/** `has`/`hasEvery`/`hasSome`/`isEmpty`, then `equals` over the field schema. */
export type ListFilterBase<
  S extends V.Schema,
  M extends V.Schema,
  L extends V.Schema,
> = {
  equals: S;
  has: M;
  hasEvery: L;
  hasSome: L;
  isEmpty: V.Boolean;
};

export type ListFilterSchema<
  S extends V.Schema,
  M extends V.Schema,
  L extends V.Schema,
> = NegatableFilterSchema<S, ListFilterBase<S, M, L>>;

/**
 * The ordered comparison filter of one kind.
 *
 * `in`/`notIn` take the kind's LIST schema and the four comparisons its MEMBER
 * schema, because neither reads the field's own nullability or arity: only the
 * whole-value arms (`equals`, and the shorthand) take `null`.
 */
export const comparisonFilterFamily = <
  K extends ScalarType,
  M extends V.Schema,
  L extends V.Schema,
>(
  kind: K,
  member: M,
  list: L
) => {
  const base = v.object({
    in: list,
    notIn: list,
    lt: v.comparisonOperand(kind, member),
    lte: v.comparisonOperand(kind, member),
    gt: v.comparisonOperand(kind, member),
    gte: v.comparisonOperand(kind, member),
  });
  return <S extends V.Schema, C extends V.Operand<any> = V.Operand<any>>(
    schema: S
  ): ComparisonFilterSchema<K, S, M, L, C> => {
    const operand = v.comparisonOperand<K, S, C>(kind, schema);
    return buildNegatableFilterSchema<
      V.ComparisonOperand<K, S, C>,
      ComparisonFilterBase<K, S, M, L, C>
    >(base.extend({ equals: operand }), operand);
  };
};

/**
 * The list filter of one kind.
 *
 * `equals` compares the WHOLE list and therefore takes the field schema; the
 * membership operators take the kind's member and list schemas.
 */
export const listFilterFamily = <M extends V.Schema, L extends V.Schema>(
  member: M,
  list: L
) => {
  const base = v.object({
    has: member,
    hasEvery: list,
    hasSome: list,
    isEmpty: v.boolean(),
  });
  return <S extends V.Schema>(schema: S): ListFilterSchema<S, M, L> =>
    buildNegatableFilterSchema<S, ListFilterBase<S, M, L>>(
      base.extend({ equals: schema }),
      schema
    );
};

// =============================================================================
// UPDATE SHAPES
// =============================================================================

/** `set` plus the four arithmetic operations, for the numeric kinds. */
export type ArithmeticUpdateSchema<
  S extends V.Schema,
  M extends V.Schema,
> = V.Union<
  readonly [
    V.ShorthandUpdate<S>,
    V.Object<{
      set: S;
      increment: M;
      decrement: M;
      multiply: M;
      divide: M;
    }>,
  ]
>;

/** `set` and nothing else, for every kind with no arithmetic. */
export type SetUpdateSchema<S extends V.Schema> = V.Union<
  readonly [V.ShorthandUpdate<S>, V.Object<{ set: S }, { partial: false }>]
>;

/**
 * One value or a whole list, the operand of `push` and `unshift`.
 *
 * Spelled with its input and output written out rather than left to
 * `V.Union`'s defaults: those defaults are an indexed access over the union of
 * the arms, and TypeScript compares a DEFERRED indexed access in target
 * position by intersection, so the family's own construction would not be
 * assignable to it while `M` and `L` are still type parameters. At a concrete
 * kind the two spellings are the same type in both directions.
 */
export type PushSchema<M extends V.Schema, L extends V.Schema> = UnionSchema<
  readonly [V.ShorthandArray<M>, L],
  L[" vibInferred"]["0"] | M[" vibInferred"]["0"],
  [M[" vibInferred"]["1"]] | L[" vibInferred"]["1"]
>;

/**
 * `set`, `push` and `unshift`, each taking one value or a whole list.
 *
 * The arm tuple is `readonly`, which is what `v.union`'s `const` type parameter
 * infers and what every kind but one already spelled for itself. String's
 * private `StringListUpdateSchema` wrote the tuple mutable, so a string LIST
 * field's `update` is the one type this consolidation respelled — an internal
 * one: `StringSchemas` is reachable from no package entry, and the inferred
 * input and output are identical either way, pinned by
 * `tests/types/scalars/scalar-family-spellings.core.types.ts`.
 */
export type ListUpdateSchema<
  S extends V.Schema,
  M extends V.Schema,
  L extends V.Schema,
> = V.Union<
  readonly [
    V.ShorthandUpdate<S>,
    V.Object<{
      set: S;
      push: PushSchema<M, L>;
      unshift: PushSchema<M, L>;
    }>,
  ]
>;

/** The arithmetic update bag of one kind, held to that kind's member schema. */
export const arithmeticUpdateFamily =
  <M extends V.Schema>(member: M) =>
  <S extends V.Schema>(schema: S): ArithmeticUpdateSchema<S, M> =>
    v.union([
      v.shorthandUpdate(schema),
      v.object({
        set: schema,
        increment: member,
        decrement: member,
        multiply: member,
        divide: member,
      }),
    ]);

/**
 * The set-only update.
 *
 * `{ partial: false }` is what makes the bare `{}` a refusal rather than a
 * no-op: with exactly one entry, partial would admit an update that names no
 * value at all.
 */
export const buildSetUpdate = <S extends V.Schema>(
  schema: S
): SetUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
    v.object({ set: schema }, { partial: false }),
  ]);

/** The list update bag of one kind, held to that kind's member and list. */
export const listUpdateFamily =
  <M extends V.Schema, L extends V.Schema>(member: M, list: L) =>
  <S extends V.Schema>(schema: S): ListUpdateSchema<S, M, L> =>
    v.union([
      v.shorthandUpdate(schema),
      v.object({
        set: schema,
        push: v.union([v.shorthandArray(member), list]),
        unshift: v.union([v.shorthandArray(member), list]),
      }),
    ]);

// =============================================================================
// THE INTERNED BUILDER TAIL
// =============================================================================

/** One filter cache and one update cache, private to one scalar kind. */
export interface ScalarInterners {
  readonly update: (key: string | null, build: () => unknown) => unknown;
  readonly filter: (key: string | null, build: () => unknown) => unknown;
}

/**
 * The intern caches of ONE kind.
 *
 * Per kind, never shared: {@link scalarInternKey} spells only the flag bits, so
 * an `s.int()` and an `s.number()` with the same flags produce the same key and
 * would otherwise collide on one cache.
 */
export const createScalarInterners = (): ScalarInterners => ({
  update: createScalarInterner<unknown>(),
  filter: createScalarInterner<unknown>(),
});

/**
 * One variant's interned thunk, built in a scope of its OWN.
 *
 * Each call captures one cache, one key and one factory and nothing else. A
 * thunk written inline beside its siblings would instead capture the whole
 * builder record, and an unresolved variant would keep its resolved siblings'
 * factories reachable — the release half of the invariant `lazy.ts` states.
 *
 * The `as never` is the one place the interner's `unknown` value meets a kind's
 * CONDITIONAL variant type (`F["array"] extends true ? … : …`), which no
 * ternary can be proved to inhabit. That seam already existed; it was spelled
 * twice per kind, sixteen times over, and is spelled once here.
 */
const internedVariant =
  (
    intern: (key: string | null, build: () => unknown) => unknown,
    key: string | null,
    build: () => unknown
  ): (() => never) =>
  () =>
    intern(key, build) as never;

/**
 * The tail every interned kind shares: pay-per-use materialization of the three
 * variants, with `update` and `filter` interned under the field's key.
 *
 * `create` is NOT interned — it carries the field's own default, nullability
 * and arity, so two fields share nothing there, and it keeps its exact type.
 */
export const internedScalarSchemas = <T extends ScalarVariantSchemas>(
  interners: ScalarInterners,
  key: string | null,
  builders: {
    base: T["base"];
    create: () => T["create"];
    update: () => unknown;
    filter: () => unknown;
  }
) =>
  lazyScalarSchemas<T>({
    base: builders.base,
    create: builders.create,
    update: internedVariant(interners.update, key, builders.update),
    filter: internedVariant(interners.filter, key, builders.filter),
  });
