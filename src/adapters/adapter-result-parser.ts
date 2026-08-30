import type { NativeType } from "@schema/scalars/native-types";
import type { DateTimePhysicalForm } from "@validation/primitives/datetime-physical-codec";
import type { DecimalPhysicalRepresentation } from "@validation/primitives/decimal-codec";

export interface AdapterResultParser {
  /**
   * How this dialect physically spells a decimal on the way back.
   *
   * `"coefficient"` means the column stores (and therefore returns) the signed
   * unscaled integer, cast to text before a driver can round an int64 into a
   * double — the SQLite family, which has no exact decimal type. Every other
   * provider returns native exact decimal text, which is the default when this
   * is unset.
   *
   * It is DECLARED and never inferred: at scale 2 the text `"120"` is logical
   * 120 in one vocabulary and logical 1.2 in the other, so a value cannot be
   * read without knowing which promise produced it. Declaring it on the adapter
   * is also what keeps the result parser from asking a dialect question, which
   * the layering rule forbids.
   */
  decimalRepresentation?: DecimalPhysicalRepresentation;

  /**
   * How this dialect physically spells a decimal LIST on the way back.
   *
   * `"coefficient"` means the column holds a JSON array of unscaled coefficient
   * STRINGS, read back as the container text — JSON has no exact decimal, and a
   * numeric token would already have been rounded past 2^53 by JavaScript or D1
   * (plan 6.1). Unset means the column is a native decimal array whose members
   * arrive as exact decimal text, one JavaScript array member each.
   *
   * A SEPARATE declaration from {@link AdapterResultParser.decimalRepresentation}
   * because the two genuinely differ: MySQL's scalar column is `DECIMAL(p,s)`
   * and answers with text while its list column is JSON and answers with
   * coefficients. Deriving one from the other would decode every MySQL list
   * member at the wrong scale, and the two spellings are indistinguishable by
   * inspection — at scale 2 the member `"120"` is 120 in one and 1.2 in the
   * other.
   */
  decimalListRepresentation?: DecimalPhysicalRepresentation;

  /**
   * How this dialect physically spells a datetime column that DECLARES the given
   * native type. Unset means timestamp text for every field, which is what every
   * dialect with a temporal column type stores.
   *
   * A function rather than a value because this promise is per FIELD, not per
   * dialect: SQLite has no temporal type at all, so `s.dateTime()` accepts a
   * declaration choosing between TEXT, an INTEGER count of epoch milliseconds
   * and a REAL Julian day, and the DDL already builds the column that way. The
   * adapter is asked because the declaration is dialect vocabulary — a
   * PostgreSQL native type reaching a SQLite adapter describes no column here
   * and answers `"text"` like an undeclared field.
   *
   * It is DECLARED and never inferred for the same reason
   * {@link AdapterResultParser.decimalRepresentation} is: the number
   * `2460324.9375` is one instant as a Julian day and a completely different one
   * as milliseconds, so a value cannot be read without knowing which promise
   * produced it.
   */
  dateTimeRepresentation?: (
    nativeType: NativeType | undefined
  ) => DateTimePhysicalForm;

  /**
   * How this dialect physically spells an enum LIST on the way back.
   *
   * `"arrayText"` means the column is a native enum array whose element type no
   * driver's result-type table knows, so the provider answers the array's own
   * text (`{ADMIN,USER}`) — PostgreSQL. Unset means the column is the dialect's
   * JSON list container and the members arrive through the JSON reading like
   * every other list.
   *
   * It is DECLARED and never inferred for the same reason
   * {@link AdapterResultParser.decimalRepresentation} is: the two spellings
   * collide on the empty container — `{}` is an empty PostgreSQL array AND a
   * valid JSON object — so a value cannot be read without knowing which promise
   * produced it, and reading array text on a JSON dialect would accept
   * malformed rows every other list type refuses.
   */
  enumListRepresentation?: "arrayText";

  /**
   * When `true`, {@link AdapterResultParser.parseField} performs NO
   * transformation for any scalar type (it is a pure `next()` passthrough) and
   * the provider returns native JS values (text→string, int→number,
   * bool→boolean, float→number). This lets the result parser take an identity
   * fast path for plain string/int/number/boolean columns, skipping the typed
   * decode switch. The path stays byte-identical: a per-value guard defers any
   * non-native value back to the full parser. Adapters that coerce field values
   * (MySQL/SQLite: 0/1→boolean, JSON-as-text, …) leave this unset.
   */
  nativeScalarPassthrough?: boolean;

  /**
   * Parse operation result (count, aggregate, etc.)
   *
   * @param raw - Raw database result
   * @param operation - Query operation type
   * @param next - Call to continue with default parsing
   *   - `next()` uses original raw value
   *   - `next(transformed)` uses the transformed value
   *
   * @returns Parsed result or result of `next()`
   *
   * @example
   * // Normalize COUNT(*) column name
   * parseResult: (raw, op, next) => {
   *   if (op === 'count') {
   *     const normalized = normalizeCountResult(raw);
   *     if (normalized) return next(normalized);
   *   }
   *   return next();
   * }
   */
  parseResult: (
    raw: unknown,
    operation: import("../query-engine/types").Operation,
    next: (value?: unknown) => unknown
  ) => unknown;

  /**
   * Parse relation value (nested JSON from includes)
   *
   * @param value - Raw relation value from database
   * @param next - Call to continue with default parsing
   *   - `next()` uses original value
   *   - `next(parsed)` uses the parsed value
   *
   * @returns Parsed relation or result of `next()`
   *
   * @example
   * // Parse JSON strings (MySQL/SQLite)
   * parseRelation: (value, next) => {
   *   const parsed = tryParseJsonString(value);
   *   return parsed !== undefined ? next(parsed) : next();
   * }
   */
  parseRelation: (
    value: unknown,
    next: (value?: unknown) => unknown
  ) => unknown;

  /**
   * Parse field value by type
   *
   * @param value - Raw field value from database
   * @param scalarType - Scalar type (boolean, datetime, bigint, etc.)
   * @param next - Pass a value to the query engine's strict scalar parser
   *   - `next()` uses original value
   *   - `next(converted)` uses the converted value
   *
   * @returns Decoded field value. The query engine strictly parses it once.
   *
   * @example
   * // Convert 0/1 to boolean (SQLite/MySQL)
   * parseField: (value, scalarType, next) => {
   *   if (scalarType !== 'boolean') return next();
   *   const bool = parseIntegerBoolean(value);
   *   return bool === undefined ? next() : next(bool);
   * }
   */
  parseField: (
    value: unknown,
    scalarType: string,
    next: (value?: unknown) => unknown
  ) => unknown;
}
