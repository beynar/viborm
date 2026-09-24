import type { NativeType } from "@schema/scalars/native-types";
import type { DateTimePhysicalForm } from "@validation/primitives/datetime-physical-codec";
import type { DecimalPhysicalRepresentation } from "@validation/primitives/decimal-codec";
import type {
  IdDomain,
  IdRepresentation,
} from "@validation/primitives/id-codec";

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
   * How this dialect physically spells one identifier DOMAIN on a column that
   * declares the given native type.
   *
   * `"text"` is the whole public string; `"uuid"` the payload as canonical UUID
   * text, which is what a PostgreSQL `uuid` column returns; `"bytes"` the
   * payload's own bytes, in whatever binary shape the driver spells them.
   *
   * A function of the DOMAIN and the field's own native type override, not a
   * constant, because both move the answer: a ULID is `bytea` on PostgreSQL and
   * `BINARY(16)` on MySQL, and a `varchar(26)` override keeps either one text
   * while the domain stays admitted. It is DECLARED and never inferred for the
   * same reason {@link AdapterResultParser.decimalRepresentation} is — sixteen
   * bytes and a 36-character string are the same identifier, and a value cannot
   * be read without knowing which promise produced it.
   *
   * Unset means the dialect stores every domain as text. Every shipped adapter
   * declares it; the option exists so a custom adapter that keeps text columns
   * is a complete adapter.
   */
  idRepresentation?: (
    domain: IdDomain,
    nativeType: NativeType | undefined
  ) => IdRepresentation;

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
   * One OPERATION's raw result, once, before it is decoded.
   *
   * This dialect's chance to reshape what the provider answered for a verb,
   * asked exactly once per operation by `Queries.decodeResult` (Arnaud's D-28)
   * with the operation's own rows — never per statement and never per member.
   * It is a REQUIRED member, and every adapter the estate ships installs the
   * one {@link passThroughParseResult} below for it: a result's MEANING belongs
   * to the engine's decoder, which asks for its own aliases and reads them
   * back, and a VALUE's meaning to {@link AdapterResultParser.parseField} and
   * the scalar codecs one level down. Arnaud's D-40 deleted the two legs that
   * decided otherwise (MySQL's count-column normalisation, PostgreSQL's bigint
   * conversion) after measuring both answering `undefined` on every live
   * operation.
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
   * // Every shipped adapter: the result is the decoder's.
   * parseResult: passThroughParseResult
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

/**
 * The `parseResult` every adapter this estate ships installs: the contract's
 * shape, deciding nothing.
 *
 * ONE object, referenced by the SQLite, MySQL and PostgreSQL adapters, so the
 * answer "this dialect decides nothing about a RESULT" has a single owner
 * rather than three byte-identical members in three files (Arnaud's D-43). It
 * lives beside the member it implements because this is the file where the
 * contract's shape is declared: the required signature and the do-nothing
 * answer to it are then one fact in one place, and the doc above cannot drift
 * from the value below it.
 *
 * It does NOT close the seam. `Queries.decodeResult` still asks the adapter's
 * own `parseResult` once per operation, so an adapter from outside this estate
 * that installs its own — to recover a result whose transport reshaped it —
 * is still asked and still honoured (Arnaud's D-42: the member stays a public
 * extension point). Both facts are pinned together by "the three shipped
 * adapters share one pass-through, and a custom adapter's own is still asked"
 * in `tests/contracts/engine/query/parity-decoding.core.test.ts`.
 */
export const passThroughParseResult: AdapterResultParser["parseResult"] = (
  _raw,
  _operation,
  next
) => next();
