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
import type { VibORMClient, VibORMConfig as ClientConfig } from "../client/client";
import type { AnyDriver } from "../drivers/driver";
import type { MigrationStorageDriver } from "../migrations/storage/driver";
import type { AnyModel } from "../schema/model";
import { validateSchemaOrThrow } from "../schema/validation";

// =============================================================================
// CONFIG TYPES
// =============================================================================

/**
 * Migration configuration options.
 */
export interface MigrationConfig {
  /** Directory for migration files (default: "./migrations") */
  dir?: string;
  /** Name of the migrations tracking table (default: "_viborm_migrations") */
  tableName?: string;
  /**
   * Storage driver for migration files.
   * If not provided, uses filesystem storage with the `dir` option.
   *
   * @example
   * ```ts
   * import { createFsStorageDriver } from "viborm/migrations/storage/fs";
   *
   * migrations: {
   *   storageDriver: createFsStorageDriver("./migrations"),
   * }
   * ```
   */
  storageDriver?: MigrationStorageDriver;
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
        `  const client = createClient({ driver, schema });\n\n` +
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
  const models = extractModels(schemaInput as Record<string, unknown>);

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
      models[key] = value as AnyModel;
    }
  }

  return models;
}

/**
 * Checks if a value is a VibORM Model instance.
 */
function isModel(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "~" in value &&
    typeof (value as any)["~"] === "object" &&
    "state" in (value as any)["~"] &&
    "fields" in (value as any)["~"].state
  );
}

/**
 * Checks if a value is a valid VibORM client instance.
 */
function isValidClient(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "$driver" in value &&
    "$schema" in value
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

// =============================================================================
// FORMATTING
// =============================================================================

/**
 * Formats bytes into human-readable size.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return "0 B";
  }
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

/**
 * Formats milliseconds into human-readable duration.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${(ms / 60_000).toFixed(1)}m`;
}
