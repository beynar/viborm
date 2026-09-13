/**
 * The one conversion no dialect can perform in SQL: a column BECOMING binary.
 *
 * Every generated `ALTER COLUMN` is a blind re-reading of the bytes already
 * stored. That is harmless when the two types share a reading — `varchar(40)`
 * and `text` are the same characters, `numeric(10,2)` and `numeric(12,2)` the
 * same number — and it is data loss the moment the target is a BINARY column,
 * because the only cast a dialect offers there re-encodes the source's own
 * spelling:
 *
 *   · PostgreSQL's `USING col::bytea` writes the ASCII of the old text. A
 *     26-character ULID becomes 26 bytes, not the 16 its codec reads, and every
 *     later read is refused as "not in this column's declared identifier
 *     domain" (measured live on PostgreSQL 16).
 *   · SQLite's table rebuild copies the value VERBATIM into the new BLOB
 *     column, so `typeof()` still answers `'text'` afterwards — the migration
 *     type and the engine binding disagree with no error at all.
 *   · MySQL's `MODIFY COLUMN … BINARY(n)` truncates or pads to the declared
 *     width without a word in a non-strict `sql_mode`.
 *
 * So the conversion is REFUSED where it is generated, with the manual route
 * named. This is the rule `docs/architecture/native-ids-plan.md` §3 states for
 * an identifier ("a blind `USING col::bytea` would re-encode text bytes, so it
 * is never emitted"), and it is stated here in the terms a migration driver
 * actually has: the two column TYPES. A snapshot carries no logical marker that
 * would say "this BLOB decodes identifiers", and it does not need one — a
 * verbatim copy into a binary column is unreadable whatever the column holds.
 *
 * PostgreSQL's `uuid` target is deliberately NOT here. `col::uuid` is a real
 * conversion PostgreSQL performs value by value: it succeeds for an estate of
 * canonical uuids and aborts the whole transaction for one that is not, leaving
 * the column as it was. That is a conversion with a wrong answer for nobody.
 *
 * Pure and connection-free, like every other module in this layer.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import type { Dialect } from "./drivers/types";

/** MySQL's two width-carrying binary column spellings. */
const MYSQL_SIZED_BINARY = /^(?:BINARY|VARBINARY)\(\d+\)$/i;
const MYSQL_BLOB_FAMILY = /^(?:TINYBLOB|BLOB|MEDIUMBLOB|LONGBLOB)$/i;

/** Whether this dialect spells `type` as a column of raw bytes. */
function isBinaryColumnType(type: string, dialect: Dialect): boolean {
  const spelling = type.trim();
  switch (dialect) {
    case "postgresql":
      return spelling.toLowerCase() === "bytea";
    case "mysql":
      return (
        MYSQL_SIZED_BINARY.test(spelling) || MYSQL_BLOB_FAMILY.test(spelling)
      );
    default:
      return spelling.toUpperCase() === "BLOB";
  }
}

/**
 * Refuse an alteration that turns a non-binary column into a binary one.
 *
 * Both sides binary is a WIDTH change and is left alone: `VARBINARY(100)` to
 * `VARBINARY(200)` re-reads the same bytes as the same bytes, which is the
 * property this refusal exists to require.
 */
export function refuseBinaryReencoding(
  table: string,
  column: string,
  fromType: string,
  toType: string,
  dialect: Dialect
): void {
  if (!isBinaryColumnType(toType, dialect)) return;
  if (isBinaryColumnType(fromType, dialect)) return;
  throw new MigrationError(
    `Column "${column}" of "${table}" would change from ${fromType} to ${toType}, and no dialect can re-read the stored values as bytes: ` +
      "the generated cast would store the old value's own spelling, which nothing can decode afterwards. " +
      "Convert the rows yourself — add the new column, write the decoded values into it, drop the old one and rename — " +
      "or, for a declared identifier format, keep the column as it is with a text-family native type, which validates the domain without changing storage.",
    VibORMErrorCode.INVALID_INPUT
  );
}
