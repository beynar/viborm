// VibORM - Main Entry Point
// TypeScript ORM for Postgres and MySQL

export type { VibORMClient, VibORMConfig } from "./client/client.js";
export { createClient, NotFoundError } from "./client/client.js";

// Main exports - Schema Builder
export { s } from "./schema/index.js";
