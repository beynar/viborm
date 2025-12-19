// Find operation args schema factories

import {
  object,
  optional,
  number,
  array,
  union,
  string,
  type ObjectSchema,
  type OptionalSchema,
  type NumberSchema,
  type ArraySchema,
  type UnionSchema,
  type StringSchema,
  type InferInput,
} from "valibot";
import type { ModelState } from "../../model";
import type { CoreSchemas } from "../types";
import { forEachScalarField } from "../utils";
import type {
  WhereSchema,
  WhereUniqueSchema,
  SelectSchema,
  IncludeSchema,
  OrderBySchema,
} from "../core";

// =============================================================================
// FIND UNIQUE ARGS
// =============================================================================

/** FindUnique args schema: { where, select?, include? } */
export type FindUniqueArgsSchema<T extends ModelState> = ObjectSchema<
  {
    where: WhereUniqueSchema<T>;
    select: OptionalSchema<SelectSchema<T>, undefined>;
    include: OptionalSchema<IncludeSchema<T>, undefined>;
  },
  undefined
>;

/** Input type for findUnique args */
export type FindUniqueArgsInput<T extends ModelState> = InferInput<
  FindUniqueArgsSchema<T>
>;

/**
 * FindUnique args: { where: whereUnique, select?, include? }
 */
export const getFindUniqueArgs = <T extends ModelState>(
  core: CoreSchemas<T>
): FindUniqueArgsSchema<T> => {
  return object({
    where: core.whereUnique,
    select: optional(core.select),
    include: optional(core.include),
  }) as FindUniqueArgsSchema<T>;
};

// =============================================================================
// FIND FIRST ARGS
// =============================================================================

/** FindFirst args schema: { where?, orderBy?, take?, skip?, cursor?, select?, include? } */
export type FindFirstArgsSchema<T extends ModelState> = ObjectSchema<
  {
    where: OptionalSchema<WhereSchema<T>, undefined>;
    orderBy: OptionalSchema<
      UnionSchema<
        [OrderBySchema<T>, ArraySchema<OrderBySchema<T>, undefined>],
        undefined
      >,
      undefined
    >;
    take: OptionalSchema<NumberSchema<undefined>, undefined>;
    skip: OptionalSchema<NumberSchema<undefined>, undefined>;
    cursor: OptionalSchema<WhereUniqueSchema<T>, undefined>;
    select: OptionalSchema<SelectSchema<T>, undefined>;
    include: OptionalSchema<IncludeSchema<T>, undefined>;
  },
  undefined
>;

/** Input type for findFirst args */
export type FindFirstArgsInput<T extends ModelState> = InferInput<
  FindFirstArgsSchema<T>
>;

/**
 * FindFirst args: { where?, orderBy?, take?, skip?, cursor?, select?, include? }
 */
export const getFindFirstArgs = <T extends ModelState>(
  core: CoreSchemas<T>
): FindFirstArgsSchema<T> => {
  return object({
    where: optional(core.where),
    orderBy: optional(union([core.orderBy, array(core.orderBy)])),
    take: optional(number()),
    skip: optional(number()),
    cursor: optional(core.whereUnique),
    select: optional(core.select),
    include: optional(core.include),
  }) as FindFirstArgsSchema<T>;
};

// =============================================================================
// FIND MANY ARGS
// =============================================================================

/** FindMany args schema: { where?, orderBy?, take?, skip?, cursor?, select?, include?, distinct? } */
export type FindManyArgsSchema<T extends ModelState> = ObjectSchema<
  {
    where: OptionalSchema<WhereSchema<T>, undefined>;
    orderBy: OptionalSchema<
      UnionSchema<
        [OrderBySchema<T>, ArraySchema<OrderBySchema<T>, undefined>],
        undefined
      >,
      undefined
    >;
    take: OptionalSchema<NumberSchema<undefined>, undefined>;
    skip: OptionalSchema<NumberSchema<undefined>, undefined>;
    cursor: OptionalSchema<WhereUniqueSchema<T>, undefined>;
    select: OptionalSchema<SelectSchema<T>, undefined>;
    include: OptionalSchema<IncludeSchema<T>, undefined>;
    distinct: OptionalSchema<
      ArraySchema<StringSchema<undefined>, undefined>,
      undefined
    >;
  },
  undefined
>;

/** Input type for findMany args */
export type FindManyArgsInput<T extends ModelState> = InferInput<
  FindManyArgsSchema<T>
>;

/**
 * FindMany args: { where?, orderBy?, take?, skip?, cursor?, select?, include?, distinct? }
 */
export const getFindManyArgs = <T extends ModelState>(
  state: T,
  core: CoreSchemas<T>
): FindManyArgsSchema<T> => {
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
  }) as FindManyArgsSchema<T>;
};
