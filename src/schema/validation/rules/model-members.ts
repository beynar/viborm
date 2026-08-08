import type { Model } from "../../model";
import type { AnyPolymorphicRelation, AnyRelation } from "../../relation";
import type { Scalar } from "../../scalars/base";
import type { ValidationContext } from "../types";

export function getRelations(model: Model<any>): [string, AnyRelation][] {
  return Object.entries(model["~"].state.relations) as [string, AnyRelation][];
}

export function getRelationValues(model: Model<any>): AnyRelation[] {
  return Object.values(model["~"].state.relations) as AnyRelation[];
}

export function getPolymorphicRelations(
  model: Model<any>
): [string, AnyPolymorphicRelation][] {
  return Object.entries(model["~"].state.polymorphicRelations);
}

export function getScalars(model: Model<any>): [string, Scalar][] {
  return Object.entries(model["~"].state.scalars) as [string, Scalar][];
}

export function findModelName(
  context: ValidationContext,
  model: Model<any>
): string | undefined {
  return context.modelToName.get(model);
}
