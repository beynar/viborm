/**
 * The three questions an EXISTING text column has to answer before it can
 * become an identifier column — asked as SQL, against the live database, by
 * the person doing the conversion.
 *
 * VibORM does not convert a populated text column on its own: the generated
 * `alterColumn` into a binary column is refused outright
 * ({@link file://./binary-conversion.ts}), and PostgreSQL's one automated leg,
 * `text` → `uuid`, is a per-value cast that either succeeds for the whole table
 * or aborts it. Both routes leave the same work to the author, and this module
 * is the part of that work a machine can state exactly:
 *
 *  1. **Every row is a value of the domain.** Prefix matched whole, payload in
 *     the format's own grammar and width. A row that is not is a row no route
 *     can carry.
 *  2. **No two rows fold together.** `uuid` admits uppercase and `ulid`
 *     lowercase as ALIASES, so a text column may hold two spellings of one
 *     identifier. Compact storage holds the canonical one, so those two rows
 *     become one value — violating a unique key, or silently merging two rows
 *     where there is none. `ksuid` has no aliases and gets no such check.
 *  3. **Every foreign key still finds its parent after the fold.** The FK
 *     column converts with its own normalization, so agreement has to be proven
 *     against the NORMALIZED sets rather than the stored text.
 *
 * Each check is one row and one boolean column, so each is exactly a
 * {@link MigrationCheckInput} — the `trusted-read` shape `generate()` already
 * accepts as `originChecks` on a manual transition. Run them by hand, or put
 * them in front of your own conversion migration; they are the same SQL either
 * way.
 *
 * Pure and connection-free, like every other module in this layer: it renders
 * SQL, it never executes it.
 *
 * What it does NOT cover, deliberately: a junction table's own columns and a
 * polymorphic row carrier's id column. Those hold a key's values too and
 * convert by the same recipe, but they are private storage with no (model,
 * field) to name them by, so the migration guide lists them rather than this
 * module guessing at them.
 */

import { type Sql, sql } from "@sql";
import { MigrationError, VibORMErrorCode } from "../errors";
import { type AnyModel, getColumnName, getTableName } from "../schema/model";
import { idDomainOf } from "../schema/validation/id-domains";
import {
  type ResolvedRelationIndex,
  resolvedEdges,
} from "../schema/validation/relation-resolution";
import { createIdentifierQuoter } from "../sql/identifiers";
import {
  type IdDomain,
  isCompactIdFormat,
} from "../validation/primitives/id-codec";
import type { Dialect } from "./drivers/types";
import type { MigrationCheckInput } from "./v1-types";

/** The key whose text column is being converted, and the schema it lives in. */
export interface IdentifierConversionRequest {
  readonly model: AnyModel;
  readonly field: string;
  readonly dialect: Dialect;
  /** The resolved index, which is where a foreign key's domain is derived. */
  readonly index: ResolvedRelationIndex;
  /** PostgreSQL's target namespace, when the estate is bound to one. */
  readonly namespace?: string | undefined;
}

/** One character class, spelled once for both pattern languages. */
const HEX = "[0-9a-fA-F]";
const CROCKFORD = "[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]";
const BASE62 = "[0-9A-Za-z]";

/** The payload grammar of each compact format, as a regex and as a GLOB. */
const PATTERNS = {
  uuid: {
    length: 36,
    regex: `^${HEX}{8}-${HEX}{4}-${HEX}{4}-${HEX}{4}-${HEX}{12}$`,
    glob: `${HEX.repeat(8)}-${HEX.repeat(4)}-${HEX.repeat(4)}-${HEX.repeat(4)}-${HEX.repeat(12)}`,
    fold: "lower",
  },
  ulid: {
    length: 26,
    regex: `^[0-7]${CROCKFORD}{25}$`,
    glob: `[0-7]${CROCKFORD.repeat(25)}`,
    fold: "upper",
  },
  ksuid: {
    length: 27,
    regex: `^${BASE62}{27}$`,
    glob: BASE62.repeat(27),
    fold: undefined,
  },
} as const;

/** `uuidv7` shares a uuid's grammar: the version nibble is not a storage fact. */
function patternOf(domain: IdDomain) {
  if (domain.format === "ulid") return PATTERNS.ulid;
  if (domain.format === "ksuid") return PATTERNS.ksuid;
  return PATTERNS.uuid;
}

/** A literal integer: a width, never caller text, so it is text and not a bind. */
const int = (value: number): Sql => sql.raw(String(value));

/** One quoted, optionally qualified table name, bound to a one-letter alias. */
function fromSql(
  model: AnyModel,
  dialect: Dialect,
  namespace: string | undefined,
  alias: string
): Sql {
  const quote = createIdentifierQuoter(dialect === "mysql" ? "`" : '"');
  const qualifier =
    dialect === "postgresql" && namespace ? `${quote(namespace)}.` : "";
  return sql.raw(`${qualifier + quote(getTableName(model))} AS ${alias}`);
}

/**
 * One column, always written through its table's alias.
 *
 * The FK checks correlate two tables, and a one-to-one child whose primary key
 * IS its foreign key names both columns `id` — an unqualified reference there
 * binds to the inner table and compares a value with itself.
 */
function columnSql(
  model: AnyModel,
  field: string,
  dialect: Dialect,
  alias: string
): Sql {
  const quote = createIdentifierQuoter(dialect === "mysql" ? "`" : '"');
  return sql.raw(`${alias}.${quote(getColumnName(model, field))}`);
}

/** The payload of a stored value: the whole column, or what follows the prefix. */
function payloadSql(column: Sql, domain: IdDomain): Sql {
  const prefix = domain.prefix;
  if (!prefix) return column;
  return sql`substr(${column}, ${int(prefix.length + 2)})`;
}

/** Whether one stored value is a value of the domain. */
function admitsSql(column: Sql, domain: IdDomain, dialect: Dialect): Sql {
  const pattern = patternOf(domain);
  const payload = payloadSql(column, domain);
  const matches =
    dialect === "postgresql"
      ? sql`${payload} ~ ${pattern.regex}`
      : dialect === "mysql"
        ? sql`${payload} REGEXP ${pattern.regex}`
        : sql`${payload} GLOB ${pattern.glob}`;
  const width = sql.raw(dialect === "mysql" ? "CHAR_LENGTH" : "length");
  const sized = sql`${width}(${payload}) = ${int(pattern.length)} AND ${matches}`;
  const prefix = domain.prefix;
  if (!prefix) return sized;
  return sql`substr(${column}, 1, ${int(prefix.length + 1)}) = ${`${prefix}-`} AND ${sized}`;
}

/** The canonical spelling of one stored value, for a format that has aliases. */
function foldSql(column: Sql, domain: IdDomain): Sql {
  const fold = patternOf(domain).fold;
  const payload = payloadSql(column, domain);
  return fold === undefined ? payload : sql`${sql.raw(fold)}(${payload})`;
}

/** `SELECT NOT EXISTS (…)`, the shape every row check takes. */
const noRowWhere = (from: Sql, predicate: Sql): MigrationCheckInput => ({
  kind: "trusted-read",
  query: sql`SELECT NOT EXISTS (SELECT 1 FROM ${from} WHERE ${predicate}) AS ok`,
  equals: true,
});

/** Every foreign-key column that holds this key's values. */
function referencingColumns(
  request: IdentifierConversionRequest
): { model: AnyModel; field: string }[] {
  const columns: { model: AnyModel; field: string }[] = [];
  for (const edge of resolvedEdges(request.index)) {
    if (edge.kind !== "foreignKey") continue;
    const other =
      edge.endpoints[0] === edge.owner ? edge.endpoints[1] : edge.endpoints[0];
    if (other.source !== request.model) continue;
    for (const member of edge.reference.members) {
      if (member.referencedField !== request.field) continue;
      columns.push({ model: edge.owner.source, field: member.foreignField });
    }
  }
  return columns;
}

/**
 * The pre-checks for converting one key's text column into its identifier
 * column, in the order a conversion needs them.
 *
 * Refuses a field with no compactly stored identifier domain rather than
 * answering with an empty list: an empty list reads as "this estate is ready",
 * and that is the one answer a caller who named the wrong field must not get.
 */
export function identifierConversionChecks(
  request: IdentifierConversionRequest
): readonly MigrationCheckInput[] {
  const { model, field, dialect, namespace } = request;
  const domain = idDomainOf(model, field, request.index);
  if (domain === undefined || !isCompactIdFormat(domain.format)) {
    throw new MigrationError(
      `'${getTableName(model)}.${getColumnName(model, field)}' has no compactly stored identifier domain, so it has no text conversion to check: only uuid, uuidv7, ulid and ksuid change storage.`,
      VibORMErrorCode.INVALID_INPUT
    );
  }
  const parent = fromSql(model, dialect, namespace, "p");
  const key = columnSql(model, field, dialect, "p");
  const checks: MigrationCheckInput[] = [
    noRowWhere(
      parent,
      sql`${key} IS NOT NULL AND NOT (${admitsSql(key, domain, dialect)})`
    ),
  ];
  if (patternOf(domain).fold !== undefined) {
    checks.push({
      kind: "trusted-read",
      query: sql`SELECT COUNT(${key}) = COUNT(DISTINCT ${foldSql(key, domain)}) AS ok FROM ${parent}`,
      equals: true,
    });
  }
  for (const reference of referencingColumns(request)) {
    const child = fromSql(reference.model, dialect, namespace, "c");
    const fk = columnSql(reference.model, reference.field, dialect, "c");
    checks.push(
      noRowWhere(
        child,
        sql`${fk} IS NOT NULL AND NOT (${admitsSql(fk, domain, dialect)})`
      ),
      noRowWhere(
        child,
        sql`${fk} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${parent} WHERE ${foldSql(key, domain)} = ${foldSql(fk, domain)})`
      )
    );
  }
  return checks;
}

// =============================================================================
// THE ONE AUTOMATED LEG
// =============================================================================

/** The text column spellings PostgreSQL can hold an identifier in. */
const PG_TEXT_COLUMN = /^(?:text|citext|varchar\(\d+\)|character varying.*)$/i;

/** A SQL string literal: the only escape a quoted name needs inside one. */
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/**
 * The message PostgreSQL's own `col::uuid` does not give.
 *
 * `ALTER COLUMN … TYPE uuid USING col::uuid` converts value by value: it
 * succeeds for an estate of canonical uuids and raises
 * `invalid input syntax for type uuid: "…"` on the first row that is not one,
 * aborting the transaction and leaving the column as it was. The outcome is
 * right; the message names one offending row and nothing about the choice the
 * author actually has. This runs FIRST, inside the same transaction, and says
 * how many rows are in the way and what the two routes are.
 *
 * A PREFIXED domain fails here too, and deliberately: `usr-a0ee…` is not uuid
 * text, and no `USING substring(col from 5)::uuid` is emitted for it, because
 * the snapshot carries the column TYPE and not the domain — the prefix is a
 * fact of the declaration that no migration artifact has ever held. Converting
 * a prefixed column is a manual route, and this says so before anything runs.
 *
 * It is not a second refusal: without it the conversion fails anyway. Its whole
 * and only coverage is the message.
 */
export function postgresTextToUuidGuard(
  qualifiedTable: string,
  quotedColumn: string
): string {
  const marker = `${qualifiedTable}.${quotedColumn}`;
  return (
    "DO $viborm$ DECLARE invalid bigint; BEGIN " +
    `SELECT count(*) INTO invalid FROM ${qualifiedTable} WHERE ${quotedColumn} IS NOT NULL AND ${quotedColumn} !~ ${literal(PATTERNS.uuid.regex)}; ` +
    "IF invalid > 0 THEN RAISE EXCEPTION " +
    `${literal(`VibORM: % row(s) of ${marker} are not canonical uuid text, so this conversion would abort on them. A prefixed identifier is one of the shapes that fails here: only the payload is stored, and no generated statement strips a prefix. Convert the rows yourself — add the uuid column, write the payloads into it, drop the old column and rename — or keep the column as it is with a text-family native type, which validates the domain without changing storage.`)}, invalid; ` +
    "END IF; END $viborm$"
  );
}

/** Whether this alteration is the one text→identifier conversion pg performs. */
export function isPostgresTextToUuid(
  fromType: string,
  toType: string
): boolean {
  return (
    toType.toLowerCase() === "uuid" && PG_TEXT_COLUMN.test(fromType.trim())
  );
}
