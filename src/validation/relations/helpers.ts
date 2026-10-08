import type { AnyModel } from "@schema/model";
import type { RelationState } from "@schema/relation";
import type { TargetGetter } from "@schema/relation/static-membership";
import type { ModelSchemas } from "@validation/model";

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

/** A collection clears its existing membership before adding new members. */
export function refuseCollectionVerbOrder(
  value: Record<string, unknown>
): string | undefined {
  let adding: string | undefined;
  for (const verb of Object.keys(value)) {
    if (value[verb] === undefined) continue;
    if (
      ["upsert", "connectOrCreate", "connect", "create", "createMany"].includes(
        verb
      )
    )
      adding ??= verb;
    else if (
      adding &&
      ["disconnect", "delete", "set", "updateMany", "deleteMany"].includes(verb)
    )
      return `Collection mutation must spell clearing verb '${verb}' before adding verb '${adding}'.`;
  }
  return undefined;
}
