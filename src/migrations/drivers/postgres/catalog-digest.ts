/**
 * Plan D5 (decision 7): the live managed schema's fingerprint, computed by
 * PostgreSQL in ONE statement instead of the namespace proof and the eight
 * catalog reads a full introspection sends.
 *
 * The digest is `fingerprintLive(introspectManaged(…))` reproduced, not
 * approximated. It reads the introspection's own catalog sources (their text
 * is shared with `introspect.ts`, never copied) and hashes the projection
 * `fingerprintSnapshot` hashes: `formatColumnType`, `cleanDefault` and
 * `normalizeDefault`, `normalizeType`, `canonicalUniqueEntities`, the
 * managed-table list `selectManagedSnapshot` applies (its tables and the
 * enums they use), the control tables left out, RFC 8785 bytes, the
 * snapshot hash domain.
 *
 * Where reproducing a fact exactly would need more than SQL can say, the
 * statement answers NULL instead of a digest, and the caller introspects as
 * before. That is every case the introspection or the managed-table list
 * refuses (its refusal is then raised with its own message), and:
 * - a partial index, whose predicate `fingerprintLive` canonicalizes through
 *   a scratch view, which one SELECT cannot create — unless the caller asks
 *   for predicates as deparsed (`$6`): the digest is then
 *   `fingerprintSnapshot` of the introspection itself, each predicate as
 *   `pg_get_expr` spells it, which the no-op compares with the spelling the
 *   apply that wrote the marker recorded from its introspection;
 * - a default that is a temporal literal, a JSON literal other than `{}`,
 *   `[]`, `null`, `true` or `false`, an array literal other than `{}`, a
 *   `date_trunc(…)` clock, an exponent or more than 15 significant digits in
 *   a floating-point literal, or more than two layers of parentheses;
 * - a type spelled with quotes or non-ASCII characters;
 * - a projection holding a character at or above U+E000, where PostgreSQL's
 *   code-point order and JavaScript's UTF-16 order can disagree;
 * - a database whose encoding is not UTF-8;
 * - an index whose deparsed definition mentions NULLS NOT DISTINCT: one
 *   statement cannot name `indnullsnotdistinct`, absent before PostgreSQL 15,
 *   but through a whole-row read, which PlanetScale's Neki refuses.
 *
 * JavaScript's regular expressions are spelled for PostgreSQL's ARE in E''
 * strings, which mean the same thing whatever `standard_conforming_strings`
 * says. No expression here can raise: the statement runs inside the locked
 * migration transaction, where an error would abort it.
 */

import { arrayLiteralText } from "../../../adapters/databases/postgres/array-literal";
import type { AnyDriver } from "../../../drivers/driver";
import { boundNamespace } from "../../catalog-probes";
import { HASH_DOMAIN, isSha256, type Sha256 } from "../../identity";
import type { BoundMigrationDriver } from "..";
import {
  admittedExtensionTypes,
  COLUMNS_SOURCE,
  CROSS_SCHEMA_FOREIGN_KEYS_SOURCE,
  ENUMS_SOURCE,
  FOREIGN_KEYS_SOURCE,
  indexesSource,
  POSTGRES_MANAGED_TABLE_NAMES_SOURCE,
  PRIMARY_KEYS_SOURCE,
  UNIQUE_CONSTRAINTS_SOURCE,
} from "./introspect";

/** A regular expression or replacement as an E'' literal. */
const re = (text: string): string =>
  `E'${text.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;

/** JavaScript's `\s`, which is also what `String#trim` removes. */
const WS =
  "[\\t\\n\\v\\f\\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]";

const trim = (value: string): string =>
  `regexp_replace(${value}, ${re(`^${WS}+|${WS}+$`)}, '', 'g')`;

/** `normalizeType`'s rewrites, in its order. */
const TYPE_REWRITES: readonly (readonly [string, string])[] = [
  [`${WS}+`, " "],
  [`${WS}*,${WS}*`, ","],
  [String.raw`${WS}+\[\]`, "[]"],
  [String.raw`\ycharacter varying\y`, "varchar"],
  [String.raw`\ycharacter\y`, "char"],
  [String.raw`\ybit varying\y`, "varbit"],
  [
    String.raw`\ytimestamptz(\([0-9]+\))?`,
    String.raw`timestamp\1 with time zone`,
  ],
  [String.raw`\ytimetz(\([0-9]+\))?`, String.raw`time\1 with time zone`],
  [
    String.raw`\y(timestamp|time)(\([0-9]+\))? without time zone`,
    String.raw`\1\2`,
  ],
  [String.raw`\yint4\y`, "integer"],
  [String.raw`\yint8\y`, "bigint"],
  [String.raw`\yint2\y`, "smallint"],
  [String.raw`\yfloat4\y`, "real"],
  [String.raw`\yfloat8\y`, "double precision"],
  [String.raw`\ybool\y`, "boolean"],
];

/** `normalizeType` of a quote-free ASCII type. */
const normalizeType = (type: string): string =>
  TYPE_REWRITES.reduce(
    (text, [pattern, replacement]) =>
      `regexp_replace(${text}, ${re(pattern)}, ${re(replacement)}, 'g')`,
    `lower(${trim(type)} COLLATE "C")`
  );

const IDENTIFIER = `(?:"(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z0-9_$]*)`;
/** `TYPE_CAST_REGEX` of `introspect.ts`. */
const TERMINAL_CAST = String.raw`::${IDENTIFIER}(?:\.${IDENTIFIER})?(?:${WS}+(?:varying|precision|with time zone|without time zone))?(?:\([0-9]+(?:,${WS}*[0-9]+)?\))?(?:\[\])?$`;
/** Quoted literals, blanked before parentheses are counted. */
const LITERALS = `'(?:[^']|'')*'|"(?:[^"]|"")*"`;
const UTC_NOW = String.raw`^(?:now\(\) at time zone 'utc'|timezone\(${WS}*'utc'${WS}*,${WS}*now\(\)${WS}*\))$`;
const UTC_CURRENT_TIME = String.raw`^timezone\(${WS}*'utc'${WS}*,${WS}*current_time(?:\(3\))?${WS}*\)$`;
const NUMBER_LITERAL = String.raw`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?$`;
/** Characters whose order differs between code points and UTF-16 units. */
const BEYOND_ORDER = "[\ue000-\\U0010FFFF]";

const quoted = (value: string): string =>
  `(left(${value}, 1) = '''' AND right(${value}, 1) = '''')`;
/** `value.slice(1, -1)`, never a negative length. */
const inner = (value: string): string =>
  `CASE WHEN length(${value}) >= 2 THEN substr(${value}, 2, length(${value}) - 2) ELSE '' END`;

/**
 * One turn of `stripDefaultParentheses`: the outer pair goes when it encloses
 * the whole value outside quoted literals. Its parentheses are reduced pair by
 * pair; eight passes settle any nesting up to eight deep, and a deeper one is
 * NULL rather than guessed.
 */
function stripParentheses(value: string): string {
  let pairs = `regexp_replace(${inner(`regexp_replace(${value}, ${re(LITERALS)}, 'q', 'g')`)}, '[^()]', '', 'g')`;
  for (let pass = 0; pass < 8; pass += 1) {
    pairs = `replace(${pairs}, '()', '')`;
  }
  return `(SELECT CASE WHEN ${value} IS NULL OR NOT (left(${value}, 1) = '(' AND right(${value}, 1) = ')') THEN ${value} WHEN reduced = '' THEN ${trim(inner(value))} WHEN reduced ~ ${re(String.raw`^\)*\(*$`)} THEN ${value} END FROM (SELECT ${pairs} AS reduced OFFSET 0) parentheses)`;
}

/** `String(Number(literal))` for a decimal literal JavaScript prints in full. */
const FLOAT_TEXT = `(SELECT CASE
  WHEN digits IS NULL THEN NULL
  WHEN whole = '' AND fraction = '' THEN '0'
  WHEN length(whole) <= 21 AND length(rtrim(ltrim(whole || fraction, '0'), '0')) <= 15 AND (whole <> '' OR length(fraction) - length(ltrim(fraction, '0')) <= 5)
    THEN CASE WHEN digits[1] = '-' THEN '-' ELSE '' END || coalesce(nullif(whole, ''), '0') || CASE WHEN fraction = '' THEN '' ELSE '.' || fraction END
END FROM (SELECT digits, ltrim(digits[2], '0') AS whole, rtrim(coalesce(digits[3], ''), '0') AS fraction FROM (SELECT regexp_match(unquoted, ${re(String.raw`^([+-]?)([0-9]*)(?:\.([0-9]*))?$`)}) AS digits) parsed) parts)`;

/** `BigInt(literal).toString()`. */
const INTEGER_TEXT = `(SELECT CASE WHEN digits[1] = '-' AND digits[2] <> '0' THEN '-' || digits[2] ELSE digits[2] END FROM (SELECT regexp_match(unquoted, '^([-+]?)0*([0-9]+)$') AS digits) parsed)`;

/** `normalizeDefault`, as the JSON text of its answer; NULL where it abstains. */
const DEFAULT_JSON = `CASE
  WHEN spelling IS NULL OR strpos(spelling, chr(8490)) > 0 THEN NULL
  WHEN normalized = 'null' THEN 'null'
  WHEN clock ~ ${re(UTC_NOW)} THEN to_json('now() at time zone ''utc'''::text)::text
  WHEN clock ~ '^date_trunc[(]' THEN NULL
  WHEN clock ~ ${re(UTC_CURRENT_TIME)} THEN to_json(CASE WHEN strpos(clock, 'current_time(3)') > 0 THEN 'timezone(''utc'',current_time(3))' ELSE 'timezone(''utc'',current_time)' END)::text
  WHEN normalized IN ('current_timestamp', 'now()') THEN '"now()"'
  WHEN ntype = 'boolean' AND normalized IN ('true', '''t''', '1') THEN '"true"'
  WHEN ntype = 'boolean' AND normalized IN ('false', '''f''', '0') THEN '"false"'
  WHEN normalized ~ ${re(String.raw`^[a-z_][a-z0-9_]*\(\)$`)} THEN to_json(normalized)::text
  WHEN ${quoted("spelling")} AND right(ntype, 2) = '[]' THEN CASE WHEN literal = '{}' THEN '"[]"' END
  WHEN ${quoted("spelling")} AND ntype IN ('json', 'jsonb') THEN CASE WHEN literal IN ('{}', '[]', 'null', 'true', 'false') THEN to_json(literal)::text END
  WHEN ntype ~ '^(integer|bigint|smallint|real|double precision|float|int|tinyint)' AND unquoted ~ ${re(NUMBER_LITERAL)}
    THEN to_json(CASE WHEN ntype ~ '^(integer|bigint|smallint|int|tinyint)' AND unquoted ~ '^[-+]?[0-9]+$' THEN ${INTEGER_TEXT} ELSE ${FLOAT_TEXT} END)::text
  WHEN ntype ~ '^(timestamp|time|date)' AND ${quoted("spelling")} THEN NULL
  ELSE to_json(spelling)::text
END`;

const SQL = `WITH
tbl AS (${POSTGRES_MANAGED_TABLE_NAMES_SOURCE}),
col AS (${COLUMNS_SOURCE}),
pk AS (${PRIMARY_KEYS_SOURCE}),
idx AS (${indexesSource("strpos(pg_catalog.pg_get_indexdef(ix.indexrelid), ' NULLS NOT DISTINCT') > 0")}),
fk AS (${FOREIGN_KEYS_SOURCE}),
xfk AS (${CROSS_SCHEMA_FOREIGN_KEYS_SOURCE}),
uq AS (${UNIQUE_CONSTRAINTS_SOURCE}),
en AS (${ENUMS_SOURCE}),
scope AS (
  SELECT table_name::text AS table_name,
    ($4::text[] IS NULL OR table_name::text = ANY ($4::text[])) AS selected,
    table_name::text NOT IN ($2::text, $3::text) AS kept,
    (relation_kind = 'p' OR is_partition) AS partitioned
  FROM tbl
),
columns AS (
  SELECT s.table_name, s.selected, s.kept, c.column_name::text AS name,
    coalesce(c.generated_kind::text, '') <> '' AS generated,
    t.type, nt.ntype, dd.valid AS decimal_valid,
    '{"autoIncrement":' || (coalesce(c.column_default, '') <> '' AND (strpos(c.column_default, 'nextval(') > 0 OR strpos(c.column_default, '_seq''::regclass)') > 0))::text
      || ',"default":' || CASE WHEN NOT s.selected OR coalesce(c.column_default, '') = '' OR strpos(c.column_default, 'nextval(') > 0 OR strpos(c.column_default, '_seq''::regclass)') > 0 THEN 'null' ELSE f.json END
      || ',"name":' || to_json(c.column_name::text)::text
      || ',"nullable":' || (c.is_nullable = 'YES')::text
      || ',"type":' || to_json(nt.ntype)::text || '}' AS json
  FROM col c
  JOIN scope s ON s.table_name = c.table_name::text
  CROSS JOIN LATERAL (SELECT c.udt_name::text AS udt, CASE WHEN left(c.udt_name::text, 1) = '_' THEN substr(c.udt_name::text, 2) ELSE c.udt_name::text END AS base OFFSET 0) b
  CROSS JOIN LATERAL (SELECT CASE
    WHEN NOT s.selected THEN CASE WHEN left(b.udt, 1) = '_' THEN b.base || '[]' ELSE b.udt END
    WHEN c.type_extension = 'postgis' AND b.base IN ('geometry', 'geography') AND NOT b.base = ANY ($5::text[]) THEN NULL
    WHEN c.type_extension IS NOT NULL AND c.type_extension_schema IS NOT NULL AND b.base = ANY ($5::text[]) THEN CASE
      WHEN starts_with(c.formatted_type, c.type_extension_schema::text || '.') THEN substr(c.formatted_type, length(c.type_extension_schema::text) + 2)
      WHEN starts_with(c.formatted_type, '"' || replace(c.type_extension_schema::text, '"', '""') || '".') THEN substr(c.formatted_type, length(replace(c.type_extension_schema::text, '"', '""')) + 4)
      ELSE c.formatted_type END
    WHEN c.type_extension IS NULL AND c.udt_schema::text <> $1::text AND c.udt_schema::text NOT IN ('pg_catalog', 'information_schema') THEN NULL
    WHEN c.udt_schema::text IN ('pg_catalog', 'information_schema') THEN c.formatted_type
    ELSE CASE WHEN left(b.udt, 1) = '_' THEN b.base || '[]' ELSE b.base END
  END AS type OFFSET 0) t
  CROSS JOIN LATERAL (SELECT CASE WHEN t.type ~ '[''"]' OR octet_length(t.type) <> length(t.type) THEN NULL ELSE ${normalizeType("t.type")} END AS ntype OFFSET 0) nt
  CROSS JOIN LATERAL (SELECT precision, scale, precision IS NULL OR (precision > 0 AND scale >= 0 AND scale <= precision AND precision <= 1000 AND scale <= 1000) AS valid FROM (SELECT
    CASE WHEN c.data_type = 'numeric' AND c.numeric_precision IS NOT NULL THEN c.numeric_precision::numeric WHEN b.udt = '_numeric' THEN m[1]::numeric END AS precision,
    CASE WHEN c.data_type = 'numeric' AND c.numeric_precision IS NOT NULL THEN coalesce(c.numeric_scale, 0)::numeric WHEN b.udt = '_numeric' THEN m[2]::numeric END AS scale
    FROM (SELECT regexp_match(c.formatted_type, ${re(String.raw`^numeric\((-?[0-9]+),(-?[0-9]+)\)\[\]$`)}) AS m) typmod) domain OFFSET 0) dd
  LEFT JOIN LATERAL (
    SELECT left(c.column_default, length(c.column_default) - length(cast_text)) AS stripped
    FROM (SELECT '::' || q || n || a AS cast_text
      FROM (VALUES (''), ($1::text || '.'), ('"' || replace($1::text, '"', '""') || '".')) qualifiers(q),
        (VALUES (b.base), ('"' || replace(b.base, '"', '""') || '"')) names(n),
        (VALUES (''), ('[]')) arrays(a)) spellings
    WHERE c.udt_schema::text = $1::text AND b.base IN (SELECT enum_name::text FROM en) AND right(c.column_default, length(cast_text)) = cast_text
    ORDER BY length(cast_text) DESC LIMIT 1
  ) e ON true
  CROSS JOIN LATERAL (SELECT ${trim(`regexp_replace(coalesce(e.stripped, c.column_default), ${re(TERMINAL_CAST)}, '')`)} AS cleaned OFFSET 0) d
  CROSS JOIN LATERAL (SELECT CASE WHEN dd.precision IS NULL OR NOT dd.valid OR NOT u ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN d.cleaned ELSE (
    SELECT CASE WHEN dd.scale = 0 THEN CASE WHEN strpos(canonical, '.') = 0 THEN canonical ELSE left(canonical, strpos(canonical, '.') - 1) END
      WHEN strpos(canonical, '.') = 0 THEN canonical || '.' || repeat('0', dd.scale::int)
      WHEN length(canonical) >= strpos(canonical, '.') + dd.scale THEN canonical
      ELSE rpad(canonical, strpos(canonical, '.') + dd.scale::int, '0') END
    FROM (SELECT CASE WHEN whole = '0' AND fraction = '' THEN '0' ELSE CASE WHEN left(u, 1) = '-' THEN '-' ELSE '' END || whole || CASE WHEN fraction = '' THEN '' ELSE '.' || fraction END END AS canonical
      FROM (SELECT coalesce(nullif(ltrim(split_part(regexp_replace(u, '^[+-]', ''), '.', 1), '0'), ''), '0') AS whole, rtrim(split_part(regexp_replace(u, '^[+-]', ''), '.', 2), '0') AS fraction) parts) decimal_text
  ) END AS rendered FROM (SELECT CASE WHEN length(d.cleaned) > 1 AND ${quoted("d.cleaned")} THEN ${inner("d.cleaned")} ELSE d.cleaned END AS u) unquoted_decimal OFFSET 0) r
  CROSS JOIN LATERAL (SELECT ${trim("r.rendered")} AS layer0 OFFSET 0) p0
  CROSS JOIN LATERAL (SELECT ${stripParentheses("p0.layer0")} AS layer1 OFFSET 0) p1
  CROSS JOIN LATERAL (SELECT ${stripParentheses("p1.layer1")} AS layer2 OFFSET 0) p2
  CROSS JOIN LATERAL (SELECT CASE WHEN ${stripParentheses("p2.layer2")} IS NOT DISTINCT FROM p2.layer2 THEN p2.layer2 END AS spelling OFFSET 0) sp
  CROSS JOIN LATERAL (SELECT lower(spelling COLLATE "C") AS normalized,
    replace(replace(lower(spelling COLLATE "C"), '::text', ''), 'current_timestamp', 'now()') AS clock,
    replace(${inner("spelling")}, '''''', '''') AS literal,
    CASE WHEN ${quoted('lower(spelling COLLATE "C")')} THEN ${inner('lower(spelling COLLATE "C")')} ELSE lower(spelling COLLATE "C") END AS unquoted OFFSET 0) v
  CROSS JOIN LATERAL (SELECT ${DEFAULT_JSON} AS json OFFSET 0) f
),
indexes AS (
  SELECT s.table_name, s.selected, s.kept, i.index_name::text AS name,
    bool_and(i.is_valid) AS valid,
    bool_or(i.unsupported_structure IS DISTINCT FROM false) AS unsupported,
    min(i.index_type::text) AS method,
    bool_and(i.is_unique) AS is_unique,
    min(coalesce(i.filter_condition, '')) AS predicate,
    bool_or(i.column_name IS NULL) AS expression,
    '[' || string_agg(to_json(i.column_name::text)::text, ',' ORDER BY i.ordinal_position) || ']' AS columns
  FROM idx i JOIN scope s ON s.table_name = i.table_name::text
  GROUP BY s.table_name, s.selected, s.kept, i.index_name
),
kept_indexes AS (
  SELECT table_name, name, columns,
    is_unique AND predicate = '' AND method = 'btree' AS total_unique,
    '{"columns":' || columns || ',"name":' || to_json(name)::text || ',"type":' || to_json(method)::text || ',"unique":' || is_unique::text
      || ',"where":' || coalesce(to_json(nullif(${trim("predicate")}, ''))::text, 'null') || '}' AS json
  FROM indexes
  WHERE kept AND method IN ('btree', 'hash', 'gin', 'gist') AND NOT expression
),
pks AS (
  SELECT s.table_name, '{"columns":[' || string_agg(to_json(p.column_name::text)::text, ',' ORDER BY p.ordinal_position) || '],"name":' || to_json(min(p.constraint_name::text))::text || '}' AS json
  FROM pk p JOIN scope s ON s.table_name = p.table_name::text
  WHERE s.kept
  GROUP BY s.table_name
),
fks AS (
  SELECT s.table_name, '{"columns":[' || string_agg(to_json(f.column_name::text)::text, ',' ORDER BY f.ordinal_position)
    || '],"name":' || to_json(f.constraint_name::text)::text
    || ',"onDelete":"' || ${referentialAction("min(f.delete_rule::text)")}
    || '","onUpdate":"' || ${referentialAction("min(f.update_rule::text)")}
    || '","referencedColumns":[' || string_agg(to_json(f.foreign_column_name::text)::text, ',' ORDER BY f.ordinal_position)
    || '],"referencedTable":' || to_json(min(f.foreign_table_name::text))::text || '}' AS json
  FROM fk f JOIN scope s ON s.table_name = f.table_name::text
  WHERE s.kept
  GROUP BY s.table_name, f.constraint_name
),
uqs AS (
  SELECT s.table_name, '{"columns":[' || string_agg(to_json(u.column_name::text)::text, ',' ORDER BY u.ordinal_position) || '],"name":' || to_json(u.constraint_name::text)::text || '}' AS json
  FROM uq u JOIN scope s ON s.table_name = u.table_name::text
  WHERE s.kept
  GROUP BY s.table_name, u.constraint_name
  UNION ALL
  SELECT table_name, '{"columns":' || columns || ',"name":' || to_json(name)::text || '}'
  FROM kept_indexes WHERE total_unique
),
tables AS (
  SELECT s.table_name,
    '{"columns":[' || coalesce((SELECT string_agg(c.json, ',' ORDER BY c.name COLLATE "C") FROM columns c WHERE c.table_name = s.table_name), '')
    || '],"foreignKeys":[' || coalesce((SELECT string_agg(f.json, ',' ORDER BY f.json COLLATE "C") FROM fks f WHERE f.table_name = s.table_name), '')
    || '],"indexes":[' || coalesce((SELECT string_agg(i.json, ',' ORDER BY i.name COLLATE "C") FROM kept_indexes i WHERE i.table_name = s.table_name AND NOT i.total_unique), '')
    || '],"name":' || to_json(s.table_name)::text
    || ',"primaryKey":' || coalesce((SELECT p.json FROM pks p WHERE p.table_name = s.table_name), 'null')
    || ',"uniqueConstraints":[' || coalesce((SELECT string_agg(u.json, ',' ORDER BY u.json COLLATE "C") FROM uqs u WHERE u.table_name = s.table_name), '')
    || ']}' AS json
  FROM scope s
  WHERE s.kept AND s.selected
),
enums AS (
  SELECT enum_name::text AS name, '{"name":' || to_json(enum_name::text)::text || ',"values":[' || string_agg(to_json(enum_value::text)::text, ',' ORDER BY sort_order) || ']}' AS json
  FROM en
  WHERE $4::text[] IS NULL OR enum_name::text IN (SELECT ${elementType("c.type")} FROM columns c WHERE c.selected OR NOT c.kept)
  GROUP BY enum_name
),
projection AS (
  SELECT '{"enums":[' || coalesce((SELECT string_agg(json, ',' ORDER BY name COLLATE "C") FROM enums), '')
    || '],"tables":[' || coalesce((SELECT string_agg(json, ',' ORDER BY table_name COLLATE "C") FROM tables), '') || ']}' AS json
)
SELECT CASE WHEN
  EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1::text)
  AND pg_catalog.getdatabaseencoding() = 'UTF8'
  AND NOT EXISTS (SELECT 1 FROM scope WHERE selected AND partitioned)
  AND NOT EXISTS (SELECT 1 FROM columns WHERE selected AND (generated OR type IS NULL OR NOT decimal_valid OR (kept AND json IS NULL)))
  AND NOT EXISTS (SELECT 1 FROM indexes WHERE selected AND (NOT valid OR unsupported OR method NOT IN ('btree', 'hash', 'gin', 'gist') OR (kept AND NOT expression AND predicate <> '' AND NOT $6::boolean)))
  AND NOT EXISTS (SELECT 1 FROM fk WHERE $4::text[] IS NOT NULL AND ${managedOrControl("fk.table_name")} <> ${managedOrControl("fk.foreign_table_name")})
  AND NOT EXISTS (SELECT 1 FROM columns c WHERE NOT c.selected AND c.kept AND ${elementType("c.type")} IN (SELECT name FROM enums))
  AND NOT EXISTS (SELECT 1 FROM xfk WHERE $4::text[] IS NULL OR (owning_schema::text = $1::text AND owning_table::text = ANY ($4::text[])) OR (referenced_schema::text = $1::text AND referenced_table::text = ANY ($4::text[])))
  AND NOT projection.json ~ ${re(BEYOND_ORDER)}
THEN encode(sha256(convert_to('${HASH_DOMAIN.snapshot}', 'UTF8') || decode('00', 'hex') || convert_to(projection.json, 'UTF8')), 'hex') END AS digest
FROM projection`;

/** A column type without its `[]`, as the managed-table selection reads it. */
function elementType(type: string): string {
  return `regexp_replace(${type}, ${re(String.raw`\[\]$`)}, '')`;
}

/** Whether a table is selected by the managed-table list, or a control table. */
function managedOrControl(table: string): string {
  return `(${table}::text = ANY ($4::text[]) OR ${table}::text IN ($2::text, $3::text))`;
}

function referentialAction(rule: string): string {
  return `CASE ${rule} WHEN 'CASCADE' THEN 'cascade' WHEN 'SET NULL' THEN 'setNull' WHEN 'RESTRICT' THEN 'restrict' WHEN 'SET DEFAULT' THEN 'setDefault' ELSE 'noAction' END`;
}

/** The two control tables the fingerprint leaves out. */
export interface ControlTableNames {
  readonly state: string;
  readonly log: string;
}

/**
 * The statement and its parameters, for a caller that embeds it in a
 * statement of its own: `$1` is the namespace and `$2`, `$3` the state and log
 * control tables, as in the control catalog read; `$4` to `$6` are its own.
 * `deparsedPredicates` hashes each partial-index predicate as the server
 * deparses it instead of abstaining (see the header).
 */
export function postgresCatalogDigestQuery(
  driver: BoundMigrationDriver,
  control: ControlTableNames,
  deparsedPredicates = false
): {
  readonly sql: string;
  readonly parameters: unknown[];
} {
  const tables = driver.target.tables;
  return {
    sql: SQL,
    parameters: [
      boundNamespace(driver),
      control.state,
      control.log,
      tables === undefined ? null : arrayLiteralText(tables),
      arrayLiteralText([...admittedExtensionTypes(driver.executionDriver)]),
      deparsedPredicates,
    ],
  };
}

/**
 * The live managed schema's fingerprint, read in one statement; `undefined`
 * where the digest abstains and the caller must introspect.
 */
export async function postgresCatalogDigest(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  control: ControlTableNames
): Promise<Sha256 | undefined> {
  const { sql, parameters } = postgresCatalogDigestQuery(driver, control);
  const result = await producer._executeRaw<{ digest: unknown }>(
    sql,
    parameters
  );
  return readDigest(result.rows[0]?.digest);
}

/** A digest the statement answered, or `undefined` for an abstention. */
export function readDigest(value: unknown): Sha256 | undefined {
  return isSha256(value) ? value : undefined;
}
