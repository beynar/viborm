/**
 * The public vocabulary of `introspectSchema`: what it returns beside the
 * document, so a caller always knows what the document does NOT say.
 */

import type { SchemaDocument } from "../../schema/json/document";

/** The kind of database object a {@link SkippedObject} names. */
export type SkippedKind =
  | "table"
  | "view"
  | "column"
  | "default"
  | "index"
  | "uniqueConstraint"
  | "foreignKey"
  | "check"
  | "enum";

/**
 * A database object the document does not carry, and why.
 *
 * `table` names the table the object belongs to (absent for a view, an enum,
 * or a whole table, whose own name is `name`).
 */
export interface SkippedObject {
  readonly kind: SkippedKind;
  readonly name: string;
  readonly table?: string | undefined;
  readonly reason: string;
}

/**
 * Something the document states differently from the database.
 *
 * `approximated`: the document carries the object with a meaning the database
 * does not prove (a SQLite `BLOB` read as bytes when it may hold UUIDs, a
 * SQLite key column that admits NULL declared NOT NULL).
 *
 * `unstated`: the database gives a table a behavior the document has no
 * spelling for — a column collation, SQLite's `STRICT` or `ON CONFLICT`, a
 * trigger, row-level security. The database keeps it and a push of the
 * document plans nothing for it, but a push that recreates the table or the
 * column (on SQLite, most column changes) cannot keep it: it drops it, or
 * refuses where it guards it (a SQLite trigger).
 *
 * `drift`: `push` with this document against this database would change it.
 * Every drift is found by the migration differ itself — the document is parsed,
 * serialized the way `push` serializes it, and diffed against the snapshot the
 * database was read into — so a document with no drift warning pushes as a
 * no-op.
 */
export interface IntrospectionWarning {
  readonly kind: "approximated" | "unstated" | "drift";
  readonly table?: string | undefined;
  readonly name?: string | undefined;
  readonly message: string;
}

/** The dialects `introspectSchema` translates. */
export type IntrospectionDialect =
  | "postgresql"
  | "sqlite"
  | "mysql"
  | "snowflake";

export interface IntrospectSchemaResult {
  /** The schema, in canonical form (`serializeSchema(parseSchema(document))`). */
  readonly document: SchemaDocument;
  /** What the document does not carry. */
  readonly skipped: readonly SkippedObject[];
  /** What the document states differently from the database. */
  readonly warnings: readonly IntrospectionWarning[];
  readonly dialect: IntrospectionDialect;
}
