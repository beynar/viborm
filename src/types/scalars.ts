// Scalar Type Definitions
// Based on specification: readme/1.3_field_scalar_types.md

// Scalar field types supported by VibORM
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

// Database mappings for scalar types
export interface DatabaseMapping {
  postgresql: string;
  mysql: string;
}

// Auto-generation types
export type AutoGenerateType =
  | "uuid"
  | "ulid"
  | "nanoid"
  | "cuid"
  | "increment"
  | "now"
  | "updatedAt";

// Type mapping from scalar types to TypeScript types
export type ScalarToTypeScript<T extends ScalarFieldType> = T extends "string"
  ? string
  : T extends "boolean"
  ? boolean
  : T extends "int" | "float" | "decimal"
  ? number
  : T extends "bigInt"
  ? bigint
  : T extends "dateTime"
  ? Date
  : T extends "json"
  ? any
  : T extends "blob"
  ? Uint8Array
  : T extends "vector"
  ? number[]
  : T extends "enum"
  ? string | number
  : never;
