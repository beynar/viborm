import type { AnyModel } from "@schema/model";
import type { RelationState } from "@schema/relation";
import type { TargetGetter } from "@schema/relation/static-membership";
import type { ModelSchemas } from "@validation/model";
import v, { type V } from "../primitives/v";
import type { VibSchema } from "../types";

/**
 * The one model a MODEL-target relation names. A variant target names several,
 * and its schema families reach them through their own entry map instead.
 */
export type TargetModel<S extends RelationState> =
  TargetGetter<S> extends () => infer T
    ? T extends AnyModel
      ? T
      : never
    : never;

export type GetTargetSchemas<S extends RelationState> = ModelSchemas<
  TargetModel<S>
>;

type CreateSchemaGetter<S extends RelationState> = (
  state: S
) => () => GetTargetSchemas<S>;

export type SchemaGetter<S extends RelationState> = ReturnType<
  CreateSchemaGetter<S>
>;

/**
 * The schemas of the declared model holding a slot's junction, where one does:
 * `$through` reads, filters and writes that model's scalars through them.
 */
export type JunctionSchemas = (() => ModelSchemas<AnyModel>) | undefined;

/**
 * The scalars of a link row a `$through` filter may test: each field's own
 * filter, and nothing else, so a relation inside it is an unknown key.
 */
export type LinkFilterSchema<M extends AnyModel> = V.Object<
  V.FromObject<ModelSchemas<M>["scalars"], "filter">["entries"]
>;

/** A target's `where` with `$through` beside it, the input it adds and no more. */
export type WhereWithLinkFilter<
  Where extends VibSchema<any, any>,
  M extends AnyModel,
> = VibSchema<
  Where[" vibInferred"]["0"] & {
    $through?: LinkFilterSchema<M>[" vibInferred"]["0"];
  },
  Where[" vibInferred"]["1"]
>;

/**
 * A target's `where` as a slot reads it: the target's own, shared by every slot
 * reaching that model, and with `$through` beside it on a declared junction. A
 * thunk, because the target's schemas are built only once something asks.
 */
export const whereWithLinkFilter = (
  own: () => VibSchema<any, any>,
  junctionSchemas: JunctionSchemas
): (() => VibSchema<any, any>) => {
  if (!junctionSchemas) return own;
  let linked: VibSchema<any, any> | undefined;
  return () => {
    linked ??= (own() as V.Object<any, any>).extend({
      $through: v.object(
        v.fromObject(junctionSchemas().scalars as never, "filter").entries
      ),
    });
    return linked;
  };
};
