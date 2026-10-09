/**
 * Schema check CLI.
 *
 * Runs every check a client runs when it is created (identifiers, model
 * identity, relation resolution, selector names), plus the advisory rules,
 * against the schema of the configured client. Run it in a build or CI step to
 * create clients with `skipSchemaValidation: true` at runtime.
 */

import { Command } from "commander";
import { sqliteNoncanonicalTemporalCount } from "../../adapters/databases/sqlite/storage/datetime";
import type { AnyDriver } from "../../drivers/driver";
import { hydrateSchemaNames } from "../../schema/hydration";
import {
  type AnyModel,
  getTableName,
  type ModelState,
} from "../../schema/model";
import { sqliteDateTimePhysicalForm } from "../../schema/scalars/datetime/physical";
import type { SchemaValidationIssue } from "../../schema/validation/types";
import { validateSchema } from "../../schema/validation/validator";
import { finishCli, loadConfig } from "../utils";

interface CheckCliOptions {
  readonly config?: string;
  readonly json?: boolean;
  readonly db?: boolean;
}

interface TemporalColumnAudit {
  readonly table: string;
  readonly column: string;
  readonly type: "datetime" | "time";
  readonly noncanonical: number;
}

/** Count each SQLite text DateTime/Time column's noncanonical rows; other dialects store native types. */
async function auditTemporalText(
  driver: AnyDriver,
  models: Record<string, AnyModel>
): Promise<TemporalColumnAudit[]> {
  if (driver.dialect !== "sqlite") return [];
  const audits: TemporalColumnAudit[] = [];
  for (const [name, model] of Object.entries(models)) {
    const table = getTableName(model, name);
    const state: ModelState = model["~"].state;
    for (const [field, scalar] of Object.entries(state.scalars)) {
      const { type, array = false } = scalar["~"].state;
      const text =
        type === "time" ||
        (type === "datetime" &&
          (array ||
            sqliteDateTimePhysicalForm(scalar["~"].nativeType) === "text"));
      if (!text) continue;
      const column = model["~"].getFieldName(field).sql;
      const { rows } = await driver._executeRaw<{ noncanonical: number }>(
        sqliteNoncanonicalTemporalCount(table, column, type, array)
      );
      audits.push({
        table,
        column,
        type,
        noncanonical: Number(rows[0]?.noncanonical),
      });
    }
  }
  return audits;
}

const describeAudit = (audit: TemporalColumnAudit): string => {
  const kind = audit.type === "time" ? "Time" : "DateTime";
  return `[storage] "${audit.table}"."${audit.column}": ${audit.noncanonical} row(s) of noncanonical ${kind} text compare and sort wrongly.\n    Repair with sqliteCanonical${kind}Expression from viborm/migrations: https://viborm.dev/docs/migration/drivers/sqlite#repairing-foreign-timestamp-and-time-text`;
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
      ? await auditTemporalText(config.driver, models)
      : undefined;
    const dirty = storage?.filter((audit) => audit.noncanonical > 0) ?? [];
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
          `Storage audited: ${storage.length} temporal text column(s), ${dirty.length} need repair.\n`
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
      "Also scan stored SQLite DateTime/Time text for noncanonical values"
    )
    .action(runCheck);
}

export const checkCommand = createCheckCommand();
