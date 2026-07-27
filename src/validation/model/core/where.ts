import type { AnyModel } from "@schema/model";
import v, { type V } from "../../primitives/v";
import type { VibSchema } from "../../types";
import type { ScalarSchemas } from "../index";
import {
  type CompoundConstraintFilterSchema,
  getCompoundConstraintFilter,
  getUniqueFilter,
  type UniqueFilterSchema,
} from "./filter";

// =============================================================================
// WHERE SCHEMA
// =============================================================================

/**
 * Build full where schema - scalar + relation filters + AND/OR/NOT
 * Uses thunks for recursive self-references
 */
export type WhereSchemaBase<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  V.FromObject<F["scalars"], "filter">["entries"] &
    V.FromObject<F["relations"], "filter">["entries"]
>;

export type WhereSchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  {
    AND: () => V.Optional<
      V.Union<readonly [WhereSchema<M, F>, V.Array<WhereSchema<M, F>>]>
    >;
    OR: () => V.Optional<V.Array<WhereSchema<M, F>>>;
    NOT: () => V.Optional<
      V.Union<readonly [WhereSchema<M, F>, V.Array<WhereSchema<M, F>>]>
    >;
  } & WhereSchemaBase<M, F>["entries"]
>;

export const getWhereSchema = <M extends AnyModel, F extends ScalarSchemas<M>>(
  fieldSchemas: F
): WhereSchema<M, F> => {
  // Build scalar and relation filter entries

  const scalarFilter = v.fromObject<F["scalars"], "filter">(
    fieldSchemas.scalars,
    "filter"
  );
  const relationFilter = v.fromObject<F["relations"], "filter">(
    fieldSchemas.relations,
    "filter"
  );

  // Create the recursive where schema with AND/OR/NOT using thunks
  const whereSchema = v
    .object({
      // Recursive AND/OR/NOT using thunks
      AND: () => v.optional(v.union([whereSchema, v.array(whereSchema)])),
      OR: () => v.optional(v.array(whereSchema)),
      NOT: () => v.optional(v.union([whereSchema, v.array(whereSchema)])),
    })
    .extend(scalarFilter.entries)
    .extend(relationFilter.entries);

  return whereSchema;
};

// =============================================================================
// WHERE UNIQUE SCHEMA
// =============================================================================

/**
 * Build whereUnique schema - unique fields + compound constraints
 * Combines single-field uniques with compound ID and compound uniques
 */
type WhereUniqueEntries<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = UniqueFilterSchema<M, F>["entries"] &
  CompoundConstraintFilterSchema<M>["entries"];

type WhereUniqueKey<M extends AnyModel, F extends ScalarSchemas<M>> = Extract<
  keyof WhereUniqueEntries<M, F>,
  string
>;

type WhereUniqueOptions<M extends AnyModel, F extends ScalarSchemas<M>> = {
  nonEmpty: true;
  requiresOneOf: readonly [WhereUniqueKey<M, F>[]];
};

export type WhereUniqueSchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<WhereUniqueEntries<M, F>, WhereUniqueOptions<M, F>>;
export const getWhereUniqueSchema = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  model: M,
  fieldSchemas: F
): WhereUniqueSchema<M, F> => {
  // Single-field unique constraints
  const uniqueFilter = getUniqueFilter(model, fieldSchemas);

  // Add compound constraints (ID + uniques) using the compound filter helpers
  const compoundConstraintFilter = getCompoundConstraintFilter(model);

  const entries: WhereUniqueEntries<M, F> = {
    ...uniqueFilter.entries,
    ...compoundConstraintFilter.entries,
  };
  const keys = Object.keys(entries) as WhereUniqueKey<M, F>[];

  return v.object(entries, {
    nonEmpty: true,
    requiresOneOf: [keys],
  });
};

// =============================================================================
// EXTENDED WHERE UNIQUE SCHEMA (Prisma >= 4.5)
// =============================================================================

/**
 * The message a relation key gets inside an extended unique `where`.
 *
 * Prisma's extended `whereUnique` also admits relation filters; viborm's does
 * not, deliberately (W4-U1). The filter portion of a unique `where` compiles
 * into the **write** statement too (batch mode addresses the row by the original
 * `where`, so the guard and the write pin the same row), and there the target
 * table carries no alias — a relation filter's correlated `EXISTS` subquery
 * would have to correlate against unqualified columns, and MySQL rejects a
 * subquery reading the table being mutated (error 1093) unless it is wrapped.
 * Rather than answer differently per dialect, the key is refused by name and the
 * caller is pointed at the operations that do answer it identically everywhere.
 */
const extendedWhereUniqueRelationRefusal = (key: string): string =>
  `Relation filter '${key}' is not supported inside a unique 'where'. An extended unique 'where' accepts non-unique scalar filters and AND/OR/NOT only — use findFirst / updateMany / deleteMany to filter by a relation.`;

type RefusedRelationEntries<M extends AnyModel, F extends ScalarSchemas<M>> = {
  [K in keyof F["relations"]]: VibSchema<never, never>;
};

const getRefusedRelationEntries = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  fieldSchemas: F
): RefusedRelationEntries<M, F> => {
  const entries: Record<string, unknown> = {};
  for (const key of Object.keys(fieldSchemas.relations as object)) {
    entries[key] = v.refused(extendedWhereUniqueRelationRefusal(key));
  }
  return entries as RefusedRelationEntries<M, F>;
};

type ScalarWhereEntries<M extends AnyModel, F extends ScalarSchemas<M>> = {
  AND: () => V.Optional<
    V.Union<
      readonly [ScalarWhereSchema<M, F>, V.Array<ScalarWhereSchema<M, F>>]
    >
  >;
  OR: () => V.Optional<V.Array<ScalarWhereSchema<M, F>>>;
  NOT: () => V.Optional<
    V.Union<
      readonly [ScalarWhereSchema<M, F>, V.Array<ScalarWhereSchema<M, F>>]
    >
  >;
} & V.FromObject<F["scalars"], "filter">["entries"] &
  RefusedRelationEntries<M, F>;

/**
 * The scalar-only `where` reachable from inside an extended unique `where`'s
 * `AND` / `OR` / `NOT`. Same recursion as {@link WhereSchema}, minus relation
 * filters (refused by name, see above).
 */
export type ScalarWhereSchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<ScalarWhereEntries<M, F>>;

export const getScalarWhereSchema = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  fieldSchemas: F
): ScalarWhereSchema<M, F> => {
  const scalarFilter = v.fromObject<F["scalars"], "filter">(
    fieldSchemas.scalars,
    "filter"
  );
  const scalarWhere = v
    .object({
      AND: () => v.optional(v.union([scalarWhere, v.array(scalarWhere)])),
      OR: () => v.optional(v.array(scalarWhere)),
      NOT: () => v.optional(v.union([scalarWhere, v.array(scalarWhere)])),
    })
    .extend(scalarFilter.entries)
    .extend(getRefusedRelationEntries<M, F>(fieldSchemas));

  return scalarWhere;
};

/**
 * Build the EXTENDED whereUnique schema — Prisma >= 4.5's `AtLeast<…>` shape:
 * the unique discriminators (single field or complete compound) PLUS ordinary
 * non-unique scalar filters and `AND` / `OR` / `NOT`, with **at least one**
 * discriminator still required (`requiresOneOf`, which the type level applies as
 * a union of "this key is required" shapes — Prisma's `AtLeast`, for free).
 *
 * SCOPE (deliberate, W4-U1): this schema is the `where` of the TOP-LEVEL
 * `findUnique` / `findUniqueOrThrow` / `update` / `delete` / `upsert` only.
 * Nested relation-write target selectors and `cursor` keep the strict
 * {@link getWhereUniqueSchema}: a nested target is located by PK boundaries the
 * extra filters would collide with, and a cursor's meaning is an exact row
 * address. See `docs/content/docs/client/*`.
 *
 * A unique field keeps its BARE-VALUE schema at the top level (Prisma spells
 * `{ email: "a@b" }`, never `{ email: { equals: … } }`, in the unique position),
 * so the discriminator entries are applied LAST and win over the filter entry of
 * the same name. Inside `AND` / `OR` / `NOT` the same field is an ordinary
 * filter, exactly as in Prisma.
 */
export type WhereUniqueExtendedSchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  Omit<ScalarWhereEntries<M, F>, keyof WhereUniqueEntries<M, F>> &
    WhereUniqueEntries<M, F>,
  WhereUniqueOptions<M, F>
>;

export const getWhereUniqueExtendedSchema = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  model: M,
  fieldSchemas: F
): WhereUniqueExtendedSchema<M, F> => {
  const uniqueFilter = getUniqueFilter(model, fieldSchemas);
  const compoundConstraintFilter = getCompoundConstraintFilter(model);
  const scalarWhere = getScalarWhereSchema<M, F>(fieldSchemas);

  const discriminators: WhereUniqueEntries<M, F> = {
    ...uniqueFilter.entries,
    ...compoundConstraintFilter.entries,
  };
  const keys = Object.keys(discriminators) as WhereUniqueKey<M, F>[];
  const entries = {
    ...scalarWhere.entries,
    ...discriminators,
  } as Omit<ScalarWhereEntries<M, F>, keyof WhereUniqueEntries<M, F>> &
    WhereUniqueEntries<M, F>;

  return v.object(entries, {
    nonEmpty: true,
    requiresOneOf: [keys],
  });
};
