/**
 * Raw indexes: an index written in a database's own language
 * (`Model.rawIndex`), for what the index declaration cannot say.
 *
 * A template is held as written. `{name}` and `{table}` are the index and its
 * table; any other `{identifier}` is a scalar field of the model, and the
 * fields a template names, in the order they first appear, are the index's
 * `columns`: rendering puts the i-th of them where the i-th field stands, so a
 * snapshot needs no field-to-column map. Its identity is `rawIndexHash` of the
 * text; the database holds the rendered text and a marker beside it (the
 * columns, the name, the hash) that introspection reads back, since no catalog
 * can say which text a statement was rendered from.
 */

import type { Dialect } from "../drivers/types";
import { MigrationError, VibORMErrorCode } from "../errors";
import type { RawIndexTemplates } from "../schema/model";
import { isRecord, isString } from "../validation/value-guards";
import { canonicalizeJsonText } from "./canonical-json";
import {
  domainHash,
  HASH_DOMAIN,
  isSha256,
  type Sha256,
  utf8Bytes,
} from "./identity";
import type { IndexDef } from "./types";

/** The template a dialect reads, by its key in `.rawIndex()`. */
export const RAW_INDEX_TEMPLATE_KEY: Readonly<
  Record<Dialect, keyof RawIndexTemplates>
> = {
  postgresql: "pg",
  mysql: "mysql",
  sqlite: "sqlite",
  surrealql: "surrealdb",
};

/** What a SQL database's catalog comment starts with when VibORM wrote it. */
export const RAW_INDEX_MARKER_PREFIX = "viborm:raw:";

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const RESERVED_PLACEHOLDERS: ReadonlySet<string> = new Set(["name", "table"]);
const SQL_HEADER =
  /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+\{name\}\s+ON\s+\{table\}/i;
const SURREAL_HEADER =
  /^\s*DEFINE\s+INDEX\s+\{name\}\s+ON\s+(?:TABLE\s+)?\{table\}/i;
const TERMINATED = /;\s*$/;

/** The fields a template names, each once, in the order they first appear. */
export function rawIndexFields(template: string): string[] {
  const fields: string[] = [];
  for (const [, name] of template.matchAll(PLACEHOLDER)) {
    if (!(RESERVED_PLACEHOLDERS.has(name!) || fields.includes(name!)))
      fields.push(name!);
  }
  return fields;
}

export function rawIndexHash(template: string): Sha256 {
  return domainHash(HASH_DOMAIN.rawIndex, utf8Bytes(template));
}

/**
 * One model's raw index as the serializer records it for `dialect`: its header
 * read, each field it names resolved to its column. `columnOf` answers a
 * scalar field's column, or undefined for anything else.
 */
export function declaredRawIndex(
  model: string,
  name: string,
  template: string,
  dialect: Dialect,
  columnOf: (field: string) => string | undefined
): IndexDef {
  if (name === "")
    throw new MigrationError(
      `A raw index of "${model}" needs a name.`,
      VibORMErrorCode.INVALID_INPUT,
      { meta: { model } }
    );
  const header = dialect === "surrealql" ? SURREAL_HEADER : SQL_HEADER;
  if (!header.test(template))
    throw new MigrationError(
      `The raw index "${model}.${name}" must start with ${dialect === "surrealql" ? "DEFINE INDEX {name} ON [TABLE] {table}" : "CREATE [UNIQUE] INDEX {name} ON {table}"}, so that VibORM names it and finds its table.`,
      VibORMErrorCode.INVALID_INPUT,
      { meta: { model, indexName: name } }
    );
  const fields = rawIndexFields(template);
  if (fields.length === 0)
    throw new MigrationError(
      `The raw index "${model}.${name}" names no field: write each column it indexes as {field}, so that it follows renames and VibORM knows what it covers.`,
      VibORMErrorCode.INVALID_INPUT,
      { meta: { model, indexName: name } }
    );
  const columns = fields.map((field) => {
    const column = columnOf(field);
    if (column === undefined)
      throw new MigrationError(
        `The raw index "${model}.${name}" names {${field}}, which is not a scalar field of "${model}". Besides {name} and {table}, a placeholder is a scalar field.`,
        VibORMErrorCode.INVALID_INPUT,
        { meta: { model, indexName: name, field } }
      );
    return column;
  });
  return {
    name,
    columns,
    unique: false,
    raw: { hash: rawIndexHash(template), template },
  };
}

/** How a driver spells the parts a template leaves to it. */
export interface RawIndexSpelling {
  readonly name: string;
  readonly table: string;
  readonly column: (column: string) => string;
}

/** The statement a raw index's template renders to, its marker not included. */
export function renderRawIndex(
  index: IndexDef,
  spelling: RawIndexSpelling
): string {
  const template = index.raw?.template;
  if (template === undefined)
    throw new MigrationError(
      `The index "${index.name}" was read from the database as a raw index this schema does not declare, so nothing says how to create it again. Declare it with .rawIndex(), or drop it in its own step first.`,
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      { meta: { indexName: index.name } }
    );
  const fields = rawIndexFields(template);
  return template.replace(PLACEHOLDER, (_, placeholder: string) => {
    if (placeholder === "name") return spelling.name;
    if (placeholder === "table") return spelling.table;
    return spelling.column(index.columns[fields.indexOf(placeholder)]!);
  });
}

/**
 * Refuses a rendered template the marker cannot be attached to: more than one
 * statement, a terminating `;`, or a word VibORM writes itself (`refused`), as
 * an executable word of the statement, so a quoted identifier or a string
 * that spells one is no refusal.
 */
export function refuseRawIndexStatement(
  index: IndexDef,
  rendered: string,
  statements: readonly (readonly string[])[],
  refused: readonly string[]
): void {
  if (statements.length !== 1 || TERMINATED.test(rendered))
    throw new MigrationError(
      `The raw index "${index.name}" must be one statement without a terminating semicolon: VibORM attaches its marker to it.`,
      VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      { meta: { indexName: index.name } }
    );
  const word = refused.find((candidate) => statements[0]!.includes(candidate));
  if (word !== undefined)
    throw new MigrationError(
      `The raw index "${index.name}" says ${word}, which VibORM writes itself on this database: ${word === "CONCURRENTLY" ? "a raw index is always built in the migration's own transaction" : "the index carries VibORM's marker there"}. Remove it from the template.`,
      VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      { meta: { indexName: index.name } }
    );
}

/**
 * What a database holds beside a raw index: canonical JSON of its columns,
 * name and hash, which is exactly the projection `fingerprintSnapshot` hashes.
 */
export function rawIndexMarker(index: IndexDef): string {
  return canonicalizeJsonText({
    columns: index.columns,
    name: index.name,
    raw: index.raw!.hash,
  });
}

/**
 * A raw index from the marker beside index `name`, or undefined when the text
 * is not one VibORM wrote for that index (an index renamed by hand keeps a
 * marker naming its old name, and is no longer the declared one).
 */
export function readRawIndexMarker(
  text: string,
  name: string
): IndexDef | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (keys.join() !== "columns,name,raw") return undefined;
  const { columns, raw } = value;
  if (
    value.name !== name ||
    !isSha256(raw) ||
    !Array.isArray(columns) ||
    columns.length === 0 ||
    !columns.every((column) => isString(column) && column !== "")
  )
    return undefined;
  return {
    name,
    columns: [...columns],
    unique: false,
    raw: { hash: raw },
  };
}
