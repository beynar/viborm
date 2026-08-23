import type { Model } from "../../model";
import type { AnyRelation } from "../../relation";
import type { Scalar } from "../../scalars/base";

export function getRelationValues(model: Model<any>): AnyRelation[] {
  return Object.values(model["~"].state.relations) as AnyRelation[];
}

export function getScalars(model: Model<any>): [string, Scalar][] {
  return Object.entries(model["~"].state.scalars) as [string, Scalar][];
}
