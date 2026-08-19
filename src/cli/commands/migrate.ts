/**
 * Migrate Command
 *
 * Generates and applies SQL migration files.
 *
 * Similar to:
 * - prisma migrate
 * - drizzle-kit generate/push
 */

import * as p from "@clack/prompts";
import { Command } from "commander";
import { apply, pending, status } from "../../migrations/apply";
import { down } from "../../migrations/apply/down";
import { generate } from "../../migrations/generate";
import { createFsStorageDriver } from "../../migrations/storage/drivers/fs";
import type { MigrationEntry, MigrationStatus } from "../../migrations/types";
import { formatMigrationFilename } from "../../migrations/utils";
import { isCleanProcessExit } from "../command-factory";
import { displayOperations, displaySQL, interactiveResolver } from "../prompts";
import { formatDuration, loadConfig } from "../utils";

// =============================================================================
// MAIN MIGRATE COMMAND
// =============================================================================

// There is deliberately no `drop` subcommand: untracking an applied migration
// without reverting it is the bypass a persisted rollback policy exists to
// close. `migrate down` executes the down artifact and untracks together.
export const migrateCommand = new Command("migrate")
  .description("Generate and apply SQL migration files")
  .addCommand(generateCommand())
  .addCommand(applyCommand())
  .addCommand(downCommand())
  .addCommand(statusCommand());

// =============================================================================
// GENERATE SUBCOMMAND
// =============================================================================

function generateCommand(): Command {
  return new Command("generate")
    .alias("gen")
    .description("Generate a new migration file from schema changes")
    .option("--config <path>", "Path to viborm.config.ts file")
    .option("--name <name>", "Custom migration name")
    .option("--out <dir>", "Output directory (default: ./migrations)")
    .option("--dry-run", "Preview without writing files", false)
    .action(async (options) => {
      const startTime = Date.now();

      p.intro("viborm migrate generate");

      try {
        // 1. Load configuration
        const spinner = p.spinner();
        spinner.start("Loading configuration...");

        const { client, migrations } = await loadConfig({
          config: options.config,
        });

        spinner.stop("Configuration loaded");

        // 2. Resolve storage driver: CLI option > config > default
        const dir = options.out || migrations?.dir || "./migrations";
        const storageDriver =
          migrations?.storageDriver || createFsStorageDriver(dir);

        // 3. Generate migration
        spinner.start("Analyzing schema changes...");

        const result = await generate(client, {
          name: options.name,
          storageDriver,
          resolver: interactiveResolver,
          dryRun: options.dryRun,
        });

        spinner.stop("Schema analysis complete");

        // 3. Display results
        if (result.entry) {
          displayOperations(result.operations);

          // In manual mode the operations above are the DETECTED DIFF, while
          // the file holds only the caller's statements — say so between the
          // two displays rather than let them read as one thing.
          if (result.mode === "manual") {
            p.note(
              `Manual migration: ${result.sql.length} supplied statement(s). The operations above are the detected schema diff, not the emitted SQL.`,
              "Manual mode"
            );
          }

          if (options.dryRun) {
            displaySQL(result.sql);
            p.note(
              `Would create: ${formatMigrationFilename(result.entry)}`,
              "Dry run"
            );
          } else {
            p.note(
              `Created migration: ${formatMigrationFilename(result.entry)}`,
              "Success"
            );
          }
        } else {
          p.note(result.message, "Status");
        }

        const duration = Date.now() - startTime;
        p.outro(`Done in ${formatDuration(duration)}`);
      } catch (error) {
        exitWithError(error);
      }
    });
}

// =============================================================================
// APPLY SUBCOMMAND
// =============================================================================

function applyCommand(): Command {
  return new Command("apply")
    .alias("up")
    .description("Apply pending migrations to the database")
    .option("--config <path>", "Path to viborm.config.ts file")
    .option("--dir <dir>", "Migrations directory (default: ./migrations)")
    .option("--table-name <name>", "Name of the migrations tracking table")
    .option("--to <index>", "Apply up to this migration index")
    .option("--dry-run", "Preview without applying", false)
    .option("--force", "Skip confirmation prompts", false)
    .action(async (options) => {
      const startTime = Date.now();

      p.intro("viborm migrate apply");

      try {
        // 1. Load configuration
        const spinner = p.spinner();
        spinner.start("Loading configuration...");

        const { client, driver, migrations } = await loadConfig({
          config: options.config,
        });

        spinner.stop("Configuration loaded");

        // 2. Connect to database if needed
        if (driver.connect) {
          spinner.start("Connecting to database...");
          await driver.connect();
          spinner.stop("Connected to database");
        }

        // 3. Resolve storage driver: CLI option > config > default
        const dir = options.dir || migrations?.dir || "./migrations";
        const storageDriver =
          migrations?.storageDriver || createFsStorageDriver(dir);
        const tableName = options.tableName || migrations?.tableName;

        // 4. Get pending migrations first
        const pendingMigrations = await pending(client, {
          storageDriver,
          tableName,
        });

        if (pendingMigrations.length === 0) {
          p.note("No pending migrations to apply.", "Status");
          const duration = Date.now() - startTime;
          p.outro(`Done in ${formatDuration(duration)}`);

          if (driver.disconnect) {
            await driver.disconnect();
          }
          return;
        }

        // 4. Display pending migrations
        displayPendingMigrations(pendingMigrations);

        // 5. If dry-run, just show what would be applied
        if (options.dryRun) {
          p.note(
            `Would apply ${pendingMigrations.length} migration(s)`,
            "Dry run"
          );
          const duration = Date.now() - startTime;
          p.outro(`Done in ${formatDuration(duration)}`);

          if (driver.disconnect) {
            await driver.disconnect();
          }
          return;
        }

        // 6. Confirm apply (skip if --force)
        if (!options.force) {
          const confirm = await p.confirm({
            message: `Apply ${pendingMigrations.length} migration(s)?`,
            initialValue: true,
          });

          if (p.isCancel(confirm) || !confirm) {
            p.cancel("Operation cancelled.");
            if (driver.disconnect) await driver.disconnect();
            process.exit(0);
          }
        }

        // 7. Apply migrations
        spinner.start("Applying migrations...");

        const result = await apply(client, {
          storageDriver,
          tableName,
          to:
            options.to !== undefined ? Number.parseInt(options.to) : undefined,
          dryRun: false,
        });

        spinner.stop(`Applied ${result.applied.length} migration(s)`);

        // 8. Display results
        for (const entry of result.applied) {
          p.log.success(`✓ ${formatMigrationFilename(entry)}`);
        }

        // 9. Disconnect
        if (driver.disconnect) {
          await driver.disconnect();
        }

        const duration = Date.now() - startTime;
        p.outro(`Done in ${formatDuration(duration)}`);
      } catch (error) {
        exitWithError(error);
      }
    });
}

// =============================================================================
// DOWN SUBCOMMAND
// =============================================================================

function downCommand(): Command {
  return new Command("down")
    .description("Roll back applied migrations using generated down SQL")
    .option("--config <path>", "Path to viborm.config.ts file")
    .option("--dir <dir>", "Migrations directory (default: ./migrations)")
    .option("--table-name <name>", "Name of the migrations tracking table")
    .option("--steps <n>", "Number of migrations to roll back (default: 1)")
    .option("--to <migration>", "Roll back to this migration (name or index)")
    .option("--dry-run", "Preview without executing", false)
    .option("--force", "Skip confirmation prompts", false)
    .action(async (options) => {
      const startTime = Date.now();

      p.intro("viborm migrate down");

      try {
        // 1. Load configuration
        const spinner = p.spinner();
        spinner.start("Loading configuration...");

        const { client, driver, migrations } = await loadConfig({
          config: options.config,
        });

        spinner.stop("Configuration loaded");

        // 2. Connect to database if needed
        if (driver.connect) {
          spinner.start("Connecting to database...");
          await driver.connect();
          spinner.stop("Connected to database");
        }

        // 3. Resolve storage driver: CLI option > config > default
        const dir = options.dir || migrations?.dir || "./migrations";
        const storageDriver =
          migrations?.storageDriver || createFsStorageDriver(dir);
        const tableName = options.tableName || migrations?.tableName;

        const downOptions = {
          storageDriver,
          tableName,
          steps:
            options.steps !== undefined
              ? Number.parseInt(options.steps)
              : undefined,
          to:
            options.to !== undefined && /^\d+$/.test(options.to)
              ? Number.parseInt(options.to)
              : options.to,
        };

        // 4. Preview which migrations would be rolled back
        const preview = await down(client, { ...downOptions, dryRun: true });

        if (preview.rolledBack.length === 0) {
          p.note("No applied migrations to roll back.", "Status");
          const duration = Date.now() - startTime;
          p.outro(`Done in ${formatDuration(duration)}`);

          if (driver.disconnect) {
            await driver.disconnect();
          }
          return;
        }

        const lines = preview.rolledBack.map(
          (entry) => `↓ ${formatMigrationFilename(entry)}`
        );
        p.note(lines.join("\n"), "Migrations to roll back");

        if (options.dryRun) {
          p.note(
            `Would roll back ${preview.rolledBack.length} migration(s)`,
            "Dry run"
          );
          const duration = Date.now() - startTime;
          p.outro(`Done in ${formatDuration(duration)}`);

          if (driver.disconnect) {
            await driver.disconnect();
          }
          return;
        }

        // 5. Confirm (skip if --force)
        if (!options.force) {
          const confirm = await p.confirm({
            message: `Roll back ${preview.rolledBack.length} migration(s)?`,
            initialValue: false,
          });

          if (p.isCancel(confirm) || !confirm) {
            p.cancel("Operation cancelled.");
            if (driver.disconnect) await driver.disconnect();
            process.exit(0);
          }
        }

        // 6. Roll back
        spinner.start("Rolling back migrations...");

        const result = await down(client, downOptions);

        spinner.stop(`Rolled back ${result.rolledBack.length} migration(s)`);

        for (const entry of result.rolledBack) {
          p.log.success(`↓ ${formatMigrationFilename(entry)}`);
        }

        // 7. Disconnect
        if (driver.disconnect) {
          await driver.disconnect();
        }

        const duration = Date.now() - startTime;
        p.outro(`Done in ${formatDuration(duration)}`);
      } catch (error) {
        exitWithError(error);
      }
    });
}

// =============================================================================
// STATUS SUBCOMMAND
// =============================================================================

function statusCommand(): Command {
  return new Command("status")
    .description("Show migration status (applied vs pending)")
    .option("--config <path>", "Path to viborm.config.ts file")
    .option("--dir <dir>", "Migrations directory (default: ./migrations)")
    .option("--table-name <name>", "Name of the migrations tracking table")
    .action(async (options) => {
      const startTime = Date.now();

      p.intro("viborm migrate status");

      try {
        // 1. Load configuration
        const spinner = p.spinner();
        spinner.start("Loading configuration...");

        const { client, driver, migrations } = await loadConfig({
          config: options.config,
        });

        spinner.stop("Configuration loaded");

        // 2. Connect to database if needed
        if (driver.connect) {
          spinner.start("Connecting to database...");
          await driver.connect();
          spinner.stop("Connected to database");
        }

        // 3. Resolve storage driver: CLI option > config > default
        const dir = options.dir || migrations?.dir || "./migrations";
        const storageDriver =
          migrations?.storageDriver || createFsStorageDriver(dir);
        const tableName = options.tableName || migrations?.tableName;

        // 4. Get status
        spinner.start("Checking migration status...");

        const statuses = await status(client, {
          storageDriver,
          tableName,
        });

        spinner.stop("Status retrieved");

        // 4. Display status
        if (statuses.length === 0) {
          p.note("No migrations found.", "Status");
        } else {
          displayMigrationStatus(statuses);
        }

        // 5. Disconnect
        if (driver.disconnect) {
          await driver.disconnect();
        }

        const duration = Date.now() - startTime;
        p.outro(`Done in ${formatDuration(duration)}`);
      } catch (error) {
        exitWithError(error);
      }
    });
}

// =============================================================================
// DISPLAY HELPERS
// =============================================================================

function exitWithError(error: unknown): never {
  if (isCleanProcessExit(error)) {
    throw error;
  }

  if (error instanceof Error) {
    p.log.error(error.message);
  } else {
    p.log.error(String(error));
  }
  process.exit(1);
}

function displayPendingMigrations(migrations: MigrationEntry[]): void {
  const lines = migrations.map(
    (entry) => `○ ${formatMigrationFilename(entry)} (pending)`
  );
  p.note(lines.join("\n"), "Pending migrations");
}

function displayMigrationStatus(statuses: MigrationStatus[]): void {
  const lines = statuses.map((s) => {
    const filename = formatMigrationFilename(s.entry);
    if (s.applied) {
      const date = s.appliedAt
        ? s.appliedAt.toISOString().split("T")[0]
        : "unknown";
      return `✓ ${filename} (applied ${date})`;
    }
    return `○ ${filename} (pending)`;
  });

  const appliedCount = statuses.filter((s) => s.applied).length;
  const pendingCount = statuses.length - appliedCount;

  p.note(
    lines.join("\n") + `\n\nApplied: ${appliedCount}, Pending: ${pendingCount}`,
    "Migration status"
  );
}
