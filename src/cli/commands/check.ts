/**
 * Schema check CLI.
 *
 * Runs every check a client runs when it is created (identifiers, model
 * identity, relation resolution, selector names), plus the advisory rules,
 * against the schema of the configured client. Run it in a build or CI step to
 * create clients with `skipSchemaValidation: true` at runtime.
 */

import { Command } from "commander";
import {
  auditStorage,
  type StorageColumnAudit,
} from "../../migrations/sqlite-storage-audit";
import { hydrateSchemaNames } from "../../schema/hydration";
import type { SchemaValidationIssue } from "../../schema/validation/types";
import { validateSchema } from "../../schema/validation/validator";
import { finishCli, loadConfig } from "../utils";

interface CheckCliOptions {
  readonly config?: string;
  readonly json?: boolean;
  readonly db?: boolean;
}

const needsRepair = (audit: StorageColumnAudit): boolean =>
  audit.type === "decimal" ? !audit.checked : audit.noncanonical !== 0;

const describeAudit = (audit: StorageColumnAudit): string => {
  const column = `[storage] "${audit.table}"."${audit.column}"`;
  if ((audit.type === "decimal" ? audit.declared : audit.noncanonical) === null)
    return `${column}: the column is missing; typed queries that use it fail.\n    Create it through viborm push or migrate.`;
  if (audit.type === "decimal")
    return `${column}: declared ${audit.declared}, not the checked scaled-integer decimal storage VibORM writes; typed reads, filters and writes are not checked against it.\n    Adopt the table through viborm push, migrate or baseline: https://viborm.dev/docs/migration/drivers/sqlite#adopting-decimal-columns-from-another-tool`;
  const kind = audit.type === "time" ? "Time" : "DateTime";
  const repair = audit.list
    ? "Rewrite each row through the typed client (`update`), which stores canonical members"
    : `Repair with sqliteCanonical${kind}Expression from viborm/migrations`;
  return `${column}: ${audit.noncanonical} row(s) of noncanonical ${kind} text compare and sort wrongly.\n    ${repair}: https://viborm.dev/docs/migration/drivers/sqlite#repairing-foreign-timestamp-and-time-text`;
};

// The repair hint, when the issue has one, goes on its own indented line.
const describe = (issue: SchemaValidationIssue): string =>
  [`[${issue.code}] ${issue.message}`, issue.repair]
    .filter(Boolean)
    .join("\n    ");

async function runCheck(options: CheckCliOptions): Promise<void> {
  let client: { $disconnect(): Promise<void> } | undefined;
  let failure: { value: unknown } | undefined;
  try {
    const config = await loadConfig({
      config: options.config,
      skipValidation: true,
    });
    client = config.client;
    const { models } = config;
    // The identifier and identity checks hydration runs, whatever the
    // configured client skipped.
    hydrateSchemaNames(models);
    const result = validateSchema(models);
    const storage = options.db
      ? await auditStorage({ $driver: config.driver, $schema: models })
      : undefined;
    const dirty = storage?.filter(needsRepair) ?? [];
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(storage ? { ...result, storage } : result, null, 2)}\n`
      );
    } else {
      for (const issue of result.errors)
        process.stderr.write(`error   ${describe(issue)}\n`);
      for (const issue of result.warnings)
        process.stderr.write(`warning ${describe(issue)}\n`);
      for (const audit of dirty)
        process.stderr.write(`error   ${describeAudit(audit)}\n`);
      process.stdout.write(
        result.valid
          ? `Schema valid (${Object.keys(models).length} models).\n`
          : `Schema invalid: ${result.errors.length} error(s).\n`
      );
      if (storage)
        process.stdout.write(
          `Storage audited: ${storage.length} column(s), ${dirty.length} need repair.\n`
        );
    }
    if (!result.valid || dirty.length > 0) process.exitCode = 1;
  } catch (error) {
    failure = { value: error };
  } finally {
    await finishCli(client, failure, options.json);
  }
}

export function createCheckCommand(): Command {
  return new Command("check")
    .description(
      "Validate the schema, so clients can be created with skipSchemaValidation"
    )
    .option("--config <path>", "Path to viborm.config.ts")
    .option("--json", "Print machine-readable JSON")
    .option(
      "--db",
      "Also audit SQLite storage: DateTime/Time text and decimal columns"
    )
    .action(runCheck);
}

export const checkCommand = createCheckCommand();
