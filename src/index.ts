// VibeORM - Main Entry Point
// TypeScript ORM for Postgres and MySQL

// Main exports - Schema Builder
export { s, SchemaBuilder, Model, Relation } from "./schema/index.js";
export type { Field } from "./schema/index.js";

// Type exports
export type * from "./types/index.js";

// Version and metadata
export const VERSION = "0.1.0";
export const SUPPORTED_DATABASES = ["postgresql", "mysql"] as const;

// Main schema builder instance (re-exported for convenience)
export { s as schema } from "./schema/index.js";
