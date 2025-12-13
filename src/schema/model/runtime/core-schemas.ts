// Core Schema Builders
// ArkType runtime schemas for model operations

import { type, Type } from "arktype";
import type { Model } from "../model";
import type { AnyRelation, Relation } from "../../relation/relation";
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
// WHERE SCHEMA (Two-Phase)
// =============================================================================

/**
 * Helper to check if object is a to-one shorthand filter (has is/isNot key)
 */
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
 * Phase 1: Builds a where schema with only scalar field filters.
 * No cross-model dependencies - safe to build in Model constructor.
 */
export const buildWhereScalarSchema = <TFields extends FieldRecord>(
  model: Model<any>
): Type => {
  const shape: Record<string, Type> = {};

  // Add scalar field filters only
  for (const [name, field] of model["~"].fieldMap) {
    shape[name + "?"] = field["~"].schemas.filter;
  }

  return type(shape);
};

/**
 * Placeholder type used when target model's schemas are being built.
 * This allows circular references to work - the actual schema is resolved at validation time.
 */
const placeholderType = type("object");

/**
 * Builds a to-one relation filter schema.
 * Supports explicit { is: {...}, isNot: {...} } forms.
 * Uses lazy thunks to access target model's where schema.
 * Returns placeholder during circular reference resolution.
 * NOTE: Shorthand normalization (e.g., { author: { name: "Alice" } } -> { is: { name: "Alice" } })
 * is handled at the query parser layer, not in the schema.
 */
export const buildToOneRelationFilter = <TFields extends FieldRecord>(
  relation: AnyRelation,
  getTargetModel: () => Model<any>
): Type => {
  const isOptional = relation["~"].isOptional ?? false;
  // Return placeholder during building to handle circular refs

  if (isOptional) {
    // Optional to-one: is, isNot, or null
    return type({
      "is?": () => {
        return getTargetModel()["~"].schemas?.where;
      },
      "isNot?": () => {
        return getTargetModel()["~"].schemas?.where;
      },
    });
  } else {
    // Required to-one: is, isNot only
    return type({
      "is?": () => {
        console.log("001", getTargetModel()["~"].schemas?.where);
        return getTargetModel()["~"].schemas?.where;
      },
      "isNot?": () => {
        console.log("001", getTargetModel()["~"].schemas?.where);
        return getTargetModel()["~"].schemas?.where;
      },
    });
  }
};

/**
 * Builds a to-many relation filter schema with some/every/none operators.
 * Uses lazy evaluation via thunks to handle circular references.
 * Returns placeholder during circular reference resolution.
 */
export const buildToManyRelationFilter = (
  getTargetModel: () => Model<any>
): Type => {
  // Return placeholder during building to handle circular refs

  return type({
    "some?": () => getTargetModel()["~"].schemas?.where,
    "every?": () => getTargetModel()["~"].schemas?.where,
    "none?": () => getTargetModel()["~"].schemas?.where,
  });
};

/**
 * Phase 2: Builds full where schema with scalar + relation filters.
 * Builds the combined shape directly to avoid ArkType merge type issues.
 * All relation filters are wrapped in thunks to prevent recursion during building.
 */
export const buildWhereSchema = <TFields extends FieldRecord>(
  model: Model<any>
): Type<ModelWhereInput<TFields>> => {
  const shape: Record<string, Type | (() => Type)> = {};

  // Add scalar field filters
  for (const [name, field] of model["~"].fieldMap) {
    shape[name + "?"] = field["~"].schemas.filter;
  }

  // Add relation filters - all wrapped in thunks to prevent recursion
  for (const [name, relation] of model["~"].relations) {
    const relationType = relation["~"].relationType;
    const getTargetModel = relation["~"].getter;

    if (relationType === "oneToOne" || relationType === "manyToOne") {
      // Wrap in thunk to defer .pipe() compilation until validation time
      shape[name + "?"] = buildToOneRelationFilter<TFields>(
        relation,
        getTargetModel
      );
      // shape[name + "?"] = () => {
      //   console.log(
      //     "00",
      //     buildToOneRelationFilter<TFields>(relation, getTargetModel)
      //   );
      //   return buildToOneRelationFilter<TFields>(relation, getTargetModel);
      // };
    } else {
      // To-many relations: some, every, none filters
      // shape[name + "?"] = buildToManyRelationFilter(getTargetModel);
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
// CREATE SCHEMA (Two-Phase)
// =============================================================================

/**
 * Helper to wrap single value in array - used for to-many relation normalization
 * Avoids ArkType morph/array union conflict by using pipe on the union
 */
const ensureArray = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

/**
 * Phase 1: Builds a create schema with only scalar fields.
 * No cross-model dependencies - safe to build in Model constructor.
 */
export const buildCreateScalarSchema = <TFields extends FieldRecord>(
  model: Model<any>
): Type => {
  const shape: Record<string, Type> = {};

  // Scalar fields - optional if hasDefault, autoGenerate, or nullable
  for (const [name, field] of model["~"].fieldMap) {
    const state = field["~"].state;
    const isOptional =
      state.hasDefault || state.autoGenerate !== undefined || state.nullable;
    const key = isOptional ? name + "?" : name;
    shape[key] = field["~"].schemas.create;
  }

  return type(shape);
};

/**
 * Builds a to-one relation create schema (create, connect, connectOrCreate).
 * Uses lazy evaluation via thunks for nested creates.
 * Returns placeholder during circular reference resolution.
 */
export const buildToOneRelationCreateSchema = (
  getTargetModel: () => Model<any>
): Type => {
  // Return placeholder during building to handle circular refs
  const getCreate = () =>
    getTargetModel()["~"].schemas?.create ?? placeholderType;
  const getWhereUnique = () =>
    getTargetModel()["~"].schemas?.whereUnique ?? placeholderType;

  return type({
    "create?": () => getCreate(),
    "connect?": () => getWhereUnique(),
    "connectOrCreate?": () =>
      type({
        where: () => getWhereUnique(),
        create: () => getCreate(),
      }),
  });
};

/**
 * Builds a to-many relation create schema with array normalization.
 * Supports single object shorthand normalized to array.
 * Returns placeholder during circular reference resolution.
 */
export const buildToManyRelationCreateSchema = (
  getTargetModel: () => Model<any>
): Type => {
  // Return placeholder during building to handle circular refs
  const getCreate = () =>
    getTargetModel()["~"].schemas?.create ?? placeholderType;
  const getWhereUnique = () =>
    getTargetModel()["~"].schemas?.whereUnique ?? placeholderType;

  return type({
    "create?": () => {
      const schema = getCreate();
      return schema.or(schema.array()).pipe(ensureArray);
    },
    "connect?": () => {
      const schema = getWhereUnique();
      return schema.or(schema.array()).pipe(ensureArray);
    },
    "connectOrCreate?": () => {
      const connectOrCreateSchema = type({
        where: () => getWhereUnique(),
        create: () => getCreate(),
      });
      return connectOrCreateSchema
        .or(connectOrCreateSchema.array())
        .pipe(ensureArray);
    },
  });
};

/**
 * Builds a relation create schema based on relation type.
 */
export const buildRelationCreateSchema = (
  relation: AnyRelation,
  getTargetModel: () => Model<any>
): Type => {
  const relationType = relation["~"].relationType;

  if (relationType === "oneToOne" || relationType === "manyToOne") {
    return buildToOneRelationCreateSchema(getTargetModel);
  } else {
    return buildToManyRelationCreateSchema(getTargetModel);
  }
};

/**
 * Phase 2: Builds full create schema with scalar + relation fields.
 * Builds the combined shape directly to avoid ArkType merge type issues.
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
    shape[name + "?"] = buildRelationCreateSchema(relation, getTargetModel);
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
// UPDATE SCHEMA (Two-Phase)
// =============================================================================

/**
 * Phase 1: Builds an update schema with only scalar fields.
 * No cross-model dependencies - safe to build in Model constructor.
 */
export const buildUpdateScalarSchema = <TFields extends FieldRecord>(
  model: Model<any>
): Type => {
  const shape: Record<string, Type> = {};

  // Scalar fields - all optional in update operations
  for (const [name, field] of model["~"].fieldMap) {
    shape[name + "?"] = field["~"].schemas.update;
  }

  return type(shape);
};

/**
 * Builds a to-one relation update schema.
 * Includes create, connect, update, upsert, and optionally disconnect/delete.
 * Returns placeholder during circular reference resolution.
 */
export const buildToOneRelationUpdateSchema = (
  relation: AnyRelation,
  getTargetModel: () => Model<any>
): Type => {
  const isOptional = relation["~"].isOptional ?? false;

  // Return placeholder during building to handle circular refs
  const getCreate = () =>
    getTargetModel()["~"].schemas?.create ?? placeholderType;
  const getWhereUnique = () =>
    getTargetModel()["~"].schemas?.whereUnique ?? placeholderType;
  const getUpdate = () =>
    getTargetModel()["~"].schemas?.update ?? placeholderType;

  const baseShape: Record<string, Type | (() => Type)> = {
    "create?": () => getCreate(),
    "connect?": () => getWhereUnique(),
    "update?": () => getUpdate(),
    "upsert?": () =>
      type({
        create: () => getCreate(),
        update: () => getUpdate(),
      }),
  };

  if (isOptional) {
    baseShape["disconnect?"] = type("boolean");
    baseShape["delete?"] = type("boolean");
  }

  return type(baseShape as Record<string, Type>);
};

/**
 * Builds a to-many relation update schema.
 * Includes array operations for create, connect, disconnect, set, delete, update, upsert.
 * Returns placeholder during circular reference resolution.
 */
export const buildToManyRelationUpdateSchema = (
  getTargetModel: () => Model<any>
): Type => {
  // Return placeholder during building to handle circular refs
  const getCreate = () =>
    getTargetModel()["~"].schemas?.create ?? placeholderType;
  const getWhereUnique = () =>
    getTargetModel()["~"].schemas?.whereUnique ?? placeholderType;
  const getWhere = () =>
    getTargetModel()["~"].schemas?.where ?? placeholderType;
  const getUpdate = () =>
    getTargetModel()["~"].schemas?.update ?? placeholderType;

  return type({
    // create/connect/disconnect/delete use whereUnique/create (no morphs) - shorthand supported
    "create?": () => {
      const schema = getCreate();
      return schema.or(schema.array()).pipe(ensureArray);
    },
    "connect?": () => {
      const schema = getWhereUnique();
      return schema.or(schema.array()).pipe(ensureArray);
    },
    "disconnect?": () => {
      const schema = getWhereUnique();
      return schema.or(schema.array()).pipe(ensureArray);
    },
    "set?": () => getWhereUnique().array(),
    "delete?": () => {
      const schema = getWhereUnique();
      return schema.or(schema.array()).pipe(ensureArray);
    },
    // Operations with update data (has morphs) - array only, no shorthand
    "deleteMany?": () => getWhere().array(),
    "update?": () =>
      type({
        where: () => getWhereUnique(),
        data: () => getUpdate(),
      }).array(),
    "updateMany?": () =>
      type({
        where: () => getWhere(),
        data: () => getUpdate(),
      }).array(),
    "upsert?": () =>
      type({
        where: () => getWhereUnique(),
        create: () => getCreate(),
        update: () => getUpdate(),
      }).array(),
  });
};

/**
 * Builds a relation update schema based on relation type.
 */
export const buildRelationUpdateSchema = (
  relation: AnyRelation,
  getTargetModel: () => Model<any>
): Type => {
  const relationType = relation["~"].relationType;

  if (relationType === "oneToOne" || relationType === "manyToOne") {
    return buildToOneRelationUpdateSchema(relation, getTargetModel);
  } else {
    return buildToManyRelationUpdateSchema(getTargetModel);
  }
};

/**
 * Phase 2: Builds full update schema with scalar + relation fields.
 * Builds the combined shape directly to avoid ArkType merge type issues.
 */
export const buildUpdateSchema = <TFields extends FieldRecord>(
  model: Model<any>
): Type<ModelUpdateInput<TFields>> => {
  const shape: Record<string, Type | (() => Type)> = {};

  // Scalar fields - all optional in update operations
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
