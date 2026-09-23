/**
 * The engine's decimal seam: every place Raptor 3 hands a value to the
 * central decimal codec, in one decimal-named module.
 *
 * The codec owns what an exact decimal is. This module owns what the engine
 * adds when it asks: which codec entry a traversal takes (a bound literal, a
 * list member, a widened `_sum`, an internal or a public result), the
 * provider's representation with its one default, and the engine's sentence
 * for a value the codec refuses. The query owner reaches the codec only
 * through here, so the census that reads every decimal module in full reads
 * this one, and the owner's integer, date and JSON readers stay outside a
 * decimal region — the shape the retired engine kept with its
 * `decimal-result-decode` and `decimal-field` modules.
 */
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { QueryEngineError } from "@errors";
import type { ScalarState } from "@schema/scalars/common";
import {
  canonicalizeDecimal,
  type DecimalDescriptor,
  decodePhysicalDecimal,
  decodePhysicalDecimalList,
  decodePhysicalWidenedSum,
  encodePhysicalDecimalListMembers,
  logicalToCoefficient,
  materializePhysicalDecimal,
  materializePhysicalWidenedSum,
  sameDecimalDescriptor,
  toDecimal,
} from "@validation/primitives/decimal-codec";

export type { DecimalDescriptor } from "@validation/primitives/decimal-codec";

/** The provider's result contract, where its decimal spellings are declared. */
type ResultContract = DatabaseAdapter["result"];

/**
 * The declared domain of an exact decimal COLUMN, or `undefined` when the state
 * is not one. A list answers `undefined`: its members live in a container and
 * the scalar comparison this domain governs is not one a list has.
 */
export function exactDecimalDomain(
  state: ScalarState
): DecimalDescriptor | undefined {
  return state.type === "decimal" && state.array !== true
    ? state.decimal
    : undefined;
}

/** The declared domain a decimal field must carry before a value can bind. */
export function requireDecimal(
  state: ScalarState,
  field: string
): DecimalDescriptor {
  if (!state.decimal)
    throw new QueryEngineError(
      `Decimal field '${field}' has no declared precision and scale, so it has no exact value to bind.`
    );
  return state.decimal;
}

/** One bound decimal, canonical, or the binder's refusal. */
export function canonicalDecimal(value: unknown, field: string): string {
  const canonical = canonicalizeDecimal(value);
  if (canonical === undefined)
    throw new QueryEngineError(
      `Decimal field '${field}' received a value that is not an exact decimal.`
    );
  return canonical;
}

/** The members of a bound decimal list, in the provider's list spelling. */
export function decimalMembers(
  state: ScalarState,
  values: readonly unknown[],
  field: string,
  result: ResultContract
): string[] {
  const members = encodePhysicalDecimalListMembers(
    values,
    requireDecimal(state, field),
    result.decimalListRepresentation ?? "text"
  );
  if (members === undefined)
    throw new QueryEngineError(
      `Decimal list '${field}' received a member that is not an exact decimal.`
    );
  return members;
}

/** Whether an arithmetic operand is the exact zero no provider may divide by. */
export function dividesByZero(by: unknown): boolean {
  return canonicalizeDecimal(by) === "0";
}

/** Two exact decimal columns compare only in one declared domain. */
export function sameDecimalDomain(
  own: DecimalDescriptor,
  other: DecimalDescriptor
): boolean {
  return sameDecimalDescriptor(own, other);
}

/**
 * A `having` `_sum` operand: its canonical form and its coefficient at the
 * domain's scale, or `undefined` when the value is not an exact decimal.
 */
export function decimalSumOperand(
  value: unknown,
  domain: DecimalDescriptor
): { readonly canonical: string; readonly coefficient: string } | undefined {
  const canonical = canonicalizeDecimal(value);
  if (canonical === undefined) return undefined;
  return {
    canonical,
    coefficient: logicalToCoefficient(canonical, domain.scale),
  };
}

/**
 * One decimal result cell: a widened `_sum` keeps the field scale and drops
 * its precision; an internal read keeps the codec's form, a public one
 * materializes the Decimal. `undefined` is the codec's refusal.
 */
export function decodeDecimalScalar(
  value: unknown,
  descriptor: DecimalDescriptor,
  widened: boolean,
  internal: boolean,
  result: ResultContract
): unknown {
  const representation = result.decimalRepresentation ?? "text";
  if (widened)
    return internal
      ? decodePhysicalWidenedSum(value, descriptor, representation)
      : materializePhysicalWidenedSum(value, descriptor, representation);
  return internal
    ? decodePhysicalDecimal(value, descriptor, representation)
    : materializePhysicalDecimal(value, descriptor, representation);
}

/** One decimal list result cell; `undefined` is the codec's refusal. */
export function decodeDecimalList(
  value: unknown,
  descriptor: DecimalDescriptor,
  internal: boolean,
  result: ResultContract
): unknown[] | undefined {
  const members = decodePhysicalDecimalList(
    value,
    descriptor,
    result.decimalListRepresentation ?? "text"
  );
  if (members === undefined) return undefined;
  return internal ? members : members.map((member) => toDecimal(member));
}
