import type { AnyModel } from "@schema/model";
import type { StringKeyOf } from "@schema/model/helper";
import { relationCardinality } from "@schema/relation/cardinality";
import type { RelationState } from "@schema/relation/types";
import type { ScalarState } from "@schema/scalars";
import {
  type SortOrderSchema,
  sortOrderSchema,
  type VectorSortOrderSchema,
  vectorSortOrderSchema,
} from "@validation/model/core/orderby";
import { createSchema, fail } from "../primitives/helpers";
import v, { type V } from "../primitives/v";
import type { VibSchema } from "../types";
import type { SchemaGetter, TargetModel } from "./helpers";

type ModelStateOf<M extends AnyModel> = M["~"]["state"];
type ModelScalars<M extends AnyModel> = ModelStateOf<M>["scalars"];
type ModelScalarKey<M extends AnyModel> = StringKeyOf<ModelScalars<M>>;

type ScalarStateOf<F> = F extends { "~": { state: infer S } }
  ? S extends ScalarState
    ? S
    : never
  : never;

type VectorScalarKey<M extends AnyModel> = {
  [K in keyof ModelScalars<M>]: ScalarStateOf<
    ModelScalars<M>[K]
  >["type"] extends "vector"
    ? K extends string
      ? K
      : never
    : never;
}[keyof ModelScalars<M>];

type NonVectorScalarKey<M extends AnyModel> = Exclude<
  ModelScalarKey<M>,
  VectorScalarKey<M>
>;

type ModelScalarOrderByEntries<M extends AnyModel> = V.FromKeys<
  NonVectorScalarKey<M>[],
  SortOrderSchema
>["entries"] &
  V.FromKeys<VectorScalarKey<M>[], VectorSortOrderSchema>["entries"];

type RuntimeRelationMap = Record<string, { "~": { state: RelationState } }>;

/**
 * Maximum number of to-one relation hops an `orderBy` chain may cross, e.g.
 * `orderBy: { a: { b: { c: { name: 'asc' } } } }` is 3 hops.
 *
 * Raised 3 -> 8 by decision D-5 (docs/architecture/prisma-parity-v2-plan.md).
 * Lifting it further, or removing it, needs a lazy self-reference in the
 * orderBy schema rather than this bounded strict-schema recursion.
 *
 * This is the FRONT LINE: past the cap the schema simply stops offering
 * relation keys, so an over-deep chain is rejected here as an unknown key.
 * MIRRORED by MAX_RELATION_ORDER_DEPTH in
 * src/query-engine/builders/relation-orderby-builder.ts, which re-checks the
 * same cap while building joins. The two constants must stay equal;
 * tests/query-engine/orderby-relation-depth.test.ts pins that they do.
 */
const MAX_RELATION_ORDER_DEPTH = 8;

/**
 * Type-level twin of MAX_RELATION_ORDER_DEPTH: one tuple element per allowed
 * hop, consumed by ConsumeRelationHop as the schema type recurses. Derived
 * from the constant so the two cannot drift.
 */
type BuildRelationOrderDepth<
  N extends number,
  Acc extends readonly unknown[] = [],
> = Acc["length"] extends N
  ? Acc
  : BuildRelationOrderDepth<N, [...Acc, unknown]>;

type RelationOrderDepth = BuildRelationOrderDepth<
  typeof MAX_RELATION_ORDER_DEPTH
>;

type ConsumeRelationHop<Depth extends readonly unknown[]> =
  Depth extends readonly [unknown, ...infer Rest extends readonly unknown[]]
    ? Rest
    : [];

type ToOneRelationKeys<M extends AnyModel> = {
  [K in keyof ModelStateOf<M>["relations"]]: RelationStateOf<
    ModelStateOf<M>["relations"][K]
  >["type"] extends "oneToOne" | "manyToOne"
    ? K extends string
      ? K
      : never
    : never;
}[keyof ModelStateOf<M>["relations"]];

type RelationStateOf<R> = R extends { "~": { state: infer S } }
  ? S extends RelationState
    ? S
    : never
  : never;

type RelationTargetModel<R> = TargetModel<RelationStateOf<R>>;

type ToOneRelationOrderByEntries<
  M extends AnyModel,
  Depth extends readonly unknown[],
> = Depth extends readonly [unknown, ...infer Rest extends readonly unknown[]]
  ? {
      [K in ToOneRelationKeys<M>]: () => ToOneModelOrderBySchema<
        RelationTargetModel<ModelStateOf<M>["relations"][K]>,
        Rest
      >;
    }
  : {};

type ToOneModelOrderBySchema<
  M extends AnyModel,
  Depth extends readonly unknown[],
> = V.Object<
  ModelScalarOrderByEntries<M> & ToOneRelationOrderByEntries<M, Depth>
>;

type ToOneOrderByRemainingDepth = ConsumeRelationHop<RelationOrderDepth>;

const isToOneRelation = (state: RelationState): boolean =>
  relationCardinality(state) === "one";

type ToManyRelationOrderByFailureSchema = VibSchema<never, never>;
type RuntimeToOneRelationOrderByEntry =
  | (() => ToOneModelOrderBySchema<AnyModel, []>)
  | ToManyRelationOrderByFailureSchema;

const createToManyRelationOrderByFailureSchema = (
  relationName: string
): ToManyRelationOrderByFailureSchema => {
  return createSchema<never, never>("relation_orderby_to_many", () =>
    fail(
      `Relation orderBy '${relationName}' cannot order through a to-many relation; use '_count'.`
    )
  );
};

const getModelScalarOrderByEntries = <M extends AnyModel>(
  target: M
): ModelScalarOrderByEntries<M> => {
  const vectorScalarKeys: VectorScalarKey<M>[] = [];
  const nonVectorScalarKeys: NonVectorScalarKey<M>[] = [];
  const scalarKeys = Object.keys(
    target["~"].state.scalars
  ) as ModelScalarKey<M>[];

  for (const fieldName of scalarKeys) {
    const scalar = target["~"].state.scalars[fieldName];
    if (scalar["~"].state.type === "vector") {
      vectorScalarKeys.push(fieldName as VectorScalarKey<M>);
      continue;
    }
    nonVectorScalarKeys.push(fieldName as NonVectorScalarKey<M>);
  }

  const scalarEntries = v.fromKeys<NonVectorScalarKey<M>[], SortOrderSchema>(
    nonVectorScalarKeys,
    sortOrderSchema
  );
  const vectorEntries = v.fromKeys<VectorScalarKey<M>[], VectorSortOrderSchema>(
    vectorScalarKeys,
    vectorSortOrderSchema
  );

  return {
    ...scalarEntries.entries,
    ...vectorEntries.entries,
  };
};

const getToOneRelationOrderByEntries = <
  M extends AnyModel,
  Depth extends readonly unknown[],
>(
  target: M,
  depth: number
): ToOneRelationOrderByEntries<M, Depth> => {
  if (depth <= 0) {
    return {} as ToOneRelationOrderByEntries<M, Depth>;
  }

  const relationEntries: Record<string, RuntimeToOneRelationOrderByEntry> = {};
  const relations = target["~"].state.relations as RuntimeRelationMap;
  for (const [relationName, relation] of Object.entries(relations)) {
    const relationState = relation["~"].state;
    if (isToOneRelation(relationState)) {
      relationEntries[relationName] = () =>
        buildToOneOrderBySchema(relationState.getter() as AnyModel, depth - 1);
      continue;
    }

    relationEntries[relationName] =
      createToManyRelationOrderByFailureSchema(relationName);
  }

  return relationEntries as ToOneRelationOrderByEntries<M, Depth>;
};

const buildToOneOrderBySchema = <
  M extends AnyModel,
  Depth extends readonly unknown[] = ToOneOrderByRemainingDepth,
>(
  target: M,
  depth: number
): ToOneModelOrderBySchema<M, Depth> => {
  const scalarEntries = getModelScalarOrderByEntries(target);
  const relationEntries = getToOneRelationOrderByEntries<M, Depth>(
    target,
    depth
  );

  return v.object({
    ...scalarEntries,
    ...relationEntries,
  }) as ToOneModelOrderBySchema<M, Depth>;
};

/**
 * To-one orderBy: scalar fields and bounded to-one chains from the related model.
 * e.g., orderBy: { author: { name: 'asc' } }
 */
export type ToOneOrderBySchema<S extends RelationState> =
  () => ToOneModelOrderBySchema<TargetModel<S>, ToOneOrderByRemainingDepth>;

export const toOneOrderByFactory = <
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  state: S,
  _targetSchemas: T
): ToOneOrderBySchema<S> => {
  return () =>
    buildToOneOrderBySchema(
      state.getter() as TargetModel<S>,
      MAX_RELATION_ORDER_DEPTH - 1
    );
};

/**
 * To-many orderBy: can order by _count aggregate
 * e.g., orderBy: { posts: { _count: 'desc' } }
 */
export type ToManyOrderBySchema<S extends RelationState> = V.Object<{
  _count: V.Enum<["asc", "desc"]>;
}>;
export const toManyOrderByFactory = <S extends RelationState>(
  _state: S
): ToManyOrderBySchema<S> => {
  return v.object({
    _count: v.enum(["asc", "desc"]),
  });
};
