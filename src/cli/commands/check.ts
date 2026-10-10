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
import { isSqliteDecimalStorage } from "../../adapters/databases/sqlite/storage/decimal";
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
import { createIdentifierQuoter } from "../../sql/identifiers";
import { finishCli, loadConfig } from "../utils";

interface CheckCliOptions {
  readonly config?: string;
  readonly json?: boolean;
  readonly db?: boolean;
}

type ColumnAudit = { readonly table: string; readonly column: string } & (
  | {
      readonly type: "datetime" | "time";
      readonly list: boolean;
      /** `null` when the column is missing. */
      readonly noncanonical: number | null;
    }
  | {
      readonly type: "decimal";
      /** The catalog's declared type; `null` when the column is missing. */
      readonly declared: string | null;
      readonly checked: boolean;
    }
);

interface CatalogColumn {
  readonly definition: string | null;
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
}

const quote = createIdentifierQuoter('"');

/** One SQLite table's declared columns, each beside the table's stored definition. */
async function readCatalog(
  driver: AnyDriver,
  table: string
): Promise<CatalogColumn[]> {
  const { rows } = await driver._executeRaw<
    Omit<CatalogColumn, "nullable"> & { notnull: number; pk: number }
  >(
    `SELECT s.sql AS definition, p.name, p.type, p."notnull", p.pk FROM sqlite_schema AS s JOIN pragma_table_info(s.name) AS p WHERE s.type = 'table' AND s.name = ?`,
    [table]
  );
  // SQLite reports a primary key nullable; VibORM writes it NOT NULL.
  return rows.map(({ notnull, pk, ...column }) => ({
    ...column,
    nullable: Number(notnull) === 0 && Number(pk) === 0,
  }));
}

/**
 * Audit SQLite storage typed queries assume but never inspect: one catalog
 * read per table decides which audited columns exist; each existing text
 * DateTime/Time column's noncanonical rows are counted (one scan each), and
 * each decimal column is checked against the scaled-integer storage of its
 * descriptor. Other dialects store native types.
 */
async function auditStorage(
  driver: AnyDriver,
  models: Record<string, AnyModel>
): Promise<ColumnAudit[]> {
  if (driver.dialect !== "sqlite") return [];
  const audits: ColumnAudit[] = [];
  for (const [name, model] of Object.entries(models)) {
    const table = getTableName(model, name);
    const state: ModelState = model["~"].state;
    // A missing table has no catalog rows: each audited column is missing.
    let catalog: Promise<CatalogColumn[]> | undefined;
    const find = async (column: string) =>
      (await (catalog ??= readCatalog(driver, table))).find(
        (entry) => entry.name === column
      );
    for (const [field, scalar] of Object.entries(state.scalars)) {
      const definition = scalar["~"].state;
      const { type, array = false } = definition;
      const column = model["~"].getFieldName(field).sql;
      if (definition.type === "decimal") {
        const row = await find(column);
        audits.push({
          table,
          column,
          type: "decimal",
          declared: row?.type ?? null,
          checked:
            row !== undefined &&
            isSqliteDecimalStorage(
              row.definition,
              row,
              definition.decimal,
              array ? "list" : "scalar",
              quote
            ),
        });
        continue;
      }
      const text =
        type === "time" ||
        (type === "datetime" &&
          (array ||
            sqliteDateTimePhysicalForm(scalar["~"].nativeType) === "text"));
      if (!text) continue;
      // Never scan a missing column: SQLite may read its quoted name as text.
      const scan =
        (await find(column)) &&
        (await driver._executeRaw<{ noncanonical: number }>(
          sqliteNoncanonicalTemporalCount(table, column, type, array)
        ));
      audits.push({
        table,
        column,
        type,
        list: array,
        noncanonical: scan ? Number(scan.rows[0]?.noncanonical) : null,
      });
    }
  }
  return audits;
}

const needsRepair = (audit: ColumnAudit): boolean =>
  audit.type === "decimal" ? !audit.checked : audit.noncanonical !== 0;

const describeAudit = (audit: ColumnAudit): string => {
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
      ? await auditStorage(config.driver, models)
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
