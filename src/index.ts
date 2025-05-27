// BaseORM - Main Entry Point
// TypeScript ORM for Postgres and MySQL

import { Model, s } from "./schema/index.js";

// Main exports - Schema Builder
export { s, SchemaBuilder, Model, Relation } from "./schema/index.js";
export type { Field } from "./schema/index.js";

// Type exports
export type * from "./types/index.js";

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
  get friends() {
    return z.lazy(() => profile);
  },
});

type R = (typeof profile._output)["friends"];

// Testing circular relations - even simpler than Zod!
const user = s.model("user", {
  id: s.string().uuid(),
  name: s.string(),
  // get friends() {
  //   return s.relation(() => user); // All relations are lazy by default!
  // },
});

const test2 = s.model("test2", {
  test: s.string(),
  get user() {
    return s.relation(() => user);
  },
});

const test = s.model("test", {
  string: s.string().uuid(),
  date: s.dateTime().nullable(),
  status: s.enum(["active", "inactive"] as const),
  // profile: s.json(profile),
  get friends() {
    return s.relation(() => test);
  },
});

type test2 = typeof test2;
type test = test2 extends Model<any> ? true : false;

type U = typeof test.infer;
