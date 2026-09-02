import type { Model } from "@schema/model";
import { type AnyRelation, isVariantRelationState } from "@schema/relation";
import type { Scalar } from "@schema/scalars";
import {
  type AggregateResultName,
  DISTANCE_RESULT_KEY,
  EMPTY_ROW_RESULT_KEY,
  getAggregateResultName,
  RELATION_COUNTS_RESULT_KEY,
} from "../result-aliases";
import type {
  ExpectedAggregateResultShape,
  ExpectedPolymorphicResultShape,
  ExpectedRelationResultShape,
  ExpectedResultShape,
} from "../types";

export type ResultColumn =
  | { readonly kind: "empty" }
  | { readonly kind: "distance"; readonly scalar: Scalar | undefined }
  | {
      readonly kind: "scalar";
      readonly key: string;
      readonly scalar: Scalar;
    }
  | {
      readonly kind: "relationCounts";
      readonly relations: ReadonlySet<string>;
    }
  | {
      readonly kind: "relation";
      readonly key: string;
      readonly relation: AnyRelation;
      readonly expected: ExpectedRelationResultShape;
    }
  | {
      readonly kind: "polymorphic";
      readonly key: string;
      readonly relation: AnyRelation;
      readonly expected: ExpectedPolymorphicResultShape;
    }
  | {
      readonly kind: "aggregate";
      readonly name: AggregateResultName;
      readonly expected: ExpectedAggregateResultShape;
    }
  | { readonly kind: "unknown"; readonly key: string };

/**
 * The one semantic classification of a compiled raw result column. SQL aliases
 * are translated to their public result owners here; parsing and detached cache
 * encoding consume the same decision.
 */
export function classifyResultColumn(
  model: Model<any>,
  key: string,
  shape: ExpectedResultShape
): ResultColumn {
  if (key === EMPTY_ROW_RESULT_KEY) return { kind: "empty" };
  if (key === DISTANCE_RESULT_KEY) {
    return { kind: "distance", scalar: shape.distanceScalar };
  }

  const scalars = model["~"].state.scalars;
  const scalar: Scalar | undefined = Object.hasOwn(scalars, key)
    ? scalars[key]
    : undefined;
  if (scalar) return { kind: "scalar", key, scalar };

  if (key === RELATION_COUNTS_RESULT_KEY) {
    return { kind: "relationCounts", relations: shape.relationCounts };
  }

  const relations = model["~"].state.relations;
  const relation: AnyRelation | undefined = Object.hasOwn(relations, key)
    ? relations[key]
    : undefined;
  if (relation) {
    if (isVariantRelationState(relation["~"].state)) {
      const expected = shape.polymorphic.get(key);
      if (!expected) return { kind: "unknown", key };
      return {
        kind: "polymorphic",
        key,
        relation,
        expected,
      };
    }
    const expected = shape.relations.get(key);
    if (!expected) return { kind: "unknown", key };
    return {
      kind: "relation",
      key,
      relation,
      expected,
    };
  }

  const name = getAggregateResultName(key);
  if (name) {
    const expected = shape.aggregates.get(key);
    if (!expected) return { kind: "unknown", key };
    return {
      kind: "aggregate",
      name,
      expected,
    };
  }

  return { kind: "unknown", key };
}
