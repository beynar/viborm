/**
 * The proof that a document says what the database is.
 *
 * The document is parsed, validated, and serialized exactly as `push`
 * serializes a schema, then diffed against the snapshot the database was read
 * into, with the differ `push` uses. Every operation that diff plans is a place
 * where the document and the database disagree, reported as a `drift` warning:
 * a document with none pushes as a no-op. The translation never has to be
 * trusted to be the exact inverse of the forward direction — this runs it.
 */

import { hydrateSchemaNames } from "../../schema/hydration";
import { parseSchema } from "../../schema/json";
import type { SchemaDocument } from "../../schema/json/document";
import { diff } from "../differ";
import type { MigrationDriver } from "../drivers/base";
import { serializeModels } from "../serializer";
import type { ColumnDef, DiffOperation, SchemaSnapshot } from "../types";
import type { IntrospectionWarning } from "./types";

function describeColumn(column: ColumnDef): string {
  return `${column.type}${column.nullable ? " NULL" : " NOT NULL"}${column.default === undefined ? "" : ` DEFAULT ${column.default}`}`;
}

function describe(operation: DiffOperation): IntrospectionWarning {
  const push = (
    table: string | undefined,
    name: string | undefined,
    message: string
  ) => ({
    kind: "drift" as const,
    table,
    name,
    message: `push would ${message}`,
  });
  switch (operation.type) {
    case "createTable":
      return push(
        operation.table.name,
        undefined,
        `create table "${operation.table.name}"`
      );
    case "dropTable":
      return push(
        operation.tableName,
        undefined,
        `drop table "${operation.tableName}"`
      );
    case "addColumn":
      return push(
        operation.tableName,
        operation.column.name,
        `add column "${operation.column.name}" (${describeColumn(operation.column)})`
      );
    case "dropColumn":
      return push(
        operation.tableName,
        operation.columnName,
        `drop column "${operation.columnName}"`
      );
    case "alterColumn":
      return push(
        operation.tableName,
        operation.columnName,
        `alter column "${operation.columnName}" from ${describeColumn(operation.from)} to ${describeColumn(operation.to)}`
      );
    case "createIndex":
      return push(
        operation.tableName,
        operation.index.name,
        `create index "${operation.index.name}" on (${operation.index.columns.join(", ")})`
      );
    case "dropIndex":
      return push(
        operation.tableName,
        operation.indexName,
        `drop index "${operation.indexName}"`
      );
    case "addForeignKey":
      return push(
        operation.tableName,
        operation.fk.name,
        `add foreign key "${operation.fk.name}" on (${operation.fk.columns.join(", ")})`
      );
    case "dropForeignKey":
      return push(
        operation.tableName,
        operation.fkName,
        `drop foreign key "${operation.fkName}"`
      );
    case "addUniqueConstraint":
      return push(
        operation.tableName,
        operation.constraint.name,
        `add unique constraint "${operation.constraint.name}" on (${operation.constraint.columns.join(", ")})`
      );
    case "dropUniqueConstraint":
      return push(
        operation.tableName,
        operation.constraintName,
        `drop unique constraint "${operation.constraintName}"`
      );
    case "addPrimaryKey":
      return push(
        operation.tableName,
        operation.primaryKey.name,
        `add a primary key on (${operation.primaryKey.columns.join(", ")})`
      );
    case "dropPrimaryKey":
      return push(
        operation.tableName,
        operation.constraintName,
        `drop primary key "${operation.constraintName}"`
      );
    case "createEnum":
      return push(
        undefined,
        operation.enumDef.name,
        `create enum "${operation.enumDef.name}"`
      );
    case "dropEnum":
      return push(
        undefined,
        operation.enumName,
        `drop enum "${operation.enumName}"`
      );
    case "alterEnum":
      return push(
        undefined,
        operation.enumName,
        `alter enum "${operation.enumName}"`
      );
    case "renameTable":
      return push(
        operation.from,
        undefined,
        `rename table "${operation.from}" to "${operation.to}"`
      );
    case "renameColumn":
      return push(
        operation.tableName,
        operation.from,
        `rename column "${operation.from}" to "${operation.to}"`
      );
    default:
      return push(undefined, undefined, (operation as { type: string }).type);
  }
}

/** The tables an operation touches, for demoting a generated junction. */
function tableOf(warning: IntrospectionWarning): string | undefined {
  return warning.table;
}

export interface Verification {
  readonly warnings: IntrospectionWarning[];
  /** Tables with at least one drift. */
  readonly drifted: ReadonlySet<string>;
}

/**
 * Diff the document against the live snapshot of the tables it declares.
 *
 * `current` holds exactly those tables (and the enums their columns use), so
 * what the document deliberately leaves out — a skipped table, a view — is not
 * reported twice. Throws what `parseSchema(…, { validate: true })` throws: a
 * document that does not validate is a translation bug, never a drift.
 */
export async function verifyDocument(
  document: SchemaDocument,
  current: SchemaSnapshot,
  migrationDriver: MigrationDriver
): Promise<Verification> {
  const schema = parseSchema(document, { validate: true });
  hydrateSchemaNames(schema);
  const desired = serializeModels(schema, { migrationDriver });
  const readsNames =
    migrationDriver.capabilities.introspectionReadsConstraintNames;
  const result = await diff(current, desired, {
    matchConstraintsByShape: !readsNames,
    refuseConstraintNameChurn: false,
  });
  // On a dialect that reads constraint names, a constraint the database holds
  // under another name is a drop and an add of one shape. `push` refuses that
  // rather than renaming it, so the pair is reported as the one fact it is.
  const renamed = new Set<DiffOperation>();
  const warnings: IntrospectionWarning[] = [];
  for (const added of result.operations) {
    if (added.type !== "addForeignKey" && added.type !== "addUniqueConstraint")
      continue;
    const columns = (
      added.type === "addForeignKey" ? added.fk : added.constraint
    ).columns.join("\0");
    const live = current.tables.find((table) => table.name === added.tableName);
    const dropped = result.operations.find((operation) => {
      if (renamed.has(operation)) return false;
      if (
        added.type === "addForeignKey" &&
        operation.type === "dropForeignKey" &&
        operation.tableName === added.tableName
      )
        return live?.foreignKeys.some(
          (fk) =>
            fk.name === operation.fkName &&
            fk.columns.join("\0") === columns &&
            fk.referencedTable === added.fk.referencedTable
        );
      if (
        added.type === "addUniqueConstraint" &&
        operation.type === "dropUniqueConstraint" &&
        operation.tableName === added.tableName
      )
        return live?.uniqueConstraints.some(
          (unique) =>
            unique.name === operation.constraintName &&
            unique.columns.join("\0") === columns
        );
      return false;
    });
    if (dropped === undefined) continue;
    renamed.add(added);
    renamed.add(dropped);
    const actual =
      dropped.type === "dropForeignKey"
        ? dropped.fkName
        : dropped.type === "dropUniqueConstraint"
          ? dropped.constraintName
          : "";
    const wanted =
      added.type === "addForeignKey" ? added.fk.name : added.constraint.name;
    warnings.push({
      kind: "drift",
      table: added.tableName,
      name: actual,
      message: `push refuses this table: the constraint "${actual}" is the one VibORM names "${wanted}", and a document cannot name it`,
    });
  }
  for (const operation of result.operations)
    if (!renamed.has(operation)) warnings.push(describe(operation));
  for (const change of result.ambiguousChanges)
    warnings.push(
      change.type === "ambiguousColumn"
        ? {
            kind: "drift",
            table: change.tableName,
            name: change.droppedColumn.name,
            message: `push would replace column "${change.droppedColumn.name}" by "${change.addedColumn.name}"`,
          }
        : {
            kind: "drift",
            table: change.droppedTable,
            message: `push would replace table "${change.droppedTable}" by "${change.addedTable}"`,
          }
    );
  // A primary key's name is matched by name, never by diff: push refuses one
  // it would have to rename rather than planning anything.
  if (readsNames) {
    const desiredTables = new Map(
      desired.tables.map((table) => [table.name, table])
    );
    for (const table of current.tables) {
      const actual = table.primaryKey?.name;
      const wanted = desiredTables.get(table.name)?.primaryKey?.name;
      if (actual !== undefined && wanted !== undefined && actual !== wanted)
        warnings.push({
          kind: "drift",
          table: table.name,
          name: actual,
          message: `push refuses this table: its primary key is named "${actual}" and VibORM names it "${wanted}"`,
        });
    }
  }
  const drifted = new Set<string>();
  for (const warning of warnings) {
    const table = tableOf(warning);
    if (table !== undefined) drifted.add(table);
  }
  return { warnings, drifted };
}
