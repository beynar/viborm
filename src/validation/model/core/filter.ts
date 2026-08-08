import type { AnyModel } from "@schema/model";
import type { ObjectSchema } from "@validation/primitives/object";
import v, { type V } from "../../primitives/v";
import type { ScalarSchemas } from "../index";

type ModelStateOf<M extends AnyModel> = M["~"]["state"];
type UniqueScalarSchemas<M extends AnyModel, F extends ScalarSchemas<M>> = Pick<
  F["scalars"],
  Extract<keyof F["scalars"], keyof ModelStateOf<M>["uniques"]>
>;

const getUniqueScalarSchemas = <M extends AnyModel, F extends ScalarSchemas<M>>(
  model: M,
  fieldSchemas: F
): UniqueScalarSchemas<M, F> => {
  const uniqueSchemas: Record<PropertyKey, unknown> = {};
  for (const key of Object.keys(model["~"].state.uniques) as Array<
    keyof F["scalars"]
  >) {
    const schema = fieldSchemas.scalars[key];
    if (schema) {
      uniqueSchemas[key] = schema;
    }
  }
  return uniqueSchemas as unknown as UniqueScalarSchemas<M, F>;
};

export type ScalarFilterSchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.FromObject<F["scalars"], "filter">;
export const getScalarFilter = <M extends AnyModel, F extends ScalarSchemas<M>>(
  fieldSchemas: F
): ScalarFilterSchema<M, F> => {
  return v.fromObject(fieldSchemas.scalars, "filter");
};

export type UniqueFilterSchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.FromObject<UniqueScalarSchemas<M, F>, "base">;
export const getUniqueFilter = <M extends AnyModel, F extends ScalarSchemas<M>>(
  model: M,
  fieldSchemas: F
): UniqueFilterSchema<M, F> => {
  return v.fromObject(getUniqueScalarSchemas(model, fieldSchemas), "base");
};

export type RelationFilterSchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.FromObject<F["relations"], "filter">;

export const getRelationFilter = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  fieldSchemas: F
): RelationFilterSchema<M, F> => {
  return v.fromObject(fieldSchemas.relations, "filter");
};

/**
 * Build compound constraint filter schema
 * Creates an object schema where each compound key maps to an optional object of field base schemas
 */

type CompoundConstraintEntries<M extends AnyModel> =
  (ModelStateOf<M>["compoundId"] extends Record<string, ObjectSchema<any>>
    ? ModelStateOf<M>["compoundId"]
    : Record<never, never>) &
    (ModelStateOf<M>["compoundUniques"] extends Record<
      string,
      ObjectSchema<any>
    >
      ? ModelStateOf<M>["compoundUniques"]
      : Record<never, never>);

export type CompoundConstraintFilterSchema<M extends AnyModel> = ObjectSchema<
  CompoundConstraintEntries<M>
>;

export const getCompoundConstraintFilter = <M extends AnyModel>(
  model: M
): CompoundConstraintFilterSchema<M> => {
  const state = model["~"].state;
  if (!(state.compoundUniques || state.compoundId)) {
    return v.object({}) as CompoundConstraintFilterSchema<M>;
  }
  if (!state.compoundUniques) {
    return v.object(state.compoundId) as CompoundConstraintFilterSchema<M>;
  }
  if (state.compoundId) {
    return v
      .object(state.compoundUniques)
      .extend(state.compoundId) as CompoundConstraintFilterSchema<M>;
  }
  return v.object(state.compoundUniques) as CompoundConstraintFilterSchema<M>;
};

export type CompoundIdFilterSchema<M extends AnyModel> = V.Object<
  ModelStateOf<M>["compoundId"]
>;
export const getCompoundIdFilter = <M extends AnyModel>(
  model: M
): CompoundIdFilterSchema<M> => {
  const state = model["~"].state;
  if (!state.compoundId) {
    return v.object({});
  }
  return v.object(state.compoundId);
};
