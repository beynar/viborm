import type { AnyModel } from "@schema/model";
import type { StringKeyOf } from "@schema/model/helper";
import v, { type V } from "@validation";
import type { FieldSchemas } from "../index";
import type { CoreSchemas } from "../core";

/**
 * FindUnique args: { where: whereUnique, select?, include? }
 */

type ModelStateOf<M extends AnyModel> = M["~"]["state"];

export type FindUniqueArgs<
  M extends AnyModel,
  F extends FieldSchemas<M>,
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
  F extends FieldSchemas<M>,
>(
  core: CoreSchemas<M, F>
): FindUniqueArgs<M, F> => {
  return v.object(
    {
      where: core.whereUnique,
      select: core.select,
      include: core.include,
    },
    { atLeast: ["where"] }
  );
};

/**
 * FindFirst args: { where?, orderBy?, take?, skip?, cursor?, select?, include? }
 */
export type FindFirstArgs<
  M extends AnyModel,
  F extends FieldSchemas<M>,
> = V.Object<
  {
    where: CoreSchemas<M, F>["where"];
    orderBy: V.Union<
      readonly [CoreSchemas<M, F>["orderBy"], V.Array<CoreSchemas<M, F>["orderBy"]>]
    >;
    take: V.Number;
    skip: V.Number;
    cursor: CoreSchemas<M, F>["whereUnique"];
    select: CoreSchemas<M, F>["select"];
    include: CoreSchemas<M, F>["include"];
  },
  { optional: true }
>;

export const getFindFirstArgs = <
  M extends AnyModel,
  F extends FieldSchemas<M>,
>(
  core: CoreSchemas<M, F>
): FindFirstArgs<M, F> => {
  return v.object(
    {
      where: core.where,
      orderBy: v.union([core.orderBy, v.array(core.orderBy)]),
      take: v.number(),
      skip: v.number(),
      cursor: core.whereUnique,
      select: core.select,
      include: core.include,
    },
    {
      optional: true,
    }
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
  F extends FieldSchemas<M>,
> = V.Object<
  {
    where: CoreSchemas<M, F>["where"];
    orderBy: V.Union<
      readonly [CoreSchemas<M, F>["orderBy"], V.Array<CoreSchemas<M, F>["orderBy"]>]
    >;
    take: V.Number;
    skip: V.Number;
    cursor: CoreSchemas<M, F>["whereUnique"];
    select: CoreSchemas<M, F>["select"];
    include: CoreSchemas<M, F>["include"];
    distinct: V.Enum<StringKeyOf<ModelStateOf<M>["scalars"]>[], { array: true }>;
  },
  { optional: true }
>;
export const getFindManyArgs = <
  M extends AnyModel,
  F extends FieldSchemas<M>,
>(
  model: M,
  core: CoreSchemas<M, F>
): FindManyArgs<M, F> => {
  // Build distinct schema - array of scalar field names
  const fieldNames = Object.keys(model["~"].state.scalars) as StringKeyOf<
    ModelStateOf<M>["scalars"]
  >[];

  return v.object(
    {
      where: core.where,
      orderBy: v.union([core.orderBy, v.array(core.orderBy)]),
      take: v.number(),
      skip: v.number(),
      cursor: core.whereUnique,
      select: core.select,
      include: core.include,
      distinct: v.enum(fieldNames, { array: true }),
    },
    { optional: true }
  );
};
