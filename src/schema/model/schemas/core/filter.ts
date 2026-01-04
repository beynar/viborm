import v, { type ObjectSchema } from "@validation";
import type { Field } from "../../../fields/base";
import type { ModelState } from "../../model";

export const getScalarFilter = <T extends ModelState>(state: T) => {
  return v.fromObject(state.scalars, "~.schemas.filter");
};

export const getUniqueFilter = <T extends ModelState>(state: T) => {
  return v.fromObject(state.uniques, "~.schemas.base");
};

export const getRelationFilter = <T extends ModelState>(state: T) => {
  return v.fromObject(state.relations, "~.schemas.filter");
};

/**
 * Build compound constraint filter schema
 * Creates an object schema where each compound key maps to an optional object of field base schemas
 */

type CompoundConstraintFilterSchema<T extends ModelState> =
  T["compoundId"] extends Record<string, Record<string, Field>>
    ? T["compoundUniques"] extends Record<string, Record<string, Field>>
      ? ObjectSchema<T["compoundId"] & T["compoundUniques"]>
      : ObjectSchema<T["compoundId"]>
    : T["compoundUniques"] extends Record<string, Record<string, Field>>
      ? ObjectSchema<T["compoundUniques"]>
      : ObjectSchema<{}, undefined>;

export const getCompoundConstraintFilter = <T extends ModelState>(state: T) => {
  if (!(state.compoundUniques || state.compoundId)) {
    return v.object({}) as CompoundConstraintFilterSchema<T>;
  }
  if (!state.compoundUniques) {
    return v.object(state.compoundId) as CompoundConstraintFilterSchema<T>;
  }
  if (state.compoundId) {
    return v
      .object(state.compoundUniques)
      .extend(state.compoundId) as CompoundConstraintFilterSchema<T>;
  }
  return v.object(state.compoundUniques) as CompoundConstraintFilterSchema<T>;
};

export const getCompoundIdFilter = <T extends ModelState>(state: T) => {
  if (!state.compoundId) {
    return v.object({});
  }
  return v.object(state.compoundId);
};
