// Core Schema Builders
// ArkType runtime schemas for model operations

import { type, Type } from "arktype";
import type { Model } from "../model";
import type { Relation } from "../../relation/relation";
import type {
  FieldRecord,
  ModelWhereInput,
  ModelWhereUniqueInput,
  ModelCreateInput,
  CreateManyEnvelope,
  ModelUpdateInput,
  ModelSelect,
  ModelInclude,
  ModelOrderBy,
} from "../types";

// =============================================================================
// WHERE SCHEMA
// =============================================================================

const isToOneShorthand = (
  t?: unknown
): t is { is: unknown } | { isNot: unknown } => {
  return (
    t !== undefined &&
    typeof t === "object" &&
    t !== null &&
    ("is" in t || "isNot" in t)
  );
};

/**
 * Builds a where schema from model fields
 * All fields are optional in where clauses
 * Relation filters use lazy evaluation - actual schemas accessed via model["~"].schemas
 * which provides per-model caching (no module-level state needed)
 */
export const buildWhereSchema = <TFields extends FieldRecord>(
  model: Model<any>
): Type<ModelWhereInput<TFields>> => {
  const shape: Record<string, Type | (() => Type)> = {};

  // Add scalar field filters
  for (const [name, field] of model["~"].fieldMap) {
    shape[name + "?"] = field["~"].schemas.filter;
  }

  // Add relation filters with lazy evaluation
  // Lazy access to targetModel["~"].schemas.where ensures:
  // 1. No recursion during build (thunk not called until validation)
  // 2. Target model schemas cached at model level (not module level)
  for (const [name, relation] of model["~"].relations) {
    const relationType = relation["~"].relationType;
    const getTargetModel = relation["~"].getter;
    const targetWhere = getTargetModel()["~"].schemas.where;
    const isOptional = relation["~"].isOptional ?? false;

    if (relationType === "oneToOne" || relationType === "manyToOne") {
      // To-one relations: supports both explicit and shorthand forms
      // Explicit: { author: { is: { name: "Alice" } } }
      // Shorthand: { author: { name: "Alice" } } -> normalized to { is: { name: "Alice" } }
      // Null shorthand (optional only): { author: null } -> normalized to { is: null }
      //
      // Uses type("object | null") + pipe to bypass ArkType morph/union limitation
      // (can't use .or(targetWhere) because targetWhere contains field filters with morphs)
      const relationFilterSchema = isOptional
        ? type("object | null")
        : type("object");

      shape[name + "?"] = relationFilterSchema.pipe((t) => {
        if (t === null)
          return { is: null } as unknown as ModelWhereInput<TFields>;
        if (isToOneShorthand(t)) return t as ModelWhereInput<TFields>;
        return { is: t } as unknown as ModelWhereInput<TFields>;
      });
    } else {
      // To-many relations: some, every, none filters
      shape[name + "?"] = type({
        "some?": () => targetWhere,
        "every?": () => targetWhere,
        "none?": () => targetWhere,
      });
    }
  }

  return type(shape as Record<string, Type>) as unknown as Type<
    ModelWhereInput<TFields>
  >;
};

// =============================================================================
// WHERE UNIQUE SCHEMA
// =============================================================================

/**
 * Generates compound key name from field names (e.g., ["email", "orgId"] -> "email_orgId")
 */
const generateCompoundKeyName = (fields: readonly string[]): string =>
  fields.join("_");

/**
 * Builds a where unique schema from model fields
 * Includes single-field unique constraints AND compound ID/unique constraints
 * Validates at runtime that at least one unique field/constraint is provided
 */
export const buildWhereUniqueSchema = <TFields extends FieldRecord>(
  model: Model<any>
): Type<ModelWhereUniqueInput<TFields>> => {
  const shape: Record<string, Type> = {};
  const uniqueFieldNames: string[] = [];
  const compoundKeyNames: string[] = [];

  // Add single-field unique constraints
  for (const [name, field] of model["~"].fieldMap) {
    const state = field["~"].state;
    if (state.isId || state.isUnique) {
      shape[name + "?"] = field["~"].schemas.base;
      uniqueFieldNames.push(name);
    }
  }

  // Add compound ID (e.g., .id(["email", "orgId"], { name: "myKey" }) -> { myKey: { email, orgId } })
  const compoundId = model["~"].compoundId;
  if (compoundId && compoundId.fields && compoundId.fields.length > 0) {
    // Use custom name if provided, otherwise generate from field names
    const keyName =
      compoundId.name ?? generateCompoundKeyName(compoundId.fields);
    compoundKeyNames.push(keyName);

    // Build the compound key object schema
    const compoundShape: Record<string, Type> = {};
    for (const fieldName of compoundId.fields) {
      const field = model["~"].fieldMap.get(fieldName);
      if (field) {
        compoundShape[fieldName] = field["~"].schemas.base;
      }
    }
    shape[keyName + "?"] = type(compoundShape);
  }

  // Add compound uniques (e.g., .unique(["email", "orgId"], { name: "myUnique" }) -> { myUnique: { email, orgId } })
  const compoundUniques = model["~"].compoundUniques;
  if (compoundUniques && compoundUniques.length > 0) {
    for (const constraint of compoundUniques) {
      if (!constraint.fields || constraint.fields.length === 0) continue;

      // Use custom name if provided, otherwise generate from field names
      const keyName =
        constraint.name ?? generateCompoundKeyName(constraint.fields);
      // Skip if this compound key was already added (e.g., same as compound ID)
      if (compoundKeyNames.includes(keyName)) continue;
      compoundKeyNames.push(keyName);

      // Build the compound key object schema
      const compoundShape: Record<string, Type> = {};
      for (const fieldName of constraint.fields) {
        const field = model["~"].fieldMap.get(fieldName);
        if (field) {
          compoundShape[fieldName] = field["~"].schemas.base;
        }
      }
      shape[keyName + "?"] = type(compoundShape);
    }
  }

  // Collect all valid unique identifiers
  const allUniqueIdentifiers = [...uniqueFieldNames, ...compoundKeyNames];

  // If no unique fields or constraints defined, return simple schema
  if (allUniqueIdentifiers.length === 0) {
    return type(shape) as unknown as Type<ModelWhereUniqueInput<TFields>>;
  }

  // Add runtime validation: at least one unique field/constraint must be provided
  const baseSchema = type(shape);
  const validatedSchema = baseSchema.narrow((data, ctx) => {
    const hasUniqueIdentifier = allUniqueIdentifiers.some(
      (name) =>
        data &&
        typeof data === "object" &&
        name in data &&
        (data as Record<string, unknown>)[name] !== undefined
    );
    if (!hasUniqueIdentifier) {
      return ctx.mustBe(
        `an object with at least one of: ${allUniqueIdentifiers.join(", ")}`
      );
    }
    return true;
  });

  return validatedSchema as unknown as Type<ModelWhereUniqueInput<TFields>>;
};

// =============================================================================
// RELATION CREATE SCHEMA (helper)
// =============================================================================

/**
 * Helper to wrap single value in array - used for to-many relation normalization
 * Avoids ArkType morph/array union conflict by using pipe on the union
 */
const ensureArray = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

/**
 * Builds a relation create schema with lazy evaluation
 */
const buildRelationCreateSchema = (
  relation: Relation<any, any>,
  getTargetModel: () => Model<any>
): Type => {
  const relationType = relation["~"].relationType;

  if (relationType === "oneToOne" || relationType === "manyToOne") {
    // To-one: create, connect, connectOrCreate
    return type({
      "create?": () => getTargetModel()["~"].schemas.create,
      "connect?": () => getTargetModel()["~"].schemas.whereUnique,
      "connectOrCreate?": type({
        where: () => getTargetModel()["~"].schemas.whereUnique,
        create: () => getTargetModel()["~"].schemas.create,
      }),
    });
  } else {
    // To-many: create/connect/connectOrCreate - shorthand single object normalized to array via pipe
    // Pattern: schema.or(schema.array()).pipe(ensureArray) avoids ArkType morph/array conflict
    const createSchema = type(() => getTargetModel()["~"].schemas.create);
    const connectSchema = type(() => getTargetModel()["~"].schemas.whereUnique);
    const connectOrCreateSchema = type({
      where: () => getTargetModel()["~"].schemas.whereUnique,
      create: () => getTargetModel()["~"].schemas.create,
    });

    return type({
      "create?": createSchema.or(createSchema.array()).pipe(ensureArray),
      "connect?": connectSchema.or(connectSchema.array()).pipe(ensureArray),
      "connectOrCreate?": connectOrCreateSchema
        .or(connectOrCreateSchema.array())
        .pipe(ensureArray),
    });
  }
};

// =============================================================================
// CREATE SCHEMA
// =============================================================================

/**
 * Builds a create schema from model fields
 * Required fields are required, optional fields (with defaults/auto-generate/nullable) are optional
 */
export const buildCreateSchema = <TFields extends FieldRecord>(
  model: Model<any>
): Type<ModelCreateInput<TFields>> => {
  const shape: Record<string, Type | (() => Type)> = {};

  // Scalar fields - optional if hasDefault, autoGenerate, or nullable
  for (const [name, field] of model["~"].fieldMap) {
    const state = field["~"].state;
    const isOptional =
      state.hasDefault || state.autoGenerate !== undefined || state.nullable;
    const key = isOptional ? name + "?" : name;
    shape[key] = field["~"].schemas.create;
  }

  // Relation fields (all optional in create) with lazy evaluation
  for (const [name, relation] of model["~"].relations) {
    const getTargetModel = relation["~"].getter;
    shape[name + "?"] = () =>
      buildRelationCreateSchema(relation, getTargetModel);
  }

  return type(shape as Record<string, Type>) as unknown as Type<
    ModelCreateInput<TFields>
  >;
};

// =============================================================================
// CREATE MANY SCHEMA
// =============================================================================

/**
 * Builds a create many schema (envelope with data array and skipDuplicates)
 * Only includes scalar fields, no nested relations
 */
export const buildCreateManySchema = <TFields extends FieldRecord>(
  model: Model<any>
): Type<CreateManyEnvelope<TFields>> => {
  const shape: Record<string, Type> = {};

  // Only scalar fields, no relations - optional if hasDefault, autoGenerate, or nullable
  for (const [name, field] of model["~"].fieldMap) {
    const state = field["~"].state;
    const isOptional =
      state.hasDefault || state.autoGenerate !== undefined || state.nullable;
    const key = isOptional ? name + "?" : name;
    shape[key] = field["~"].schemas.create;
  }

  const singleSchema = type(shape);
  const envelopeSchema = type({
    data: singleSchema.array(),
    "skipDuplicates?": "boolean",
  });

  return envelopeSchema as unknown as Type<CreateManyEnvelope<TFields>>;
};

// =============================================================================
// RELATION UPDATE SCHEMA (helper)
// =============================================================================

/**
 * Builds a relation update schema with lazy evaluation
 */
const buildRelationUpdateSchema = (
  relation: Relation<any, any>,
  getTargetModel: () => Model<any>
): Type => {
  const relationType = relation["~"].relationType;
  const isOptional = relation["~"].isOptional ?? false;

  if (relationType === "oneToOne" || relationType === "manyToOne") {
    // To-one: create, connect, update, upsert, (disconnect/delete if optional)
    const baseShape: Record<string, Type | (() => Type)> = {
      "create?": () => getTargetModel()["~"].schemas.create,
      "connect?": () => getTargetModel()["~"].schemas.whereUnique,
      "update?": () => getTargetModel()["~"].schemas.update,
      "upsert?": type({
        create: () => getTargetModel()["~"].schemas.create,
        update: () => getTargetModel()["~"].schemas.update,
      }),
    };

    if (isOptional) {
      baseShape["disconnect?"] = type("boolean");
      baseShape["delete?"] = type("boolean");
    }

    return type(baseShape as Record<string, Type>);
  } else {
    // To-many: array inputs for operations
    // NOTE: Single-value shorthand not supported for operations using where schema (contains morphs)
    // due to ArkType union/morph limitations
    const createSchema = type(() => getTargetModel()["~"].schemas.create);
    const connectSchema = type(() => getTargetModel()["~"].schemas.whereUnique);
    const whereSchema = type(() => getTargetModel()["~"].schemas.where);
    const updateSchema = type({
      where: () => getTargetModel()["~"].schemas.whereUnique,
      data: () => getTargetModel()["~"].schemas.update,
    });
    const updateManySchema = type({
      where: () => getTargetModel()["~"].schemas.where,
      data: () => getTargetModel()["~"].schemas.update,
    });
    const upsertSchema = type({
      where: () => getTargetModel()["~"].schemas.whereUnique,
      create: () => getTargetModel()["~"].schemas.create,
      update: () => getTargetModel()["~"].schemas.update,
    });

    return type({
      // create/connect/disconnect/delete use whereUnique/create (no morphs) - shorthand supported
      "create?": createSchema.or(createSchema.array()).pipe(ensureArray),
      "connect?": connectSchema.or(connectSchema.array()).pipe(ensureArray),
      "disconnect?": connectSchema.or(connectSchema.array()).pipe(ensureArray),
      "set?": connectSchema.array(),
      "delete?": connectSchema.or(connectSchema.array()).pipe(ensureArray),
      // Operations with update data (has morphs) - array only, no shorthand
      "deleteMany?": whereSchema.array(),
      "update?": updateSchema.array(),
      "updateMany?": updateManySchema.array(),
      "upsert?": upsertSchema.array(),
    });
  }
};

// =============================================================================
// UPDATE SCHEMA
// =============================================================================

/**
 * Builds an update schema from model fields
 * All fields are optional in update operations
 */
export const buildUpdateSchema = <TFields extends FieldRecord>(
  model: Model<any>
): Type<ModelUpdateInput<TFields>> => {
  const shape: Record<string, Type | (() => Type)> = {};

  // Scalar fields
  for (const [name, field] of model["~"].fieldMap) {
    shape[name + "?"] = field["~"].schemas.update;
  }

  // Relation fields (all optional in update) with lazy evaluation
  for (const [name, relation] of model["~"].relations) {
    const getTargetModel = relation["~"].getter;
    shape[name + "?"] = () =>
      buildRelationUpdateSchema(relation, getTargetModel);
  }

  return type(shape as Record<string, Type>) as unknown as Type<
    ModelUpdateInput<TFields>
  >;
};

// =============================================================================
// SELECT SCHEMA
// =============================================================================

/**
 * Builds a select schema from model fields
 * Each field can be true/false to include/exclude
 */
export const buildSelectSchema = <TFields extends FieldRecord>(
  model: Model<any>
): Type<ModelSelect<TFields>> => {
  const shape: Record<string, string> = {};

  // Scalar fields
  for (const [name] of model["~"].fieldMap) {
    shape[name + "?"] = "boolean";
  }

  // Relations
  for (const [name] of model["~"].relations) {
    shape[name + "?"] = "boolean";
  }

  return type(shape) as unknown as Type<ModelSelect<TFields>>;
};

// =============================================================================
// INCLUDE SCHEMA
// =============================================================================

/**
 * Builds an include schema for relations
 */
export const buildIncludeSchema = <TFields extends FieldRecord>(
  model: Model<any>
): Type<ModelInclude<TFields>> => {
  const shape: Record<string, string> = {};

  for (const [name] of model["~"].relations) {
    shape[name + "?"] = "boolean";
  }

  return type(shape) as unknown as Type<ModelInclude<TFields>>;
};

// =============================================================================
// ORDER BY SCHEMA
// =============================================================================

/**
 * Builds an orderBy schema from model fields with nulls handling
 */
export const buildOrderBySchema = <TFields extends FieldRecord>(
  model: Model<any>
): Type<ModelOrderBy<TFields>> => {
  const shape: Record<string, Type> = {};

  // Sort order input: "asc" | "desc" | { sort: "asc" | "desc", nulls?: "first" | "last" }
  const sortOrderInput = type("'asc' | 'desc'").or(
    type({
      sort: "'asc' | 'desc'",
      "nulls?": "'first' | 'last'",
    })
  );

  for (const [name] of model["~"].fieldMap) {
    shape[name + "?"] = sortOrderInput;
  }

  return type(shape) as unknown as Type<ModelOrderBy<TFields>>;
};
