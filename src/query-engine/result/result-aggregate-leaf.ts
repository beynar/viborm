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
  | { readonly kind: "unknown" };

/**
 * The one semantic classification of an aggregate result leaf. Provider
 * parsing and detached cache encoding must agree on widening and nullability.
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
  if (name === "_avg" && scalar["~"].state.type !== "decimal") {
    return { kind: "number", nullable: true };
  }
  return { kind: "scalar", nullable: true, scalar };
}
