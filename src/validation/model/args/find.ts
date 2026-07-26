import type { AnyModel } from "@schema/model";
import type { StringKeyOf } from "@schema/model/helper";
import v, { type V } from "../../primitives/v";
import type { CoreSchemas } from "../core";
import type { ScalarSchemas } from "../index";
import {
  type PaginationSkipSchema,
  type PaginationTakeSchema,
  paginationSkip,
  paginationTake,
} from "./pagination";
import { rejectSelectInclude } from "./select-include-exclusivity";

/**
 * FindUnique args: { where: whereUnique, select?, include? }
 */

type ModelStateOf<M extends AnyModel> = M["~"]["state"];

/**
 * `distinct` accepts a single scalar name or an array of them; the bare string
 * is coerced to a one-element array so the engine only ever sees `string[]`.
 * Prisma allows the shorthand on both `findMany` and `findFirst`.
 */
type DistinctSchema<M extends AnyModel> = V.SingleOrArray<
  V.Enum<StringKeyOf<ModelStateOf<M>["scalars"]>[]>
>;

const getDistinctSchema = <M extends AnyModel>(model: M): DistinctSchema<M> => {
  const fieldNames = Object.keys(model["~"].state.scalars) as StringKeyOf<
    ModelStateOf<M>["scalars"]
  >[];
  return v.singleOrArray(v.enum(fieldNames)) as DistinctSchema<M>;
};

export type FindUniqueArgs<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  {
    where: CoreSchemas<M, F>["whereUnique"];
    select: CoreSchemas<M, F>["select"];
    include: CoreSchemas<M, F>["include"];
  },
  { atLeast: ["where"] }
>;

export const getFindUniqueArgs = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  core: CoreSchemas<M, F>
): FindUniqueArgs<M, F> => {
  return rejectSelectInclude(
    v.object(
      {
        where: v.lazyRef(() => core.whereUnique),
        select: v.lazyRef(() => core.select),
        include: v.lazyRef(() => core.include),
      },
      { atLeast: ["where"] }
    )
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
  return rejectSelectInclude(
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
        // Prisma has distinct on findFirst too; it compiles through the same
        // findMany-with-limit path (ReadOperation), so nothing else changes.
        distinct: getDistinctSchema(model),
      },
      {
        optional: true,
      }
    )
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
    distinct: DistinctSchema<M>;
  },
  { optional: true }
>;
export const getFindManyArgs = <M extends AnyModel, F extends ScalarSchemas<M>>(
  model: M,
  core: CoreSchemas<M, F>
): FindManyArgs<M, F> => {
  return rejectSelectInclude(
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
        distinct: getDistinctSchema(model),
      },
      { optional: true }
    )
  );
};
