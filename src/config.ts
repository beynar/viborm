/**
 * VibORM Configuration Helpers
 *
 * Use this module to define your viborm.config.ts file with type safety.
 *
 * @example
 * ```ts
 * // viborm.config.ts
 * import { defineConfig } from "viborm/config";
 * import { driver } from "./src/db";
 * import * as schema from "./src/schema";
 *
 * export default defineConfig({
 *   driver,
 *   schema,
 * });
 * ```
 */

export type { VibORMConfig } from "./cli/utils";
export { defineConfig } from "./cli/utils";
