/**
 * CLI Utilities
 *
 * Configuration loading and other CLI utilities.
 *
 * Config file pattern similar to:
 * - drizzle.config.ts
 * - prisma (uses schema.prisma but we use TS)
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  VibORMConfig as ClientConfig,
  VibORMClient,
} from "../client/client";
import type { AnyDriver } from "../drivers/driver";
import { isVibORMError } from "../errors";
import type { MigrationStorageWriter } from "../migrations/storage/contract";
import type { AnyModel } from "../schema/model";
import { validateSchemaOrThrow } from "../schema/validation";

// =============================================================================
// CONFIG TYPES
// =============================================================================

/**
 * Migration configuration options.
 */
export interface MigrationConfig {
  /** Estate directory (default: "./migrations") */
  dir?: string;
  /**
   * Estate storage writer. Defaults to filesystem storage at `dir`.
   *
   * @example
   * ```ts
   * import { createFsStorageWriter } from "viborm/migrations";
   *
   * migrations: {
   *   storage: createFsStorageWriter("./migrations"),
   * }
   * ```
   */
  storage?: MigrationStorageWriter;
}

/**
 * VibORM configuration file format.
 *
 * Example viborm.config.ts:
 * ```ts
 * import { defineConfig } from "viborm/config";
 * import { client } from "./src/db";
 *
 * export default defineConfig({
 *   client,
 * });
 * ```
 */
export interface VibORMConfig {
  /** VibORM client instance */
  client: VibORMClient<any>;
  /** Optional: Migration configuration */
  migrations?: MigrationConfig;
}

export interface LoadConfigOptions {
  /** Path to config file (default: ./viborm.config.ts) */
  config?: string;
}

export interface LoadedConfig {
  client: VibORMClient<ClientConfig>;
  driver: AnyDriver;
  models: Record<string, AnyModel>;
  migrations?: MigrationConfig;
}

// =============================================================================
// CONFIG FILE DISCOVERY
// =============================================================================

const CONFIG_FILES = [
  "viborm.config.ts",
  "viborm.config.mts",
  "viborm.config.js",
  "viborm.config.mjs",
];

/**
 * Finds the first existing file from a list of candidates.
 */
function findFile(cwd: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const fullPath = resolve(cwd, candidate);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

// =============================================================================
// CONFIG LOADING
// =============================================================================

/**
 * Loads VibORM configuration from viborm.config.ts file.
 *
 * The config file should export a default configuration object with:
 * - client: VibORM client instance created with createClient()
 */
export function failCli(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

export async function loadConfig(
  options: LoadConfigOptions = {}
): Promise<LoadedConfig> {
  const cwd = process.cwd();

  // Find config file
  const configPath = options.config
    ? resolve(cwd, options.config)
    : findFile(cwd, CONFIG_FILES);

  if (!(configPath && existsSync(configPath))) {
    const searchedPaths = options.config ? [options.config] : CONFIG_FILES;

    throw new Error(
      "Could not find VibORM configuration file.\n\n" +
        `Searched for:\n${searchedPaths.map((f) => `  - ${f}`).join("\n")}\n\n` +
        "Create a viborm.config.ts file:\n\n" +
        `  import { defineConfig } from "viborm/config";\n` +
        `  import { client } from "./src/db";\n\n` +
        "  export default defineConfig({\n" +
        "    client,\n" +
        "  });\n"
    );
  }

  // Load the config file
  const configModule = await importModule(configPath);

  // Extract config (handle both default export and named export)
  const config: VibORMConfig =
    configModule.default || configModule.config || configModule;

  // Validate client
  if (!config.client) {
    throw new Error(
      `Missing "client" in ${configPath}.\n\n` +
        "Your config should include a VibORM client:\n\n" +
        `  import { createClient } from "viborm";\n` +
        "  const client = createClient({ driver, schema });\n\n" +
        "  export default defineConfig({\n" +
        "    client,\n" +
        "  });\n"
    );
  }

  if (!isValidClient(config.client)) {
    throw new Error(
      `Invalid "client" in ${configPath}.\n\n` +
        "The client must be created with createClient().\n"
    );
  }

  // Extract driver and schema from client
  const driver = config.client.$driver;
  const schemaInput = config.client.$schema;

  // Extract models from schema (filter out non-model exports)
  const models = extractModels(schemaInput);

  if (Object.keys(models).length === 0) {
    throw new Error(
      `No models found in client schema from ${configPath}.\n\n` +
        "Make sure your client was created with schema models:\n\n" +
        "  // src/schema.ts\n" +
        `  import { model, string, int } from "viborm";\n\n` +
        "  export const user = model({\n" +
        "    id: string().id(),\n" +
        "    name: string(),\n" +
        "  });\n"
    );
  }

  // Validate schema before proceeding
  validateSchemaOrThrow(models);

  return {
    client: config.client,
    driver,
    models,
    migrations: config.migrations,
  };
}

/**
 * Dynamically imports a TypeScript/JavaScript module.
 */
async function importModule(filePath: string): Promise<any> {
  try {
    const module = await import(pathToFileURL(filePath).href);
    return module;
  } catch (e) {
    if (isVibORMError(e)) throw e;
    if (filePath.endsWith(".ts") || filePath.endsWith(".mts")) {
      throw new Error(
        `Failed to load ${filePath}.\n\n` +
          `Make sure you're running with a TypeScript loader:\n\n` +
          "  # Using bun (recommended)\n" +
          "  bun viborm push\n\n" +
          "  # Using tsx\n" +
          "  npx tsx node_modules/.bin/viborm push\n\n" +
          "  # Using ts-node\n" +
          "  npx ts-node --esm node_modules/.bin/viborm push\n"
      );
    }
    throw e;
  }
}

/**
 * Extracts model objects from a module by checking for Model instances.
 */
function extractModels(
  schema: Record<string, unknown>
): Record<string, AnyModel> {
  const models: Record<string, AnyModel> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (isModel(value)) {
      models[key] = value;
    }
  }

  return models;
}

/**
 * Checks if a value is a VibORM Model instance.
 */
function isModel(value: unknown): value is AnyModel {
  if (value === null || typeof value !== "object") return false;
  const metadata = Reflect.get(value, "~");
  if (metadata === null || typeof metadata !== "object") return false;
  const state = Reflect.get(metadata, "state");
  // Model state exposes `scalars`/`relations` (never `fields`); the rest of
  // the codebase discriminates models the same way (see serializer).
  return state !== null && typeof state === "object" && "scalars" in state;
}

/**
 * Checks if a value is a valid VibORM client instance.
 */
function isValidClient(value: unknown): boolean {
  // The client is a Proxy whose only trap is `get`, so `"$driver" in value`
  // (which triggers the `has` trap / falls back to the bare target) is always
  // false. Probe via property access instead.
  // `typeof null === "object"`, so null has to be refused here: Reflect.get
  // throws on it rather than answering undefined.
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return false;
  }
  return (
    Reflect.get(value, "$driver") !== undefined &&
    Reflect.get(value, "$schema") !== undefined
  );
}

// =============================================================================
// DEFINE CONFIG HELPER
// =============================================================================

/**
 * Helper function for defining VibORM configuration with type safety.
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
export function defineConfig(config: VibORMConfig): VibORMConfig {
  return config;
}
