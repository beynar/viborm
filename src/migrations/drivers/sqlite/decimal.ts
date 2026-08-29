/**
 * SQLite fixed-decimal migration storage.
 *
 * SQLite cannot carry a decimal descriptor in its declared storage type, so
 * this module owns the reserved CHECK carrier, its structural reader, and the
 * exact table-rebuild expressions that rescale scalar and list coefficients.
 */

import type { DecimalDescriptor } from "@validation/primitives/decimal-codec";
import { MigrationError, VibORMErrorCode } from "../../../errors";
import {
  type DecimalStorageKind,
  describeDecimalDomain,
  readStoredDecimalDescriptor,
  sqliteDecimalStorageKind,
} from "../../decimal";
import type { ColumnDef } from "../../types";
import {
  isSqliteBareIdentifierCharacter,
  readSqliteIdentifier,
  skipSqlNonStructuralRegion,
} from "./sql-lexing";

/**
 * The reserved SQLite constraint name for one decimal column.
 *
 * SQLite's declared type is the wrong carrier twice over: it stores `INTEGER`
 * (or `TEXT` for a list) whatever the domain is, and a CHECK written INTO the
 * type string never reads back — `PRAGMA table_info.type` reports only the
 * `type-name` production, so the desired `TEXT CHECK(...)` can never equal the
 * introspected `TEXT` and a full table recreation is planned on every push,
 * forever. (That is measured behaviour of the enum column type, not a
 * hypothetical.) So the descriptor rides in a NAMED constraint, and
 * introspection recovers it from the name.
 */
export function sqliteDecimalConstraintName(
  columnName: string,
  descriptor: DecimalDescriptor
): string {
  return `viborm_decimal_${columnName}_${descriptor.precision}_${descriptor.scale}`;
}

/** The namespace VibORM reserves for the constraints it writes itself. */
const RESERVED_CONSTRAINT_PREFIX = "viborm_decimal_";

/** `<precision>_<scale>`: what follows the column name in a reserved name. */
const RESERVED_CONSTRAINT_TAIL = /^(\d+)_(\d+)$/;

/**
 * The declared domain of one column, read back out of the `CREATE TABLE` text
 * SQLite stored — or `undefined` when this column carries no reserved
 * constraint. The matching PRAGMA type and nullability travel with the column:
 * the stored clause is owned only when it is the exact writer rendering for
 * those physical facts.
 *
 * This PARSES, it does not search. The name alone is not evidence: SQLite
 * stores the statement verbatim, so any string literal a user can write — an
 * enum value, a string default, an index predicate — appears in the same text
 * and can spell VibORM's reserved prefix. A first-hit substring scan therefore
 * reads a user's data as a descriptor, and with an earlier offset it OVERRIDES
 * the real constraint: the next push plans a conversion between two domains
 * neither side declared and rewrites every stored coefficient. So the reader
 * walks the column-definition list the same quote-aware way
 * `partialIndexPredicate` walks a `CREATE INDEX` (`introspect.ts`), finds real
 * `CONSTRAINT <name> CHECK (…)` clauses, and binds each to the column definition
 * it actually sits in.
 *
 * A reserved name the module could not have written is REFUSED, not ignored.
 * Ignoring it is not the safe reading: the name is in a namespace only this
 * module writes, so its presence means either a corrupted carrier or a
 * collision, and both make every later push either wrong (a conversion between
 * invented domains) or non-convergent (a descriptor the desired side can never
 * match). The refusal names the constraint so the estate can be repaired.
 *
 * Ownership is proved by RE-RENDERING: the clause must be, byte for byte, what
 * {@link sqliteDecimalCheck} would emit for this column at the descriptor the
 * name declares. That is the only test that cannot be forged by a name alone,
 * and it is exact because SQLite re-spells nothing it stores.
 */
export function readSqliteDecimalConstraint(
  tableSql: string | null | undefined,
  column: Pick<ColumnDef, "name" | "type" | "nullable">,
  escapeIdentifier: (name: string) => string
): DecimalDescriptor | undefined {
  if (!tableSql) return undefined;
  // The reserved namespace has to appear at all before the statement is worth
  // parsing: introspection reads every column of every table, and the
  // overwhelming majority carry no decimal.
  if (!tableSql.includes(RESERVED_CONSTRAINT_PREFIX)) return undefined;

  let found: DecimalDescriptor | undefined;
  for (const definition of tableDefinitions(tableSql)) {
    for (const clause of constraintClauses(definition.text)) {
      if (!clause.name.startsWith(RESERVED_CONSTRAINT_PREFIX)) continue;
      // This reader is invoked once for every PRAGMA column. A reserved
      // column constraint is adjudicated when its own physical column is in
      // hand, because only that invocation knows the type and nullability the
      // database actually reported. TABLE constraints have no such invocation
      // and are always namespace squatters.
      if (
        definition.columnName !== undefined &&
        definition.columnName !== column.name
      ) {
        continue;
      }
      const descriptor = ownedDescriptor(
        definition,
        clause,
        column,
        escapeIdentifier
      );
      if (descriptor === undefined) {
        throw new MigrationError(
          `The stored definition carries a constraint named "${clause.name}", which is inside the namespace VibORM reserves for the fixed-decimal descriptor it writes itself, but it is not a constraint VibORM wrote. ` +
            "A reserved constraint is the ONLY place a SQLite column's declared precision and scale survive — the storage class is INTEGER or TEXT at every domain — so reading this one as a descriptor would plan conversions between domains the schema never declared, and ignoring it would re-plan the same alteration on every push. " +
            "Rename or drop the constraint, or restore the definition VibORM wrote for this column.",
          VibORMErrorCode.INVALID_INPUT,
          {
            meta: {
              constraint: clause.name,
              // Absent for a TABLE constraint, which belongs to no column.
              ...(definition.columnName === undefined
                ? {}
                : { column: definition.columnName }),
            },
          }
        );
      }
      if (definition.columnName === column.name) {
        if (found !== undefined) {
          throw new MigrationError(
            `The stored definition carries more than one fixed-decimal descriptor for column "${column.name}": ${describeDecimalDomain(found)} and ${describeDecimalDomain(descriptor)}. ` +
              "One physical column can have only one logical decimal domain, so introspection refuses the ambiguous reserved carriers instead of choosing one by order.",
            VibORMErrorCode.INVALID_INPUT,
            { meta: { column: column.name } }
          );
        }
        found = descriptor;
      }
    }
  }
  return found;
}

/** One top-level entry of a `CREATE TABLE`'s parenthesized definition list. */
interface TableDefinition {
  readonly text: string;
  /** The column this entry defines, or `undefined` for a table constraint. */
  readonly columnName: string | undefined;
}

/** A `CONSTRAINT <name>` at the top level of one definition. */
interface ConstraintClause {
  readonly name: string;
  /** Where the `CONSTRAINT` keyword starts inside the definition text. */
  readonly offset: number;
}

/** Keywords that open a TABLE constraint rather than a column definition. */
const TABLE_CONSTRAINT_KEYWORDS = new Set([
  "CONSTRAINT",
  "PRIMARY",
  "UNIQUE",
  "CHECK",
  "FOREIGN",
]);

/**
 * The reserved constraint this clause carries, or `undefined` when the clause
 * is one this module could not have written.
 *
 * Three things must hold together, and each is a way the namespace gets
 * squatted: the clause sits in a COLUMN definition (never a table constraint,
 * which VibORM never writes); its name is this column's name followed by the
 * two numbers; and the whole clause re-renders byte for byte.
 */
function ownedDescriptor(
  definition: TableDefinition,
  clause: ConstraintClause,
  physicalColumn: Pick<ColumnDef, "name" | "type" | "nullable">,
  escapeIdentifier: (name: string) => string
): DecimalDescriptor | undefined {
  const column = definition.columnName;
  if (column === undefined || column !== physicalColumn.name) return undefined;
  const prefix = `${RESERVED_CONSTRAINT_PREFIX}${column}_`;
  if (!clause.name.startsWith(prefix)) return undefined;
  const match = RESERVED_CONSTRAINT_TAIL.exec(clause.name.slice(prefix.length));
  if (!match) return undefined;
  const descriptor = readStoredDecimalDescriptor(match[1], match[2], "sqlite");
  if (descriptor === undefined) return undefined;
  // PRAGMA owns the physical type and nullability. Re-render ONLY the shape
  // those facts permit; trying all four writer spellings lets an impossible
  // INTEGER/list or nullable/non-null carrier masquerade as a valid domain.
  const kind = sqliteDecimalStorageKind({
    ...physicalColumn,
    decimal: descriptor,
  });
  if (kind === undefined) return undefined;
  const rendered = sqliteDecimalCheck(
    physicalColumn,
    descriptor,
    kind,
    escapeIdentifier
  );
  if (definition.text.startsWith(rendered, clause.offset)) {
    return descriptor;
  }
  return undefined;
}

/**
 * Whether one generated table definition carries this column's reserved
 * decimal descriptor name in the structural column clause that owns it.
 *
 * Apply uses this only after it has proved the surrounding statement sequence
 * is VibORM's exact generated table-recreation program. It distinguishes the
 * decimal-column rename variant, whose copy expression needs no conversion
 * sentinel, from an unrelated recreation of a table that merely contains some
 * other decimal column.
 */
export function sqliteColumnDefinitionCarriesDecimalDescriptor(
  tableSql: string,
  columnName: string
): boolean {
  const prefix = `${RESERVED_CONSTRAINT_PREFIX}${columnName}_`;
  for (const definition of tableDefinitions(tableSql)) {
    if (definition.columnName !== columnName) continue;
    for (const clause of constraintClauses(definition.text)) {
      if (!clause.name.startsWith(prefix)) continue;
      const match = RESERVED_CONSTRAINT_TAIL.exec(
        clause.name.slice(prefix.length)
      );
      if (
        match &&
        readStoredDecimalDescriptor(match[1], match[2], "sqlite") !== undefined
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Every top-level entry of the definition list, with the column each one
 * defines.
 *
 * The list is what sits between the parenthesis that follows the table name and
 * its match, split on the commas at that depth — quoted identifiers and string
 * literals skipped, because both can contain a comma, a parenthesis, or the
 * word `CONSTRAINT`.
 */
function tableDefinitions(sql: string): TableDefinition[] {
  let open = -1;
  let scan = 0;
  while (scan < sql.length) {
    const skipped = skipSqlNonStructuralRegion(sql, scan);
    if (skipped !== scan) {
      scan = skipped;
      continue;
    }
    if (sql[scan] === "(") {
      open = scan;
      break;
    }
    scan++;
  }
  if (open === -1) return [];

  const definitions: TableDefinition[] = [];
  let depth = 1;
  let start = open + 1;
  let cursor = start;
  while (cursor < sql.length) {
    const skipped = skipSqlNonStructuralRegion(sql, cursor);
    if (skipped !== cursor) {
      cursor = skipped;
      continue;
    }
    const char = sql[cursor];
    if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth === 0) break;
    } else if (char === "," && depth === 1) {
      definitions.push(describeDefinition(sql.slice(start, cursor)));
      start = cursor + 1;
    }
    cursor++;
  }
  definitions.push(describeDefinition(sql.slice(start, cursor)));
  return definitions;
}

function describeDefinition(raw: string): TableDefinition {
  const text = raw.trim();
  const first = readSqliteIdentifier(text, 0);
  if (first === undefined) return { text, columnName: undefined };
  // A quoted first token is always a column name, even when it spells a
  // keyword: `"CHECK CONSTRAINT" INTEGER` is a legal column.
  if (first.quoted) return { text, columnName: first.value };
  return {
    text,
    columnName: TABLE_CONSTRAINT_KEYWORDS.has(first.value.toUpperCase())
      ? undefined
      : first.value,
  };
}

/**
 * Every `CONSTRAINT <name>` at depth 0 of one definition.
 *
 * Whole tokens only: reading `CONSTRAINT` out of the middle of a longer word
 * would find one where none was written.
 */
function constraintClauses(definition: string): ConstraintClause[] {
  const clauses: ConstraintClause[] = [];
  let depth = 0;
  let cursor = 0;
  while (cursor < definition.length) {
    const skipped = skipSqlNonStructuralRegion(definition, cursor);
    if (skipped !== cursor) {
      cursor = skipped;
      continue;
    }
    const char = definition[cursor] ?? "";
    if (isSqliteBareIdentifierCharacter(char)) {
      const word = readSqliteIdentifier(definition, cursor);
      if (word === undefined) {
        cursor++;
        continue;
      }
      if (depth === 0 && word.value.toUpperCase() === "CONSTRAINT") {
        const name = readSqliteIdentifier(definition, word.end);
        if (name) {
          clauses.push({ name: name.value, offset: cursor });
          cursor = name.end;
          continue;
        }
      }
      cursor = word.end;
      continue;
    }
    if (char === "(") depth++;
    else if (char === ")") depth--;
    cursor++;
  }
  return clauses;
}

/** `10^precision - 1`: the widest coefficient the domain can hold. */
function maxCoefficient(precision: number): bigint {
  return 10n ** BigInt(precision) - 1n;
}

/**
 * The reserved CHECK a SQLite decimal column carries, as a complete column
 * constraint (`CONSTRAINT <name> CHECK (<body>)`).
 *
 * A scalar is the signed integer coefficient. A list is TEXT holding a JSON
 * array of coefficient strings. NULL passes only for a nullable column.
 */
export function sqliteDecimalCheck(
  column: { readonly name: string; readonly nullable: boolean },
  descriptor: DecimalDescriptor,
  kind: DecimalStorageKind,
  escapeIdentifier: (name: string) => string
): string {
  const col = escapeIdentifier(column.name);
  const name = escapeIdentifier(
    sqliteDecimalConstraintName(column.name, descriptor)
  );
  const bound = maxCoefficient(descriptor.precision).toString();
  const body =
    kind === "list"
      ? `typeof(${col}) = 'text' AND json_valid(${col}) AND json_type(${col}) = 'array'`
      : `typeof(${col}) = 'integer' AND ${col} BETWEEN -${bound} AND ${bound}`;
  const guarded = column.nullable ? `${col} IS NULL OR (${body})` : body;
  return `CONSTRAINT ${name} CHECK (${guarded})`;
}

/**
 * The value a row lands in the rebuilt table when it does not fit the target
 * domain. It fails the target column's own reserved CHECK and aborts the whole
 * recreation atomically.
 */
const SCALAR_SENTINEL = "'viborm:decimal-out-of-domain'";
const LIST_SENTINEL = "'viborm:decimal-list-out-of-domain'";

interface Rescale {
  /** `10^|scale delta|`, as an integer literal. */
  readonly factor: string;
  readonly direction: "up" | "down" | "none";
  /** The inclusive absolute bound the SOURCE coefficient must satisfy. */
  readonly bound: string;
}

/** The one arithmetic decision behind every SQLite conversion expression. */
function rescale(
  from: DecimalDescriptor | undefined,
  to: DecimalDescriptor
): Rescale {
  const targetMax = maxCoefficient(to.precision);
  const sourceMax = from ? maxCoefficient(from.precision) : targetMax;
  const delta = to.scale - (from?.scale ?? 0);
  if (delta === 0) {
    return {
      factor: "1",
      direction: "none",
      bound: min(sourceMax, targetMax).toString(),
    };
  }
  if (delta > 0) {
    const factor = 10n ** BigInt(delta);
    return {
      factor: factor.toString(),
      direction: "up",
      bound: min(sourceMax, targetMax / factor).toString(),
    };
  }
  const factor = 10n ** BigInt(-delta);
  return {
    factor: factor.toString(),
    direction: "down",
    bound: min(sourceMax, targetMax * factor).toString(),
  };
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * The per-column source expression used by SQLite table recreation. It
 * converts stored values from `from`'s physical spelling to `to`'s without a
 * REAL intermediate and routes every malformed or out-of-domain value to the
 * target CHECK's sentinel.
 */
export function sqliteDecimalCopyExpression(
  source: string,
  from: DecimalDescriptor | undefined,
  to: DecimalDescriptor,
  kind: DecimalStorageKind
): string {
  const { factor, direction, bound } = rescale(from, to);
  const exact = direction === "down" ? ` AND ${source} % ${factor} = 0` : "";
  if (kind === "scalar") {
    const converted = convertedCoefficient(source, direction, factor);
    return (
      `CASE WHEN ${source} IS NULL THEN NULL WHEN typeof(${source}) = 'integer' ` +
      `AND ${source} BETWEEN -${bound} AND ${bound}${exact} THEN ${converted} ` +
      `ELSE ${SCALAR_SENTINEL} END`
    );
  }
  return listCopyExpression(source, direction, factor, bound);
}

function convertedCoefficient(
  operand: string,
  direction: Rescale["direction"],
  factor: string
): string {
  if (direction === "up") return `${operand} * ${factor}`;
  if (direction === "down") return `${operand} / ${factor}`;
  return operand;
}

/** Convert a SQLite JSON coefficient-string list without losing order. */
function listCopyExpression(
  source: string,
  direction: Rescale["direction"],
  factor: string,
  bound: string
): string {
  const member = `"m"."value"`;
  const asInteger = `CAST(${member} AS INTEGER)`;
  const exact = direction === "down" ? ` AND ${asInteger} % ${factor} = 0` : "";
  const admissible =
    `"m"."type" = 'text' AND CAST(${asInteger} AS TEXT) = ${member} ` +
    `AND ${asInteger} BETWEEN -${bound} AND ${bound}${exact}`;
  const converted = `CAST(${convertedCoefficient(`CAST("value" AS INTEGER)`, direction, factor)} AS TEXT)`;
  return (
    `CASE WHEN ${source} IS NULL THEN NULL WHEN typeof(${source}) = 'text' AND json_valid(${source}) = 1 THEN ` +
    `CASE WHEN json_type(${source}) = 'array' THEN CASE WHEN ` +
    `(SELECT count(*) FROM json_each(${source}) AS "m" WHERE NOT (${admissible})) = 0 THEN ` +
    `(SELECT json_group_array(${converted}) FROM (SELECT "value" FROM json_each(${source}) AS "m" ORDER BY "m"."key")) ` +
    `ELSE ${LIST_SENTINEL} END ELSE ${LIST_SENTINEL} END ELSE ${LIST_SENTINEL} END`
  );
}
