// Find operation args schema factories

import {
  object,
  optional,
  number,
  array,
  union,
  string,
  type ObjectSchema,
} from "valibot";
import type { ModelState } from "../../model";
import type { CoreSchemas } from "../types";
import { forEachScalarField } from "../utils";

/**
 * FindUnique args: { where: whereUnique, select?, include? }
 */
export const getFindUniqueArgs = (
  core: CoreSchemas
): ObjectSchema<any, any> => {
  return object({
    where: core.whereUnique,
    select: optional(core.select),
    include: optional(core.include),
  });
};

/**
 * FindFirst args: { where?, orderBy?, take?, skip?, cursor?, select?, include? }
 */
export const getFindFirstArgs = (core: CoreSchemas): ObjectSchema<any, any> => {
  return object({
    where: optional(core.where),
    orderBy: optional(union([core.orderBy, array(core.orderBy)])),
    take: optional(number()),
    skip: optional(number()),
    cursor: optional(core.whereUnique),
    select: optional(core.select),
    include: optional(core.include),
  });
};

/**
 * FindMany args: { where?, orderBy?, take?, skip?, cursor?, select?, include?, distinct? }
 */
export const getFindManyArgs = <T extends ModelState>(
  state: T,
  core: CoreSchemas
): ObjectSchema<any, any> => {
  // Build distinct schema - array of scalar field names
  const fieldNames: string[] = [];
  forEachScalarField(state, (name) => {
    fieldNames.push(name);
  });

  // Build distinct as array of string (field names validated at type level, not runtime)
  const distinctSchema = array(string());

  return object({
    where: optional(core.where),
    orderBy: optional(union([core.orderBy, array(core.orderBy)])),
    take: optional(number()),
    skip: optional(number()),
    cursor: optional(core.whereUnique),
    select: optional(core.select),
    include: optional(core.include),
    distinct: optional(distinctSchema),
  });
};
