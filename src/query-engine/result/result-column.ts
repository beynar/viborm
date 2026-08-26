import type { Model } from "@schema/model";
import { type AnyRelation, isVariantRelationState } from "@schema/relation";
import type { Scalar } from "@schema/scalars";
import {
  type AggregateResultName,
  EMPTY_ROW_RESULT_KEY,
  getAggregateResultName,
  RELATION_COUNTS_RESULT_KEY,
  VECTOR_DISTANCE_RESULT_KEY,
} from "../result-aliases";
import type {
  ExpectedAggregateResultShape,
  ExpectedPolymorphicResultShape,
  ExpectedRelationResultShape,
  ExpectedResultShape,
} from "../types";

export type ResultColumn =
  | { readonly kind: "empty" }
  | { readonly kind: "vectorDistance" }
  | {
      readonly kind: "scalar";
      readonly key: string;
      readonly scalar: Scalar;
    }
  | {
      readonly kind: "relationCounts";
      readonly relations: ReadonlySet<string> | undefined;
    }
  | {
      readonly kind: "relation";
      readonly key: string;
      readonly relation: AnyRelation;
      readonly expected: ExpectedRelationResultShape | undefined;
    }
  | {
      readonly kind: "polymorphic";
      readonly key: string;
      readonly relation: AnyRelation;
      readonly expected: ExpectedPolymorphicResultShape | undefined;
    }
  | {
      readonly kind: "aggregate";
      readonly name: AggregateResultName;
      readonly expected: ExpectedAggregateResultShape | undefined;
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
  shape: ExpectedResultShape | undefined
): ResultColumn {
  if (key === EMPTY_ROW_RESULT_KEY) return { kind: "empty" };
  if (key === VECTOR_DISTANCE_RESULT_KEY) return { kind: "vectorDistance" };

  const scalars = model["~"].state.scalars;
  const scalar: Scalar | undefined = Object.hasOwn(scalars, key)
    ? scalars[key]
    : undefined;
  if (scalar) return { kind: "scalar", key, scalar };

  if (key === RELATION_COUNTS_RESULT_KEY) {
    return { kind: "relationCounts", relations: shape?.relationCounts };
  }

  const relations = model["~"].state.relations;
  const relation: AnyRelation | undefined = Object.hasOwn(relations, key)
    ? relations[key]
    : undefined;
  if (relation) {
    if (isVariantRelationState(relation["~"].state)) {
      return {
        kind: "polymorphic",
        key,
        relation,
        expected: shape?.polymorphic.get(key),
      };
    }
    return {
      kind: "relation",
      key,
      relation,
      expected: shape?.relations.get(key),
    };
  }

  const name = getAggregateResultName(key);
  if (name) {
    return {
      kind: "aggregate",
      name,
      expected: shape?.aggregates.get(key),
    };
  }

  return { kind: "unknown", key };
}
