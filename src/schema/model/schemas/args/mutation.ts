// Mutation operation args schema factories

import { object, optional, boolean, array, type ObjectSchema } from "valibot";
import type { CoreSchemas } from "../types";

/**
 * Create args: { data: create, select?, include? }
 */
export const getCreateArgs = (core: CoreSchemas): ObjectSchema<any, any> => {
  return object({
    data: core.create,
    select: optional(core.select),
    include: optional(core.include),
  });
};

/**
 * CreateMany args: { data: create[], skipDuplicates? }
 */
export const getCreateManyArgs = (
  core: CoreSchemas
): ObjectSchema<any, any> => {
  return object({
    data: array(core.scalarCreate),
    skipDuplicates: optional(boolean()),
  });
};

/**
 * Update args: { where: whereUnique, data: update, select?, include? }
 */
export const getUpdateArgs = (core: CoreSchemas): ObjectSchema<any, any> => {
  return object({
    where: core.whereUnique,
    data: core.update,
    select: optional(core.select),
    include: optional(core.include),
  });
};

/**
 * UpdateMany args: { where?, data: update }
 */
export const getUpdateManyArgs = (
  core: CoreSchemas
): ObjectSchema<any, any> => {
  return object({
    where: optional(core.where),
    data: core.update,
  });
};

/**
 * Delete args: { where: whereUnique, select?, include? }
 */
export const getDeleteArgs = (core: CoreSchemas): ObjectSchema<any, any> => {
  return object({
    where: core.whereUnique,
    select: optional(core.select),
    include: optional(core.include),
  });
};

/**
 * DeleteMany args: { where? }
 */
export const getDeleteManyArgs = (
  core: CoreSchemas
): ObjectSchema<any, any> => {
  return object({
    where: optional(core.where),
  });
};

/**
 * Upsert args: { where: whereUnique, create, update, select?, include? }
 */
export const getUpsertArgs = (core: CoreSchemas): ObjectSchema<any, any> => {
  return object({
    where: core.whereUnique,
    create: core.create,
    update: core.update,
    select: optional(core.select),
    include: optional(core.include),
  });
};

