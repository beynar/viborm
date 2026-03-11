import type { StringKeyOf } from "@schema/model/helper";
import v, { type V } from "@validation";
import type { ModelState } from "../../model";
import type { CoreSchemas } from "../core";

/**
 * FindUnique args: { where: whereUnique, select?, include? }
 */

export type FindUniqueArgs<T extends ModelState> = V.Object<
  {
    where: CoreSchemas<T>["whereUnique"];
    select: CoreSchemas<T>["select"];
    include: CoreSchemas<T>["include"];
  },
  { atLeast: ["where"] }
>;

export const getFindUniqueArgs = <T extends ModelState>(
  core: CoreSchemas<T>
): FindUniqueArgs<T> => {
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
export type FindFirstArgs<T extends ModelState> = V.Object<
  {
    where: CoreSchemas<T>["where"];
    orderBy: V.Union<
      readonly [CoreSchemas<T>["orderBy"], V.Array<CoreSchemas<T>["orderBy"]>]
    >;
    take: V.Number;
    skip: V.Number;
    cursor: CoreSchemas<T>["whereUnique"];
    select: CoreSchemas<T>["select"];
    include: CoreSchemas<T>["include"];
  },
  { optional: true }
>;

export const getFindFirstArgs = <T extends ModelState>(
  core: CoreSchemas<T>
): FindFirstArgs<T> => {
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
export type FindManyArgs<T extends ModelState> = V.Object<
  {
    where: CoreSchemas<T>["where"];
    orderBy: V.Union<
      readonly [CoreSchemas<T>["orderBy"], V.Array<CoreSchemas<T>["orderBy"]>]
    >;
    take: V.Number;
    skip: V.Number;
    cursor: CoreSchemas<T>["whereUnique"];
    select: CoreSchemas<T>["select"];
    include: CoreSchemas<T>["include"];
    distinct: V.Enum<StringKeyOf<T["scalars"]>[], { array: true }>;
  },
  { optional: true }
>;
export const getFindManyArgs = <T extends ModelState>(
  state: T,
  core: CoreSchemas<T>
): FindManyArgs<T> => {
  // Build distinct schema - array of scalar field names
  const fieldNames = Object.keys(state.scalars) as StringKeyOf<T["scalars"]>[];

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
