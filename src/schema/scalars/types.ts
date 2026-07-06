// Scalar Types and Configurations
// Types for the scalar system (Zod-backed)

import type { StandardSchemaV1 } from "@standard-schema";

// =============================================================================
// SCALAR TYPES
// =============================================================================

export type ScalarType =
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
// SCALAR CONFIGURATION INTERFACES
// =============================================================================

/**
 * Base configuration interface for all scalar types
 * Using `| undefined` for exactOptionalPropertyTypes compatibility
 */
export interface BaseScalarConfig<T = any> {
  scalarType: ScalarType;
  isOptional: boolean;
  isArray: boolean;
  isId: boolean;
  isUnique: boolean;
  defaultValue?: T | (() => T) | undefined;
  autoGenerate?: AutoGenerateType | undefined;
}

/**
 * String scalar configuration
 */
export interface StringScalarConfig extends BaseScalarConfig<string> {
  scalarType: "string";
}

/**
 * Number scalar configuration (int, float, decimal)
 */
export interface NumberScalarConfig extends BaseScalarConfig<number> {
  scalarType: "int" | "float" | "decimal";
}

/**
 * Boolean scalar configuration
 */
export interface BooleanScalarConfig extends BaseScalarConfig<boolean> {
  scalarType: "boolean";
}

/**
 * BigInt scalar configuration
 */
export interface BigIntScalarConfig extends BaseScalarConfig<bigint> {
  scalarType: "bigInt";
}

/**
 * DateTime scalar configuration
 */
export interface DateTimeScalarConfig extends BaseScalarConfig<Date> {
  scalarType: "dateTime";
}

/**
 * JSON scalar configuration
 */
export interface JsonScalarConfig<TData = any> extends BaseScalarConfig<TData> {
  scalarType: "json";
  schema?: StandardSchemaV1<any, TData> | undefined;
}

/**
 * Blob scalar configuration
 */
export interface BlobScalarConfig extends BaseScalarConfig<Uint8Array> {
  scalarType: "blob";
}

/**
 * Enum scalar configuration
 */
export interface EnumScalarConfig<TEnum extends string | string[] = string[]>
  extends BaseScalarConfig<TEnum extends string[] ? TEnum[number] : TEnum> {
  scalarType: "enum";
  enumValues: TEnum extends string[] ? TEnum : TEnum[];
}

/**
 * Vector scalar configuration
 */
export interface VectorScalarConfig extends BaseScalarConfig<number[]> {
  scalarType: "vector";
  dimension?: number | undefined;
}

// =============================================================================
// UNION TYPES
// =============================================================================

export type ScalarConfig =
  | StringScalarConfig
  | NumberScalarConfig
  | BooleanScalarConfig
  | BigIntScalarConfig
  | DateTimeScalarConfig
  | JsonScalarConfig
  | BlobScalarConfig
  | EnumScalarConfig
  | VectorScalarConfig;
