import type { Scalar } from "@schema/scalars";
import type { AggregateResultName } from "../result-aliases";

export type AggregateLeaf =
  | { readonly kind: "count"; readonly nullable: false }
  | { readonly kind: "number"; readonly nullable: true }
  | {
      readonly kind: "scalar";
      readonly nullable: true;
      readonly scalar: Scalar;
    }
  | {
      readonly kind: "widenedSum";
      readonly nullable: true;
      readonly scalar: Scalar;
    }
  | { readonly kind: "unknown" };

/**
 * The one semantic classification of an aggregate result leaf. Provider
 * parsing and detached cache encoding must agree on widening and nullability.
 *
 * A decimal `_sum` is its OWN leaf kind because it is the only aggregate that
 * answers outside the column's declared domain: summing a million
 * `precision: 10` rows is exact arithmetic whose result no single column could
 * store, so it keeps the field's scale and drops the field's precision. Every
 * other decimal aggregate stays in the field domain — `_min` and `_max` are
 * stored values, and `_avg` is quantized to the field's scale by the shared
 * half-even rounder before it leaves the database. Reading a sum through the
 * field decoder would refuse a correct answer; reading an average through the
 * widened one would accept a wrong one.
 */
export function classifyAggregateLeaf(
  name: AggregateResultName,
  field: string,
  scalars: Readonly<Record<string, Scalar>>
): AggregateLeaf {
  const scalar: Scalar | undefined = Object.hasOwn(scalars, field)
    ? scalars[field]
    : undefined;
  if (name === "_count") {
    return field === "_all" || scalar
      ? { kind: "count", nullable: false }
      : { kind: "unknown" };
  }
  if (!scalar) return { kind: "unknown" };
  const isDecimal = scalar["~"].state.type === "decimal";
  if (name === "_avg" && !isDecimal) {
    return { kind: "number", nullable: true };
  }
  if (name === "_sum" && isDecimal) {
    return { kind: "widenedSum", nullable: true, scalar };
  }
  return { kind: "scalar", nullable: true, scalar };
}
