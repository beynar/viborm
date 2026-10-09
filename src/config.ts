/**
 * VibORM Configuration Helpers
 *
 * Use this module to define your viborm.config.ts file with type safety.
 *
 * @example
 * ```ts
 * // viborm.config.ts
 * import { defineConfig } from "viborm/config";
 * import { client } from "./src/db";
 *
 * export default defineConfig({
 *   client,
 * });
 * ```
 */

export type { MigrationConfig, VibORMConfig } from "./cli/utils";
export { defineConfig } from "./cli/utils";
