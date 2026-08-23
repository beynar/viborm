// Relation Select & Include Schemas

import type { AnyModel, ModelState } from "@schema/model";
import type { StringKeyOf } from "@schema/model/helper";
import type { AnyRelation } from "@schema/relation";
import type { RelationState } from "@schema/relation/types";
import { withOmitProjection } from "../model/args/omit";
import {
  type PaginationSkipSchema,
  type PaginationTakeSchema,
  paginationSkip,
  paginationTake,
} from "../model/args/pagination";
import { rejectSelectInclude } from "../model/args/select-include-exclusivity";
import { projectableScalarNames } from "../model/core/projection";
import v, { type V } from "../primitives/v";
import type { VibSchema } from "../types";
import type { GetTargetSchemas, SchemaGetter, TargetModel } from "./helpers";

// =============================================================================
// TRANSFORM HELPERS
// =============================================================================

const getTargetState = (relation: AnyRelation): ModelState =>
  getTargetModel(relation)["~"].state as ModelState;

/**
 * `settleTarget` is the one sanctioned getter invocation: the target is settled
 * once per declaration and every schema graph reusing this terminal observes
 * the same return or the same normalized `Error`.
 */
const getTargetModel = (relation: AnyRelation): AnyModel =>
  relation["~"].settleTarget() as AnyModel;

const buildSelectionForModel = (target: AnyModel): Record<string, true> => {
  const select: Record<string, true> = {};
  for (const field of projectableScalarNames(target)) {
    select[field] = true;
  }
  return select;
};

/**
 * The label a nested node's `omit` failure carries. Relations name themselves
 * when the schema disambiguated them (`.name()`); otherwise the message still
 * names the target model, which is the part a caller needs.
 */
const nestedOmitLabel = (relation: AnyRelation): string => {
  const name = relation["~"].state.name;
  return name ? `include.${name}` : "a nested include";
};

/**
 * A relation node accepts `omit` exactly like a top-level operation does:
 * subtractive with `select`, composable with `include`, and desugared into one
 * explicit `select` before anything downstream sees it. Wrapping the node
 * schema with the SAME helper the top level uses is what keeps the two surfaces
 * from drifting — and it runs BEFORE `includeToField`, which then finds a
 * `select` already in place and leaves it alone.
 */
const withOmitForModel = <Schema extends V.Object<any>>(
  target: AnyModel,
  label: string,
  schema: Schema
): Schema => withOmitProjection(schema as never, target, label) as never;

const withNestedOmit = <Schema extends V.Object<any>>(
  relation: AnyRelation,
  schema: Schema
): Schema =>
  withOmitForModel(getTargetModel(relation), nestedOmitLabel(relation), schema);

/**
 * Nested `distinct`: scalar field names of the RELATED model, deduplicating
 * that relation's ordered rows before `take`/`skip` window them (the same
 * enum-of-scalars schema the top-level findMany args use).
 */
type NestedDistinctSchema<S extends RelationState> = V.Enum<
  StringKeyOf<TargetModel<S>["~"]["state"]["scalars"]>[],
  { array: true }
>;

const nestedDistinctNames = <S extends RelationState>(
  relation: AnyRelation
): StringKeyOf<TargetModel<S>["~"]["state"]["scalars"]>[] =>
  Object.keys(getTargetState(relation).scalars) as StringKeyOf<
    TargetModel<S>["~"]["state"]["scalars"]
  >[];

type IncludeToField<Schema extends V.Object<any>> = V.Coerce<
  Schema,
  Schema[" vibInferred"]["1"] & { select?: Record<string, true> }
>;

const includeToFieldForModel =
  (target: AnyModel) =>
  <V extends Record<string, any>>(
    value: V
  ): V & { select?: Record<string, true> } => {
    if (Object.hasOwn(value, "select") && value.select !== false) {
      return value;
    }
    const select = buildSelectionForModel(target);
    if (Object.keys(select).length === 0) return value;
    return {
      ...value,
      select,
    };
  };

const includeToField = (relation: AnyRelation) =>
  includeToFieldForModel(getTargetModel(relation));

type BooleanToSelect = V.Coerce<
  V.Boolean,
  { select?: Record<string, true> } | false
>;

/**
 * The node a bare `true` desugars to: an explicit projection of the target's
 * projectable scalars, FRESH on every parse so the engine never receives a
 * schema-level singleton it could mutate. A target with nothing projectable
 * yields `{}`, which the builder reads as "default row".
 */
export const defaultSelectionNode = (
  target: AnyModel
): { select?: Record<string, true> } => {
  const select = buildSelectionForModel(target);
  return Object.keys(select).length > 0 ? { select } : {};
};

// `false` stays `false` so the query engine omits the relation entirely
// (Prisma parity: include/select `rel: false` must not return the relation)
const booleanToSelect = (relation: AnyRelation): BooleanToSelect =>
  v.coerce(
    v.boolean(),
    (value: boolean): { select?: Record<string, true> } | false =>
      value ? defaultSelectionNode(getTargetModel(relation)) : false
  );

// =============================================================================
// INCLUDE FACTORY IMPLEMENTATIONS
// =============================================================================

/**
 * To-one include: true or nested { select, include }
 * `select` and `include` are mutually exclusive on the same node (Prisma parity)
 */

export type ToOneIncludeSchema<S extends RelationState> = V.Union<
  readonly [
    BooleanToSelect,
    IncludeToField<
      V.Object<{
        select: () => GetTargetSchemas<S>["core"]["select"];
        include: () => GetTargetSchemas<S>["core"]["include"];
        omit: () => GetTargetSchemas<S>["core"]["omit"];
      }>
    >,
  ]
>;
export const toOneIncludeFactory = <
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  relation: AnyRelation,
  targetSchemas: T
): ToOneIncludeSchema<S> => {
  return v.union([
    booleanToSelect(relation),
    v.coerce(
      withNestedOmit(
        relation,
        rejectSelectInclude(
          v.object({
            select: () => targetSchemas().core.select,
            include: () => targetSchemas().core.include,
            omit: () => targetSchemas().core.omit,
          })
        )
      ),
      includeToField(relation)
    ),
  ]);
};

/**
 * THE TO-MANY NESTED NODE — `{ where, orderBy, take, skip, cursor, distinct,
 * select, include, omit }`, with `select`/`include` mutually exclusive on the
 * same node (Prisma parity).
 *
 * `take`/`skip`/`cursor`/`distinct` are the very schemas the top level uses: a
 * negative `take` is Prisma's "last N" (the relation subquery runs the reversed
 * order with an absolute limit and the parser restores the logical order), a
 * non-integer take or a negative skip is refused with the top-level message,
 * `cursor` is a whereUnique of the RELATED model applied per parent, and
 * `distinct` names scalars of the RELATED model.
 *
 * DECOUPLED FROM `RelationState` on purpose. Everything the node needs reduces
 * to four facts — the target model (default projection + `omit` desugaring),
 * the label an `omit` failure carries, the target's core schemas, and the
 * target's scalar names for `distinct`. Naming those four directly is what lets
 * a SECOND caller build the identical node without a relation to read them off:
 * a polymorphic collection's per-variant arm
 * (`./polymorphic/select-include.ts`), whose target is chosen by a
 * discriminator rather than by an edge.
 *
 * Extracted rather than hand-copied. Two hand-written copies of these nine keys
 * under `rejectSelectInclude` + `withOmitProjection` + `includeToField` would be
 * two things to keep in step, and the drift would be silent — a polymorphic arm
 * quietly missing `cursor`, say, reads as "not supported" rather than as a bug.
 * `to-many.core.test.ts` is the regression net for the extraction itself.
 */
/** The six core schemas of the related model a to-many node reaches for. */
export type ToManyNestedTargetCore = {
  readonly where: VibSchema<any, any>;
  readonly orderBy: VibSchema<any, any>;
  readonly whereUnique: VibSchema<any, any>;
  readonly select: VibSchema<any, any>;
  readonly include: VibSchema<any, any>;
  readonly omit: VibSchema<any, any>;
};

export type ToManyNestedNodeSchema<
  Core extends ToManyNestedTargetCore,
  Distinct,
> = IncludeToField<
  V.Object<{
    where: () => Core["where"];
    orderBy: () => V.Union<
      readonly [Core["orderBy"], V.Array<Core["orderBy"]>]
    >;
    take: PaginationTakeSchema;
    skip: PaginationSkipSchema;
    cursor: () => Core["whereUnique"];
    distinct: Distinct;
    select: () => Core["select"];
    include: () => Core["include"];
    omit: () => Core["omit"];
  }>
>;

export const buildToManyNestedNode = <
  Core extends ToManyNestedTargetCore,
  ScalarNames extends string[],
>(config: {
  readonly targetModel: AnyModel;
  readonly label: string;
  readonly core: () => Core;
  readonly scalarNames: ScalarNames;
}): ToManyNestedNodeSchema<Core, V.Enum<ScalarNames, { array: true }>> => {
  const { targetModel, label, scalarNames } = config;
  // ELEMENT access, not `core().where`: a dotted read on a value of generic
  // type collapses to the CONSTRAINT's property (`VibSchema<any, any>`), which
  // erases the caller's real schema and with it the whole nested node's input
  // type. Keying with a generic `K` keeps the deferred `Core[K]`.
  const at = <K extends keyof Core>(key: K): Core[K] => config.core()[key];
  return v.coerce(
    withOmitForModel(
      targetModel,
      label,
      rejectSelectInclude(
        v.object({
          where: () => at("where"),
          orderBy: () => {
            const orderBySchema = at("orderBy");
            return v.union([orderBySchema, v.array(orderBySchema)]);
          },
          take: paginationTake(),
          skip: paginationSkip(),
          cursor: () => at("whereUnique"),
          distinct: v.enum(scalarNames, { array: true }),
          select: () => at("select"),
          include: () => at("include"),
          omit: () => at("omit"),
        })
      )
    ),
    includeToFieldForModel(targetModel)
  );
};

export type ToManyIncludeSchema<S extends RelationState> = V.Union<
  readonly [
    BooleanToSelect,
    ToManyNestedNodeSchema<
      GetTargetSchemas<S>["core"],
      NestedDistinctSchema<S>
    >,
  ]
>;
export const toManyIncludeFactory = <
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  relation: AnyRelation,
  targetSchemas: T
): ToManyIncludeSchema<S> => {
  return v.union([
    booleanToSelect(relation),
    buildToManyNestedNode({
      targetModel: getTargetModel(relation),
      label: nestedOmitLabel(relation),
      core: () => targetSchemas().core,
      scalarNames: nestedDistinctNames<S>(relation),
    }),
  ]);
};

/**
 * Relation-level args are the same shape in select and include position
 * (Prisma parity: select/include can alternate down the relation tree)
 */
export type ToOneSelectSchema<S extends RelationState> = ToOneIncludeSchema<S>;
export const toOneSelectFactory = toOneIncludeFactory;

export type ToManySelectSchema<S extends RelationState> =
  ToManyIncludeSchema<S>;
export const toManySelectFactory = toManyIncludeFactory;
