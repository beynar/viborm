/**
 * INTEGRATION tests for `viborm migrate` and its five subcommands
 * (generate / apply / down / status / drop).
 *
 * Everything runs for real: a temp project with a real `viborm.config.ts`
 * (in-memory PGlite client + real schema), the real migration engine, the real
 * fs storage driver writing `.sql` files into a temp `./migrations` dir. Only
 * `@clack/prompts` and `process.exit` are stubbed by `_harness.ts`.
 *
 * DB state is asserted for real two ways:
 *   - by re-running CLI commands whose output is a function of DB state
 *     (`status` flips pending<->applied; `down` only sees applied migrations), and
 *   - by importing the SAME config module the CLI imports (Node caches it, so the
 *     PGlite client instance is shared) and querying information_schema directly.
 *
 * WHY A FILE-BACKED PGlite (not the harness default `{}` in-memory):
 * every CLI command connects then disconnects, and PGlite's `close()` DESTROYS
 * an in-memory database. So in-memory DB state (including the migration tracking
 * table) does NOT survive across two CLI invocations — a `status` after an
 * `apply` would see a fresh empty DB. A real deployment points at a persistent
 * DB, so we mirror that: `writePersistentConfig` gives the client a `dataDir`
 * under the temp project. State then survives disconnect, exactly as in prod.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CANCEL,
  invokeCLI,
  makeTempProject,
  queueAnswers,
  type TempProject,
  writeConfigFixture,
} from "./_harness";

interface PersistentConfigOptions {
  schemaBody?: string;
  migrationsBlock?: string;
  configName?: string;
}

/**
 * Write a `viborm.config.ts` whose PGlite client uses a persistent on-disk
 * dataDir under the temp project (so DB state survives connect/disconnect).
 * Returns the absolute config path. Thin wrapper over the shared harness's
 * `writeConfigFixture` with a per-config-name dataDir (each config filename gets
 * its own DB, since a config module is import-cached and can't be re-read after
 * a schema change).
 */
function writePersistentConfig(
  project: TempProject,
  options: PersistentConfigOptions = {}
): string {
  const {
    schemaBody,
    migrationsBlock,
    configName = "viborm.config.ts",
  } = options;
  return writeConfigFixture(project, {
    configName,
    schemaBody,
    migrationsBlock,
    dataDir: join(project.dir, `pgdata-${configName}`),
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * The harness rebuilds a fresh `program` per invocation but re-adds the SAME
 * module-singleton `migrateCommand` (and its subcommands) imported from src.
 * Commander stores parsed option values ON the Command instance and does NOT
 * clear un-defaulted options between parses, so an option set in one invocation
 * (e.g. `--name`) leaks into the next parse of that same subcommand. Production
 * parses once per process so never hits this; multi-invocation tests do.
 *
 * `resetCommands()` clears that leaked per-Command state (restoring registered
 * defaults) so every `cli()` call parses from a clean slate. It touches ONLY
 * commander's own bookkeeping — the config module / PGlite DB stays cached, so
 * DB state still persists across invocations within a test.
 */
// biome-ignore lint/suspicious/noExplicitAny: reaching into commander internals
function resetCommand(cmd: any): void {
  for (const child of cmd.commands) {
    resetCommand(child);
  }
  for (const key of Object.keys(cmd._optionValues)) {
    delete cmd._optionValues[key];
  }
  cmd._optionValueSources = {};
  for (const opt of cmd.options) {
    if (opt.defaultValue !== undefined) {
      cmd.setOptionValueWithSource(
        opt.attributeName(),
        opt.defaultValue,
        "default"
      );
    }
  }
}

async function resetCommands(): Promise<void> {
  const { migrateCommand } = await import("../../src/cli/commands/migrate");
  resetCommand(migrateCommand);
}

/** Reset leaked commander option state, then invoke the CLI via the harness. */
async function cli(argv: string[], cwd: string) {
  await resetCommands();
  return invokeCLI(argv, { cwd });
}

/**
 * Set up a project with TWO migrations both applied:
 *   idx 0 -> `user` table, idx 1 -> `post` table.
 * Returns the config path to use for subsequent commands (the second config,
 * whose DB holds the tracking rows). Uses two config filenames because the first
 * config module is cached and can't be re-read after a schema change.
 */
async function setupTwoAppliedMigrations(
  project: TempProject
): Promise<string> {
  writePersistentConfig(project, {
    schemaBody: `
      const user = s.model({ id: s.string().id(), email: s.string() });
      const schema = { user };
    `,
  });
  await cli(
    ["migrate", "generate", "--config", project.configPath],
    project.dir
  );

  const cfg2 = writePersistentConfig(project, {
    configName: "viborm2.config.ts",
    schemaBody: `
      const user = s.model({ id: s.string().id(), email: s.string() });
      const post = s.model({ id: s.string().id(), title: s.string() });
      const schema = { user, post };
    `,
  });
  await cli(["migrate", "generate", "--config", cfg2], project.dir);
  await cli(["migrate", "apply", "--force", "--config", cfg2], project.dir);
  return cfg2;
}

/** List the *.sql migration files in a dir (empty array if the dir is absent). */
function migrationFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".sql"));
  } catch {
    return [];
  }
}

/**
 * Import the client from the temp config module (same instance the CLI used,
 * thanks to Node's module cache) and query whether a table exists in PGlite.
 * Reconnects if the CLI left the driver disconnected.
 */
async function tableExists(
  configPath: string,
  table: string
): Promise<boolean> {
  const mod = await import(pathToFileURL(configPath).href);
  const client = mod.client;
  if (client.$driver.connect) {
    await client.$driver.connect();
  }
  const rows = await client.$queryRawUnsafe(
    "SELECT 1 FROM information_schema.tables WHERE table_name = $1",
    table
  );
  return Array.isArray(rows) && rows.length > 0;
}

/** First migration filename: `0000_<name>.sql`. */
const FIRST_MIGRATION_FILE = /^0000_.*\.sql$/;

describe("migrate", () => {
  let project: TempProject;

  beforeEach(() => {
    project = makeTempProject();
    queueAnswers([]);
  });

  afterEach(() => {
    project.cleanup();
  });

  // =========================================================================
  // migrate (parent)
  // =========================================================================

  describe("parent command", () => {
    it("with no subcommand prints help listing the five subcommands and exits 1", async () => {
      const result = await cli(["migrate"], project.dir);

      // Commander emits the usage/help text (a real side effect) and, under
      // exitOverride with no dispatched subcommand, exits with code 1.
      for (const name of ["generate", "apply", "down", "status", "drop"]) {
        expect(result.output).toContain(name);
      }
      expect(result.exitCode).toBe(1);
    });
  });

  // =========================================================================
  // migrate generate
  // =========================================================================

  describe("generate", () => {
    it("writes a migration file into the default ./migrations dir", async () => {
      writePersistentConfig(project);

      const result = await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );

      expect(result.thrown).toBeUndefined();
      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("Created migration:");

      const files = migrationFiles(project.migrationsDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(FIRST_MIGRATION_FILE);
    });

    it("--dry-run previews SQL but writes NO file", async () => {
      writePersistentConfig(project);

      const result = await cli(
        ["migrate", "generate", "--dry-run", "--config", project.configPath],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("Would create:");
      expect(migrationFiles(project.migrationsDir)).toHaveLength(0);
    });

    it("--out writes into a custom dir (CLI option beats default)", async () => {
      writePersistentConfig(project);

      const result = await cli(
        [
          "migrate",
          "generate",
          "--out",
          "custom-mig",
          "--config",
          project.configPath,
        ],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(migrationFiles(`${project.dir}/custom-mig`)).toHaveLength(1);
      // default dir untouched
      expect(migrationFiles(project.migrationsDir)).toHaveLength(0);
    });

    it("config migrations.dir is used when no --out is given", async () => {
      writePersistentConfig(project, {
        migrationsBlock: `migrations: { dir: "./cfg-mig" }`,
      });

      const result = await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(migrationFiles(`${project.dir}/cfg-mig`)).toHaveLength(1);
    });

    it("--name puts the name into the migration filename", async () => {
      writePersistentConfig(project);

      const result = await cli(
        [
          "migrate",
          "generate",
          "--name",
          "hello-world",
          "--config",
          project.configPath,
        ],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      const files = migrationFiles(project.migrationsDir);
      expect(files[0]).toBe("0000_hello-world.sql");
    });

    it("reports 'No schema changes detected.' on a second generate", async () => {
      writePersistentConfig(project);

      await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );
      const second = await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );

      expect(second.exitCode).toBeNull();
      expect(second.output).toContain("No schema changes detected.");
      // still exactly one file (the second run wrote nothing new)
      expect(migrationFiles(project.migrationsDir)).toHaveLength(1);
    });

    it("gen alias resolves to the same command", async () => {
      writePersistentConfig(project);

      const result = await cli(
        ["migrate", "gen", "--config", project.configPath],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("Created migration:");
      expect(migrationFiles(project.migrationsDir)).toHaveLength(1);
    });

    it("bad config surfaces an error and exits 1", async () => {
      // No config written -> loadConfig cannot find it.
      const result = await cli(
        ["migrate", "generate", "--config", `${project.dir}/nope.config.ts`],
        project.dir
      );

      expect(result.exitCode).toBe(1);
      expect(result.output.toLowerCase()).toContain("error");
    });
  });

  // =========================================================================
  // migrate apply
  // =========================================================================

  describe("apply", () => {
    it("no pending migrations: notes 'No pending migrations to apply.'", async () => {
      writePersistentConfig(project);
      // no generate -> journal empty -> nothing pending

      const result = await cli(
        ["migrate", "apply", "--config", project.configPath],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("No pending migrations to apply.");
      expect(result.output).toContain("Done in");
    });

    it("confirm=true applies pending migrations: table created + tracking updated", async () => {
      writePersistentConfig(project);
      await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );

      queueAnswers([true]); // confirm apply
      const result = await cli(
        ["migrate", "apply", "--config", project.configPath],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("Applied 1 migration(s)");
      expect(result.output).toContain("✓");

      // real DB: the user table now exists
      expect(await tableExists(project.configPath, "user")).toBe(true);

      // tracking updated: status now reports it applied
      const status = await cli(
        ["migrate", "status", "--config", project.configPath],
        project.dir
      );
      expect(status.output).toContain("Applied: 1, Pending: 0");
    });

    it("--dry-run lists pending and applies nothing (status stays pending)", async () => {
      writePersistentConfig(project);
      await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );

      const result = await cli(
        ["migrate", "apply", "--dry-run", "--config", project.configPath],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("Would apply 1 migration(s)");

      const status = await cli(
        ["migrate", "status", "--config", project.configPath],
        project.dir
      );
      expect(status.output).toContain("Applied: 0, Pending: 1");
    });

    it("--force skips confirm and applies directly (no answer queued)", async () => {
      writePersistentConfig(project);
      await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );

      const result = await cli(
        ["migrate", "apply", "--force", "--config", project.configPath],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("Applied 1 migration(s)");
      expect(await tableExists(project.configPath, "user")).toBe(true);
    });

    it("confirm=false cancels and applies nothing", async () => {
      writePersistentConfig(project);
      await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );

      queueAnswers([false]); // decline
      const result = await cli(
        ["migrate", "apply", "--config", project.configPath],
        project.dir
      );

      // "Operation cancelled." is emitted and nothing was applied — the reliable,
      // user-visible contract.
      expect(result.output).toContain("Operation cancelled.");

      const status = await cli(
        ["migrate", "status", "--config", project.configPath],
        project.dir
      );
      expect(status.output).toContain("Applied: 0, Pending: 1");
    });

    it("cancel (Ctrl-C) applies nothing", async () => {
      writePersistentConfig(project);
      await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );

      queueAnswers([CANCEL]);
      const result = await cli(
        ["migrate", "apply", "--config", project.configPath],
        project.dir
      );

      expect(result.output).toContain("Operation cancelled.");

      const status = await cli(
        ["migrate", "status", "--config", project.configPath],
        project.dir
      );
      expect(status.output).toContain("Applied: 0, Pending: 1");
    });

    it("user-cancel exits 0", async () => {
      writePersistentConfig(project);
      await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );

      queueAnswers([false]);
      const result = await cli(
        ["migrate", "apply", "--config", project.configPath],
        project.dir
      );

      expect(result.exitCode).toBe(0);
    });

    it("--to <index> bounds which migrations apply", async () => {
      // Two models so we can generate two migrations (idx 0 and 1).
      writePersistentConfig(project, {
        schemaBody: `
          const user = s.model({ id: s.string().id(), email: s.string() });
          const schema = { user };
        `,
      });
      await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );

      // Add a second model. The first config module is cached (re-importing it
      // won't see a rewritten file), so use a fresh config filename whose schema
      // adds `post`; its generate reads the on-disk snapshot from the first and
      // emits migration idx 1. Apply/status below all use this second config so
      // tracking lives in one DB.
      const cfg2 = writePersistentConfig(project, {
        configName: "viborm2.config.ts",
        schemaBody: `
          const user = s.model({ id: s.string().id(), email: s.string() });
          const post = s.model({ id: s.string().id(), title: s.string() });
          const schema = { user, post };
        `,
      });
      await cli(["migrate", "generate", "--config", cfg2], project.dir);

      expect(
        migrationFiles(project.migrationsDir).length
      ).toBeGreaterThanOrEqual(2);

      // Apply only up to index 0.
      const result = await cli(
        ["migrate", "apply", "--to", "0", "--force", "--config", cfg2],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("Applied 1 migration(s)");

      // Only migration 0 applied -> user exists, post does not.
      expect(await tableExists(cfg2, "user")).toBe(true);
      expect(await tableExists(cfg2, "post")).toBe(false);

      const status = await cli(
        ["migrate", "status", "--config", cfg2],
        project.dir
      );
      expect(status.output).toContain("Applied: 1, Pending: 1");
    });

    it("up alias resolves", async () => {
      writePersistentConfig(project);
      await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );

      const result = await cli(
        ["migrate", "up", "--force", "--config", project.configPath],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("Applied 1 migration(s)");
    });

    it("--dir override applies migrations from a custom directory", async () => {
      writePersistentConfig(project);
      await cli(
        [
          "migrate",
          "generate",
          "--out",
          "alt-mig",
          "--config",
          project.configPath,
        ],
        project.dir
      );

      // default ./migrations has no journal -> nothing pending
      const def = await cli(
        ["migrate", "apply", "--config", project.configPath],
        project.dir
      );
      expect(def.output).toContain("No pending migrations to apply.");

      // --dir alt-mig sees + applies the generated migration
      const result = await cli(
        [
          "migrate",
          "apply",
          "--dir",
          "alt-mig",
          "--force",
          "--config",
          project.configPath,
        ],
        project.dir
      );
      expect(result.output).toContain("Applied 1 migration(s)");
      expect(await tableExists(project.configPath, "user")).toBe(true);
    });

    it("--table-name override tracks in a custom table (status honors it too)", async () => {
      writePersistentConfig(project);
      await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );

      await cli(
        [
          "migrate",
          "apply",
          "--table-name",
          "custom_migrations",
          "--force",
          "--config",
          project.configPath,
        ],
        project.dir
      );

      // status with the SAME custom table sees it applied
      const custom = await cli(
        [
          "migrate",
          "status",
          "--table-name",
          "custom_migrations",
          "--config",
          project.configPath,
        ],
        project.dir
      );
      expect(custom.output).toContain("Applied: 1, Pending: 0");

      // status with the DEFAULT table sees nothing applied (different tracking table)
      const def = await cli(
        ["migrate", "status", "--config", project.configPath],
        project.dir
      );
      expect(def.output).toContain("Applied: 0, Pending: 1");
    });

    it("bad config exits 1", async () => {
      const result = await cli(
        ["migrate", "apply", "--config", `${project.dir}/nope.config.ts`],
        project.dir
      );
      expect(result.exitCode).toBe(1);
    });
  });

  // =========================================================================
  // migrate status
  // =========================================================================

  describe("status", () => {
    it("with a generated-but-unapplied migration shows pending count", async () => {
      writePersistentConfig(project);
      await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );

      const result = await cli(
        ["migrate", "status", "--config", project.configPath],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("(pending)");
      expect(result.output).toContain("Applied: 0, Pending: 1");
    });

    it("with an applied migration shows the ✓ applied line", async () => {
      writePersistentConfig(project);
      await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );
      await cli(
        ["migrate", "apply", "--force", "--config", project.configPath],
        project.dir
      );

      const result = await cli(
        ["migrate", "status", "--config", project.configPath],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("✓");
      expect(result.output).toContain("(applied");
      expect(result.output).toContain("Applied: 1, Pending: 0");
    });

    it("--dir override reads the custom migrations dir", async () => {
      writePersistentConfig(project);
      await cli(
        [
          "migrate",
          "generate",
          "--out",
          "alt-mig",
          "--config",
          project.configPath,
        ],
        project.dir
      );

      // default dir: no journal -> no migrations
      const def = await cli(
        ["migrate", "status", "--config", project.configPath],
        project.dir
      );
      expect(def.output).toContain("No migrations found.");

      // --dir alt-mig: sees the generated migration
      const alt = await cli(
        [
          "migrate",
          "status",
          "--dir",
          "alt-mig",
          "--config",
          project.configPath,
        ],
        project.dir
      );
      expect(alt.output).toContain("Applied: 0, Pending: 1");
    });

    it("bad config exits 1", async () => {
      const result = await cli(
        ["migrate", "status", "--config", `${project.dir}/nope.config.ts`],
        project.dir
      );
      expect(result.exitCode).toBe(1);
    });
  });

  // =========================================================================
  // migrate down
  // =========================================================================

  describe("down", () => {
    it("no applied migrations: notes 'No applied migrations to roll back.'", async () => {
      writePersistentConfig(project);
      await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );
      // generated but never applied

      const result = await cli(
        ["migrate", "down", "--config", project.configPath],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("No applied migrations to roll back.");
    });

    it("confirm=true rolls back: table dropped + status back to pending", async () => {
      writePersistentConfig(project);
      await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );
      await cli(
        ["migrate", "apply", "--force", "--config", project.configPath],
        project.dir
      );
      expect(await tableExists(project.configPath, "user")).toBe(true);

      queueAnswers([true]); // confirm (initialValue is false here)
      const result = await cli(
        ["migrate", "down", "--config", project.configPath],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("Rolled back 1 migration(s)");
      expect(result.output).toContain("↓");

      // real DB: down SQL dropped the user table
      expect(await tableExists(project.configPath, "user")).toBe(false);

      // tracking reverted -> status shows pending again
      const status = await cli(
        ["migrate", "status", "--config", project.configPath],
        project.dir
      );
      expect(status.output).toContain("Applied: 0, Pending: 1");
    });

    it("--dry-run lists roll-backs but executes nothing", async () => {
      writePersistentConfig(project);
      await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );
      await cli(
        ["migrate", "apply", "--force", "--config", project.configPath],
        project.dir
      );

      const result = await cli(
        ["migrate", "down", "--dry-run", "--config", project.configPath],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("Would roll back 1 migration(s)");
      // still applied: nothing executed
      expect(await tableExists(project.configPath, "user")).toBe(true);
      const status = await cli(
        ["migrate", "status", "--config", project.configPath],
        project.dir
      );
      expect(status.output).toContain("Applied: 1, Pending: 0");
    });

    it("--force skips confirm and rolls back directly", async () => {
      writePersistentConfig(project);
      await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );
      await cli(
        ["migrate", "apply", "--force", "--config", project.configPath],
        project.dir
      );

      const result = await cli(
        ["migrate", "down", "--force", "--config", project.configPath],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("Rolled back 1 migration(s)");
      expect(await tableExists(project.configPath, "user")).toBe(false);
    });

    it("confirm=false cancels and rolls back nothing", async () => {
      writePersistentConfig(project);
      await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );
      await cli(
        ["migrate", "apply", "--force", "--config", project.configPath],
        project.dir
      );

      queueAnswers([false]);
      const result = await cli(
        ["migrate", "down", "--config", project.configPath],
        project.dir
      );

      // Cancel message emitted and the table survives (nothing rolled back).
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Operation cancelled.");
      expect(await tableExists(project.configPath, "user")).toBe(true);
    });

    it("--steps 1 rolls back only the most recent of two migrations", async () => {
      const cfg2 = await setupTwoAppliedMigrations(project);
      expect(await tableExists(cfg2, "user")).toBe(true);
      expect(await tableExists(cfg2, "post")).toBe(true);

      const result = await cli(
        ["migrate", "down", "--steps", "1", "--force", "--config", cfg2],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("Rolled back 1 migration(s)");
      // only idx 1 (post) reverted; user survives
      expect(await tableExists(cfg2, "post")).toBe(false);
      expect(await tableExists(cfg2, "user")).toBe(true);

      const status = await cli(
        ["migrate", "status", "--config", cfg2],
        project.dir
      );
      expect(status.output).toContain("Applied: 1, Pending: 1");
    });

    it("--to <numeric index> rolls back migrations above that index", async () => {
      const cfg2 = await setupTwoAppliedMigrations(project);

      // Roll back to index 0 => everything with idx > 0 (i.e. post) is reverted.
      const result = await cli(
        ["migrate", "down", "--to", "0", "--force", "--config", cfg2],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("Rolled back 1 migration(s)");
      expect(await tableExists(cfg2, "post")).toBe(false);
      expect(await tableExists(cfg2, "user")).toBe(true);
    });

    it("--to <non-numeric name> that matches no migration errors and exits 1", async () => {
      // The /^\d+$/ branch passes the raw string through to `down`, which
      // rejects a name matching no applied migration (down.ts throws, the action
      // logs `Migration "<name>" not found` and process.exit(1)). This is an
      // error path, NOT a silent no-op — assert the real error + exit code.
      const cfg2 = await setupTwoAppliedMigrations(project);

      const result = await cli(
        [
          "migrate",
          "down",
          "--to",
          "does-not-exist",
          "--force",
          "--config",
          cfg2,
        ],
        project.dir
      );

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('Migration "does-not-exist" not found');
      // Nothing rolled back: both tables survive the failed command.
      expect(await tableExists(cfg2, "user")).toBe(true);
      expect(await tableExists(cfg2, "post")).toBe(true);
    });

    it("bad config exits 1", async () => {
      const result = await cli(
        ["migrate", "down", "--config", `${project.dir}/nope.config.ts`],
        project.dir
      );
      expect(result.exitCode).toBe(1);
    });
  });

  // =========================================================================
  // migrate drop
  // =========================================================================

  describe("drop", () => {
    it("default: warns + confirm; confirm=true untracks but does NOT drop the table", async () => {
      writePersistentConfig(project);
      await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );
      await cli(
        ["migrate", "apply", "--force", "--config", project.configPath],
        project.dir
      );
      expect(await tableExists(project.configPath, "user")).toBe(true);

      queueAnswers([true]); // confirm (initialValue false)
      const result = await cli(
        ["migrate", "drop", "--config", project.configPath],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("Warning");
      expect(result.output).toContain("Removed 1 migration(s) from tracking");
      expect(result.output).toContain("(untracked)");

      // drop only untracks: the table still exists
      expect(await tableExists(project.configPath, "user")).toBe(true);

      // tracking removed -> status shows pending again
      const status = await cli(
        ["migrate", "status", "--config", project.configPath],
        project.dir
      );
      expect(status.output).toContain("Applied: 0, Pending: 1");
    });

    it("--force skips the warning + confirm and drops directly", async () => {
      writePersistentConfig(project);
      await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );
      await cli(
        ["migrate", "apply", "--force", "--config", project.configPath],
        project.dir
      );

      const result = await cli(
        ["migrate", "drop", "--force", "--config", project.configPath],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("Removed 1 migration(s) from tracking");
    });

    it("--count 2 untracks the last two migrations (neither table dropped)", async () => {
      const cfg2 = await setupTwoAppliedMigrations(project);

      const result = await cli(
        ["migrate", "drop", "--count", "2", "--force", "--config", cfg2],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("Removed 2 migration(s) from tracking");
      // drop only untracks — both tables still exist
      expect(await tableExists(cfg2, "user")).toBe(true);
      expect(await tableExists(cfg2, "post")).toBe(true);

      const status = await cli(
        ["migrate", "status", "--config", cfg2],
        project.dir
      );
      expect(status.output).toContain("Applied: 0, Pending: 2");
    });

    it("--last keeps the count at 1", async () => {
      const cfg2 = await setupTwoAppliedMigrations(project);

      const result = await cli(
        ["migrate", "drop", "--last", "--force", "--config", cfg2],
        project.dir
      );

      expect(result.exitCode).toBeNull();
      expect(result.output).toContain("Removed 1 migration(s) from tracking");

      const status = await cli(
        ["migrate", "status", "--config", cfg2],
        project.dir
      );
      expect(status.output).toContain("Applied: 1, Pending: 1");
    });

    it("confirm=false cancels and leaves tracking unchanged", async () => {
      writePersistentConfig(project);
      await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );
      await cli(
        ["migrate", "apply", "--force", "--config", project.configPath],
        project.dir
      );

      queueAnswers([false]);
      const result = await cli(
        ["migrate", "drop", "--config", project.configPath],
        project.dir
      );

      // Cancel message emitted; tracking untouched (still applied).
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Operation cancelled.");

      const status = await cli(
        ["migrate", "status", "--config", project.configPath],
        project.dir
      );
      expect(status.output).toContain("Applied: 1, Pending: 0");
    });

    it("bad config exits 1", async () => {
      const result = await cli(
        ["migrate", "drop", "--config", `${project.dir}/nope.config.ts`],
        project.dir
      );
      expect(result.exitCode).toBe(1);
    });
  });

  // =========================================================================
  // full round-trip
  // =========================================================================

  describe("generate -> apply -> down round-trip", () => {
    it("creates, applies (table up), then rolls back (table gone)", async () => {
      writePersistentConfig(project);

      // generate
      const gen = await cli(
        ["migrate", "generate", "--config", project.configPath],
        project.dir
      );
      expect(gen.output).toContain("Created migration:");
      expect(migrationFiles(project.migrationsDir)).toHaveLength(1);

      // apply
      const apply = await cli(
        ["migrate", "apply", "--force", "--config", project.configPath],
        project.dir
      );
      expect(apply.output).toContain("Applied 1 migration(s)");
      expect(await tableExists(project.configPath, "user")).toBe(true);

      // down
      const down = await cli(
        ["migrate", "down", "--force", "--config", project.configPath],
        project.dir
      );
      expect(down.output).toContain("Rolled back 1 migration(s)");
      expect(await tableExists(project.configPath, "user")).toBe(false);
    });
  });
});
