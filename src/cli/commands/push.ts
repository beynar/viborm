/**
 * Push Command
 *
 * Pushes schema changes directly to the database.
 *
 * Similar to:
 * - prisma db push
 * - drizzle-kit push
 */

import * as p from "@clack/prompts";
import { Command } from "commander";
import { getMigrationDriver } from "../../migrations/drivers";
import { push } from "../../migrations/push";
import { normalizeDialect } from "../../migrations/utils";
import {
  displayOperations,
  displaySQL,
  interactiveResolve,
} from "../prompts";
import { loadConfig } from "../utils";

export const pushCommand = new Command("push")
  .description("Push schema changes directly to database")
  .option("--config <path>", "Path to viborm.config.ts file")
  .option(
    "--force",
    "Skip confirmation prompts for destructive/ambiguous changes",
    false
  )
  .option(
    "--force-reset",
    "Reset the database before pushing (drops all tables)",
    false
  )
  .option(
    "--strict",
    "Always ask for approval before executing SQL statements",
    false
  )
  .option("--verbose", "Print all SQL statements prior to execution", false)
  .option("--dry-run", "Preview SQL without executing", false)
  .action(async (options) => {
    const startTime = Date.now();

    p.intro("viborm push");

    try {
      // 1. Load configuration
      const spinner = p.spinner();
      spinner.start("Loading configuration...");

      const { client, driver } = await loadConfig({
        config: options.config,
      });

      spinner.stop("Configuration loaded");

      // 2. Connect to database if needed
      if (driver.connect) {
        spinner.start("Connecting to database...");
        await driver.connect();
        spinner.stop("Connected to database");
      }

      // 3. Handle --force-reset (drop all tables first)
      if (options.forceReset) {
        const confirmReset = await p.confirm({
          message:
            "This will DROP ALL TABLES and reset the database. Are you sure?",
          initialValue: false,
        });

        if (p.isCancel(confirmReset) || !confirmReset) {
          p.cancel("Operation cancelled.");
          if (driver.disconnect) await driver.disconnect();
          process.exit(0);
        }

        spinner.start("Resetting database...");

        const dialect = normalizeDialect(driver.dialect);
        const migrationDriver = getMigrationDriver(driver.driverName, dialect);
        const resetStatements = migrationDriver.generateResetSQL();

        if (resetStatements.length > 0) {
          // Use driver-specific reset SQL
          for (const sql of resetStatements) {
            await driver._executeRaw(sql);
          }
        } else {
          // Fallback for databases without dynamic SQL (e.g., SQLite)
          // Query for tables and drop each one
          const tablesQuery = migrationDriver.generateListTables();
          const result = await driver._executeRaw(tablesQuery);
          const tables =
            ((result as unknown) as { rows?: { name: string }[] }).rows ?? [];

          for (const table of tables) {
            const dropSql = migrationDriver.generateDropTableSQL(table.name);
            await driver._executeRaw(dropSql);
          }
        }

        spinner.stop("Database reset complete");
      }

      // 4. Introspect and diff
      spinner.start("Comparing schemas...");

      const result = await push(client, {
        force: options.force,
        dryRun: true, // First run as dry-run to preview
        resolve: options.force ? undefined : interactiveResolve,
      });

      spinner.stop("Schema comparison complete");

      // 5. Display changes
      displayOperations(result.operations);

      // 6. Verbose mode: show all SQL
      if (options.verbose && result.sql.length > 0) {
        displaySQL(result.sql);
      }

      // 7. If no changes, we're done
      if (result.operations.length === 0) {
        const duration = Date.now() - startTime;
        p.outro(`Done in ${formatDuration(duration)}`);

        if (driver.disconnect) {
          await driver.disconnect();
        }
        return;
      }

      // 8. If dry-run mode, don't apply
      if (options.dryRun) {
        if (!options.verbose) {
          displaySQL(result.sql);
        }
        const duration = Date.now() - startTime;
        p.outro(`Dry run complete in ${formatDuration(duration)}`);

        if (driver.disconnect) {
          await driver.disconnect();
        }
        return;
      }

      // 9. Strict mode or normal confirmation
      if (options.strict) {
        // In strict mode, show SQL and ask for confirmation
        if (!options.verbose) {
          displaySQL(result.sql);
        }

        const confirm = await p.confirm({
          message: "Execute these SQL statements?",
          initialValue: false,
        });

        if (p.isCancel(confirm) || !confirm) {
          p.cancel("Operation cancelled.");
          if (driver.disconnect) await driver.disconnect();
          process.exit(0);
        }
      } else {
        // Normal mode: just confirm the number of changes
        const confirm = await p.confirm({
          message: `Apply ${result.operations.length} change(s)?`,
          initialValue: true,
        });

        if (p.isCancel(confirm) || !confirm) {
          p.cancel("Operation cancelled.");
          if (driver.disconnect) await driver.disconnect();
          process.exit(0);
        }
      }

      // 10. Apply changes
      spinner.start("Applying changes...");

      const applyResult = await push(client, {
        force: true,
        dryRun: false,
      });

      spinner.stop(`Applied ${applyResult.operations.length} change(s)`);

      // 11. Disconnect
      if (driver.disconnect) {
        await driver.disconnect();
      }

      const duration = Date.now() - startTime;
      p.outro(`Done in ${formatDuration(duration)}`);
    } catch (error) {
      if (error instanceof Error) {
        p.log.error(error.message);
      } else {
        p.log.error(String(error));
      }
      process.exit(1);
    }
  });

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
