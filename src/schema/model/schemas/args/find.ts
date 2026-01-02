import type { ModelState } from "../../model";
import type { CoreSchemas } from "../types";
import v from "@validation";
import { StringKeyOf } from "@schema/model/helper";

/**
 * FindUnique args: { where: whereUnique, select?, include? }
 */
export const getFindUniqueArgs = <T extends ModelState>(
  core: CoreSchemas<T>
) => {
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
export const getFindFirstArgs = <T extends ModelState>(
  core: CoreSchemas<T>
) => {
  return v.object({
    where: core.where,
    orderBy: () => v.union([core.orderBy, v.array(core.orderBy)]),
    take: v.number(),
    skip: v.number(),
    cursor: core.whereUnique,
    select: core.select,
    include: core.include,
  });
};

// =============================================================================
// FIND MANY ARGS
// =============================================================================

/**
 * FindMany args: { where?, orderBy?, take?, skip?, cursor?, select?, include?, distinct? }
 */
export const getFindManyArgs = <T extends ModelState>(
  state: T,
  core: CoreSchemas<T>
) => {
  // Build distinct schema - array of scalar field names
  const fieldNames = Object.keys(state.scalars) as StringKeyOf<T["scalars"]>[];

  return v.object({
    where: core.where,
    orderBy: v.union([core.orderBy, v.array(core.orderBy)]),
    take: v.number(),
    skip: v.number(),
    cursor: core.whereUnique,
    select: core.select,
    include: core.include,
    distinct: v.enum(fieldNames, { array: true }),
  });
};
