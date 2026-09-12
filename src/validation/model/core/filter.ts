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

/**
 * One compound selector, with each member taken from the FIELD's own schema.
 *
 * `Model.id([...])` / `.unique([...])` snapshot `state.base` at declaration
 * time, which is the PRE-DOMAIN schema: a `.uuid()` member was validated as a
 * plain string there, so an out-of-domain value crossed the args boundary and
 * an alias was never folded — one row addressed by two cache keys. The member
 * names and their order are the declaration's; what each member ADMITS is the
 * field's, which is where an identifier domain (declared or derived) lives.
 */
/** The per-field schemas a compound member is rebuilt from. */
type CompoundMemberSources = Readonly<
  Record<string, { readonly base: V.Schema } | undefined>
>;

/** One rebuilt selector: the same shape `Model.id([...])` stored, member for member. */
type CompoundSelectorSchema = V.Object<
  Record<string, V.Schema>,
  { readonly partial: false }
>;

const compoundSelector = (
  declared: ObjectSchema<Record<string, V.Schema>>,
  scalars: CompoundMemberSources
): CompoundSelectorSchema => {
  const members: Record<string, V.Schema> = {};
  for (const field of Object.keys(declared.entries)) {
    members[field] = scalars[field]?.base ?? declared.entries[field]!;
  }
  return v.object(members, { partial: false });
};

const compoundSelectors = (
  declared: Record<string, ObjectSchema<Record<string, V.Schema>>> | undefined,
  scalars: CompoundMemberSources
): Record<string, CompoundSelectorSchema> => {
  const selectors: Record<string, CompoundSelectorSchema> = {};
  for (const [name, entry] of Object.entries(declared ?? {})) {
    selectors[name] = compoundSelector(entry, scalars);
  }
  return selectors;
};

export const getCompoundConstraintFilter = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  model: M,
  fieldSchemas: F
): CompoundConstraintFilterSchema<M> => {
  const state = model["~"].state;
  if (!(state.compoundUniques || state.compoundId)) {
    return v.object({}) as CompoundConstraintFilterSchema<M>;
  }
  const scalars = fieldSchemas.scalars as CompoundMemberSources;
  return v.object({
    ...compoundSelectors(state.compoundUniques, scalars),
    ...compoundSelectors(state.compoundId, scalars),
  }) as CompoundConstraintFilterSchema<M>;
};

export type CompoundIdFilterSchema<M extends AnyModel> = V.Object<
  ModelStateOf<M>["compoundId"]
>;
export const getCompoundIdFilter = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  model: M,
  fieldSchemas: F
): CompoundIdFilterSchema<M> => {
  const state = model["~"].state;
  if (!state.compoundId) {
    return v.object({});
  }
  return v.object(
    compoundSelectors(state.compoundId, fieldSchemas.scalars)
  ) as CompoundIdFilterSchema<M>;
};
