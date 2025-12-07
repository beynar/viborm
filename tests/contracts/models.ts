/**
 * Shared Test Models for Contract Tests
 *
 * Models designed to test every field type and relation type.
 * Each field has required, nullable, default, and array variants where applicable.
 */

import z from "zod/v4";
import { s } from "../../src/schema/index.js";

// =============================================================================
// STRING FIELD MODEL
// =============================================================================

export const stringModel = s.model({
  id: s.string().id().ulid(),
  required: s.string(),
  nullable: s.string().nullable(),
  withDefault: s.string().default("default"),
  array: s.string().array(),
  nullableArray: s.string().nullable().array(),
});

// =============================================================================
// INT FIELD MODEL
// =============================================================================

export const intModel = s.model({
  id: s.string().id().ulid(),
  required: s.int(),
  nullable: s.int().nullable(),
  withDefault: s.int().default(0),
  array: s.int().array(),
});

// =============================================================================
// FLOAT FIELD MODEL
// =============================================================================

export const floatModel = s.model({
  id: s.string().id().ulid(),
  required: s.float(),
  nullable: s.float().nullable(),
  withDefault: s.float().default(0.0),
  array: s.float().array(),
});

// =============================================================================
// DECIMAL FIELD MODEL
// =============================================================================

export const decimalModel = s.model({
  id: s.string().id().ulid(),
  required: s.decimal(),
  nullable: s.decimal().nullable(),
  withDefault: s.decimal().default(0),
  array: s.decimal().array(),
});

// =============================================================================
// BOOLEAN FIELD MODEL
// =============================================================================

export const booleanModel = s.model({
  id: s.string().id().ulid(),
  required: s.boolean(),
  nullable: s.boolean().nullable(),
  withDefault: s.boolean().default(false),
  array: s.boolean().array(),
});

// =============================================================================
// DATETIME FIELD MODEL
// =============================================================================

export const datetimeModel = s.model({
  id: s.string().id().ulid(),
  required: s.dateTime(),
  nullable: s.dateTime().nullable(),
  withDefault: s.dateTime().now(),
  array: s.dateTime().array(),
});

// =============================================================================
// BIGINT FIELD MODEL
// =============================================================================

export const bigintModel = s.model({
  id: s.string().id().ulid(),
  required: s.bigInt(),
  nullable: s.bigInt().nullable(),
  withDefault: s.bigInt().default(BigInt(0)),
  array: s.bigInt().array(),
});

// =============================================================================
// JSON FIELD MODEL
// =============================================================================

export const jsonSchema = z.object({
  name: z.string(),
  count: z.number(),
});

export const jsonModel = s.model({
  id: s.string().id().ulid(),
  required: s.json(jsonSchema),
  nullable: s.json(jsonSchema).nullable(),
  withDefault: s.json(jsonSchema).default({ name: "default", count: 0 }),
  untyped: s.json(), // JSON without schema
  untypedNullable: s.json().nullable(),
});

// =============================================================================
// BLOB FIELD MODEL
// Note: Blob fields do not support array modifier
// =============================================================================

export const blobModel = s.model({
  id: s.string().id().ulid(),
  required: s.blob(),
  nullable: s.blob().nullable(),
  withDefault: s.blob().default(new Uint8Array([0])),
});

// =============================================================================
// ENUM FIELD MODEL
// =============================================================================

export const enumModel = s.model({
  id: s.string().id().ulid(),
  required: s.enum(["A", "B", "C"]),
  nullable: s.enum(["A", "B", "C"]).nullable(),
  withDefault: s.enum(["A", "B", "C"]).default("A"),
  array: s.enum(["A", "B", "C"]).array(),
});

// =============================================================================
// RELATION MODELS (Separate models to isolate relation type tests)
// =============================================================================

// --- One-to-One Models ---
export const oneToOneTarget = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
});

export const oneToOneSource = s.model({
  id: s.string().id().ulid(),
  targetId: s.string().unique(),
  target: s.oneToOne(() => oneToOneTarget).optional(),
});

// --- One-to-Many Models ---
export const oneToManyChild = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  parentId: s.string(),
});

export const oneToManyParent = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  children: s.oneToMany(() => oneToManyChild),
});

// --- Many-to-One Models ---
export const manyToOneTarget = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
});

export const manyToOneSource = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  targetId: s.string(),
  target: s.manyToOne(() => manyToOneTarget),
});

// --- Many-to-Many Models ---
export const manyToManyA = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
});

export const manyToManyB = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  aList: s.manyToMany(() => manyToManyA),
});

// Legacy exports for backward compatibility
export const author = oneToManyParent;
export const post = manyToOneSource;
export const profile = oneToOneTarget;
export const category = manyToOneTarget;
export const tag = manyToManyA;

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type StringModelFields = (typeof stringModel)["~"]["fields"];
export type IntModelFields = (typeof intModel)["~"]["fields"];
export type FloatModelFields = (typeof floatModel)["~"]["fields"];
export type DecimalModelFields = (typeof decimalModel)["~"]["fields"];
export type BooleanModelFields = (typeof booleanModel)["~"]["fields"];
export type DatetimeModelFields = (typeof datetimeModel)["~"]["fields"];
export type BigintModelFields = (typeof bigintModel)["~"]["fields"];
export type JsonModelFields = (typeof jsonModel)["~"]["fields"];
export type BlobModelFields = (typeof blobModel)["~"]["fields"];
export type EnumModelFields = (typeof enumModel)["~"]["fields"];
// Type exports for relation tests
export type OneToOneSourceFields = (typeof oneToOneSource)["~"]["fields"];
export type OneToOneTargetFields = (typeof oneToOneTarget)["~"]["fields"];
export type OneToManyParentFields = (typeof oneToManyParent)["~"]["fields"];
export type OneToManyChildFields = (typeof oneToManyChild)["~"]["fields"];
export type ManyToOneSourceFields = (typeof manyToOneSource)["~"]["fields"];
export type ManyToOneTargetFields = (typeof manyToOneTarget)["~"]["fields"];
export type ManyToManyAFields = (typeof manyToManyA)["~"]["fields"];
export type ManyToManyBFields = (typeof manyToManyB)["~"]["fields"];

