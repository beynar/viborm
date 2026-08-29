/** Exact recognition of VibORM-generated SQLite fixed-decimal rebuilds. */

import type { DiffOperation, TableDef } from "../../types";
import { sqliteColumnDefinitionCarriesDecimalDescriptor } from "./decimal";
import { readSqliteIdentifier, skipSqlNonStructuralRegion } from "./sql-lexing";

const TEMP_TABLE_PREFIX = "__new_";
const SCALAR_CONVERSION_SENTINEL = "'viborm:decimal-out-of-domain'";
const LIST_CONVERSION_SENTINEL = "'viborm:decimal-list-out-of-domain'";

interface IdentifierTail {
  readonly identifier: string;
  readonly tail: string;
}

interface RenameColumn {
  readonly table: string;
  readonly from: string;
  readonly to: string;
}

/** Remove the one terminator the artifact formatter preserves. */
function statementBody(statement: string): string {
  const trimmed = statement.trim();
  return trimmed.endsWith(";") ? trimmed.slice(0, -1).trimEnd() : trimmed;
}

/** Read the identifier immediately after one exact generator-owned prefix. */
function identifierAfter(
  statement: string,
  prefix: string
): IdentifierTail | undefined {
  const body = statementBody(statement);
  if (!body.startsWith(prefix)) return undefined;
  const identifier = readSqliteIdentifier(body, prefix.length);
  if (identifier === undefined) return undefined;
  return {
    identifier: identifier.value,
    tail: body.slice(identifier.end).trim(),
  };
}

function exactTableName(statement: string, prefix: string): string | undefined {
  const parsed = identifierAfter(statement, prefix);
  return parsed?.tail === "" ? parsed.identifier : undefined;
}

function renameTable(
  statement: string
): { readonly from: string; readonly to: string } | undefined {
  const source = identifierAfter(statement, "ALTER TABLE ");
  if (source === undefined || !source.tail.startsWith("RENAME TO ")) {
    return undefined;
  }
  const target = readSqliteIdentifier(source.tail, "RENAME TO ".length);
  if (
    target === undefined ||
    source.tail.slice(target.end).trim().length !== 0
  ) {
    return undefined;
  }
  return { from: source.identifier, to: target.value };
}

function renameColumn(statement: string): RenameColumn | undefined {
  const table = identifierAfter(statement, "ALTER TABLE ");
  if (table === undefined || !table.tail.startsWith("RENAME COLUMN ")) {
    return undefined;
  }
  const from = readSqliteIdentifier(table.tail, "RENAME COLUMN ".length);
  if (from === undefined) return undefined;
  const afterFrom = table.tail.slice(from.end).trim();
  if (!afterFrom.startsWith("TO ")) return undefined;
  const to = readSqliteIdentifier(afterFrom, "TO ".length);
  if (to === undefined || afterFrom.slice(to.end).trim().length !== 0) {
    return undefined;
  }
  return { table: table.identifier, from: from.value, to: to.value };
}

function hasClosingPragma(
  statements: readonly string[],
  start: number
): boolean {
  for (let index = start; index < statements.length; index++) {
    const body = statementBody(statements[index] ?? "");
    if (body === "PRAGMA foreign_keys=ON") return true;
    if (body === "PRAGMA foreign_keys=OFF") return false;
  }
  return false;
}

/** Whether the INSERT expression contains one exact generator sentinel token. */
function hasConversionSentinel(statement: string): boolean {
  let cursor = 0;
  while (cursor < statement.length) {
    const skipped = skipSqlNonStructuralRegion(statement, cursor);
    if (skipped === cursor) {
      cursor++;
      continue;
    }
    if (statement[cursor] === "'") {
      const token = statement.slice(cursor, skipped);
      if (
        token === SCALAR_CONVERSION_SENTINEL ||
        token === LIST_CONVERSION_SENTINEL
      ) {
        return true;
      }
    }
    cursor = skipped;
  }
  return false;
}

/** The referenced-table identifiers in one exact generated CREATE TABLE. */
function referencedTables(statement: string): string[] {
  const references: string[] = [];
  let cursor = 0;
  while (cursor < statement.length) {
    const skipped = skipSqlNonStructuralRegion(statement, cursor);
    if (skipped !== cursor) {
      cursor = skipped;
      continue;
    }
    const token = readSqliteIdentifier(statement, cursor);
    if (token === undefined) {
      cursor++;
      continue;
    }
    cursor = token.end;
    if (token.quoted || token.value.toUpperCase() !== "REFERENCES") continue;
    const referenced = readSqliteIdentifier(statement, cursor);
    if (referenced === undefined) continue;
    references.push(referenced.value);
    cursor = referenced.end;
  }
  return references;
}

/** The relation-bearing portion of one exact generated CREATE TABLE. */
function generatedCreateTable(statement: string): TableDef | undefined {
  const created = identifierAfter(statement, "CREATE TABLE ");
  if (created === undefined || !created.tail.startsWith("(")) return undefined;
  return {
    name: created.identifier,
    columns: [],
    indexes: [],
    uniqueConstraints: [],
    foreignKeys: referencedTables(statement).map((referencedTable, index) => ({
      name: `__viborm_artifact_fk_${index}`,
      columns: [],
      referencedTable,
      referencedColumns: [],
    })),
  };
}

/**
 * The generated table-membership and relation program through this rebuild.
 *
 * CREATE/DROP/table-rename are the complete set that can change whether a
 * foreign key touches a table before a decimal alteration: SQLite expresses FK
 * add/drop as table reconstruction, and a column rename changes an endpoint's
 * column spelling but not whether the endpoint exists. A generated FK add is
 * ordered after alterColumn; a generated CREATE TABLE or FK/drop-table removal
 * can precede it, and both are represented here.
 */
function relationOperationsThroughRebuild(
  statements: readonly string[],
  insertIndex: number
): DiffOperation[] {
  const operations: DiffOperation[] = [];
  // The current reconstruction's DROP and closing rename sit immediately
  // after INSERT. Replaying through them gives the census the rebuilt table's
  // outgoing FKs as well as the live schema's inbound ones.
  const end = insertIndex + 2;
  for (let index = 0; index <= end; index++) {
    const statement = statements[index] ?? "";
    const created = generatedCreateTable(statement);
    if (created !== undefined) {
      operations.push({ type: "createTable", table: created });
      continue;
    }
    const dropped = exactTableName(statement, "DROP TABLE ");
    if (dropped !== undefined) {
      operations.push({ type: "dropTable", tableName: dropped });
      continue;
    }
    const renamed = renameTable(statements[index] ?? "");
    if (renamed === undefined) continue;
    operations.push({
      type: "renameTable",
      from: renamed.from,
      to: renamed.to,
    });
  }
  return operations;
}

/**
 * Return the table rebuilt by the exact generated recreation around `INSERT`.
 * This is intentionally not a general SQL classifier: every token checked here
 * is one deterministic statement and adjacency emitted by
 * `SQLite3MigrationDriver.generateTableRecreation`.
 */
function generatedRebuildAt(
  statements: readonly string[],
  insertIndex: number
): { readonly table: string; readonly createSql: string } | undefined {
  if (insertIndex < 2) return undefined;
  const pragma = statementBody(statements[insertIndex - 2] ?? "");
  if (pragma !== "PRAGMA foreign_keys=OFF") return undefined;

  const createSql = statements[insertIndex - 1] ?? "";
  const created = identifierAfter(createSql, "CREATE TABLE ");
  const inserted = identifierAfter(
    statements[insertIndex] ?? "",
    "INSERT INTO "
  );
  const dropped = exactTableName(
    statements[insertIndex + 1] ?? "",
    "DROP TABLE "
  );
  const renamed = renameTable(statements[insertIndex + 2] ?? "");
  if (
    created === undefined ||
    !created.tail.startsWith("(") ||
    inserted === undefined ||
    !inserted.tail.startsWith("(") ||
    dropped === undefined ||
    renamed === undefined ||
    created.identifier !== inserted.identifier ||
    created.identifier !== `${TEMP_TABLE_PREFIX}${dropped}` ||
    renamed.from !== created.identifier ||
    renamed.to !== dropped ||
    !hasClosingPragma(statements, insertIndex + 3)
  ) {
    return undefined;
  }
  return { table: dropped, createSql };
}

/**
 * Tables whose generated artifact performs a fixed-decimal reconstruction.
 *
 * Descriptor conversions/adoptions carry the generator's impossible-value
 * sentinel in the copy expression. Decimal-column renames need no conversion,
 * so their proof is the immediately preceding native column rename plus the
 * renamed column's structural reserved descriptor in the recreated table.
 */
export function generatedSqliteDecimalRebuilds(
  statements: readonly string[]
): Array<{
  readonly table: string;
  readonly precedingOperations: readonly DiffOperation[];
}> {
  const rebuilds: Array<{
    readonly table: string;
    readonly precedingOperations: readonly DiffOperation[];
  }> = [];
  for (let index = 0; index < statements.length; index++) {
    const insert = statements[index] ?? "";
    const rebuild = generatedRebuildAt(statements, index);
    if (rebuild === undefined) continue;
    if (hasConversionSentinel(insert)) {
      rebuilds.push({
        table: rebuild.table,
        precedingOperations: relationOperationsThroughRebuild(
          statements,
          index
        ),
      });
      continue;
    }

    const nativeRename = renameColumn(statements[index - 3] ?? "");
    if (
      nativeRename?.table === rebuild.table &&
      sqliteColumnDefinitionCarriesDecimalDescriptor(
        rebuild.createSql,
        nativeRename.to
      )
    ) {
      rebuilds.push({
        table: rebuild.table,
        precedingOperations: relationOperationsThroughRebuild(
          statements,
          index
        ),
      });
    }
  }
  return rebuilds;
}
