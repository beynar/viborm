// Model Schema Factories
// Builds all model schemas by composing field-level Valibot schemas

import {
  object,
  optional,
  partial,
  boolean,
  number,
  array,
  union,
  literal,
  lazy,
  string,
  type ObjectSchema,
  type BaseSchema,
} from "valibot";
import { ModelState } from "./model";
import { isField, type Field } from "../fields/base";
import type { AnyRelation } from "../relation/relation";
import type { AnySchema } from "../fields/common";

// =============================================================================
// HELPER TYPES
// =============================================================================

type SchemaEntries = Record<string, AnySchema>;

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Merge two object schemas into one
 */
const merge = <
  A extends ObjectSchema<any, any>,
  B extends ObjectSchema<any, any>
>(
  a: A,
  b: B
): ObjectSchema<A["entries"] & B["entries"], any> => {
  return object({
    ...a.entries,
    ...b.entries,
  });
};

/**
 * Iterate over scalar fields only (excludes relations)
 */
const forEachScalarField = (
  state: ModelState,
  fn: (name: string, field: Field) => void
): void => {
  for (const [name, fieldOrRelation] of Object.entries(state.fields)) {
    if (isField(fieldOrRelation)) {
      fn(name, fieldOrRelation);
    }
  }
};

/**
 * Iterate over relations only (excludes scalar fields)
 */
const forEachRelation = (
  state: ModelState,
  fn: (name: string, relation: AnyRelation) => void
): void => {
  for (const [name, fieldOrRelation] of Object.entries(state.fields)) {
    if (!isField(fieldOrRelation)) {
      fn(name, fieldOrRelation as AnyRelation);
    }
  }
};

/**
 * Check if a relation is to-one (oneToOne or manyToOne)
 */
const isToOne = (relation: AnyRelation): boolean => {
  const type = relation["~"].state.type;
  return type === "oneToOne" || type === "manyToOne";
};

// =============================================================================
// PHASE 1: CORE SCALAR SCHEMA FACTORIES
// =============================================================================

/**
 * Build scalar filter schema - combines all scalar field filters
 */
const getScalarFilter = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  forEachScalarField(state, (name, field) => {
    entries[name] = optional(field["~"].schemas.filter);
  });

  return object(entries);
};

/**
 * Build unique filter schema - only fields marked as id or unique
 */
const getUniqueFilter = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  forEachScalarField(state, (name, field) => {
    const fieldState = field["~"].state;
    if (fieldState.isId || fieldState.isUnique) {
      entries[name] = optional(field["~"].schemas.base);
    }
  });

  return object(entries);
};

/**
 * Build scalar create schema - all scalar fields for create input
 */
const getScalarCreate = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  forEachScalarField(state, (name, field) => {
    const fieldState = field["~"].state;
    // Fields with defaults, auto-generate, or nullable are optional
    const isOptional =
      fieldState.hasDefault ||
      fieldState.autoGenerate !== undefined ||
      fieldState.nullable;

    if (isOptional) {
      entries[name] = optional(field["~"].schemas.create);
    } else {
      entries[name] = field["~"].schemas.create;
    }
  });

  return object(entries);
};

/**
 * Build scalar update schema - all scalar fields for update input (all optional)
 */
const getScalarUpdate = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  forEachScalarField(state, (name, field) => {
    entries[name] = optional(field["~"].schemas.update);
  });

  return object(entries);
};

// =============================================================================
// PHASE 2: SELECT, INCLUDE, ORDERBY SCHEMAS
// =============================================================================

/** Sort order schema for orderBy */
const sortOrderSchema = union([
  literal("asc"),
  literal("desc"),
  object({
    sort: union([literal("asc"), literal("desc")]),
    nulls: optional(union([literal("first"), literal("last")])),
  }),
]);

/**
 * Build select schema - boolean selection for each scalar field
 */
const getSelectSchema = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  forEachScalarField(state, (name) => {
    entries[name] = optional(boolean());
  });

  // Also add relations to select
  forEachRelation(state, (name) => {
    entries[name] = optional(boolean());
  });

  return object(entries);
};

/**
 * Build include schema - boolean inclusion for each relation
 */
const getIncludeSchema = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  forEachRelation(state, (name) => {
    entries[name] = optional(boolean());
  });

  return object(entries);
};

/**
 * Build orderBy schema - sort direction for each scalar field
 */
const getOrderBySchema = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  forEachScalarField(state, (name) => {
    entries[name] = optional(sortOrderSchema);
  });

  return object(entries);
};

// =============================================================================
// PHASE 3: RELATION SCHEMA FACTORIES
// =============================================================================

/**
 * Build relation filter schema - combines all relation filters
 */
const getRelationFilter = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  forEachRelation(state, (name, relation) => {
    entries[name] = optional(relation["~"].schemas.filter);
  });

  return object(entries);
};

/**
 * Build relation create schema - combines all relation create inputs
 */
const getRelationCreate = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  forEachRelation(state, (name, relation) => {
    entries[name] = optional(relation["~"].schemas.create);
  });

  return object(entries);
};

/**
 * Build relation update schema - combines all relation update inputs
 */
const getRelationUpdate = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  forEachRelation(state, (name, relation) => {
    entries[name] = optional(relation["~"].schemas.update);
  });

  return object(entries);
};

// =============================================================================
// PHASE 4: COMBINED SCHEMAS
// =============================================================================

/**
 * Build full where schema - scalar + relation filters + AND/OR/NOT
 */
const getWhereSchema = <T extends ModelState>(
  state: T
): BaseSchema<any, any, any> => {
  const scalarEntries: SchemaEntries = {};
  const relationEntries: SchemaEntries = {};

  forEachScalarField(state, (name, field) => {
    scalarEntries[name] = optional(field["~"].schemas.filter);
  });

  forEachRelation(state, (name, relation) => {
    relationEntries[name] = optional(relation["~"].schemas.filter);
  });

  // Use lazy for recursive AND/OR/NOT
  const whereSchema: BaseSchema<any, any, any> = lazy(() =>
    partial(
      object({
        ...scalarEntries,
        ...relationEntries,
        AND: optional(
          union([lazy(() => whereSchema), array(lazy(() => whereSchema))])
        ),
        OR: optional(array(lazy(() => whereSchema))),
        NOT: optional(
          union([lazy(() => whereSchema), array(lazy(() => whereSchema))])
        ),
      })
    )
  );

  return whereSchema;
};

/**
 * Generate compound key name from field names
 */
const generateCompoundKeyName = (fields: readonly string[]): string =>
  fields.join("_");

/**
 * Build whereUnique schema - unique fields + compound constraints
 */
const getWhereUniqueSchema = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  // Add single-field unique constraints
  forEachScalarField(state, (name, field) => {
    const fieldState = field["~"].state;
    if (fieldState.isId || fieldState.isUnique) {
      entries[name] = optional(field["~"].schemas.base);
    }
  });

  // Add compound ID
  if (state.compoundId?.fields && state.compoundId.fields.length > 0) {
    const keyName =
      state.compoundId.name ?? generateCompoundKeyName(state.compoundId.fields);
    const compoundEntries: SchemaEntries = {};

    for (const fieldName of state.compoundId.fields) {
      const field = state.fields[fieldName];
      if (field && isField(field)) {
        compoundEntries[fieldName] = field["~"].schemas.base;
      }
    }

    entries[keyName] = optional(object(compoundEntries));
  }

  // Add compound uniques
  if (state.compoundUniques && state.compoundUniques.length > 0) {
    for (const constraint of state.compoundUniques) {
      if (!constraint.fields || constraint.fields.length === 0) continue;

      const keyName =
        constraint.name ?? generateCompoundKeyName(constraint.fields);
      // Skip if already added (same as compound ID)
      if (keyName in entries) continue;

      const compoundEntries: SchemaEntries = {};
      for (const fieldName of constraint.fields) {
        const field = state.fields[fieldName];
        if (field && isField(field)) {
          compoundEntries[fieldName] = field["~"].schemas.base;
        }
      }

      entries[keyName] = optional(object(compoundEntries));
    }
  }

  return object(entries);
};

/**
 * Build full create schema - scalar + relation creates
 */
const getCreateSchema = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  // Scalar fields
  forEachScalarField(state, (name, field) => {
    const fieldState = field["~"].state;
    const isOptional =
      fieldState.hasDefault ||
      fieldState.autoGenerate !== undefined ||
      fieldState.nullable;

    if (isOptional) {
      entries[name] = optional(field["~"].schemas.create);
    } else {
      entries[name] = field["~"].schemas.create;
    }
  });

  // Relation creates (all optional)
  forEachRelation(state, (name, relation) => {
    entries[name] = optional(relation["~"].schemas.create);
  });

  return object(entries);
};

/**
 * Build full update schema - scalar + relation updates (all optional)
 */
const getUpdateSchema = <T extends ModelState>(
  state: T
): ObjectSchema<any, any> => {
  const entries: SchemaEntries = {};

  // Scalar updates
  forEachScalarField(state, (name, field) => {
    entries[name] = optional(field["~"].schemas.update);
  });

  // Relation updates
  forEachRelation(state, (name, relation) => {
    entries[name] = optional(relation["~"].schemas.update);
  });

  return object(entries);
};

// =============================================================================
// PHASE 5: ARGS SCHEMA FACTORIES
// =============================================================================

interface CoreSchemas {
  where: BaseSchema<any, any, any>;
  whereUnique: ObjectSchema<any, any>;
  create: ObjectSchema<any, any>;
  update: ObjectSchema<any, any>;
  select: ObjectSchema<any, any>;
  include: ObjectSchema<any, any>;
  orderBy: ObjectSchema<any, any>;
  scalarCreate: ObjectSchema<any, any>;
}

/**
 * FindUnique args: { where: whereUnique, select?, include? }
 */
const getFindUniqueArgs = (core: CoreSchemas): ObjectSchema<any, any> => {
  return object({
    where: core.whereUnique,
    select: optional(core.select),
    include: optional(core.include),
  });
};

/**
 * FindFirst args: { where?, orderBy?, take?, skip?, cursor?, select?, include? }
 */
const getFindFirstArgs = (core: CoreSchemas): ObjectSchema<any, any> => {
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
const getFindManyArgs = <T extends ModelState>(
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

/**
 * Create args: { data: create, select?, include? }
 */
const getCreateArgs = (core: CoreSchemas): ObjectSchema<any, any> => {
  return object({
    data: core.create,
    select: optional(core.select),
    include: optional(core.include),
  });
};

/**
 * CreateMany args: { data: create[], skipDuplicates? }
 */
const getCreateManyArgs = (core: CoreSchemas): ObjectSchema<any, any> => {
  return object({
    data: array(core.scalarCreate),
    skipDuplicates: optional(boolean()),
  });
};

/**
 * Update args: { where: whereUnique, data: update, select?, include? }
 */
const getUpdateArgs = (core: CoreSchemas): ObjectSchema<any, any> => {
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
const getUpdateManyArgs = (core: CoreSchemas): ObjectSchema<any, any> => {
  return object({
    where: optional(core.where),
    data: core.update,
  });
};

/**
 * Delete args: { where: whereUnique, select?, include? }
 */
const getDeleteArgs = (core: CoreSchemas): ObjectSchema<any, any> => {
  return object({
    where: core.whereUnique,
    select: optional(core.select),
    include: optional(core.include),
  });
};

/**
 * DeleteMany args: { where? }
 */
const getDeleteManyArgs = (core: CoreSchemas): ObjectSchema<any, any> => {
  return object({
    where: optional(core.where),
  });
};

/**
 * Upsert args: { where: whereUnique, create, update, select?, include? }
 */
const getUpsertArgs = (core: CoreSchemas): ObjectSchema<any, any> => {
  return object({
    where: core.whereUnique,
    create: core.create,
    update: core.update,
    select: optional(core.select),
    include: optional(core.include),
  });
};

/**
 * Count args: { where?, cursor?, take?, skip? }
 */
const getCountArgs = (core: CoreSchemas): ObjectSchema<any, any> => {
  return object({
    where: optional(core.where),
    cursor: optional(core.whereUnique),
    take: optional(number()),
    skip: optional(number()),
  });
};

/**
 * Build aggregate field schemas (for _count, _avg, _sum, _min, _max)
 */
const getAggregateFieldSchemas = <T extends ModelState>(state: T) => {
  const countEntries: SchemaEntries = { _all: optional(boolean()) };
  const numericEntries: SchemaEntries = {};
  const minMaxEntries: SchemaEntries = {};

  forEachScalarField(state, (name, field) => {
    const fieldType = field["~"].state.type;

    // Count can include all fields
    countEntries[name] = optional(boolean());

    // Avg/Sum only for numeric types
    if (["int", "float", "decimal", "bigint"].includes(fieldType)) {
      numericEntries[name] = optional(boolean());
    }

    // Min/Max for all comparable types
    minMaxEntries[name] = optional(boolean());
  });

  return {
    count: object(countEntries),
    avg: object(numericEntries),
    sum: object(numericEntries),
    min: object(minMaxEntries),
    max: object(minMaxEntries),
  };
};

/**
 * Aggregate args: { where?, _count?, _avg?, _sum?, _min?, _max? }
 */
const getAggregateArgs = <T extends ModelState>(
  state: T,
  core: CoreSchemas
): ObjectSchema<any, any> => {
  const aggSchemas = getAggregateFieldSchemas(state);

  return object({
    where: optional(core.where),
    orderBy: optional(union([core.orderBy, array(core.orderBy)])),
    cursor: optional(core.whereUnique),
    take: optional(number()),
    skip: optional(number()),
    _count: optional(union([literal(true), aggSchemas.count])),
    _avg: optional(aggSchemas.avg),
    _sum: optional(aggSchemas.sum),
    _min: optional(aggSchemas.min),
    _max: optional(aggSchemas.max),
  });
};

/**
 * GroupBy args: { by, where?, having?, orderBy?, take?, skip? }
 */
const getGroupByArgs = <T extends ModelState>(
  state: T,
  core: CoreSchemas
): ObjectSchema<any, any> => {
  // Build "by" schema - array of scalar field names or single field
  const fieldNames: string[] = [];
  forEachScalarField(state, (name) => {
    fieldNames.push(name);
  });

  // Use string for runtime - field names are validated at type level
  const fieldSchema = string();

  const aggSchemas = getAggregateFieldSchemas(state);

  return object({
    by: union([fieldSchema, array(fieldSchema)]),
    where: optional(core.where),
    having: optional(core.where), // Simplified - could be more specific
    orderBy: optional(union([core.orderBy, array(core.orderBy)])),
    take: optional(number()),
    skip: optional(number()),
    _count: optional(union([literal(true), aggSchemas.count])),
    _avg: optional(aggSchemas.avg),
    _sum: optional(aggSchemas.sum),
    _min: optional(aggSchemas.min),
    _max: optional(aggSchemas.max),
  });
};

// =============================================================================
// PHASE 6: MAIN EXPORT - getModelSchemas
// =============================================================================

/**
 * Build all schemas for a model.
 * Returns a complete set of schemas for validation and type inference.
 */
export const getModelSchemas = <T extends ModelState>(state: T) => {
  // Core building blocks
  const scalarFilter = getScalarFilter(state);
  const uniqueFilter = getUniqueFilter(state);
  const relationFilter = getRelationFilter(state);

  const scalarCreate = getScalarCreate(state);
  const relationCreate = getRelationCreate(state);

  const scalarUpdate = getScalarUpdate(state);
  const relationUpdate = getRelationUpdate(state);

  // Select, include, orderBy
  const select = getSelectSchema(state);
  const include = getIncludeSchema(state);
  const orderBy = getOrderBySchema(state);

  // Combined schemas
  const where = getWhereSchema(state);
  const whereUnique = getWhereUniqueSchema(state);
  const create = getCreateSchema(state);
  const update = getUpdateSchema(state);

  // Core schemas bundle for args factories
  const core: CoreSchemas = {
    where,
    whereUnique,
    create,
    update,
    select,
    include,
    orderBy,
    scalarCreate,
  };

  return {
    // Core building blocks (exposed for advanced use)
    _filter: {
      scalar: scalarFilter,
      unique: uniqueFilter,
      relation: relationFilter,
    },
    _create: {
      scalar: scalarCreate,
      relation: relationCreate,
    },
    _update: {
      scalar: scalarUpdate,
      relation: relationUpdate,
    },

    // Combined schemas
    where,
    whereUnique,
    create,
    update,
    select,
    include,
    orderBy,

    // Args schemas for each operation
    args: {
      findUnique: getFindUniqueArgs(core),
      findFirst: getFindFirstArgs(core),
      findMany: getFindManyArgs(state, core),
      create: getCreateArgs(core),
      createMany: getCreateManyArgs(core),
      update: getUpdateArgs(core),
      updateMany: getUpdateManyArgs(core),
      delete: getDeleteArgs(core),
      deleteMany: getDeleteManyArgs(core),
      upsert: getUpsertArgs(core),
      count: getCountArgs(core),
      aggregate: getAggregateArgs(state, core),
      groupBy: getGroupByArgs(state, core),
    },
  };
};
