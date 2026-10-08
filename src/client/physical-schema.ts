import {
  type SQLiteStorageColumn,
  sqliteStorageCheck,
} from "@adapters/databases/sqlite/storage/runtime-check";
import type { AnyDriver, QueryExecutionContext } from "@drivers/exports";
import { deriveStatementExecutionContext } from "@drivers/execution-context";
import { UnsupportedOperationError } from "@errors";
import type { Schema } from "@schema/hydration";
import type { AnyModel, ModelState } from "@schema/model";
import type { Sql } from "@sql";

export interface PhysicalSchemaAssertion {
  readonly query: Sql;
  readonly failure: UnsupportedOperationError;
}

export type PhysicalSchemaCheck = (
  driver: AnyDriver,
  context: QueryExecutionContext,
  models: Iterable<AnyModel>
) => Promise<readonly PhysicalSchemaAssertion[]>;

/** Bind immutable declarations; observe mutable storage at each execution. */
export function createPhysicalSchemaCheck(
  schema: Schema,
  driver: AnyDriver
): PhysicalSchemaCheck | undefined {
  if (driver.dialect !== "sqlite") return undefined;
  const checks = new Map<AnyModel, ReturnType<typeof sqliteStorageCheck>>();
  for (const [name, model] of Object.entries(schema)) {
    const state: ModelState = model["~"].state;
    const columns: SQLiteStorageColumn[] = [];
    for (const [field, scalar] of Object.entries(state.scalars)) {
      const definition = scalar["~"].state;
      const name = model["~"].getFieldName(field).sql;
      if (definition.type === "decimal") {
        columns.push({
          name,
          kind: "decimal",
          descriptor: definition.decimal,
          list: definition.array === true,
        });
      } else if (
        definition.type === "time" ||
        (definition.type === "datetime" &&
          (definition.array ||
            (driver.adapter.result.dateTimeRepresentation?.(
              scalar["~"].nativeType
            ) ?? "text") === "text"))
      ) {
        columns.push({
          name,
          kind: definition.type === "time" ? "time" : "timestamp",
          list: definition.array === true,
        });
      }
    }
    if (columns.length)
      checks.set(
        model,
        sqliteStorageCheck(
          model["~"].names.sql ?? state.tableName ?? name,
          columns
        )
      );
  }
  if (checks.size === 0) return undefined;
  return async (executionDriver, context, models) => {
    const assertions: PhysicalSchemaAssertion[] = [];
    for (const model of new Set(models)) {
      const check = checks.get(model);
      if (!check) continue;
      // Catalog reads are physical and must not pass through model codecs or
      // user statement transforms. No successful observation is cached across
      // writes, DDL, transaction boundaries or replacement transports.
      const result = await executionDriver._executeRaw(
        check.statement.toStatement(),
        check.statement.values,
        deriveStatementExecutionContext(context, "$schema", "verifyStorage")
      );
      const query = check.validate(result.rows);
      assertions.push({
        query,
        failure: new UnsupportedOperationError(
          `SQLite storage for model '${model["~"].names.ts}' changed after inspection or contains noncanonical time values; repair its physical schema/data before using typed queries.`,
          { meta: { model: model["~"].names.ts, dialect: "sqlite" } }
        ),
      });
    }
    return assertions;
  };
}
