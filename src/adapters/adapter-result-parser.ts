import type { RelationType } from "../schema/relation/types";

export type RelationResultKind = RelationType | "polymorphic";

export interface AdapterResultParser {
  /**
   * When `true`, {@link AdapterResultParser.parseField} performs NO
   * transformation for any scalar type (it is a pure `next()` passthrough) and
   * the provider returns native JS values (text→string, int→number,
   * bool→boolean, float→number). This lets the result parser take an identity
   * fast path for plain string/int/float/boolean columns, skipping the typed
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
   * @param type - Relation type (oneToMany, manyToOne, etc.)
   * @param next - Call to continue with default parsing
   *   - `next()` uses original value
   *   - `next(parsed)` uses the parsed value
   *
   * @returns Parsed relation or result of `next()`
   *
   * @example
   * // Parse JSON strings (MySQL/SQLite)
   * parseRelation: (value, type, next) => {
   *   const parsed = tryParseJsonString(value);
   *   return parsed !== undefined ? next(parsed) : next();
   * }
   */
  parseRelation: (
    value: unknown,
    type: RelationResultKind,
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
