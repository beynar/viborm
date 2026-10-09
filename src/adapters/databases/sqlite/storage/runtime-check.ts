import { UnsupportedOperationError } from "@errors";
import { type Sql, sql } from "@sql";
import {
  type DecimalDescriptor,
  sameDecimalDescriptor,
} from "@validation/primitives/decimal-codec";
import { createIdentifierQuoter } from "../../../../sql/identifiers";
import { readSqliteDecimalConstraint } from "./decimal";

export interface SQLiteDecimalColumn {
  readonly name: string;
  readonly descriptor: DecimalDescriptor;
  readonly list: boolean;
}

const quote = createIdentifierQuoter('"');

/** Observe the catalog of one table's checked decimal columns in one read. */
export function sqliteStorageCheck(
  table: string,
  columns: readonly SQLiteDecimalColumn[]
) {
  const statement: Sql = sql`SELECT s.sql AS definition, p.name, p.type, p."notnull", p.pk FROM sqlite_schema AS s JOIN pragma_table_info(s.name) AS p WHERE s.type = 'table' AND s.name = ${table}`;
  return {
    statement,
    validate(rows: readonly Record<string, unknown>[]): Sql {
      const definition = rows[0]?.definition;
      if (typeof definition !== "string")
        refuse(
          table,
          columns[0]?.name ?? "",
          "its physical table is missing or cannot be inspected"
        );
      for (const column of columns) {
        const row = rows.find((row) => row.name === column.name);
        if (
          !row ||
          typeof row.type !== "string" ||
          typeof row.definition !== "string"
        )
          refuse(
            table,
            column.name,
            "its physical column is missing or cannot be inspected"
          );
        const descriptor = readSqliteDecimalConstraint(
          row.definition,
          {
            name: column.name,
            type: row.type,
            nullable: Number(row.notnull) === 0 && Number(row.pk) === 0,
          },
          quote
        );
        if (
          row.type.toUpperCase() !== (column.list ? "TEXT" : "INTEGER") ||
          !sameDecimalDescriptor(descriptor, column.descriptor)
        )
          refuse(
            table,
            column.name,
            "its declared storage is not the checked scaled-integer decimal domain; foreign REAL/NUMERIC/TEXT decimals require an explicit conversion"
          );
      }
      // This assertion is spent inside the same atomic unit as the typed
      // statement. A preflight observation alone cannot vouch for later DDL.
      return sql`SELECT 1 FROM sqlite_schema AS s WHERE s.type = 'table' AND s.name = ${table} AND s.sql = ${definition}`;
    },
  };
}

function refuse(table: string, column: string, reason: string): never {
  throw new UnsupportedOperationError(
    `Cannot use SQLite column "${table}"."${column}": ${reason}.`,
    {
      meta: { table, column, dialect: "sqlite" },
    }
  );
}
