import type { AnyModel } from "@schema/model";
import type { RelationState } from "@schema/relation";
import type { ModelSchemas } from "@validation/model";

export type TargetModel<S extends RelationState> =
  S["getter"] extends () => infer T ? (T extends AnyModel ? T : never) : never;

export type GetTargetSchemas<S extends RelationState> = ModelSchemas<
  TargetModel<S>
>;

type CreateSchemaGetter<S extends RelationState> = (
  state: S
) => () => GetTargetSchemas<S>;

export type SchemaGetter<S extends RelationState> = ReturnType<
  CreateSchemaGetter<S>
>;
