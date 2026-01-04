// Mutation operation args schema factories

import v from "@validation";
import type { ModelState } from "../../model";
import type { CoreSchemas } from "../types";

// =============================================================================
// CREATE ARGS
// =============================================================================

/**
 * Create args: { data: create, select?, include? }
 */
export const getCreateArgs = <T extends ModelState>(core: CoreSchemas<T>) => {
  return v.object(
    {
      data: core.create,
      select: v.optional(core.select),
      include: v.optional(core.include),
    },
    { partial: false }
  );
};

// =============================================================================
// CREATE MANY ARGS
// =============================================================================

/**
 * CreateMany args: { data: create[], skipDuplicates? }
 */
export const getCreateManyArgs = <T extends ModelState>(
  core: CoreSchemas<T>
) => {
  return v.object(
    {
      data: v.array(core.scalarCreate),
      skipDuplicates: v.boolean({ optional: true }),
    },
    { partial: false }
  );
};

// =============================================================================
// UPDATE ARGS
// =============================================================================

/**
 * Update args: { where: whereUnique, data: update, select?, include? }
 */
export const getUpdateArgs = <T extends ModelState>(core: CoreSchemas<T>) => {
  return v.object(
    {
      where: core.whereUnique,
      data: core.update,
      select: v.optional(core.select),
      include: v.optional(core.include),
    },
    { partial: false }
  );
};

// =============================================================================
// UPDATE MANY ARGS
// =============================================================================

/**
 * UpdateMany args: { where?, data: update }
 */
export const getUpdateManyArgs = <T extends ModelState>(
  core: CoreSchemas<T>
) => {
  return v.object(
    {
      where: v.optional(core.where),
      data: core.update,
    },
    { partial: false }
  );
};

// =============================================================================
// DELETE ARGS
// =============================================================================

/**
 * Delete args: { where: whereUnique, select?, include? }
 */
export const getDeleteArgs = <T extends ModelState>(core: CoreSchemas<T>) => {
  return v.object(
    {
      where: core.whereUnique,
      select: v.optional(core.select),
      include: v.optional(core.include),
    },
    { partial: false }
  );
};

// =============================================================================
// DELETE MANY ARGS
// =============================================================================

/**
 * DeleteMany args: { where? }
 */
export const getDeleteManyArgs = <T extends ModelState>(
  core: CoreSchemas<T>
) => {
  return v.object(
    {
      where: v.optional(core.where),
    },
    { partial: false }
  );
};

// =============================================================================
// UPSERT ARGS
// =============================================================================

/**
 * Upsert args: { where: whereUnique, create, update, select?, include? }
 */
export const getUpsertArgs = <T extends ModelState>(core: CoreSchemas<T>) => {
  return v.object(
    {
      where: core.whereUnique,
      create: core.create,
      update: core.update,
      select: v.optional(core.select),
      include: v.optional(core.include),
    },
    { partial: false }
  );
};
