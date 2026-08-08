/**
 * Shared CLI test harness.
 *
 * ---------------------------------------------------------------------------
 * THE SEAM (read this before writing a CLI test)
 * ---------------------------------------------------------------------------
 * The CLI has no injectable seam: `src/cli/index.ts` builds a commander program,
 * each command is an async `.action()` closure, and every command reaches its
 * config + driver exclusively through `loadConfig()`, which dynamically
 * `import()`s a `viborm.config.ts` file resolved against `process.cwd()`. On
 * failure the actions call `process.exit(1)`; on cancellation `process.exit(0)`.
 * Interactive steps call `@clack/prompts` (`p.confirm` / `p.select`), which
 * hard-crash in a non-TTY (vitest) process.
 *
 * So a test drives a command through FOUR real seams and nothing fake in
 * between (the migration engine, differ, DDL, storage, and pglite all run for
 * real):
 *
 *   1. CONFIG/DRIVER — `writeConfigFixture()` writes a real `viborm.config.ts`
 *      into a temp dir. It imports `createClient` + `s` from `src/` via absolute
 *      file:// URLs (so vitest/vite transforms the .ts), builds an in-memory
 *      PGlite (or sqlite3) client, and default-exports `{ client }`. `loadConfig`
 *      imports it exactly as production would. No mock of the code under test.
 *
 *   2. INVOCATION — `invokeCLI(argv)` builds a FRESH commander program from the
 *      real `pushCommand` / `migrateCommand` and calls `program.parseAsync`.
 *      Fresh per call because commander stores parsed option state on the
 *      Command instance. We chdir into the temp dir so `--config` discovery and
 *      the default `./migrations` dir resolve like a real invocation.
 *
 *   3. EXIT — `process.exit` is stubbed to throw `ProcessExitError(code)` so a
 *      command's exit is observable (`result.exitCode`) instead of killing the
 *      vitest runner.
 *
 *   4. PROMPTS — `@clack/prompts` is mocked in `_clack.ts`, registered as a
 *      vitest setupFile so the mock re-applies per test file even when a forked
 *      worker is reused (see `_clack.ts` for why a setupFile, not an inline
 *      `vi.mock`, is required). `confirm`/`select` pull from a per-test answer
 *      queue set via `queueAnswers([...])`; `intro/outro/note/log/spinner`
 *      become silent no-ops whose text is still captured for assertions. This
 *      mocks the *prompt library*, never the command under test.
 *
 * stdout/stderr and all clack log/note text are captured in `result.output` so
 * tests assert on real user-visible output.
 *
 * Keep this API tiny. Everything a writer needs is exported below.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getClackLog, resetClackLog } from "@tests/contracts/public-client/cli/_clack";
import { SOURCE_ROOT } from "@tests/fixtures/repo-paths";

// Re-export the clack mock controls so a test file needs only one import. The
// mock itself lives in `_clack.ts`, registered as a setupFile (see its header
// and vitest.config.ts) so it survives fork-worker reuse.
export { CANCEL, queueAnswers } from "@tests/contracts/public-client/cli/_clack";

// ---------------------------------------------------------------------------
// process.exit capture
// ---------------------------------------------------------------------------

/** Thrown in place of a real `process.exit(code)` so vitest survives. */
export class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
    this.name = "ProcessExitError";
  }
}

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

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

export interface InvokeResult {
  /** null if the command returned normally; the code if it called process.exit. */
  exitCode: number | null;
  /** Error thrown out of parseAsync that was NOT a process.exit (e.g. a bug). */
  thrown: unknown;
  /** Combined stdout + stderr + clack text, newline-joined. */
  output: string;
  /** Raw stdout writes. */
  stdout: string;
  /** Raw stderr writes. */
  stderr: string;
  /** Clack log/note/intro/outro lines. */
  clack: string[];
}

async function buildProgram() {
  const { Command } = await import("commander");
  const { pushCommand } = await import("@src/cli/commands/push");
  const { migrateCommand } = await import("@src/cli/commands/migrate");
  const program = new Command();
  program.name("viborm").version("0.0.0-test");
  program.exitOverride(); // never let commander itself call process.exit
  program.addCommand(pushCommand);
  program.addCommand(migrateCommand);
  return program;
}

/**
 * Invoke the CLI with the given argv (e.g. `["migrate", "status", "--config", p]`).
 * Chdir into `cwd` for the duration so relative config/dir resolution matches a
 * real invocation. Captures stdout/stderr/clack and any process.exit.
 */
export async function invokeCLI(
  argv: string[],
  opts: { cwd?: string } = {}
): Promise<InvokeResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  resetClackLog();

  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;
  const origCwd = process.cwd();

  const exitSpy = ((code?: number): never => {
    throw new ProcessExitError(code ?? 0);
  }) as typeof process.exit;

  // biome-ignore lint/suspicious/noExplicitAny: test capture shims
  process.stdout.write = ((chunk: any) => {
    stdout.push(String(chunk));
    return true;
  }) as any;
  // biome-ignore lint/suspicious/noExplicitAny: test capture shims
  process.stderr.write = ((chunk: any) => {
    stderr.push(String(chunk));
    return true;
  }) as any;
  process.exit = exitSpy;

  if (opts.cwd) {
    process.chdir(opts.cwd);
  }

  let exitCode: number | null = null;
  let thrown: unknown;

  try {
    const program = await buildProgram();
    await program.parseAsync(["node", "viborm", ...argv]);
  } catch (err) {
    if (err instanceof ProcessExitError) {
      exitCode = err.code;
    } else {
      thrown = err;
    }
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
    process.exit = origExit;
    process.chdir(origCwd);
  }

  const clack = getClackLog();
  const output = [...stdout, ...stderr, ...clack].join("\n");
  return {
    exitCode,
    thrown,
    output,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    clack,
  };
}
