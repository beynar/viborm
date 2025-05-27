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

const string = s.string().nullable();

import { z } from "zod/v4";

const profile = z.object({
  name: z.string(),
  age: z.number(),
});

const test = s.model("test", {
  string: s.string().auto.uuid(),
  date: s.dateTime().nullable(),
  status: s.enum(["active", "inactive"] as const),
  profile: s.json(profile),
});

type U = typeof test.infer;
