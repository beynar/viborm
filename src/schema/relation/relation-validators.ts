import { parseWhereManyInput } from "@schema/model/validator";
import { Relation } from "./relation";

const relationFilterMap = {
  is: "is",
  isNot: "isNot",
};

export const parseSingularRelationFilter = (
  relation: Relation,
  input: Record<string, any>
) => {
  return parseWhereManyInput(relation.targetModel, input);
};

export const parsePluralRelationFilter = (
  relation: Relation,
  input: Record<string, any>
) => {
  if (
    ["some", "every", "none"].some((key) => {
      return input[key] !== undefined;
    })
  ) {
    throw new Error("Invalid plural relation filter");
  }

  return {
    some: input.some
      ? parseWhereManyInput(relation.targetModel, input.some)
      : undefined,
    every: input.every
      ? parseWhereManyInput(relation.targetModel, input.every)
      : undefined,
    none: input.none
      ? parseWhereManyInput(relation.targetModel, input.none)
      : undefined,
  };
};
