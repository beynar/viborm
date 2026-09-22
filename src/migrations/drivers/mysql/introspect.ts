/**
 * MySQL Schema Introspection
 *
 * Reads the current database schema from MySQL's information_schema,
 * returning a normalized SchemaSnapshot.
 */

import type { DecimalDescriptor } from "@validation/primitives/decimal-codec";
import { MigrationError, VibORMErrorCode } from "../../../errors";
import {
  readMysqlDecimalListMarker,
  readStoredDecimalDescriptor,
} from "../../decimal";
import { decodeUtf8 } from "../../identity";
import type {
  ColumnDef,
  EnumDef,
  ForeignKeyDef,
  IndexDef,
  PrimaryKeyDef,
  ReferentialAction,
  SchemaSnapshot,
  TableDef,
  UniqueConstraintDef,
} from "../../types";
import {
  MYSQL_LITERAL_ESCAPES,
  mysqlEnumType,
  mysqlStringLiteral,
} from "../type-mapping";
import { groupBy, groupByNested } from "../utils";
import { type CatalogReader, resolveCatalogNamespace } from "./catalog";
import type {
  MySQLColumn,
  MySQLForeignKey,
  MySQLIndex,
  MySQLPrimaryKey,
  MySQLTable,
} from "./types";

// =============================================================================
// SQL QUERIES
// =============================================================================

// Every filter below binds the resolved database as DATA (§5.2). The name is
// never spliced into the statement, and `DATABASE()` — the connection's ambient
// default, which the ORM never configured — appears nowhere.
const TABLES_QUERY = `
SELECT TABLE_NAME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = ?
  AND TABLE_TYPE = 'BASE TABLE'
ORDER BY TABLE_NAME
`;

const COLUMNS_QUERY = `
SELECT
  TABLE_NAME,
  COLUMN_NAME,
  DATA_TYPE,
  COLUMN_TYPE,
  IS_NULLABLE,
  COLUMN_DEFAULT,
  CHARACTER_MAXIMUM_LENGTH,
  NUMERIC_PRECISION,
  NUMERIC_SCALE,
  SRS_ID,
  EXTRA,
  COLUMN_COMMENT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ?
ORDER BY TABLE_NAME, ORDINAL_POSITION
`;

const PRIMARY_KEYS_QUERY = `
SELECT
  tc.TABLE_NAME,
  tc.CONSTRAINT_NAME,
  kcu.COLUMN_NAME,
  kcu.ORDINAL_POSITION
FROM information_schema.TABLE_CONSTRAINTS tc
JOIN information_schema.KEY_COLUMN_USAGE kcu
  ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
  AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
  AND tc.TABLE_NAME = kcu.TABLE_NAME
WHERE tc.TABLE_SCHEMA = ?
  AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
ORDER BY tc.TABLE_NAME, kcu.ORDINAL_POSITION
`;

const INDEXES_QUERY = `
SELECT
  TABLE_NAME,
  INDEX_NAME,
  COLUMN_NAME,
  NON_UNIQUE,
  INDEX_TYPE,
  SEQ_IN_INDEX
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = ?
  AND INDEX_NAME != 'PRIMARY'
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
`;

// Both endpoints are projected and BOTH are admitted as filter candidates
// (§5.2): a constraint that leaves the estate in either direction has to be
// visible here before it can be refused, and an inbound one is not reachable
// through the referencing side's schema at all.
const FOREIGN_KEYS_QUERY = `
SELECT
  tc.TABLE_SCHEMA,
  tc.TABLE_NAME,
  tc.CONSTRAINT_NAME,
  kcu.COLUMN_NAME,
  kcu.REFERENCED_TABLE_SCHEMA,
  kcu.REFERENCED_TABLE_NAME,
  kcu.REFERENCED_COLUMN_NAME,
  rc.DELETE_RULE,
  rc.UPDATE_RULE,
  kcu.ORDINAL_POSITION
FROM information_schema.TABLE_CONSTRAINTS tc
JOIN information_schema.KEY_COLUMN_USAGE kcu
  ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
  AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
  AND tc.TABLE_NAME = kcu.TABLE_NAME
JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
  ON rc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
  AND rc.CONSTRAINT_SCHEMA = tc.TABLE_SCHEMA
WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
  AND (tc.TABLE_SCHEMA = ? OR kcu.REFERENCED_TABLE_SCHEMA = ?)
ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
`;

// =============================================================================
// CONSTANTS
// =============================================================================

const ENUM_VALUES_REGEX = /enum\((.+)\)/i;

/**
 * The MySQL storage whose literal default the catalog already reports the way
 * the estate spells it: a number is a number, and a `BIT` default is reported
 * as its own `b'…'` literal. Every other type's literal default is a QUOTED
 * string in DDL, and `information_schema` reports it with the quotes gone.
 */
const MYSQL_NUMERIC_DATA_TYPES = new Set([
  "bigint",
  "bit",
  "decimal",
  "double",
  "float",
  "int",
  "integer",
  "mediumint",
  "numeric",
  "real",
  "smallint",
  "tinyint",
]);

/**
 * What MySQL's printer writes, read backwards: the WRITE table
 * (`mysqlStringLiteral`) inverted, plus the apostrophe, which MySQL prints as
 * `\'` although the DDL spelling doubles it instead. Every other character —
 * tab, backspace, `"` — is printed raw (measured on 8.4.11), so an escape
 * outside this table is one this inverse does not own.
 *
 * ONE table, both catalog vocabularies, because both are MySQL printing a
 * string literal it parsed: the expression default below, and an ENUM's members
 * inside `COLUMN_TYPE`. The enum printer writes a strict SUBSET of it (`\\`,
 * `\n`, `\r`, `\0`; it doubles `'` and prints ctrl-Z raw, measured), so reading
 * one table backwards covers both and leaves the same remainder unowned.
 */
const MYSQL_PRINTED_CHARACTERS: ReadonlyMap<string, string> = new Map([
  ["'", "'"],
  ...[...MYSQL_LITERAL_ESCAPES].map(
    ([character, sequence]) =>
      [sequence.slice(1), character] as [string, string]
  ),
]);

/**
 * Parse enum values from MySQL COLUMN_TYPE string, or `null` when the catalog
 * spelled one this inverse does not own.
 *
 * Handles values containing commas, doubled single quotes (''), and the
 * backslash escapes MySQL's printer writes (`MYSQL_PRINTED_CHARACTERS`).
 * Example: "enum('a,b','it''s','c')" -> ['a,b', "it's", 'c']
 * Example: String.raw`enum('a\\b','line1\nline2')` -> ["a\\b", "line1\nline2"]
 *
 * Reading `\x` as a bare `x` — which is what "skip the backslash" does — turned
 * the printed `\n` of a declared NEWLINE into the letter `n`, a value the
 * declaration never held. An escape outside the table is not one this server
 * printed for a member the estate spelled, so inverting it would be a guess:
 * the column keeps MySQL's own `COLUMN_TYPE` instead and the push fails at the
 * final attestation, the same fail-closed direction the string inverse takes.
 */
function parseEnumValues(columnType: string): string[] | null {
  const match = columnType.match(ENUM_VALUES_REGEX);
  if (!match?.[1]) return null;

  const content = match[1];
  const values: string[] = [];
  let i = 0;

  while (i < content.length) {
    // Skip whitespace and commas
    while (i < content.length && (content[i] === " " || content[i] === ",")) {
      i++;
    }
    if (i >= content.length) break;

    // Expect opening quote
    if (content[i] !== "'") {
      i++;
      continue;
    }
    i++; // Skip opening quote

    // Collect value until closing quote (handle escaped quotes '' and \')
    let value = "";
    while (i < content.length) {
      if (content[i] === "\\" && i + 1 < content.length) {
        // Backslash escape - the character MySQL's printer wrote it for
        const printed = MYSQL_PRINTED_CHARACTERS.get(content[i + 1] ?? "");
        if (printed === undefined) return null;
        value += printed;
        i += 2;
      } else if (content[i] === "'" && content[i + 1] === "'") {
        // Doubled quote escape - add single quote and skip both
        value += "'";
        i += 2;
      } else if (content[i] === "'") {
        // Closing quote
        i++;
        break;
      } else {
        value += content[i];
        i++;
      }
    }
    values.push(value);
  }

  return values.length > 0 ? values : null;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function mapReferentialAction(rule: string): ReferentialAction {
  switch (rule.toUpperCase()) {
    case "CASCADE":
      return "cascade";
    case "SET NULL":
      return "setNull";
    case "RESTRICT":
      return "restrict";
    case "SET DEFAULT":
      return "setDefault";
    default:
      return "noAction";
  }
}

function formatColumnType(col: MySQLColumn): string {
  if (col.DATA_TYPE.toLowerCase() === "point") {
    const srid = readSrid(col);
    return srid === undefined ? "POINT" : `POINT SRID ${srid}`;
  }

  // An ENUM's values ARE its type. `information_schema` prints its own
  // rendering of them — `enum('a','b')`, no space after the comma — so the
  // parsed values are re-spelled through the estate's ONE enum speller and the
  // two snapshots name one type. A COLUMN_TYPE that parses to no values at all
  // is not an enum MySQL could have created; it stays exactly as read.
  if (col.DATA_TYPE === "enum") {
    const values = parseEnumValues(col.COLUMN_TYPE);
    return values ? mysqlEnumType(values) : col.COLUMN_TYPE;
  }

  // For types with modifiers (unsigned, zerofill) or size info in COLUMN_TYPE,
  // prefer COLUMN_TYPE to preserve full type specification
  // Examples: "int unsigned", "bigint unsigned zerofill", "varbinary(255)", "bit(8)", "timestamp(6)"
  const columnType = col.COLUMN_TYPE.toLowerCase();
  const hasModifiers =
    columnType.includes("unsigned") ||
    columnType.includes("zerofill") ||
    // Has parentheses with size/precision info (but not enum which is handled above)
    (columnType.includes("(") && col.DATA_TYPE !== "enum");

  if (hasModifiers) {
    return col.COLUMN_TYPE;
  }

  // Fallback: construct from DATA_TYPE with precision info
  if (col.DATA_TYPE === "varchar" && col.CHARACTER_MAXIMUM_LENGTH) {
    return `VARCHAR(${col.CHARACTER_MAXIMUM_LENGTH})`;
  }
  if (col.DATA_TYPE === "char" && col.CHARACTER_MAXIMUM_LENGTH) {
    return `CHAR(${col.CHARACTER_MAXIMUM_LENGTH})`;
  }
  if (col.DATA_TYPE === "decimal" && col.NUMERIC_PRECISION) {
    if (col.NUMERIC_SCALE !== null && col.NUMERIC_SCALE !== undefined) {
      return `DECIMAL(${col.NUMERIC_PRECISION},${col.NUMERIC_SCALE})`;
    }
    return `DECIMAL(${col.NUMERIC_PRECISION})`;
  }

  return col.DATA_TYPE.toUpperCase();
}

function readSrid(col: MySQLColumn): number | undefined {
  if (col.SRS_ID === null || col.SRS_ID === undefined) return undefined;
  const value = Number(col.SRS_ID);
  if (Number.isSafeInteger(value) && value >= 0 && value <= 4_294_967_295) {
    return value;
  }
  throw new MigrationError(
    `MySQL reported an invalid SRID for column "${col.TABLE_NAME}"."${col.COLUMN_NAME}". Migration introspection is refused rather than publishing an unprovable spatial type.`,
    VibORMErrorCode.MIGRATION_INVALID_STATE,
    {
      meta: {
        dialect: "mysql",
        table: col.TABLE_NAME,
        column: col.COLUMN_NAME,
        type: "invalid-catalog-srid",
      },
    }
  );
}

function isAutoIncrement(extra: string): boolean {
  return extra.toLowerCase().includes("auto_increment");
}

/**
 * The declared decimal domain of a MySQL column, or `undefined`.
 *
 * Two carriers, because MySQL stores the two shapes differently. A scalar is
 * `DECIMAL(p,s)` and the catalog reports the pair directly. A list is `JSON`,
 * which carries nothing, so its domain lives in the deterministic column
 * comment — matched EXACTLY (§6.2): a comment that merely mentions a decimal is
 * a comment, not a descriptor, and reading one as a descriptor would attach a
 * domain to a column VibORM never declared one on.
 */
function readDecimalDomain(col: MySQLColumn): DecimalDescriptor | undefined {
  if (col.DATA_TYPE === "decimal" && col.NUMERIC_PRECISION !== null) {
    const descriptor = readStoredDecimalDescriptor(
      col.NUMERIC_PRECISION,
      col.NUMERIC_SCALE ?? 0,
      "mysql"
    );
    if (descriptor !== undefined) return descriptor;
    throw new MigrationError(
      `MySQL reported column "${col.TABLE_NAME}"."${col.COLUMN_NAME}" as DECIMAL(${String(col.NUMERIC_PRECISION)},${String(col.NUMERIC_SCALE ?? 0)}), outside VibORM's complete exact-decimal domain for this provider. Migration introspection is refused rather than publishing an invalid descriptor.`,
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      {
        meta: {
          dialect: "mysql",
          table: col.TABLE_NAME,
          column: col.COLUMN_NAME,
          type: "invalid-catalog-decimal-domain",
        },
      }
    );
  }
  if (col.DATA_TYPE !== "json") return undefined;
  return readMysqlDecimalListMarker(col.COLUMN_COMMENT);
}

/**
 * MySQL deparses an expression-backed string literal as `_charset\\'value\\'`.
 * The introducer is CAPTURED because it names the encoding of the bytes that
 * follow it (see {@link decodeIntroducedLiteral}).
 */
const MYSQL_STRING_EXPRESSION_DEFAULT = /^_([A-Za-z0-9_]+)\\'([\s\S]*)\\'$/;

/** One backslash escape, with the character it escapes. */
const MYSQL_ESCAPE_SEQUENCE = /\\([\s\S]?)/g;

/** Each byte read as the codepoint of the same number. */
function decodeSingleByte(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
}

/**
 * MySQL's `latin1` IS Windows-1252, not ISO-8859-1: the 32 bytes 0x80–0x9F are
 * printable characters there (0x93 is U+201C), and the five cp1252 leaves
 * undefined (0x81, 0x8D, 0x8F, 0x90, 0x9D) MySQL maps to the same-numbered
 * control. Every other byte is the codepoint of its own number.
 */
const CP1252_HIGH: readonly number[] = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c,
  0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d,
  0x017e, 0x0178,
];
function decodeLatin1(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    String.fromCharCode(
      byte >= 0x80 && byte <= 0x9f ? (CP1252_HIGH[byte - 0x80] ?? byte) : byte
    )
  ).join("");
}

/**
 * How an introducer's bytes are READ — one entry per charset, because the
 * charset is what says what a byte MEANS.
 *
 * MySQL names the charset of the DDL the literal arrived in and FREEZES it in
 * the stored expression, so the writing SESSION decides what reaches this
 * inverse, whatever the reading one speaks (measured: a column created over a
 * `latin1` connection reports `_latin1` to an ordinary utf8mb4 connection,
 * `closure-repair-2/t3/receipts/probe-frozen-introducer.log`). The UTF-8 family
 * is decoded; `ascii` and `binary` map each byte to the codepoint of the same
 * number, so the catalog's text already IS the value; `latin1` is read as the
 * Windows-1252 MySQL means by it ({@link decodeLatin1}). A charset
 * outside this table — `cp1251`, say, where the same byte is a different
 * letter — is not read at all: either reading would be a guess there, and a
 * wrong guess calls two different defaults equal.
 */
const MYSQL_INTRODUCER_DECODERS: ReadonlyMap<
  string,
  (bytes: Uint8Array) => string
> = new Map([
  ["utf8", decodeUtf8],
  ["utf8mb3", decodeUtf8],
  ["utf8mb4", decodeUtf8],
  ["latin1", decodeLatin1],
  ["ascii", decodeSingleByte],
  ["binary", decodeSingleByte],
]);

/**
 * The printed literal behind the catalog's text, or `undefined` when the text
 * is not the byte sequence the introducer promises.
 *
 * `information_schema.COLUMNS.COLUMN_DEFAULT` hands an EXPRESSION default's
 * text back one codepoint per BYTE: `café ☕` arrives as the nine codepoints
 * `63 61 66 c3 a9 20 e2 98 95` — the UTF-8 bytes of the value, each read as a
 * character — while the SAME column carries a LITERAL default's value decoded
 * (measured on 8.4.11: `HEX(COLUMN_DEFAULT)` shows the expansion server-side,
 * and `SHOW CREATE TABLE` prints the true text, so the loss is MySQL's own
 * rendering of a stored expression, not the connection's character set and not
 * the driver). Those bytes are the literal, in the charset the introducer
 * names, so they are read back with THAT charset
 * ({@link MYSQL_INTRODUCER_DECODERS}) rather than re-decoded by a rule of this
 * module's invention.
 *
 * An unknown charset, an out-of-byte-range codepoint, or an invalid byte
 * sequence keeps the catalog's own text. These checks do not prove provenance:
 * the measured mysql2 byte-expanded spelling of `é` and already-decoded text
 * whose literal characters are `Ã©` both present `c3 a9`, a valid UTF-8
 * sequence. Content alone cannot distinguish them. This decoder therefore
 * describes the measured mysql2 catalog representation; other transport
 * representations are unverified, and valid UTF-8-shaped already-decoded text
 * can be transformed rather than fail closed.
 */
function decodeIntroducedLiteral(
  introducer: string,
  printed: string
): string | undefined {
  const decode = MYSQL_INTRODUCER_DECODERS.get(introducer.toLowerCase());
  if (decode === undefined) return undefined;
  const codes = [...printed].map((character) => character.codePointAt(0) ?? 0);
  if (codes.some((code) => code > 0xff)) return undefined;
  try {
    return decode(Uint8Array.from(codes));
  } catch {
    return undefined;
  }
}

/** `undefined` for a body carrying an escape MySQL's printer does not write. */
function unescapeOneLayer(body: string): string | undefined {
  let owned = true;
  const unescaped = body.replace(
    MYSQL_ESCAPE_SEQUENCE,
    (_match: string, escaped: string) => {
      const character = MYSQL_PRINTED_CHARACTERS.get(escaped);
      if (character === undefined) {
        owned = false;
        return escaped;
      }
      return character;
    }
  );
  return owned ? unescaped : undefined;
}

/**
 * The VALUE behind MySQL's deparse of a string default, or `undefined` when
 * the catalog text carries an escape this inverse does not own.
 *
 * The text is escaped TWICE — once by MySQL printing the string literal inside
 * the expression, once by `information_schema` printing that expression — so a
 * declared `it's` arrives as the characters `_utf8mb4\'it\\\'s\'` (measured on
 * MySQL 8.4.11). Each pass undoes one layer, through the table MySQL's printer
 * writes (`MYSQL_PRINTED_CHARACTERS`). An escape outside that table is not one
 * this server printed for a value the estate spelled, so inverting it would be
 * a guess, and a wrong guess calls two different defaults equal.
 *
 * The BYTES come first ({@link decodeIntroducedLiteral}), because the catalog
 * spells them one per codepoint and every escape MySQL prints is ASCII: the
 * layers are the same after the decode, and only a text that is those bytes
 * reaches them.
 */
function deparsedStringValue(columnDefault: string): string | undefined {
  const deparsed = MYSQL_STRING_EXPRESSION_DEFAULT.exec(columnDefault);
  const introducer = deparsed?.[1];
  const body = deparsed?.[2];
  const printed =
    introducer === undefined || body === undefined
      ? undefined
      : decodeIntroducedLiteral(introducer, body);
  const literal = printed === undefined ? undefined : unescapeOneLayer(printed);
  return literal === undefined ? undefined : unescapeOneLayer(literal);
}

/**
 * The column's default, in the ONE spelling the estate uses.
 *
 * MySQL reports a default in two vocabularies and neither is the estate's. A
 * LITERAL default comes back as the bare VALUE — `member`, `x'y` — with the
 * quotes DDL required stripped off. An EXPRESSION default (every default on a
 * TEXT, BLOB, JSON or GEOMETRY column, since those refuse a literal) comes back
 * as MySQL's deparse of the expression, where a string literal is printed
 * `_charset\\'value\\'`. Both are translated here, at the one boundary that
 * reads the catalog, into what `finalizeMySQLColumn` spells on the desired
 * side; otherwise a default nobody touched reads as a changed column on every
 * push, and the final push attestation refuses the schema it just created.
 *
 * A deparse this inverse does not own keeps MySQL's own catalog text, which
 * stays different from the desired side: the column is re-planned and the push
 * then FAILS at the final attestation with `MIGRATION_DRIFT`. That is the
 * fail-closed direction — the same one the decimal-list container took when it
 * could not be re-encoded byte for byte — and it refuses a default nobody
 * proved equal instead of reporting a schema the database does not hold.
 */
function cleanDefault(col: MySQLColumn): string | undefined {
  const columnDefault = col.COLUMN_DEFAULT;
  if (columnDefault === null) return undefined;
  if (col.EXTRA.toUpperCase().includes("DEFAULT_GENERATED")) {
    const value = deparsedStringValue(columnDefault);
    return value === undefined
      ? columnDefault
      : `(${mysqlStringLiteral(value)})`;
  }
  return MYSQL_NUMERIC_DATA_TYPES.has(col.DATA_TYPE.toLowerCase())
    ? columnDefault
    : mysqlStringLiteral(columnDefault);
}

/**
 * Refuses every foreign key with one endpoint outside the selected database
 * (§5.2), before the snapshot exists.
 *
 * Both directions are refused for the same reason: the estate's own DDL cannot
 * express, drop or recreate a constraint whose other half lives in a database
 * this client does not manage, so a reset, a push, or a generated down would
 * plan work that is either impossible or destructive to a stranger's schema.
 *
 * This runs BEFORE the rows are grouped, because the grouped set is also what
 * hides MySQL's auto-created FK indexes from the snapshot: admitting a foreign
 * row here would silently change which indexes the differ sees.
 */
function admitContainedForeignKeys(
  rows: readonly MySQLForeignKey[],
  namespace: string
): void {
  for (const row of rows) {
    if (
      row.TABLE_SCHEMA === namespace &&
      row.REFERENCED_TABLE_SCHEMA === namespace
    ) {
      continue;
    }
    throw new MigrationError(
      `Foreign key "${row.CONSTRAINT_NAME}" crosses a database boundary: \`${row.TABLE_SCHEMA}\`.\`${row.TABLE_NAME}\` references \`${row.REFERENCED_TABLE_SCHEMA}\`.\`${row.REFERENCED_TABLE_NAME}\`, and this client manages only "${namespace}". ` +
        "Migration work is refused before any snapshot, plan or DDL: VibORM cannot recreate or drop a constraint whose other half lives in a database it does not own.",
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      {
        // BOTH endpoints are reported (§5.2), each on its own allowlisted
        // channel: the referencing one on `table`, the referenced one on
        // `referencedTable`, beside the database this client manages.
        meta: {
          dialect: "mysql",
          type: "cross-database-foreign-key",
          constraint: row.CONSTRAINT_NAME,
          namespace,
          table: `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`,
          referencedTable: `${row.REFERENCED_TABLE_SCHEMA}.${row.REFERENCED_TABLE_NAME}`,
        },
      }
    );
  }
}

// =============================================================================
// INTROSPECTION
// =============================================================================

export async function introspect(
  executeRaw: CatalogReader,
  namespace: string | undefined
): Promise<SchemaSnapshot> {
  // The database is proven to exist BEFORE anything is read, so an absent one
  // can never be published as an empty inventory (§5.2). Its returned spelling
  // is what every filter below binds and what the containment comparison uses:
  // under `lower_case_table_names` the server's spelling is the identity the
  // catalog rows actually carry.
  const catalogNamespace = await resolveCatalogNamespace(executeRaw, namespace);

  // Execute all queries in parallel
  const [
    tablesResult,
    columnsResult,
    primaryKeysResult,
    indexesResult,
    foreignKeysResult,
  ] = await Promise.all([
    executeRaw<MySQLTable>(TABLES_QUERY, [catalogNamespace]),
    executeRaw<MySQLColumn>(COLUMNS_QUERY, [catalogNamespace]),
    executeRaw<MySQLPrimaryKey>(PRIMARY_KEYS_QUERY, [catalogNamespace]),
    executeRaw<MySQLIndex>(INDEXES_QUERY, [catalogNamespace]),
    executeRaw<MySQLForeignKey>(FOREIGN_KEYS_QUERY, [
      catalogNamespace,
      catalogNamespace,
    ]),
  ]);

  admitContainedForeignKeys(foreignKeysResult.rows, catalogNamespace);

  // Group results
  const columnsByTable = groupBy(columnsResult.rows, (col) => col.TABLE_NAME);
  const pkByTable = groupBy(primaryKeysResult.rows, (pk) => pk.TABLE_NAME);
  const indexesByTable = groupByNested(
    indexesResult.rows,
    (idx) => idx.TABLE_NAME,
    (idx) => idx.INDEX_NAME
  );
  const fkByTable = groupByNested(
    foreignKeysResult.rows,
    (fk) => fk.TABLE_NAME,
    (fk) => fk.CONSTRAINT_NAME
  );
  // Track enum definitions found in columns
  const enumDefs: EnumDef[] = [];
  const seenEnums = new Set<string>();

  // Build tables
  const tables: TableDef[] = [];

  for (const table of tablesResult.rows) {
    const tableName = table.TABLE_NAME;

    // Build columns
    const columns: ColumnDef[] = [];
    for (const col of columnsByTable.get(tableName) || []) {
      // Extract enum values if this is an enum column
      // MySQL has no standalone enum object, so the inline type IS the
      // identity — and it is the identity the DESIRED snapshot registers too
      // (`serializer.ts` names an enum by `getEnumColumnType`). Naming it
      // anything else here, as a derived `table$column$enum` did, made every
      // enum-bearing schema carry two enum definitions that could never match.
      if (col.DATA_TYPE === "enum") {
        const values = parseEnumValues(col.COLUMN_TYPE);
        const enumName = values && mysqlEnumType(values);
        if (values && enumName && !seenEnums.has(enumName)) {
          enumDefs.push({ name: enumName, values });
          seenEnums.add(enumName);
        }
      }

      const decimal = readDecimalDomain(col);
      columns.push({
        name: col.COLUMN_NAME,
        type: formatColumnType(col),
        nullable: col.IS_NULLABLE === "YES",
        default: cleanDefault(col),
        autoIncrement: isAutoIncrement(col.EXTRA),
        decimal,
      });
    }

    // Build primary key
    let primaryKey: PrimaryKeyDef | undefined;
    const pkCols = pkByTable.get(tableName);
    if (pkCols && pkCols.length > 0) {
      pkCols.sort((a, b) => a.ORDINAL_POSITION - b.ORDINAL_POSITION);
      const firstPkCol = pkCols[0];
      if (firstPkCol) {
        primaryKey = {
          columns: pkCols.map((pk) => pk.COLUMN_NAME),
          name: firstPkCol.CONSTRAINT_NAME,
        };
      }
    }

    // Build indexes
    const indexes: IndexDef[] = [];
    const tableIndexes = indexesByTable.get(tableName);
    // MySQL auto-creates an index named after each FK constraint; it isn't a
    // user index and can't be dropped while the FK exists, so hide it
    const fkNames = new Set(fkByTable.get(tableName)?.keys() ?? []);
    if (tableIndexes) {
      for (const [indexName, indexCols] of tableIndexes) {
        if (fkNames.has(indexName)) {
          continue;
        }
        indexCols.sort((a, b) => a.SEQ_IN_INDEX - b.SEQ_IN_INDEX);
        const firstCol = indexCols[0];
        if (firstCol) {
          const rawIndexType = firstCol.INDEX_TYPE.toLowerCase();
          // MySQL INFORMATION_SCHEMA reports RTREE for spatial indexes, normalize to "spatial"
          const indexType = rawIndexType === "rtree" ? "spatial" : rawIndexType;
          indexes.push({
            name: indexName,
            columns: indexCols.map((idx) => idx.COLUMN_NAME),
            unique: firstCol.NON_UNIQUE === 0,
            // MySQL uses BTREE, HASH, FULLTEXT, SPATIAL (reported as RTREE) - preserve all supported types
            type:
              indexType === "btree" ||
              indexType === "hash" ||
              indexType === "fulltext" ||
              indexType === "spatial"
                ? (indexType as "btree" | "hash" | "fulltext" | "spatial")
                : undefined,
          });
        }
      }
    }

    // Build foreign keys
    const foreignKeys: ForeignKeyDef[] = [];
    const tableFks = fkByTable.get(tableName);
    if (tableFks) {
      for (const [constraintName, fkCols] of tableFks) {
        fkCols.sort((a, b) => a.ORDINAL_POSITION - b.ORDINAL_POSITION);
        const firstFk = fkCols[0];
        if (firstFk) {
          foreignKeys.push({
            name: constraintName,
            columns: fkCols.map((fk) => fk.COLUMN_NAME),
            referencedTable: firstFk.REFERENCED_TABLE_NAME,
            referencedColumns: fkCols.map((fk) => fk.REFERENCED_COLUMN_NAME),
            onDelete: mapReferentialAction(firstFk.DELETE_RULE),
            onUpdate: mapReferentialAction(firstFk.UPDATE_RULE),
          });
        }
      }
    }

    // MySQL HAS ONE UNIQUE NAMESPACE, so a unique is reported ONCE — as an
    // index, above, from STATISTICS. TABLE_CONSTRAINTS lists the very same
    // object a second time (its `UNIQUE` constraint face), and filing that
    // second face here made every unique-bearing MySQL schema churn forever:
    // whichever bucket the desired side did not use looked like a stray object
    // and the differ planned a drop for it (measured on docker MySQL 8 — a
    // spurious `dropIndex` for a declared unique constraint, a spurious
    // `dropUniqueConstraint` for a declared unique index).
    //
    // The desired side is canonicalized to match by the driver's
    // `finalizeTable`, which rewrites every unique constraint into a unique
    // index. Both sides now speak indexes, so a unique round-trips unchanged.
    //
    // The bucket stays in the shape (every dialect's snapshot carries it) and
    // is always empty for MySQL. TABLE_CONSTRAINTS is no longer queried at all:
    // it can report nothing the STATISTICS rows above do not already carry.
    const uniqueConstraints: UniqueConstraintDef[] = [];

    tables.push({
      name: tableName,
      columns,
      primaryKey,
      indexes,
      foreignKeys,
      uniqueConstraints,
    });
  }

  // MySQL doesn't have standalone enum types, but we track them for compatibility
  return {
    tables,
    enums: enumDefs.length > 0 ? enumDefs : undefined,
  };
}
