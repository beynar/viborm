// Scalar Type Definitions
// Based on specification: readme/1.3_field_scalar_types.md

// Scalar field types supported by BaseORM
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
  | "enum";

// Database mappings for scalar types
export interface DatabaseMapping {
  postgresql: string;
  mysql: string;
}

export const ScalarTypeMappings: Record<ScalarFieldType, DatabaseMapping> = {
  string: {
    postgresql: "TEXT",
    mysql: "VARCHAR(191)",
  },
  boolean: {
    postgresql: "BOOLEAN",
    mysql: "TINYINT(1)",
  },
  int: {
    postgresql: "INTEGER",
    mysql: "INT",
  },
  bigInt: {
    postgresql: "BIGINT",
    mysql: "BIGINT",
  },
  float: {
    postgresql: "DOUBLE PRECISION",
    mysql: "DOUBLE",
  },
  decimal: {
    postgresql: "DECIMAL",
    mysql: "DECIMAL",
  },
  dateTime: {
    postgresql: "TIMESTAMP",
    mysql: "DATETIME",
  },
  json: {
    postgresql: "JSONB",
    mysql: "JSON",
  },
  blob: {
    postgresql: "BYTEA",
    mysql: "BLOB",
  },
  enum: {
    postgresql: "ENUM",
    mysql: "ENUM",
  },
};

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
  : T extends "enum"
  ? string | number
  : never;

// Field configuration options
export interface FieldOptions {
  nullable?: boolean;
  unique?: boolean;
  id?: boolean;
  auto?: AutoGenerateType;
  default?: any;
  list?: boolean;
}

// String field specific options
export interface StringFieldOptions extends FieldOptions {
  minLength?: number;
  maxLength?: number;
  regex?: RegExp;
}

// Number field specific options
export interface NumberFieldOptions extends FieldOptions {
  min?: number;
  max?: number;
}

// Decimal field specific options
export interface DecimalFieldOptions extends NumberFieldOptions {
  precision?: number;
  scale?: number;
}

// Enum field specific options
export interface EnumFieldOptions<T extends readonly (string | number)[]>
  extends FieldOptions {
  values: T;
}
