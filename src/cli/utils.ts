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
import { createClient, type VibORMClient, type VibORMConfig as ClientConfig } from "../client/client";
import type { AnyDriver } from "../drivers/driver";
import type { AnyModel } from "../schema/model";

// =============================================================================
// CONFIG TYPES
// =============================================================================

/**
 * VibORM configuration file format.
 *
 * Example viborm.config.ts:
 * ```ts
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
export interface VibORMConfig {
  /** Database driver instance */
  driver: AnyDriver;
  /** Schema models */
  schema: Record<string, AnyModel>;
  /** Optional: Output directory for generated files */
  out?: string;
}

export interface LoadConfigOptions {
  /** Path to config file (default: ./viborm.config.ts) */
  config?: string;
}

export interface LoadedConfig {
  client: VibORMClient<ClientConfig>;
  driver: AnyDriver;
  models: Record<string, AnyModel>;
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
 * - driver: Database driver instance
 * - schema: Object containing model definitions
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
        `  import { driver } from "./src/db";\n` +
        `  import * as schema from "./src/schema";\n\n` +
        "  export default defineConfig({\n" +
        "    driver,\n" +
        "    schema,\n" +
        "  });\n"
    );
  }

  // Load the config file
  const configModule = await importModule(configPath);

  // Extract config (handle both default export and named export)
  const config: VibORMConfig =
    configModule.default || configModule.config || configModule;

  // Validate required fields
  if (!config.driver) {
    throw new Error(
      `Missing "driver" in ${configPath}.\n\n` +
        "Your config should include a database driver:\n\n" +
        "  export default defineConfig({\n" +
        "    driver: yourDriver,\n" +
        "    schema: { ... },\n" +
        "  });\n"
    );
  }

  if (!config.schema || typeof config.schema !== "object") {
    throw new Error(
      `Missing "schema" in ${configPath}.\n\n` +
        "Your config should include schema models:\n\n" +
        `  import * as schema from "./src/schema";\n\n` +
        "  export default defineConfig({\n" +
        "    driver,\n" +
        "    schema,\n" +
        "  });\n"
    );
  }

  // Extract models from schema (filter out non-model exports)
  const models = extractModels(config.schema);

  if (Object.keys(models).length === 0) {
    throw new Error(
      `No models found in schema from ${configPath}.\n\n` +
        "Make sure your schema exports VibORM models:\n\n" +
        "  // src/schema.ts\n" +
        `  import { model, string, int } from "viborm";\n\n` +
        "  export const user = model({\n" +
        "    id: string().id(),\n" +
        "    name: string(),\n" +
        "  });\n"
    );
  }

  // Create client from driver and models
  const client = createClient({
    driver: config.driver,
    schema: models,
  });

  return {
    client,
    driver: config.driver,
    models,
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
 * import { driver } from "./src/db";
 * import * as schema from "./src/schema";
 *
 * export default defineConfig({
 *   driver,
 *   schema,
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
