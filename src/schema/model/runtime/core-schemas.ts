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
// SCHEMA CACHE
// =============================================================================

// Cache for where schemas to prevent circular reference issues
const whereSchemaCache = new WeakMap<Model<any>, Type>();

// =============================================================================
// WHERE SCHEMA
// =============================================================================

/**
 * Builds a where schema from model fields
 * All fields are optional in where clauses
 * Uses caching to prevent circular reference issues with self-referential models
 */
export const buildWhereSchema = <TFields extends FieldRecord>(
  model: Model<any>
): Type<ModelWhereInput<TFields>> => {
  // Check cache first to prevent circular references
  const cached = whereSchemaCache.get(model);
  if (cached) {
    return cached as Type<ModelWhereInput<TFields>>;
  }

  const shape: Record<string, Type | (() => Type)> = {};

  // Add scalar field filters
  for (const [name, field] of model["~"].fieldMap) {
    shape[name + "?"] = field["~"].schemas.filter;
  }

  // Add relation filters with lazy evaluation to avoid circular refs
  for (const [name, relation] of model["~"].relations) {
    const relationType = relation["~"].relationType;
    const getTargetModel = relation["~"].getter;

    if (relationType === "oneToOne" || relationType === "manyToOne") {
      // To-one relations: explicit is/isNot filters only
      // NOTE: Shorthand { author: { name: "Alice" } } is NOT supported at runtime
      // due to ArkType limitations with lazy evaluation and .or()/.narrow()
      // The TypeScript type allows shorthand for better DX, but runtime requires explicit form:
      //   { author: { is: { name: "Alice" } } }
      shape[name + "?"] = type({
        "is?": () => buildWhereSchema(getTargetModel()),
        "isNot?": () => buildWhereSchema(getTargetModel()),
      });
    } else {
      // To-many relations: some, every, none filters
      shape[name + "?"] = type({
        "some?": () => buildWhereSchema(getTargetModel()),
        "every?": () => buildWhereSchema(getTargetModel()),
        "none?": () => buildWhereSchema(getTargetModel()),
      });
    }
  }

  // Build the base where object
  const result = type(shape as Record<string, Type>) as unknown as Type<
    ModelWhereInput<TFields>
  >;

  // Cache the result
  whereSchemaCache.set(model, result);

  return result;
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
    const keyName = compoundId.name ?? generateCompoundKeyName(compoundId.fields);
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
      const keyName = constraint.name ?? generateCompoundKeyName(constraint.fields);
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
      "create?": () => buildCreateSchema(getTargetModel()),
      "connect?": () => buildWhereUniqueSchema(getTargetModel()),
      "connectOrCreate?": type({
        where: () => buildWhereUniqueSchema(getTargetModel()),
        create: () => buildCreateSchema(getTargetModel()),
      }),
    });
  } else {
    // To-many: create/connect/connectOrCreate - shorthand single object normalized to array via pipe
    const createSchema = type(() => buildCreateSchema(getTargetModel()));
    const connectSchema = type(() => buildWhereUniqueSchema(getTargetModel()));
    const connectOrCreateSchema = type({
      where: () => buildWhereUniqueSchema(getTargetModel()),
      create: () => buildCreateSchema(getTargetModel()),
    });

    return type({
      "create?": createSchema.array().or(createSchema.pipe((v) => [v])),
      "connect?": connectSchema.array().or(connectSchema.pipe((v) => [v])),
      "connectOrCreate?": connectOrCreateSchema
        .array()
        .or(connectOrCreateSchema.pipe((v) => [v])),
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
      "create?": () => buildCreateSchema(getTargetModel()),
      "connect?": () => buildWhereUniqueSchema(getTargetModel()),
      "update?": () => buildUpdateSchema(getTargetModel()),
      "upsert?": type({
        create: () => buildCreateSchema(getTargetModel()),
        update: () => buildUpdateSchema(getTargetModel()),
      }),
    };

    if (isOptional) {
      baseShape["disconnect?"] = type("boolean");
      baseShape["delete?"] = type("boolean");
    }

    return type(baseShape as Record<string, Type>);
  } else {
    // To-many: shorthand single object normalized to array via pipe
    const createSchema = type(() => buildCreateSchema(getTargetModel()));
    const connectSchema = type(() => buildWhereUniqueSchema(getTargetModel()));
    const whereSchema = type(() => buildWhereSchema(getTargetModel()));
    const updateSchema = type({
      where: () => buildWhereUniqueSchema(getTargetModel()),
      data: () => buildUpdateSchema(getTargetModel()),
    });
    const updateManySchema = type({
      where: () => buildWhereSchema(getTargetModel()),
      data: () => buildUpdateSchema(getTargetModel()),
    });
    const upsertSchema = type({
      where: () => buildWhereUniqueSchema(getTargetModel()),
      create: () => buildCreateSchema(getTargetModel()),
      update: () => buildUpdateSchema(getTargetModel()),
    });

    return type({
      "create?": createSchema.array().or(createSchema.pipe((v) => [v])),
      "connect?": connectSchema.array().or(connectSchema.pipe((v) => [v])),
      "disconnect?": connectSchema.array().or(connectSchema.pipe((v) => [v])),
      "set?": connectSchema.array(),
      "delete?": connectSchema.array().or(connectSchema.pipe((v) => [v])),
      "deleteMany?": whereSchema.array().or(whereSchema.pipe((v) => [v])),
      "update?": updateSchema.array().or(updateSchema.pipe((v) => [v])),
      "updateMany?": updateManySchema
        .array()
        .or(updateManySchema.pipe((v) => [v])),
      "upsert?": upsertSchema.array().or(upsertSchema.pipe((v) => [v])),
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

