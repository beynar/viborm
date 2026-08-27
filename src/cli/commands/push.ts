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
import { admitLiveMigrationCapability } from "../../migrations/admission";
import { getMigrationDriver } from "../../migrations/drivers";
import { push } from "../../migrations/push";
import { formatMigrationTarget } from "../../migrations/target";
import { displayOperations, displaySQL, interactiveResolve } from "../prompts";
import { createRecordingResolver } from "../resolve-recorder";
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

      // 2. Admission FIRST — before the connection, before any confirmation,
      // and long before an inventory decides what to drop. §10's letter is
      // "before connection, lock, further storage reads, storage writes, or
      // other provider work", and the order used to be the other way round:
      // `--force-reset` connected, ran its own destructive program, and only
      // then reached the refusal, so an unattested MySQL driver had its
      // database wiped before being told the command was not supported.
      const migrationDriver = getMigrationDriver(driver);
      admitLiveMigrationCapability(
        migrationDriver,
        options.dryRun ? "read-only" : "effectful",
        options.forceReset ? "push({ forceReset: true })" : "push()"
      );

      // 3. Confirm the destructive intent, naming the exact target — the
      // schema on PostgreSQL and the DATABASE on MySQL, whose estate target
      // carries no name of its own (DECISIONS N6). The CLI owns confirmation
      // and presentation; the effect itself belongs to the one programmatic
      // reset owner, which `push({ forceReset: true })` reaches under the same
      // session lock as the rebuild. A dry run drops nothing, so it is not
      // confirmed.
      const forceReset = options.forceReset && !options.dryRun;
      if (forceReset) {
        const confirmReset = await p.confirm({
          message: `This will DROP ALL TABLES in ${formatMigrationTarget(migrationDriver.target, migrationDriver.namespace)} and rebuild it. Are you sure?`,
          initialValue: false,
        });

        if (p.isCancel(confirmReset) || !confirmReset) {
          p.cancel("Operation cancelled.");
          process.exit(0);
        }
      }

      // 4. Connect to database if needed
      if (driver.connect) {
        spinner.start("Connecting to database...");
        await driver.connect();
        spinner.stop("Connected to database");
      }

      // 5. Force-reset is clear-and-rebuild, not a diff: previewing it against
      // the database it is about to empty would describe a program that never
      // runs. One push owns the whole thing — clear and rebuild under one lock
      // — and what it reports is what it did.
      if (forceReset) {
        spinner.start("Resetting and rebuilding schema...");
        const rebuilt = await push(client, {
          force: true,
          dryRun: false,
          forceReset: true,
        });
        spinner.stop(`Rebuilt ${rebuilt.operations.length} object(s)`);

        displayOperations(rebuilt.operations);
        if (options.verbose && rebuilt.sql.length > 0) {
          displaySQL(rebuilt.sql);
        }

        if (driver.disconnect) {
          await driver.disconnect();
        }
        p.outro(`Done in ${formatDuration(Date.now() - startTime)}`);
        return;
      }

      // 6. Introspect and diff
      spinner.start("Comparing schemas...");

      // Record every interactive decision made during the dry-run pass so the
      // apply pass can replay it verbatim. Without this, re-planning for apply
      // would fall back to force semantics and a change the user resolved as
      // "rename" would silently execute as DROP + ADD (data loss).
      const recorder = options.force
        ? undefined
        : createRecordingResolver(interactiveResolve);

      const result = await push(client, {
        force: options.force,
        dryRun: true, // First run as dry-run to preview
        resolve: recorder?.resolve,
      });

      spinner.stop("Schema comparison complete");

      // 7. Display changes
      displayOperations(result.operations);

      // 8. Verbose mode: show all SQL
      if (options.verbose && result.sql.length > 0) {
        displaySQL(result.sql);
      }

      // 9. If no changes, we're done
      if (result.operations.length === 0) {
        const duration = Date.now() - startTime;
        p.outro(`Done in ${formatDuration(duration)}`);

        if (driver.disconnect) {
          await driver.disconnect();
        }
        return;
      }

      // 10. If dry-run mode, don't apply
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

      // 11. Strict mode or normal confirmation
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

      // 12. Apply changes
      spinner.start("Applying changes...");

      // --force keeps force semantics (no interactive pass at all). The
      // interactive path replays the recorded dry-run decisions instead of
      // re-prompting; force stays false there so a change that was never
      // resolved during the dry run (e.g. concurrent drift between the two
      // planning passes) aborts instead of degrading to add+drop.
      const applyResult = await push(client, {
        force: options.force,
        dryRun: false,
        resolve: recorder?.replay,
      });

      spinner.stop(`Applied ${applyResult.operations.length} change(s)`);

      // 13. Disconnect
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
