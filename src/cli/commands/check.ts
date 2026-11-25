/**
 * Schema check CLI.
 *
 * Runs every check a client runs when it is created (identifiers, model
 * identity, relation resolution, selector names), plus the advisory rules and
 * the query of every view, against the schema of the configured client. Run it in a build or CI step to
 * create clients with `skipSchemaValidation: true` at runtime.
 */

import { Command } from "commander";
import type { AnyDriver } from "../../drivers/driver";
import { getMigrationDriver } from "../../migrations/drivers";
import type {
  MigrationDriver,
  ViewWriter,
} from "../../migrations/drivers/base";
import { mysqlMigrationDriver } from "../../migrations/drivers/mysql";
import { postgresMigrationDriver } from "../../migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "../../migrations/drivers/sqlite";
import type { Dialect } from "../../migrations/drivers/types";
import { serializeModels } from "../../migrations/serializer";
import {
  auditStorage,
  type StorageColumnAudit,
} from "../../migrations/sqlite-storage-audit";
import { writeView } from "../../migrations/view-definition";
import { hydrateSchemaNames } from "../../schema/hydration";
import type {
  SchemaValidationIssue,
  ValidationResult,
} from "../../schema/validation/types";
import { validateSchema } from "../../schema/validation/validator";
import { viewFacts } from "../../schema/view/facts";
import { type LoadedConfig, runCli } from "../utils";

type LoadedModels = LoadedConfig["models"];

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

/** How many models and how many database views a valid schema holds. */
const summarize = (models: LoadedModels): string => {
  const views = Object.values(models).filter(
    (model) => viewFacts(model) !== undefined
  ).length;
  const tables = `${Object.keys(models).length - views} models`;
  if (views === 0) return tables;
  return `${tables}, ${views} ${views === 1 ? "view" : "views"}`;
};

// The repair hint, when the issue has one, goes on its own indented line.
const describe = (issue: SchemaValidationIssue): string =>
  [`[${issue.code}] ${issue.message}`, issue.repair]
    .filter(Boolean)
    .join("\n    ");

/**
 * Who writes a view's body, per dialect VibORM creates views on: on SurrealDB
 * the read backend of the configured driver, which its migration binds to.
 */
const VIEW_WRITERS: Partial<
  Record<Dialect, (driver: AnyDriver) => ViewWriter | undefined>
> = {
  postgresql: () => postgresMigrationDriver.viewWriter(),
  mysql: () => mysqlMigrationDriver.viewWriter(),
  sqlite: () => sqlite3MigrationDriver.viewWriter(),
  surrealql: (driver) => getMigrationDriver(driver).viewWriter(),
};

/**
 * What a view's query is refused for (W005), found by compiling its body as
 * a migration would: a clause a view cannot hold, or a query its source does
 * not take. Asked of a schema whose relations resolve, on a dialect VibORM
 * creates views on.
 */
function withViewQueries(
  result: ValidationResult,
  { models, driver }: LoadedConfig
): ValidationResult {
  const writer = result.valid ? VIEW_WRITERS[driver.dialect] : undefined;
  if (writer === undefined) return result;
  const errors = [...result.errors];
  for (const [model, view] of Object.entries(models)) {
    if (viewFacts(view) === undefined) continue;
    try {
      const written = writer(driver);
      if (written) writeView(written, { schema: models }, view);
    } catch (cause) {
      errors.push({
        code: "W005",
        message: cause instanceof Error ? cause.message : String(cause),
        severity: "error",
        model,
      });
    }
  }
  // What a view kept by triggers needs of the schema's other tables (MySQL's
  // cascades) is read off the whole schema, as a migration serializes it.
  const cascades = errors.length === 0 && AUTO_CASCADES[driver.dialect];
  if (
    cascades &&
    Object.values(models).some((model) => viewFacts(model)?.refresh === "auto")
  )
    try {
      serializeModels(models, { migrationDriver: cascades() });
    } catch (cause) {
      const meta = (cause as { meta?: { feature?: string; model?: string } })
        .meta;
      if (meta?.feature !== "auto view") throw cause;
      errors.push({
        code: "W005",
        message: (cause as Error).message,
        severity: "error",
        model:
          Object.keys(models).find(
            (key) => models[key]!["~"].names.sql === meta.model
          ) ??
          meta.model ??
          "",
      });
    }
  return { ...result, errors, valid: errors.length === 0 };
}

/** The dialects whose cascades a view kept by triggers must follow itself. */
const AUTO_CASCADES: Partial<Record<Dialect, () => MigrationDriver>> = {
  mysql: () => mysqlMigrationDriver,
};

async function runCheck(options: CheckCliOptions): Promise<void> {
  const load = { config: options.config, skipValidation: true };
  await runCli(load, options.json, async (config) => {
    const { models } = config;
    // The identifier and identity checks hydration runs, whatever the
    // configured client skipped.
    hydrateSchemaNames(models);
    const result = withViewQueries(validateSchema(models), config);
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
          ? `Schema valid (${summarize(models)}).\n`
          : `Schema invalid: ${result.errors.length} error(s).\n`
      );
      if (storage)
        process.stdout.write(
          `Storage audited: ${storage.length} column(s), ${dirty.length} need repair.\n`
        );
    }
    if (!result.valid || dirty.length > 0) process.exitCode = 1;
  });
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
