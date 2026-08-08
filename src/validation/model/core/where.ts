import type { AnyModel } from "@schema/model";
import { scopeOperands } from "@validation/primitives/operand";
import v, { type V } from "../../primitives/v";
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
    V.FromObject<F["relations"], "filter">["entries"] &
    V.FromObject<F["polymorphic"], "filter">["entries"]
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
  model: M,
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
  const polymorphicFilter = v.fromObject<F["polymorphic"], "filter">(
    fieldSchemas.polymorphic,
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
    .extend(relationFilter.entries)
    .extend(polymorphicFilter.entries);

  // A `where` is the operand-callback scope boundary: `ctx.fields` inside it
  // names THIS model's columns. A nested relation filter embeds the TARGET
  // model's `where`, which carries its own boundary, so depth re-scopes for
  // free and pops back on the way out (see `primitives/operand.ts`).
  return scopeOperands(whereSchema, model);
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
 * The merged entry set: the ordinary `where` MINUS the names the discriminators
 * take back, PLUS the discriminators. Named once so the local that builds it can
 * be annotated with the same type `WhereUniqueExtendedSchema` declares.
 */
type WhereUniqueExtendedEntries<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = Omit<WhereSchema<M, F>["entries"], keyof WhereUniqueEntries<M, F>> &
  WhereUniqueEntries<M, F>;

/**
 * Build the EXTENDED whereUnique schema — Prisma >= 4.5's `AtLeast<…>` shape:
 * the unique discriminators (single field or complete compound) PLUS the model's
 * ordinary `where` — non-unique scalar filters, RELATION filters, and `AND` /
 * `OR` / `NOT` — with **at least one** discriminator still required
 * (`requiresOneOf`, which the type level applies as a union of "this key is
 * required" shapes — Prisma's `AtLeast`, for free).
 *
 * SCOPE. This schema is the `where` of the TOP-LEVEL `findUnique` /
 * `findUniqueOrThrow` / `update` / `delete` / `upsert`, and — since N6-U1
 * (decision D-N1) — of the NESTED `update` / `upsert` / `delete` TARGET selectors
 * too. W4-U1 kept those nested positions strict for a stated reason: "a nested
 * target is located by PK boundaries the extra filters would collide with". N1 and
 * N4-U1 removed that collision by making a nested locate RETURN its primary key
 * however the row was named, so the scoping had outlived its cause and the three
 * target positions now take this schema. Prisma's nested selectors are unique-only
 * there, which makes this a deliberate SUPERSET (capability matrix, §write).
 *
 * Still strict, and for reasons that are their own, not leftovers:
 *  · `connect` / `disconnect` / `set` / `connectOrCreate.where` — these NAME a row
 *    to link, they do not locate one to mutate. Prisma parity, and nothing in the
 *    engine reads a filter half there.
 *  · `cursor` — its meaning is an exact row address in an ordering, not a predicate.
 *
 * The filter half stays inert to everything compile-time wherever this schema is
 * used: `getWhereUniqueEntries` returns the discriminator alone, so pins, `racePin`
 * attribution and identity cannot see it by construction. See
 * `query-engine-v2/shared.ts` `uniqueSelectorConjuncts` for the one place the two
 * halves are recombined, and `docs/content/docs/client/*`.
 *
 * RELATION FILTERS (N6-U2). They were refused here until the write half learned
 * to name its own table. A unique `where`'s filter half compiles into the
 * UPDATE/DELETE as well as the locate (batch mode addresses the row by the
 * original `where`, so guard and write pin one row), and there the target
 * carries no alias: a correlated `EXISTS` built against bare column names binds
 * the OUTER column to the RELATED table whenever both models carry that name —
 * silently, on every dialect. `buildUpdate` / `buildDelete` now qualify the
 * unique `where` by the target's table name and declare it as the
 * `mutationTable`, which is exactly what `buildUpdateMany` / `buildDeleteMany`
 * have always done: the correlation is unambiguous, and MySQL's refusal to read
 * the mutated table in a subquery (error 1093) is answered by the same
 * derived-table wrapper, engaged only where the relation actually reads that
 * table (a self-relation, or a self-M2M's target side).
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
> = V.Object<WhereUniqueExtendedEntries<M, F>, WhereUniqueOptions<M, F>>;

export const getWhereUniqueExtendedSchema = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  model: M,
  fieldSchemas: F
): WhereUniqueExtendedSchema<M, F> => {
  const uniqueFilter = getUniqueFilter(model, fieldSchemas);
  const compoundConstraintFilter = getCompoundConstraintFilter(model);
  const where = getWhereSchema<M, F>(model, fieldSchemas);

  const discriminators: WhereUniqueEntries<M, F> = {
    ...uniqueFilter.entries,
    ...compoundConstraintFilter.entries,
  };
  const keys = Object.keys(discriminators) as WhereUniqueKey<M, F>[];
  // Annotated, not asserted, like `discriminators` above and the sibling
  // `getWhereUniqueSchema`: the annotation checks the FILTER half of the merge
  // (dropping `...where.entries` is a compile error; under an `as` it was not).
  // It cannot check the discriminator half — those entries are optional in the
  // ordinary `where` they overwrite, so their absence is assignable either way.
  const entries: WhereUniqueExtendedEntries<M, F> = {
    ...where.entries,
    ...discriminators,
  };

  // The filter portion of an extended unique `where` is an ordinary filter, so
  // it opens the same operand callbacks and needs the same scope. (The
  // discriminator entries are BARE values — no operand position there.)
  return scopeOperands(
    v.object(entries, {
      nonEmpty: true,
      requiresOneOf: [keys],
    }),
    model
  );
};
