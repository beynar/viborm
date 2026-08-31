/** Configuration fixture harness for the CLI utility contracts. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SOURCE_ROOT } from "@tests/fixtures/repo-paths";

// ---------------------------------------------------------------------------
// Temp project fixture
// ---------------------------------------------------------------------------

const SRC = SOURCE_ROOT;
const PGLITE_URL = pathToFileURL(join(SRC, "drivers/pglite/index.ts")).href;
const SQLITE3_URL = pathToFileURL(join(SRC, "drivers/sqlite3/index.ts")).href;
const SCHEMA_URL = pathToFileURL(join(SRC, "schema/index.ts")).href;

export type Dialect = "pglite" | "sqlite3";

export interface TempProject {
  /** Absolute path of the temp project root. */
  dir: string;
  /** Absolute path to the written viborm.config.ts (or whatever configName was). */
  configPath: string;
  /** Absolute default migrations dir (dir/migrations). */
  migrationsDir: string;
  /** Remove the temp dir. */
  cleanup(): void;
}

export interface ConfigFixtureOptions {
  /** Which in-memory driver the config's client uses. Default "pglite". */
  dialect?: Dialect;
  /**
   * Persist the pglite client to this on-disk dataDir instead of an ephemeral
   * in-memory one. REQUIRED for any test that invokes a CLI command and then
   * reads DB state afterwards: every command calls `driver.disconnect()`, and
   * pglite's close() DESTROYS an in-memory database, so state (including the
   * migration tracking table) would not survive to the next invocation. A
   * dataDir mirrors a real deployment's persistent DB. pglite-only.
   */
  dataDir?: string;
  /**
   * Body of the schema module: a snippet that declares model consts and a
   * `schema` object literal. Defaults to a single valid `user` model.
   * The snippet has `s` in scope and must end by defining `const schema = {...}`.
   */
  schemaBody?: string;
  /** Filename for the config (default "viborm.config.ts"). */
  configName?: string;
  /**
   * Optional `migrations: {...}` block source appended to the default export,
   * e.g. `migrations: { dir: "./db/migrations" }`.
   */
  migrationsBlock?: string;
  /** If set, the config exports this raw source INSTEAD of the generated one. */
  rawConfigSource?: string;
  /**
   * Shape of the export that `loadConfig` extracts (`configModule.default ||
   * configModule.config || configModule`):
   *   - "default"      → `export default { client }`   (the production shape)
   *   - "namedConfig"  → `export const config = { client }`, no default
   *   - "moduleItself" → only `export const client`, no default/config
   * Every variant still emits `export const client`. Default "default".
   */
  exportKind?: "default" | "namedConfig" | "moduleItself";
}

const DEFAULT_SCHEMA_BODY = `
  const user = s.model({
    id: s.string().id(),
    email: s.string().unique(),
  });
  const schema = { user };
`;

/** Create an empty temp project dir. */
export function makeTempProject(configName = "viborm.config.ts"): TempProject {
  const dir = mkdtempSync(join(tmpdir(), "viborm-cli-"));
  return {
    dir,
    configPath: join(dir, configName),
    migrationsDir: join(dir, "migrations"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Write a loadable `viborm.config.ts` into `project.dir`.
 * Returns the absolute config path.
 */
export function writeConfigFixture(
  project: TempProject,
  options: ConfigFixtureOptions = {}
): string {
  const {
    dialect = "pglite",
    dataDir,
    schemaBody = DEFAULT_SCHEMA_BODY,
    configName = "viborm.config.ts",
    migrationsBlock,
    rawConfigSource,
    exportKind = "default",
  } = options;

  const configPath = join(project.dir, configName);
  const driverUrl = dialect === "sqlite3" ? SQLITE3_URL : PGLITE_URL;
  let driverArgs: string;
  if (dialect === "sqlite3") {
    driverArgs = `{ dataDir: ":memory:" }`;
  } else if (dataDir) {
    driverArgs = `{ dataDir: ${JSON.stringify(dataDir)} }`;
  } else {
    driverArgs = "{}";
  }

  const configBody = `{
  client,${migrationsBlock ? `\n  ${migrationsBlock},` : ""}
}`;
  let exportLine: string;
  if (exportKind === "namedConfig") {
    exportLine = `export const config = ${configBody};`;
  } else if (exportKind === "moduleItself") {
    // No default and no `config` export: `client` is the only top-level export,
    // so loadConfig falls back to the module namespace itself.
    exportLine = "";
  } else {
    exportLine = `export default ${configBody};`;
  }

  const source =
    rawConfigSource ??
    `import { createClient } from ${JSON.stringify(driverUrl)};
import { s } from ${JSON.stringify(SCHEMA_URL)};

${schemaBody}

export const client = createClient({ schema, ...${driverArgs} });

${exportLine}
`;

  writeFileSync(configPath, source);
  return configPath;
}
