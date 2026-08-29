import type { DecimalDescriptor } from "@validation/primitives/decimal-codec";
import { MigrationError, VibORMErrorCode } from "../../../errors";
import {
  decimalConversionConstraintName,
  mysqlDecimalFitsCatalogCheck,
  mysqlDecimalListFitsCatalogCheck,
  readMysqlDecimalListMarker,
  readStoredDecimalDescriptor,
} from "../../decimal";
import type { CatalogRead } from "../../target";

const RESERVED_PREFIX = "viborm_decimal_";
const RESERVED_NAME = /^viborm_decimal_([sl])_(\d+)_(\d+)$/;
const CATALOG_CHARACTER_SET_INTRODUCER = /^_[a-zA-Z0-9]+(?=')/;
const WHITESPACE = /\s/;

const CONSTRAINTS_QUERY = `
SELECT
  tc.TABLE_NAME,
  tc.CONSTRAINT_NAME,
  tc.ENFORCED,
  cc.CHECK_CLAUSE
FROM information_schema.TABLE_CONSTRAINTS tc
JOIN information_schema.CHECK_CONSTRAINTS cc
  ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
  AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
WHERE tc.CONSTRAINT_SCHEMA = ?
  AND tc.CONSTRAINT_TYPE = 'CHECK'
  AND LEFT(tc.CONSTRAINT_NAME, 15) = ?
ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME
`;

const COLUMNS_QUERY = `
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_COMMENT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ?
ORDER BY TABLE_NAME, ORDINAL_POSITION
`;

interface ConstraintRow {
  readonly TABLE_NAME: unknown;
  readonly CONSTRAINT_NAME: unknown;
  readonly ENFORCED: unknown;
  readonly CHECK_CLAUSE: unknown;
}

interface ColumnRow {
  readonly TABLE_NAME: unknown;
  readonly COLUMN_NAME: unknown;
  readonly DATA_TYPE: unknown;
  readonly COLUMN_COMMENT: unknown;
}

interface ProvenConstraint {
  readonly tableName: string;
  readonly constraintName: string;
}

interface RecoveryColumn {
  readonly name: string;
  readonly dataType: string;
  readonly comment: string;
}

function refuseReservedConstraint(
  constraintName: string,
  tableName: string,
  reason: string
): never {
  throw new MigrationError(
    `The MySQL CHECK constraint "${constraintName}" on table "${tableName}" uses VibORM's reserved decimal-conversion namespace but ${reason}. ` +
      "Migration work is refused before any cleanup or schema effect; rename the user-owned constraint, or restore the exact interrupted VibORM conversion proof and run the command again.",
    VibORMErrorCode.MIGRATION_INVALID_STATE,
    {
      meta: {
        dialect: "mysql",
        type: "decimal-conversion-constraint-collision",
        table: tableName,
        constraint: constraintName,
      },
    }
  );
}

function readString(
  value: unknown,
  constraintName: string,
  tableName: string,
  field: string
): string {
  if (typeof value === "string") return value;
  refuseReservedConstraint(
    constraintName,
    tableName,
    `its catalog ${field} is not a string`
  );
}

/**
 * MySQL stores CHECK clauses in a normalized spelling: keywords are lower-case,
 * redundant grouping parentheses are added, `CHARACTER SET` becomes `CHARSET`,
 * and string literals acquire a connection-character-set introducer. These are
 * presentation changes only. Removing precisely those tokens leaves the exact
 * generated expression comparable without accepting another predicate.
 */
function normalizeCheckClause(clause: string): string {
  // CHECK_CLAUSE escapes each catalog-rendered string delimiter as `\'` on
  // mysql2. None of VibORM's fixed proof literals contains an apostrophe, so
  // this removes only the provider's delimiter escape, never literal content.
  const rendered = clause.replaceAll("\\'", "'");
  let normalized = "";
  let index = 0;
  while (index < rendered.length) {
    const char = rendered[index];
    if (char === "'") {
      const start = index;
      index++;
      while (index < rendered.length) {
        if (rendered[index] === "\\" && index + 1 < rendered.length) {
          index += 2;
          continue;
        }
        if (rendered[index] === "'" && rendered[index + 1] === "'") {
          index += 2;
          continue;
        }
        if (rendered[index] === "'") {
          index++;
          break;
        }
        index++;
      }
      normalized += rendered.slice(start, index);
      continue;
    }
    if (char === "`") {
      const end = rendered.indexOf("`", index + 1);
      if (end < 0) return clause;
      normalized += rendered.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (WHITESPACE.test(char ?? "")) {
      index++;
      continue;
    }
    if (char === "_") {
      const introducer = CATALOG_CHARACTER_SET_INTRODUCER.exec(
        rendered.slice(index)
      );
      if (introducer !== null) {
        index += introducer[0].length;
        continue;
      }
    }
    normalized += char?.toLowerCase() ?? "";
    index++;
  }
  return normalized;
}

function expectedConstraint(
  column: RecoveryColumn,
  kind: "s" | "l",
  descriptor: DecimalDescriptor
): string {
  const quotedColumn = `\`${column.name}\``;
  return kind === "s"
    ? mysqlDecimalFitsCatalogCheck(
        quotedColumn,
        `DECIMAL(${descriptor.precision},${descriptor.scale})`
      )
    : mysqlDecimalListFitsCatalogCheck(quotedColumn, descriptor);
}

function readDescriptor(
  match: RegExpExecArray,
  constraintName: string,
  tableName: string
): DecimalDescriptor {
  const descriptor = readStoredDecimalDescriptor(match[2], match[3], "mysql");
  if (descriptor === undefined) {
    refuseReservedConstraint(
      constraintName,
      tableName,
      "its name declares a decimal domain this provider does not admit"
    );
  }
  const kind = match[1] === "s" ? "scalar" : "list";
  if (decimalConversionConstraintName(kind, descriptor) !== constraintName) {
    refuseReservedConstraint(
      constraintName,
      tableName,
      "its name is not the canonical spelling of its decimal proof"
    );
  }
  return descriptor;
}

function proveConstraint(
  row: ConstraintRow,
  columnsByTable: ReadonlyMap<string, readonly RecoveryColumn[]>
): ProvenConstraint {
  const rawName =
    typeof row.CONSTRAINT_NAME === "string"
      ? row.CONSTRAINT_NAME
      : "<unreported>";
  const rawTable =
    typeof row.TABLE_NAME === "string" ? row.TABLE_NAME : "<unreported>";
  const constraintName = readString(
    row.CONSTRAINT_NAME,
    rawName,
    rawTable,
    "CONSTRAINT_NAME"
  );
  const tableName = readString(
    row.TABLE_NAME,
    constraintName,
    rawTable,
    "TABLE_NAME"
  );
  const clause = readString(
    row.CHECK_CLAUSE,
    constraintName,
    tableName,
    "CHECK_CLAUSE"
  );
  const enforced = readString(
    row.ENFORCED,
    constraintName,
    tableName,
    "ENFORCED"
  );
  if (enforced !== "YES") {
    refuseReservedConstraint(
      constraintName,
      tableName,
      "its CHECK is not enforced"
    );
  }
  const nameMatch = RESERVED_NAME.exec(constraintName);
  if (nameMatch === null) {
    refuseReservedConstraint(
      constraintName,
      tableName,
      "its name does not match the complete reserved proof identity"
    );
  }
  const kind = nameMatch[1] === "s" ? "s" : "l";
  const descriptor = readDescriptor(nameMatch, constraintName, tableName);

  const columns = columnsByTable.get(tableName) ?? [];
  const actualClause = normalizeCheckClause(clause);
  for (const column of columns) {
    const expected = expectedConstraint(column, kind, descriptor);
    if (normalizeCheckClause(expected) !== actualClause) continue;
    if (kind === "s") {
      if (
        column.dataType === "decimal" ||
        column.dataType === "int" ||
        column.dataType === "bigint"
      ) {
        return { tableName, constraintName };
      }
      refuseReservedConstraint(
        constraintName,
        tableName,
        `its scalar proof is attached to impossible ${column.dataType} storage`
      );
    }
    if (column.dataType !== "json") {
      refuseReservedConstraint(
        constraintName,
        tableName,
        `its list proof is attached to impossible ${column.dataType} storage`
      );
    }
    let current: DecimalDescriptor | undefined;
    try {
      current = readMysqlDecimalListMarker(column.comment);
    } catch {
      refuseReservedConstraint(
        constraintName,
        tableName,
        "its JSON column carries an invalid decimal-list marker"
      );
    }
    if (
      current !== undefined &&
      current.scale === descriptor.scale &&
      current.precision >= descriptor.precision
    ) {
      return { tableName, constraintName };
    }
    refuseReservedConstraint(
      constraintName,
      tableName,
      "its JSON column does not carry a compatible source or target decimal-list marker"
    );
  }

  refuseReservedConstraint(
    constraintName,
    tableName,
    "its concrete CHECK predicate does not match that proof identity"
  );
}

function groupColumns(
  rows: readonly ColumnRow[]
): Map<string, RecoveryColumn[]> {
  const columnsByTable = new Map<string, RecoveryColumn[]>();
  for (const row of rows) {
    const tableName = typeof row.TABLE_NAME === "string" ? row.TABLE_NAME : "";
    const columnName =
      typeof row.COLUMN_NAME === "string" ? row.COLUMN_NAME : "";
    const dataType = typeof row.DATA_TYPE === "string" ? row.DATA_TYPE : "";
    const comment =
      typeof row.COLUMN_COMMENT === "string" ? row.COLUMN_COMMENT : "";
    if (tableName === "" || columnName === "" || dataType === "") continue;
    const columns = columnsByTable.get(tableName) ?? [];
    columns.push({
      name: columnName,
      dataType: dataType.toLowerCase(),
      comment,
    });
    columnsByTable.set(tableName, columns);
  }
  return columnsByTable;
}

/**
 * Plans the removal of authenticated remnants of a MySQL decimal conversion.
 *
 * The migration lock excludes another VibORM command. Every reserved row is
 * proven before the first DROP is returned, so a user-owned collision or a
 * malformed catalog answer cannot make cleanup partially mutate the estate.
 * Execution belongs to the sequential-program owner: MySQL can commit a DROP
 * before reporting a connection failure, and only that owner can state the
 * resulting uncertain boundary honestly.
 */
export async function planInterruptedMySQLDecimalRecovery(
  read: CatalogRead,
  namespace: string,
  quoteIdentifier: (name: string) => string
): Promise<readonly string[]> {
  const { rows } = await read<ConstraintRow>(CONSTRAINTS_QUERY, [
    namespace,
    RESERVED_PREFIX,
  ]);
  if (rows.length === 0) return [];
  if (rows.length > 1) {
    const first = rows[0];
    refuseReservedConstraint(
      typeof first?.CONSTRAINT_NAME === "string"
        ? first.CONSTRAINT_NAME
        : "<unreported>",
      typeof first?.TABLE_NAME === "string" ? first.TABLE_NAME : "<unreported>",
      `the catalog contains ${rows.length} reserved proofs, although one locked conversion can leave at most one`
    );
  }

  const columns = await read<ColumnRow>(COLUMNS_QUERY, [namespace]);
  const columnsByTable = groupColumns(columns.rows);
  const proven = rows.map((row) => proveConstraint(row, columnsByTable));

  return proven.map(
    (constraint) =>
      `ALTER TABLE ${quoteIdentifier(namespace)}.${quoteIdentifier(constraint.tableName)} DROP CHECK ${quoteIdentifier(constraint.constraintName)}`
  );
}
