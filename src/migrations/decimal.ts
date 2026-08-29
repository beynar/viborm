/**
 * The migration layer's decimal renders.
 *
 * `@validation/primitives/decimal-codec` owns everything VALUE-shaped: the
 * grammar, canonical text, the logical <-> coefficient conversion, and the two
 * DDL renderings (`decimalColumnType`, `decimalDefaultText`). This module owns
 * what only a MIGRATION asks — the questions whose subject is a pair of
 * descriptors or a stored column rather than a value:
 *
 * - whether two snapshots describe the same domain, whether a change narrows
 *   it, and which scalar/list storage shape a decimal column carries;
 * - the MySQL column-comment marker for a JSON-backed list; and
 * - the shared validation predicates used by native-decimal migration drivers.
 *
 * Everything here is PURE and connection-free: migration DDL is generated into
 * durable artifacts, so none of it may consult a database.
 *
 * Nothing here re-derives a precision or a scale. Every entry takes the frozen
 * descriptor its caller already holds (plan §1.1: no migration component stores
 * an independent precision or scale decision).
 */

import {
  type DecimalDescriptor,
  type DecimalDialect,
  decimalColumnType,
  describeProviderLimitRefusal,
  sameDecimalDescriptor,
} from "@validation/primitives/decimal-codec";
import { MigrationError, VibORMErrorCode } from "../errors";
import type { ColumnDef } from "./types";

/**
 * Whether moving from `from` to `to` SHRINKS the set of representable values —
 * the destructive half of a descriptor change.
 *
 * Two independent limits move: the fractional digits (`scale`) and the integer
 * digits (`precision - scale`). A change that lowers either one can find a
 * stored value it cannot hold, and the conversion then refuses; a change that
 * raises both is exact for every existing row. Widening the scale while keeping
 * the precision therefore counts as narrowing, because it takes an integer
 * digit away — `NUMERIC(10,2)` holds 99999999.99 and `NUMERIC(10,5)` does not.
 */
export function decimalDomainNarrows(
  from: DecimalDescriptor,
  to: DecimalDescriptor
): boolean {
  const integerDigitsLost =
    to.precision - to.scale < from.precision - from.scale;
  return integerDigitsLost || to.scale < from.scale;
}

/**
 * Whether this alteration moves stored values INTO a declared decimal domain —
 * the ONE signal every provider's conversion route reads.
 *
 * Only the TARGET has to declare a domain. An absent source descriptor does not
 * make the change descriptor-free: it means the stored values were written
 * under some other reading, and adopting them under this one is exactly the
 * transition §7.3 governs. Skipping the conversion there is what silently
 * reinterprets a PostgreSQL `numeric` by rounding it through the `USING` cast,
 * and what copies a SQLite integer into a coefficient column at a scale it was
 * never written at. Each provider answers the absent source in its own terms —
 * PostgreSQL's target-domain CHECK is a complete proof on its own, and the
 * SQLite copy reads an untyped `INTEGER` as the logical integer it is — but the
 * QUESTION is one, so this is one predicate.
 *
 * The physical type is part of it beside the descriptor, because a scalar that
 * becomes a list keeps its precision and scale while changing storage class
 * completely. It is compared case-insensitively, the same reading the differ
 * takes: one snapshot side is the serializer's spelling and the other is
 * whatever the catalog answered.
 */
export function decimalConversionRequired(
  from: ColumnDef,
  to: ColumnDef
): boolean {
  if (to.decimal === undefined) return false;
  return (
    !sameDecimalDescriptor(from.decimal, to.decimal) ||
    from.type.toUpperCase() !== to.type.toUpperCase()
  );
}

/**
 * Whether this alteration can lose data because the target domain is smaller.
 * The migration differ's destructive classifier is the sole consumer-facing
 * decision owner; this function owns only the decimal-domain question it asks.
 */
export function decimalChangeNarrows(from: ColumnDef, to: ColumnDef): boolean {
  if (from.decimal === undefined || to.decimal === undefined) return false;
  return decimalDomainNarrows(from.decimal, to.decimal);
}

/**
 * The domain, spelled for a refusal MESSAGE.
 *
 * `precision` and `scale` are deliberately not `meta` keys: the error metadata
 * allowlist (`src/errors/diagnostics.ts`) admits neither, so a refusal that put
 * them there would drop them silently. Following the namespace precedent, the
 * numbers go in the sentence.
 */
export function describeDecimalDomain(descriptor: DecimalDescriptor): string {
  return `precision ${descriptor.precision}, scale ${descriptor.scale}`;
}

/**
 * A storage shape, spelled for a refusal MESSAGE.
 *
 * `undefined` is a real answer here and it has to say so: it means the column's
 * declared type is neither of the two spellings this layer writes, which is a
 * different fact from "the domain moved" and must not be reported as one.
 */
export function describeDecimalStorageKind(
  kind: DecimalStorageKind | undefined
): string {
  return kind ?? "unrecognized";
}

// =============================================================================
// THE MYSQL DESCRIPTOR CARRIER
// =============================================================================

/**
 * The deterministic VibORM-owned column-comment marker for a JSON-backed MySQL
 * decimal list.
 *
 * A `DECIMAL(p,s)` column spells its own domain, but a decimal LIST is stored
 * as `JSON` (MySQL has no array type), and JSON carries nothing. The marker is
 * that column's descriptor, and it is the whole comment: introspection
 * recognizes only the exact marker (§6.2), so a hand-written comment that
 * merely mentions a decimal is not a descriptor.
 */
export function mysqlDecimalListMarker(descriptor: DecimalDescriptor): string {
  return `viborm:decimal(${descriptor.precision},${descriptor.scale})`;
}

const MYSQL_LIST_MARKER = /^viborm:decimal\((\d+),(\d+)\)$/;
const STORED_DECIMAL_INTEGER = /^-?\d+$/;

/**
 * A descriptor recovered from provider-owned catalog text, or `undefined` when
 * the captures cannot be one this provider's writer emitted.
 *
 * Catalog text is a new trust boundary: digit syntax alone still admits zero,
 * scale above precision, integers JavaScript cannot represent, `Infinity`, and
 * domains the provider cannot physically implement. The complete check runs
 * before SQLite re-renders a constraint, so an untrusted precision never
 * reaches `10n ** precision`.
 */
export function readStoredDecimalDescriptor(
  precisionValue: unknown,
  scaleValue: unknown,
  dialect: DecimalDialect
): DecimalDescriptor | undefined {
  const precision = readStoredDecimalInteger(precisionValue);
  const scale = readStoredDecimalInteger(scaleValue);
  if (
    precision === undefined ||
    scale === undefined ||
    precision <= 0 ||
    scale < 0 ||
    scale > precision
  ) {
    return undefined;
  }
  const descriptor = { precision, scale };
  return describeProviderLimitRefusal(dialect, descriptor) === undefined
    ? descriptor
    : undefined;
}

function readStoredDecimalInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (typeof value !== "string" || !STORED_DECIMAL_INTEGER.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * The domain a MySQL column comment declares, or `undefined` when it is not the
 * reserved marker. A marker-shaped comment with an invalid domain refuses.
 */
export function readMysqlDecimalListMarker(
  comment: string | null | undefined
): DecimalDescriptor | undefined {
  if (!comment) return undefined;
  const match = MYSQL_LIST_MARKER.exec(comment);
  if (!match) return undefined;
  const descriptor = readStoredDecimalDescriptor(match[1], match[2], "mysql");
  if (descriptor !== undefined) return descriptor;
  throw new MigrationError(
    "The stored MySQL column comment uses VibORM's reserved decimal-list marker but carries an invalid fixed-decimal descriptor. " +
      "A reserved marker must contain finite safe integers inside the complete MySQL decimal domain; repair or remove the comment before running migrations.",
    VibORMErrorCode.INVALID_INPUT
  );
}

// =============================================================================
// THE DIALECT STORAGE SHAPES
// =============================================================================

/**
 * How one dialect physically holds a decimal: one value, or a container of
 * them. The migration layer reads it off the column rather than the model,
 * because a snapshot side may have come from introspection.
 */
export type DecimalStorageKind = "scalar" | "list";

/**
 * The storage shape of a SQLite decimal column, or `undefined` when the column
 * holds no decimal.
 *
 * `INTEGER` is the scalar coefficient and `TEXT` the JSON container — the two
 * classes `decimalColumnType` and the list mapping produce. Any other type on a
 * column that claims a descriptor is a snapshot this layer did not write, and
 * it gets no conversion: the target's own CHECK refuses whatever is copied into
 * it, which fails the rebuild atomically instead of guessing at a shape.
 */
export function sqliteDecimalStorageKind(
  column: ColumnDef
): DecimalStorageKind | undefined {
  if (column.decimal === undefined) return undefined;
  const type = column.type.toUpperCase();
  if (type === decimalColumnType("sqlite", column.decimal)) return "scalar";
  return type === SQLITE_DECIMAL_LIST_TYPE ? "list" : undefined;
}

/**
 * The storage shape of a MySQL decimal column, or `undefined` when the column
 * holds no decimal.
 *
 * A scalar spells its own domain in `DECIMAL(p,s)` — introspection reads it
 * back lowercased, so the comparison is case-insensitive — and a list is the
 * `JSON` container every MySQL list gets, carrying its domain in the
 * column-comment marker instead.
 *
 * A MODIFIER after the domain does not change the storage shape.
 * `decimal(10,2) unsigned` and `decimal(10,2) zerofill` are the same physical
 * decimal, introspected verbatim through `formatColumnType`'s modifier arm, and
 * a shape of `undefined` for them would refuse the very ALTER that normalizes
 * them — an estate that could never converge. The domain token itself still has
 * to match the descriptor EXACTLY, so `DECIMAL(10,20)` is not `DECIMAL(10,2)`
 * with a modifier.
 */
export function mysqlDecimalStorageKind(
  column: ColumnDef
): DecimalStorageKind | undefined {
  if (column.decimal === undefined) return undefined;
  const type = column.type.toUpperCase().replace(/\s+/g, " ").trim();
  const scalar = decimalColumnType("mysql", column.decimal);
  if (type === scalar || type.startsWith(`${scalar} `)) return "scalar";
  return type === MYSQL_DECIMAL_LIST_TYPE ? "list" : undefined;
}

/** PostgreSQL's native scalar and native-array decimal storage shapes. */
export function postgresDecimalStorageKind(
  column: ColumnDef
): DecimalStorageKind | undefined {
  if (column.decimal === undefined) return undefined;
  const type = column.type.toUpperCase().replace(/\s+/g, "").trim();
  const scalar = decimalColumnType("pg", column.decimal);
  if (type === scalar) return "scalar";
  return type === `${scalar}[]` ? "list" : undefined;
}

/**
 * The provider-independent scalar/list identity of a migration decimal.
 *
 * Rename detection needs the shape, not typmod equality: changing a decimal
 * descriptor necessarily changes PostgreSQL/MySQL's physical type spelling,
 * while it keeps the same value/container identity and can still be a native
 * column rename followed by one exact conversion.
 */
export function migrationDecimalStorageKind(
  column: ColumnDef
): DecimalStorageKind | undefined {
  return (
    postgresDecimalStorageKind(column) ??
    mysqlDecimalStorageKind(column) ??
    sqliteDecimalStorageKind(column)
  );
}

/** MySQL has no array type; every list is JSON, decimal lists included. */
export const MYSQL_DECIMAL_LIST_TYPE = "JSON";

/**
 * TEXT, not the blanket `JSON` every other SQLite list gets: the list's
 * reserved CHECK asserts `typeof = 'text'`, and `JSON` has NUMERIC affinity
 * under SQLite's rules (it contains none of INT/CHAR/CLOB/TEXT/BLOB/REAL/FLOA/
 * DOUB), which would try to convert a numeric-looking container on the way in.
 */
export const SQLITE_DECIMAL_LIST_TYPE = "TEXT";

// =============================================================================
// THE PostgreSQL / MySQL VALIDATION PREDICATE
// =============================================================================

/**
 * The transient constraint a native-decimal conversion validates through.
 *
 * It is added, kept live ACROSS the type change, and dropped after. That
 * ordering is the whole design: the constraint proves every EXISTING row
 * already fits the target domain, and — because it stays — no concurrent write
 * can land a value the target would have to round while the conversion runs.
 * It is how "while writes are excluded" is spelled on MySQL, whose `LOCK
 * TABLES` the artifact classifier refuses as a transaction leader.
 */
/**
 * The compact identity of one transient conversion proof.
 *
 * The table and column deliberately stay out of this identity: MySQL can
 * publish a different table-name spelling through `lower_case_table_names`,
 * while an interrupted proof must authenticate before the original spelling
 * is available again. The exact catalog CHECK authenticates its table and
 * column instead. Kind, precision and scale are already a small, bounded,
 * collision-free identity, so spelling them directly is both shorter and
 * stronger than hashing them: recovery can authenticate the declared proof
 * without searching or trusting a lossy digest.
 */
export function decimalConversionConstraintName(
  kind: DecimalStorageKind,
  descriptor: DecimalDescriptor
): string {
  return `viborm_decimal_${kind === "scalar" ? "s" : "l"}_${descriptor.precision}_${descriptor.scale}`;
}

/**
 * "The target domain admits this value UNCHANGED", as a CHECK body.
 *
 * One idea, spelled in each dialect's cast syntax: a cast to the target type
 * rounds a value with too many fractional digits and refuses one with too many
 * integer digits, so a value that survives the cast intact is exactly a value
 * the conversion does not have to change. That is §7.3's rule — "convert only
 * when every value fits", and "no descriptor change rounds existing data" —
 * without a per-digit predicate. PostgreSQL's `numeric` also admits special
 * non-finite values, and `NaN` compares equal to itself, so finiteness is an
 * independent part of the proof. Arrays prove it for every member beside the
 * existing NULL-member refusal, while the outer `column IS NULL` continues to
 * admit a nullable whole list.
 *
 * The type token is the one `decimalColumnType` produced for the target column,
 * array suffix included; nothing here re-spells it.
 */
export function postgresDecimalFitsCheck(
  column: string,
  targetType: string
): string {
  const unchanged = `${column} = ${column}::${targetType}`;
  if (targetType.endsWith("[]")) {
    const hasNoNonFiniteMember = ["NaN", "Infinity", "-Infinity"]
      .map((value) => `array_position(${column}, '${value}'::numeric) IS NULL`)
      .join(" AND ");
    return `${column} IS NULL OR (array_position(${column}, NULL) IS NULL AND ${hasNoNonFiniteMember} AND ${unchanged})`;
  }
  const hasFiniteValue = `${column} NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`;
  return `${column} IS NULL OR (${hasFiniteValue} AND ${unchanged})`;
}

/** {@link postgresDecimalFitsCheck}'s MySQL spelling. */
export function mysqlDecimalFitsCheck(
  column: string,
  targetType: string
): string {
  return `${column} IS NULL OR ${column} = CAST(${column} AS ${targetType})`;
}

/** MySQL's catalog-normalized shape for {@link mysqlDecimalFitsCheck}. */
export function mysqlDecimalFitsCatalogCheck(
  column: string,
  targetType: string
): string {
  return `((${column} is null) or (${column} = cast(${column} as ${targetType})))`;
}

function mysqlDecimalListCheckParts(
  column: string,
  descriptor: DecimalDescriptor
): { readonly rendered: string; readonly normalizedContainer: string } {
  const coefficient = `("0"|"-?[1-9][0-9]{0,${descriptor.precision - 1}}")`;
  return {
    rendered: `CAST(${column} AS CHAR CHARACTER SET utf8mb4)`,
    normalizedContainer: `^.(${coefficient}(, ${coefficient})*)?.$`,
  };
}

/**
 * A MySQL JSON decimal list is already in the target domain without changing
 * one stored byte.
 *
 * MySQL CHECK expressions cannot contain a subquery, so this validates the
 * provider's own normalized JSON rendering as one anchored language. Every
 * member must be a JSON string carrying the canonical coefficient grammar,
 * and the digit bound comes from the narrower descriptor that must remain true
 * across the marker change. `LEFT` and `RIGHT` prove the two brackets while
 * the anchored regular expression uses one character for each. That avoids a
 * backslash whose SQL meaning would depend on `NO_BACKSLASH_ESCAPES`.
 */
export function mysqlDecimalListFitsCheck(
  column: string,
  descriptor: DecimalDescriptor
): string {
  const { rendered, normalizedContainer } = mysqlDecimalListCheckParts(
    column,
    descriptor
  );
  return (
    `${column} IS NULL OR (` +
    `LEFT(${rendered}, 1) = '[' AND RIGHT(${rendered}, 1) = ']' AND ` +
    `REGEXP_LIKE(${rendered}, '${normalizedContainer}', 'c'))`
  );
}

/** MySQL's catalog-normalized shape for {@link mysqlDecimalListFitsCheck}. */
export function mysqlDecimalListFitsCatalogCheck(
  column: string,
  descriptor: DecimalDescriptor
): string {
  const { rendered, normalizedContainer } = mysqlDecimalListCheckParts(
    column,
    descriptor
  );
  const catalogRendered = rendered.replace(
    "CHAR CHARACTER SET",
    "char charset"
  );
  return (
    `((${column} is null) or (` +
    `(${`LEFT(${catalogRendered}, 1)`} = '[') and ` +
    `(${`RIGHT(${catalogRendered}, 1)`} = ']') and ` +
    `${`REGEXP_LIKE(${catalogRendered}, '${normalizedContainer}', 'c')`}))`
  );
}
