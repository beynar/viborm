import type { DatabaseAdapter } from "@adapters";
import type { Scalar } from "@schema/scalars";
import {
  type DecimalDescriptor,
  type DecimalPhysicalRepresentation,
  decodePhysicalDecimal,
  decodePhysicalDecimalList,
  decodePhysicalWidenedSum,
  materializePhysicalDecimal,
  materializePhysicalWidenedSum,
} from "@validation/primitives/decimal-codec";
import type Decimal from "decimal.js";

/**
 * The result boundary's half of the one decimal codec.
 *
 * Two facts meet here and nowhere else: the field's declared DOMAIN, read off
 * the resolved scalar the column classification already hands over, and the
 * PHYSICAL spelling the active adapter promised for that column. The codec owns
 * every grammar and conversion; this module owns only routing the adapter's
 * declared representation into that codec.
 */

/**
 * Everything one compiled decimal column needs to route a provider value into
 * the codec. The representation vocabulary itself belongs to that codec.
 */
export interface DecimalColumn {
  readonly descriptor: DecimalDescriptor;
  readonly representation: DecimalPhysicalRepresentation;
}

/**
 * The physical decimal spelling the active ADAPTER promises, defaulting to
 * native decimal text.
 *
 * ONE seam, asked once per compiled field chain, and asked of the adapter
 * because the physical representation is a fact about the dialect's storage —
 * never of the driver's name, which would be the dialect check the layering
 * rule forbids in this directory. `text` is the default because it is what
 * every provider that HAS an exact decimal type returns; an adapter whose
 * column stores the coefficient instead declares so
 * ({@link AdapterResultParser.decimalRepresentation}).
 */
export function decimalRepresentationFor(
  adapter: DatabaseAdapter
): DecimalPhysicalRepresentation {
  return adapter.result.decimalRepresentation === "coefficient"
    ? "coefficient"
    : "text";
}

/**
 * The physical decimal-LIST spelling the active ADAPTER promises, defaulting to
 * a native array of exact decimal text.
 *
 * Its own declaration rather than the scalar's, because a dialect can spell a
 * scalar decimal exactly and still have no exact decimal inside a JSON
 * container: MySQL's `DECIMAL(p,s)` answers with text while its JSON list
 * answers with unscaled coefficient strings. `coefficient` therefore also
 * carries the CONTAINER's shape — one JSON text document rather than one array
 * member per value — because on every provider that has to spell members as
 * coefficients, the reason it does is that the list is JSON.
 */
export function decimalListRepresentationFor(
  adapter: DatabaseAdapter
): DecimalPhysicalRepresentation {
  return adapter.result.decimalListRepresentation === "coefficient"
    ? "coefficient"
    : "text";
}

/**
 * The compiled decimal facts of one scalar column, or `undefined` when the
 * scalar is not a decimal — or is one whose declared domain never reached its
 * state, which is the same thing at a result boundary: without a precision and
 * scale there is no domain to hold a provider value to, and a value nothing can
 * be held to is not one this parser may hand back.
 */
export function decimalColumnFor(
  scalar: Scalar,
  adapter: DatabaseAdapter
): DecimalColumn | undefined {
  const state = scalar["~"].state;
  if (state.type !== "decimal") return undefined;
  const descriptor = state.decimal;
  if (!descriptor) return undefined;
  // A LIST column takes the LIST vocabulary. One compiled fact per column, and
  // the column's arity is what decides which promise applies to it.
  const representation =
    state.array === true
      ? decimalListRepresentationFor(adapter)
      : decimalRepresentationFor(adapter);
  return { descriptor, representation };
}

/**
 * The canonical private value of one physical decimal, or `undefined` when the
 * provider returned something outside the promised vocabulary or outside the
 * column's declared domain.
 *
 * It never falls back to `Number`, never accepts a caller- or provider-owned
 * `Decimal`, and never accepts the `bigint` an unconfigured SQLite driver hands
 * back for an INTEGER column: both codec entries below are string-gated, so a
 * driver that returns anything else must be reconfigured rather than
 * accommodated.
 */
export function decodeDecimalValue(
  value: unknown,
  column: DecimalColumn
): string | undefined {
  return decodePhysicalDecimal(value, column.descriptor, column.representation);
}

/** The one fresh public value of an admitted physical decimal scalar. */
export function materializeDecimalValue(
  value: unknown,
  column: DecimalColumn
): Decimal | undefined {
  return materializePhysicalDecimal(
    value,
    column.descriptor,
    column.representation
  );
}

/**
 * The canonical private members of one physical decimal LIST, in order and with
 * multiplicity preserved — or `undefined` when the container is not one this
 * codec wrote, or holds a member outside the column's declared domain.
 *
 * The whole container goes through the codec, and the generic list decode never
 * sees it (plan 6.3): a JSON parse followed by a per-member scalar rule would
 * give a second reader a chance to interpret `[120]` as a number, `[null]` as
 * an absent element, or `{"0":"120"}` as an array — and the numeric token is
 * exactly the spelling that rounds past 2^53.
 *
 * The codec checks both the container grammar and the field domain. This module
 * does not interpret a member.
 */
export function decodeDecimalListValue(
  value: unknown,
  column: DecimalColumn
): string[] | undefined {
  return decodePhysicalDecimalList(
    value,
    column.descriptor,
    column.representation
  );
}

/**
 * The canonical private value of one physical aggregate SUM.
 *
 * A sum keeps the field's SCALE and is deliberately not held to its precision:
 * adding a million `precision: 10` rows produces a legitimate answer wider than
 * any single column, and refusing it would be refusing arithmetic the database
 * performed exactly.
 */
export function decodeWidenedSumValue(
  value: unknown,
  column: DecimalColumn
): string | undefined {
  return decodePhysicalWidenedSum(
    value,
    column.descriptor,
    column.representation
  );
}

/** The one fresh public value of an admitted widened SUM. */
export function materializeWidenedSumValue(
  value: unknown,
  column: DecimalColumn
): Decimal | undefined {
  return materializePhysicalWidenedSum(
    value,
    column.descriptor,
    column.representation
  );
}
