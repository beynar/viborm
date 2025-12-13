// Field Types and Configurations
// Types for the field system (Zod-backed)

import type { StandardSchemaV1 } from "../../standardSchema";
import type { ZodType } from "zod/v4-mini";

// =============================================================================
// SCALAR FIELD TYPES
// =============================================================================

export type ScalarFieldType =
  | "string"
  | "boolean"
  | "int"
  | "bigInt"
  | "float"
  | "decimal"
  | "dateTime"
  | "json"
  | "blob"
  | "vector"
  | "enum";

// =============================================================================
// AUTO-GENERATION TYPES
// =============================================================================

export type AutoGenerateType =
  | "uuid"
  | "ulid"
  | "nanoid"
  | "cuid"
  | "increment"
  | "now"
  | "updatedAt";

// =============================================================================
// FIELD CONFIGURATION INTERFACES
// =============================================================================

/**
 * Base configuration interface for all field types
 * Using `| undefined` for exactOptionalPropertyTypes compatibility
 */
export interface BaseFieldConfig<T = any> {
  fieldType: ScalarFieldType;
  isOptional: boolean;
  isArray: boolean;
  isId: boolean;
  isUnique: boolean;
  defaultValue?: T | (() => T) | undefined;
  autoGenerate?: AutoGenerateType | undefined;
}

/**
 * String field configuration
 */
export interface StringFieldConfig extends BaseFieldConfig<string> {
  fieldType: "string";
}

/**
 * Number field configuration (int, float, decimal)
 */
export interface NumberFieldConfig extends BaseFieldConfig<number> {
  fieldType: "int" | "float" | "decimal";
}

/**
 * Boolean field configuration
 */
export interface BooleanFieldConfig extends BaseFieldConfig<boolean> {
  fieldType: "boolean";
}

/**
 * BigInt field configuration
 */
export interface BigIntFieldConfig extends BaseFieldConfig<bigint> {
  fieldType: "bigInt";
}

/**
 * DateTime field configuration
 */
export interface DateTimeFieldConfig extends BaseFieldConfig<Date> {
  fieldType: "dateTime";
}

/**
 * JSON field configuration
 */
export interface JsonFieldConfig<TData = any> extends BaseFieldConfig<TData> {
  fieldType: "json";
  schema?: StandardSchemaV1<any, TData> | undefined;
}

/**
 * Blob field configuration
 */
export interface BlobFieldConfig extends BaseFieldConfig<Uint8Array> {
  fieldType: "blob";
}

/**
 * Enum field configuration
 */
export interface EnumFieldConfig<TEnum extends string | string[] = string[]>
  extends BaseFieldConfig<TEnum extends string[] ? TEnum[number] : TEnum> {
  fieldType: "enum";
  enumValues: TEnum extends string[] ? TEnum : TEnum[];
}

/**
 * Vector field configuration
 */
export interface VectorFieldConfig extends BaseFieldConfig<number[]> {
  fieldType: "vector";
  dimension?: number | undefined;
}

// =============================================================================
// FIELD SCHEMAS INTERFACE
// =============================================================================

/**
 * Common interface for field schemas
 * Each field exposes these schemas for validation (Zod types)
 */
export interface FieldSchemas {
  /** Base type schema */
  base: ZodType;
  /** Filter schema for where clauses */
  filter: ZodType;
  /** Create input schema */
  create: ZodType;
  /** Update input schema */
  update: ZodType;
}

// =============================================================================
// UNION TYPES
// =============================================================================

export type FieldConfig =
  | StringFieldConfig
  | NumberFieldConfig
  | BooleanFieldConfig
  | BigIntFieldConfig
  | DateTimeFieldConfig
  | JsonFieldConfig
  | BlobFieldConfig
  | EnumFieldConfig
  | VectorFieldConfig;
