/**
 * History-free, authenticated schema push CLI.
 *
 * The preview is inert. Effectful execution receives only the consent emitted
 * by that preview; no generic force authorization reaches the apply call.
 */

import { cancel, confirm, isCancel, note, outro } from "@clack/prompts";
import { Command } from "commander";
import { createMigrationClient } from "../../migrations/client";
import type { PushPreview } from "../../migrations/push-v1";
import { finishCli, loadConfig } from "../utils";

interface PushCliOptions {
  readonly config?: string;
  readonly dryRun?: boolean;
  readonly forceReset?: boolean;
  readonly yes?: boolean;
  readonly acceptDataLoss?: boolean;
  readonly json?: boolean;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printPlan(preview: PushPreview): void {
  const operations =
    preview.operations.length === 0
      ? ["No schema changes."]
      : preview.operations.map(
          (operation) =>
            `[${operation.risk}] ${operation.label} (${operation.id})`
        );
  const statements = preview.statements.map(
    (statement, index) =>
      `${index + 1}. ${statement.sql}${
        statement.parameters.length === 0
          ? ""
          : `\n   parameters: ${JSON.stringify(statement.parameters)}`
      }`
  );
  const lines = [
    `Target: ${JSON.stringify(preview.target)}`,
    `Plan: ${preview.planHash}`,
    ...operations,
    ...(statements.length === 0 ? [] : ["", "SQL:", ...statements]),
  ];
  note(lines.join("\n"), "Push plan");
}

async function runPush(options: PushCliOptions): Promise<void> {
  let orm: { $disconnect(): Promise<void> } | undefined;
  let failure: { value: unknown } | undefined;
  try {
    const config = await loadConfig({ config: options.config });
    orm = config.client;
    const migrations =
      config.migrations?.tables === undefined
        ? createMigrationClient(config.client)
        : createMigrationClient(config.client, {
            tables: config.migrations.tables,
          });
    // `force` is confined to the inert planning arm. The authenticated apply
    // arm below receives only the consent bound to this exact preview.
    const preview = await migrations.push({
      dryRun: true,
      ...(options.forceReset === true ? { forceReset: true } : {}),
      ...(config.migrations?.resolve
        ? { resolve: config.migrations.resolve }
        : {}),
    });

    if (
      !options.json &&
      config.driver?.dialect === "sqlite" &&
      ["sqlite3", "bun-sqlite", "bun-sql"].includes(config.driver.driverName)
    ) {
      const databases = await config.driver._executeRaw<{
        name: string;
        file: string;
      }>("PRAGMA database_list");
      if (
        databases.rows.some(
          (database) => database.name === "main" && database.file === ""
        )
      )
        process.stderr.write(
          "warning: SQLite reports an in-memory main database. Use a persistent target for durable schema changes.\n"
        );
    }

    if (options.dryRun) {
      if (options.json) printJson(preview);
      else printPlan(preview);
      return;
    }

    if (!options.json) printPlan(preview);

    if (
      preview.destructive &&
      !options.acceptDataLoss &&
      (options.yes || options.json || !process.stdin.isTTY)
    ) {
      throw new Error(
        "Destructive push requires --accept-data-loss; --yes does not authorize data loss. Inspect --dry-run first."
      );
    }
    if (
      preview.outcome !== "noop" &&
      !options.yes &&
      !options.acceptDataLoss &&
      !options.json &&
      process.stdin.isTTY
    ) {
      const accepted = await confirm({
        message: preview.destructive
          ? "Apply this destructive push plan?"
          : "Apply this push plan?",
        initialValue: !preview.destructive,
      });
      if (isCancel(accepted) || !accepted) {
        cancel("Push cancelled.");
        return;
      }
    }

    const result = await migrations.push({ consent: preview.consent });
    if (options.json) printJson(result);
    else
      outro(
        result.outcome === "noop" ? "Schema is up to date." : "Push applied."
      );
  } catch (error) {
    failure = { value: error };
  } finally {
    await finishCli(orm, failure, options.json);
  }
}

export function createPushCommand(): Command {
  return new Command("push")
    .description("Synchronize the schema directly without migration history")
    .option("--config <path>", "Path to viborm.config.ts")
    .option("--dry-run", "Preview without changing the database")
    .option("--force-reset", "Plan a rebuild from an empty database")
    .option("-y, --yes", "Skip prompts for non-destructive plans")
    .option(
      "--accept-data-loss",
      "Explicitly accept the previewed destructive plan"
    )
    .option("--json", "Print machine-readable JSON")
    .action(runPush);
}

export const pushCommand = createPushCommand();
