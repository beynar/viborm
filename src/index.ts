// BaseORM - Main Entry Point
// TypeScript ORM for Postgres and MySQL

import { s } from "./schema/index.js";

// Main exports - Schema Builder
export { s, SchemaBuilder, Model, Relation } from "./schema/index.js";
export type { Field } from "./schema/index.js";

// Type exports
export type * from "./types/index.js";

// Validation utilities
export * from "./validation/index.js";

// Query builder
export { QueryBuilder } from "./query/queryBuilder.js";

// Version and metadata
export const VERSION = "0.1.0";
export const SUPPORTED_DATABASES = ["postgresql", "mysql"] as const;

// Main schema builder instance (re-exported for convenience)
export { s as schema } from "./schema/index.js";

const test = s.model("test", {
  string: s.string().nullable(),
  boolean: s.boolean(),
  number: s.int(),
  bigint: s.bigInt(),
  float: s.float(),
  decimal: s.decimal(1, 2),
  dateTime: s.dateTime(),
  json: s.json(),
  blob: s.blob(),
});

type U = typeof test.infer;
