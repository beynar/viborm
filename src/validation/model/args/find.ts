import type { AnyModel } from "@schema/model";
import type { NonPointScalarKeys } from "@schema/model/helper";
import v, { type V } from "../../primitives/v";
import type { CoreSchemas } from "../core";
import type { ScalarSchemas } from "../index";
import { type OmitSchema, withOmitProjection } from "./omit";
import {
  type PaginationSkipSchema,
  type PaginationTakeSchema,
  paginationSkip,
  paginationTake,
} from "./pagination";
import { rejectSelectInclude } from "./select-include-exclusivity";

/**
 * FindUnique args: { where: whereUniqueExtended, select?, include? }
 *
 * `where` is the EXTENDED unique selector (Prisma >= 4.5): at least one unique
 * discriminator, plus any non-unique scalar filters / AND / OR / NOT. `cursor`
 * below keeps the STRICT `whereUnique` — a cursor is an exact row address, not a
 * filtered lookup.
 */

type ModelStateOf<M extends AnyModel> = M["~"]["state"];

/**
 * `distinct` accepts a single scalar name or an array of them; the bare string
 * is coerced to a one-element array so the engine only ever sees `string[]`.
 * Prisma allows the shorthand on both `findMany` and `findFirst`.
 */
type DistinctSchema<M extends AnyModel> = V.SingleOrArray<
  V.Enum<NonPointScalarKeys<ModelStateOf<M>["scalars"]>[]>
>;

const getDistinctSchema = <M extends AnyModel>(model: M): DistinctSchema<M> => {
  const fieldNames = Object.keys(model["~"].state.scalars).filter(
    (field) => model["~"].state.scalars[field]!["~"].state.type !== "point"
  ) as NonPointScalarKeys<ModelStateOf<M>["scalars"]>[];
  return v.singleOrArray(v.enum(fieldNames)) as DistinctSchema<M>;
};

export type FindUniqueArgs<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  {
    where: CoreSchemas<M, F>["whereUniqueExtended"];
    select: CoreSchemas<M, F>["select"];
    include: CoreSchemas<M, F>["include"];
    omit: OmitSchema<M>;
  },
  { atLeast: ["where"] }
>;

export const getFindUniqueArgs = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  model: M,
  core: CoreSchemas<M, F>
): FindUniqueArgs<M, F> => {
  return withOmitProjection(
    rejectSelectInclude(
      v.object(
        {
          where: v.lazyRef(() => core.whereUniqueExtended),
          select: v.lazyRef(() => core.select),
          include: v.lazyRef(() => core.include),
          omit: v.lazyRef(() => core.omit),
        },
        { atLeast: ["where"] }
      )
    ),
    model,
    "findUnique"
  );
};

/**
 * FindFirst args: { where?, orderBy?, take?, skip?, cursor?, select?, include?, distinct? }
 */
export type FindFirstArgs<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  {
    where: CoreSchemas<M, F>["where"];
    orderBy: V.Union<
      readonly [
        CoreSchemas<M, F>["orderBy"],
        V.Array<CoreSchemas<M, F>["orderBy"]>,
      ]
    >;
    take: PaginationTakeSchema;
    skip: PaginationSkipSchema;
    cursor: CoreSchemas<M, F>["whereUnique"];
    select: CoreSchemas<M, F>["select"];
    include: CoreSchemas<M, F>["include"];
    omit: OmitSchema<M>;
    distinct: DistinctSchema<M>;
  },
  { optional: true }
>;

export const getFindFirstArgs = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  model: M,
  core: CoreSchemas<M, F>
): FindFirstArgs<M, F> => {
  return withOmitProjection(
    rejectSelectInclude(
      v.object(
        {
          where: v.lazyRef(() => core.where),
          orderBy: v.lazyRef(() =>
            v.union([core.orderBy, v.array(core.orderBy)])
          ),
          take: paginationTake(),
          skip: paginationSkip(),
          cursor: v.lazyRef(() => core.whereUnique),
          select: v.lazyRef(() => core.select),
          include: v.lazyRef(() => core.include),
          omit: v.lazyRef(() => core.omit),
          // Prisma has distinct on findFirst too; it compiles through the same
          // findMany-with-limit path (ReadOperation), so nothing else changes.
          distinct: getDistinctSchema(model),
        },
        {
          optional: true,
        }
      )
    ),
    model,
    "findFirst"
  );
};

// =============================================================================
// FIND MANY ARGS
// =============================================================================

/**
 * FindMany args: { where?, orderBy?, take?, skip?, cursor?, select?, include?, distinct? }
 */
export type FindManyArgs<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  {
    where: CoreSchemas<M, F>["where"];
    orderBy: V.Union<
      readonly [
        CoreSchemas<M, F>["orderBy"],
        V.Array<CoreSchemas<M, F>["orderBy"]>,
      ]
    >;
    take: PaginationTakeSchema;
    skip: PaginationSkipSchema;
    cursor: CoreSchemas<M, F>["whereUnique"];
    select: CoreSchemas<M, F>["select"];
    include: CoreSchemas<M, F>["include"];
    omit: OmitSchema<M>;
    distinct: DistinctSchema<M>;
  },
  { optional: true }
>;
export const getFindManyArgs = <M extends AnyModel, F extends ScalarSchemas<M>>(
  model: M,
  core: CoreSchemas<M, F>
): FindManyArgs<M, F> => {
  return withOmitProjection(
    rejectSelectInclude(
      v.object(
        {
          where: v.lazyRef(() => core.where),
          orderBy: v.lazyRef(() =>
            v.union([core.orderBy, v.array(core.orderBy)])
          ),
          take: paginationTake(),
          skip: paginationSkip(),
          cursor: v.lazyRef(() => core.whereUnique),
          select: v.lazyRef(() => core.select),
          include: v.lazyRef(() => core.include),
          omit: v.lazyRef(() => core.omit),
          distinct: getDistinctSchema(model),
        },
        { optional: true }
      )
    ),
    model,
    "findMany"
  );
};
