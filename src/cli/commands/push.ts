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
import { push } from "../../migrations/push";
import {
  confirmDestructiveChanges,
  displayOperations,
  displaySQL,
  interactiveResolver,
} from "../prompts";
import { loadConfig } from "../utils";

export const pushCommand = new Command("push")
  .description("Push schema changes directly to database")
  .option("--config <path>", "Path to viborm.config.ts file")
  .option(
    "--accept-data-loss",
    "Ignore data loss warnings (required for destructive changes)",
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
        // Drop all tables in the public schema
        await driver._executeRaw(`
          DO $$ DECLARE
            r RECORD;
          BEGIN
            FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
              EXECUTE 'DROP TABLE IF EXISTS "' || r.tablename || '" CASCADE';
            END LOOP;
          END $$;
        `);
        // Drop all types (enums)
        await driver._executeRaw(`
          DO $$ DECLARE
            r RECORD;
          BEGIN
            FOR r IN (SELECT typname FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid WHERE n.nspname = 'public' AND t.typtype = 'e') LOOP
              EXECUTE 'DROP TYPE IF EXISTS "' || r.typname || '" CASCADE';
            END LOOP;
          END $$;
        `);
        spinner.stop("Database reset complete");
      }

      // 4. Introspect and diff
      spinner.start("Comparing schemas...");

      const result = await push(client, {
        force: options.acceptDataLoss,
        dryRun: true, // First run as dry-run to preview
        resolver: interactiveResolver,
        onDestructive: async (descriptions) => {
          if (options.acceptDataLoss) {
            return true;
          }
          return confirmDestructiveChanges(descriptions);
        },
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
        resolver: interactiveResolver,
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
