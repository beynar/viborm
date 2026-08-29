/**
 * Where the query engine reads a decimal field's DOMAIN.
 *
 * The descriptor has one owner — the scalar's own state, frozen at definition
 * and carried by reference through every modifier — so nothing here copies it
 * into a scope, a plan, or a result shape. These are lookups, not a second
 * decimal concept: they answer "is this field an exact decimal, and in which
 * domain", which every predicate, order, aggregate and arithmetic lowering has
 * to know before it can spell exact SQL.
 *
 * This file replaces the old portability gate. There is no dialect refusal left
 * to make: SQLite stores the unscaled integer coefficient, so ordering,
 * aggregation and arithmetic are exact there too, and what used to be a
 * capability question is now a descriptor question.
 */

import type { Model } from "@schema/model";
import type { Scalar } from "@schema/scalars/base";
import type { ScalarState } from "@schema/scalars/common";
import type { DecimalDescriptor } from "@validation/primitives/decimal-codec";

/**
 * The declared domain of a non-list decimal scalar, or `undefined` when the
 * state is not one.
 *
 * A LIST decimal answers `undefined` deliberately: its members are stored in a
 * container, and every scalar path that calls this (comparison, ordering,
 * aggregate, arithmetic) is one a list does not have.
 */
export function decimalDescriptorOfState(
  state: ScalarState | undefined
): DecimalDescriptor | undefined {
  if (state?.type !== "decimal" || state.array === true) return undefined;
  return state.decimal;
}

/** {@link decimalDescriptorOfState} for a resolved scalar. */
export function decimalDescriptorOfScalar(
  scalar: Scalar | undefined
): DecimalDescriptor | undefined {
  return decimalDescriptorOfState(scalar?.["~"].state);
}

/** {@link decimalDescriptorOfState} for a field of a model. */
export function decimalDescriptorOf(
  model: Model<any>,
  fieldName: string
): DecimalDescriptor | undefined {
  return decimalDescriptorOfScalar(model["~"].state.scalars[fieldName]);
}

/**
 * The declared domain of a decimal LIST, or `undefined` when the state is not
 * one.
 *
 * The mirror of {@link decimalDescriptorOfState}, and separate from it for the
 * same reason it excludes lists: a list has no comparison, order, aggregate or
 * arithmetic lowering, and everything it DOES have — the container, its members
 * and its containment candidates — has to know it is a list before it can spell
 * either one. Asking with the wrong shape is what silently binds a member as a
 * whole list or a container as a value.
 */
export function decimalListDescriptorOfState(
  state: ScalarState | undefined
): DecimalDescriptor | undefined {
  if (state?.type !== "decimal" || state.array !== true) return undefined;
  return state.decimal;
}

/**
 * The domain an aggregate's operand is compared in — the ONE owner of the
 * widened `_sum` domain.
 *
 * `_sum` is the one aggregate that legitimately answers OUTSIDE the field's
 * precision — a million `precision: 10` rows add up to more than ten digits —
 * so an operand compared against it is held to the field's SCALE and to its own
 * width, never to the column's precision. Everything else (`_min`, `_max`,
 * `_avg`) answers inside the field's own domain and is checked against it.
 *
 * The widened precision is the operand's own, widened no further than it needs
 * to be: the cast has to hold the operand exactly, and no wider is more correct
 * than any wider.
 *
 * WIDENED IS NOT UNBOUNDED. The adapter first admits the exact coefficient and
 * returns the precision its cast needs. This matters on SQLite, where signed
 * int64 contains only part of the 19-digit domain; digit count alone can neither
 * admit every valid value nor refuse every saturating one.
 */
export function widenedSumDomain(
  descriptor: DecimalDescriptor,
  operandPrecision: number
): DecimalDescriptor {
  return {
    precision: Math.max(descriptor.precision, operandPrecision),
    scale: descriptor.scale,
  };
}

/**
 * Why this provider cannot compare a `_sum` against this refused operand.
 *
 * One sentence naming the field and the operand's own width. The adapter has
 * already established that this exact coefficient is outside its cast domain;
 * the query engine does not reinterpret that provider fact as a digit ceiling.
 */
export function describeWidenedSumRefusal(
  fieldName: string,
  coefficient: string
): string {
  const coefficientDigits = coefficient.startsWith("-")
    ? coefficient.length - 1
    : coefficient.length;
  return (
    `The 'having' _sum operand for decimal field '${fieldName}' needs ${coefficientDigits} coefficient digits, but its value is outside this provider's exact HAVING operand cast domain. ` +
    "The provider may compute a wider sum, but VibORM cannot express this operand through its exact decimal cast without changing or refusing the value written."
  );
}
