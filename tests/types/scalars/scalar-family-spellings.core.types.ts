/**
 * The shared scalar families, held to the spellings the kinds gave up.
 *
 * `src/validation/scalars/family.ts` re-spelled ten kinds' `update` and
 * `filter` types through one set of generic aliases (footprint workstream 2).
 * The runtime census in `tests/unit/scalars/_scalar-shape-census.ts` pins the
 * TREES those builders produce; nothing pinned the TYPES a user infers from
 * them, and `tsc` passing proves only that the tree compiles, not that
 * `InferInput` still answers what it answered before.
 *
 * So this file holds each family against the private alias the per-kind module
 * carried on `footprint-safe-scope`, copied verbatim below. `Mutual` is
 * assignability in both directions: the family's alias and the kind's old one
 * must each be usable where the other was.
 *
 * ONE deviation is deliberate and is spelled as such at the bottom. String's
 * `StringListUpdateSchema` wrote its union arms as a MUTABLE tuple; every other
 * kind wrote `readonly`, and `readonly` is what `v.union`'s `const` type
 * parameter actually infers, so the family owns the readonly spelling and a
 * string list field's `update` narrows by exactly that. It is reachable from no
 * package entry, and what a caller infers through it is unchanged — which is
 * what `SameIo` states.
 */

import { s } from "@schema";
import type { InferInput, InferOutput } from "@validation";
import type { V } from "@validation/primitives/v";
import type {
  ArithmeticUpdateSchema,
  ComparisonFilterSchema,
  ListFilterSchema,
  ListUpdateSchema,
  SetUpdateSchema,
} from "@validation/scalars/family";
import type { NegatableFilterSchema } from "@validation/scalars/negatable-filter";

type Assignable<A, B> = [A] extends [B] ? true : false;

/** Each type usable where the other was. */
type Mutual<A, B> = Assignable<A, B> extends true ? Assignable<B, A> : false;

/** The two things a caller actually reads off a schema type. */
type SameIo<A extends V.Schema, B extends V.Schema> = Mutual<
  InferInput<A>,
  InferInput<B>
> extends true
  ? Mutual<InferOutput<A>, InferOutput<B>>
  : false;

// =============================================================================
// THE FIELD SCHEMAS THE ALIASES ARE APPLIED TO
// =============================================================================

const intField = s.int();
const nullableIntField = s.int().nullable();
const intListField = s.int().array();
const stringField = s.string();
const stringListField = s.string().array();

type IntBase = (typeof intField)["~"]["state"]["base"];
type NullableIntBase = (typeof nullableIntField)["~"]["state"]["base"];
type IntListBase = (typeof intListField)["~"]["state"]["base"];
type StringBase = (typeof stringField)["~"]["state"]["base"];
type StringListBase = (typeof stringListField)["~"]["state"]["base"];

type IntList = V.Integer<{ array: true }>;
type StringList = V.String<{ array: true }>;
type Ctx = V.Operand<any>;

// =============================================================================
// THE PRE-BRANCH SPELLINGS, VERBATIM
// =============================================================================

type OldIntOperand<
  S extends V.Schema,
  C extends V.Operand<any>,
> = V.ComparisonOperand<"int", S, C>;

type OldIntFilterBase<S extends V.Schema, C extends V.Operand<any>> = {
  equals: OldIntOperand<S, C>;
  in: V.Integer<{ array: true }>;
  notIn: V.Integer<{ array: true }>;
  lt: OldIntOperand<V.Integer, C>;
  lte: OldIntOperand<V.Integer, C>;
  gt: OldIntOperand<V.Integer, C>;
  gte: OldIntOperand<V.Integer, C>;
};

type OldIntFilterSchema<
  S extends V.Schema,
  C extends V.Operand<any>,
> = NegatableFilterSchema<OldIntOperand<S, C>, OldIntFilterBase<S, C>>;

type OldIntListFilterBase<S extends V.Schema> = {
  equals: S;
  has: V.Integer;
  hasEvery: V.Integer<{ array: true }>;
  hasSome: V.Integer<{ array: true }>;
  isEmpty: V.Boolean;
};

type OldIntListFilterSchema<S extends V.Schema> = NegatableFilterSchema<
  S,
  OldIntListFilterBase<S>
>;

type OldIntUpdateSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandUpdate<S>,
    V.Object<{
      set: S;
      increment: V.Integer;
      decrement: V.Integer;
      multiply: V.Integer;
      divide: V.Integer;
    }>,
  ]
>;

type OldIntListUpdateSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandUpdate<S>,
    V.Object<{
      set: S;
      push: V.Union<
        readonly [V.ShorthandArray<V.Integer>, V.Integer<{ array: true }>]
      >;
      unshift: V.Union<
        readonly [V.ShorthandArray<V.Integer>, V.Integer<{ array: true }>]
      >;
    }>,
  ]
>;

type OldStringUpdateSchema<S extends V.Schema> = V.Union<
  readonly [V.ShorthandUpdate<S>, V.Object<{ set: S }, { partial: false }>]
>;

type OldStringListFilterBaseSchema<S extends V.Schema> = {
  equals: S;
  has: V.String;
  hasEvery: V.String<{ array: true }>;
  hasSome: V.String<{ array: true }>;
  isEmpty: V.Boolean;
};

type OldStringListFilterSchema<S extends V.Schema> = NegatableFilterSchema<
  S,
  OldStringListFilterBaseSchema<S>
>;

/** The one mutable arm tuple in the estate; see the header. */
type OldStringListUpdateSchema<S extends V.Schema> = V.Union<
  [
    V.ShorthandUpdate<S>,
    V.Object<{
      set: S;
      push: V.Union<
        readonly [V.ShorthandArray<V.String>, V.String<{ array: true }>]
      >;
      unshift: V.Union<
        readonly [V.ShorthandArray<V.String>, V.String<{ array: true }>]
      >;
    }>,
  ]
>;

// =============================================================================
// THE FAMILY ANSWERS THE SAME TYPE
// =============================================================================

const _intFilter: Mutual<
  OldIntFilterSchema<IntBase, Ctx>,
  ComparisonFilterSchema<"int", IntBase, V.Integer, IntList, Ctx>
> = true;

const _nullableIntFilter: Mutual<
  OldIntFilterSchema<NullableIntBase, Ctx>,
  ComparisonFilterSchema<"int", NullableIntBase, V.Integer, IntList, Ctx>
> = true;

const _intListFilter: Mutual<
  OldIntListFilterSchema<IntListBase>,
  ListFilterSchema<IntListBase, V.Integer, IntList>
> = true;

const _intUpdate: Mutual<
  OldIntUpdateSchema<IntBase>,
  ArithmeticUpdateSchema<IntBase, V.Integer>
> = true;

const _nullableIntUpdate: Mutual<
  OldIntUpdateSchema<NullableIntBase>,
  ArithmeticUpdateSchema<NullableIntBase, V.Integer>
> = true;

const _intListUpdate: Mutual<
  OldIntListUpdateSchema<IntListBase>,
  ListUpdateSchema<IntListBase, V.Integer, IntList>
> = true;

const _stringUpdate: Mutual<
  OldStringUpdateSchema<StringBase>,
  SetUpdateSchema<StringBase>
> = true;

const _stringListFilter: Mutual<
  OldStringListFilterSchema<StringListBase>,
  ListFilterSchema<StringListBase, V.String, StringList>
> = true;

// =============================================================================
// THE ONE DELIBERATE DEVIATION
// =============================================================================

/** A mutable arm tuple still goes where the family's readonly one is wanted. */
const _stringListUpdateWidens: Assignable<
  OldStringListUpdateSchema<StringListBase>,
  ListUpdateSchema<StringListBase, V.String, StringList>
> = true;

/** And nothing a caller infers moved with it. */
const _stringListUpdateInference: SameIo<
  OldStringListUpdateSchema<StringListBase>,
  ListUpdateSchema<StringListBase, V.String, StringList>
> = true;
