import { UnsupportedOperationError } from "@errors";
import { type Sql, sql } from "@sql";
import {
  type DecimalDescriptor,
  sameDecimalDescriptor,
} from "@validation/primitives/decimal-codec";
import {
  createIdentifierQuoter,
  renderQualifiedIdentifier,
} from "../../../../sql/identifiers";
import {
  sqliteCanonicalDateTimePredicate,
  sqliteCanonicalTimePredicate,
} from "./datetime";
import { readSqliteDecimalConstraint } from "./decimal";

export type SQLiteStorageColumn = {
  readonly name: string;
} & (
  | {
      readonly kind: "decimal";
      readonly descriptor: DecimalDescriptor;
      readonly list: boolean;
    }
  | {
      readonly kind: "timestamp" | "time";
      readonly list: boolean;
    }
);

const quote = createIdentifierQuoter('"');

/** Observe the catalog and relevant stored spellings in one read statement. */
export function sqliteStorageCheck(
  table: string,
  columns: readonly SQLiteStorageColumn[]
) {
  const temporal = columns.filter((column) => column.kind !== "decimal");
  const incompatible = temporal.map((column) => {
    const canonical =
      column.kind === "time"
        ? sqliteCanonicalTimePredicate
        : sqliteCanonicalDateTimePredicate;
    if (!column.list) return sql`NOT ${sql.raw(canonical(column.name))}`;
    const name = quote(column.name);
    // json_each is reached only after proving an array carrier. Each non-null
    // member uses the same temporal domain as a scalar storage boundary.
    return sql.raw(
      `CASE WHEN ${name} IS NULL THEN 0 WHEN json_valid(${name}) AND json_type(${name}) = 'array' THEN EXISTS (SELECT 1 FROM json_each(${name}) WHERE type <> 'text' OR NOT ${canonical("value")}) ELSE 1 END`
    );
  });
  const foreignTime =
    incompatible.length === 0
      ? sql.raw("NULL")
      : sql`(SELECT 1 FROM ${sql.raw(renderQualifiedIdentifier(quote, undefined, table))} WHERE ${sql.join(incompatible, " OR ")} LIMIT 1)`;
  const statement: Sql = sql`SELECT s.sql AS definition, p.name, p.type, p."notnull", p.pk, ${foreignTime} AS foreign_time FROM sqlite_schema AS s JOIN pragma_table_info(s.name) AS p WHERE s.type = 'table' AND s.name = ${table}`;
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
        if (row.foreign_time !== null && row.foreign_time !== undefined)
          refuse(
            table,
            column.name,
            "stored time values are not canonical UTC text; repair them with VibORM's SQLite DateTime conversion before using typed queries"
          );
        if (column.kind !== "decimal") continue;
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
      // statement. A preflight observation alone cannot vouch for later DDL
      // or for another writer introducing a noncanonical temporal value.
      return sql`SELECT 1 FROM sqlite_schema AS s WHERE s.type = 'table' AND s.name = ${table} AND s.sql = ${definition} AND ${foreignTime} IS NULL`;
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
