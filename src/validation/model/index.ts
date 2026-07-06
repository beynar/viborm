import type { AnyModel } from "@schema/model";
import type { GetRelationsSchemas } from "@validation/relations";
import type { GetScalarsSchemas } from "@validation/scalars";
import { type ArgsSchemas, getArgsSchemas } from "./args";
import { type CoreSchemas, getCoreSchemas } from "./core";

export type { ArgsSchemas } from "./args";
export type { CoreSchemas } from "./core";

export type ScalarSchemas<M extends AnyModel> = {
  scalars: GetScalarsSchemas<M>;
  relations: GetRelationsSchemas<M>;
};

export type AnyScalarSchemas = ScalarSchemas<AnyModel>;

type SchemaInput<S> = S extends { " vibInferred": [infer Input, unknown] }
  ? Input
  : never;

export type ModelSchemas<
  M extends AnyModel,
  F extends ScalarSchemas<M> = ScalarSchemas<M>,
> = {
  core: CoreSchemas<M, F>;
  args: ArgsSchemas<M, F>;
  scalars: F["scalars"];
  relations: F["relations"];
};

export type ModelStateSchemas<M extends AnyModel> = ModelSchemas<
  M,
  ScalarSchemas<M>
>;

export type ModelArgsSchemas<M extends AnyModel> = ModelStateSchemas<M>["args"];

export type ModelCoreSchemas<M extends AnyModel> = ModelStateSchemas<M>["core"];

export type ModelOperationInput<
  M extends AnyModel,
  Operation extends keyof ModelArgsSchemas<M>,
> = SchemaInput<ModelArgsSchemas<M>[Operation]>;

export type ModelCoreInput<
  M extends AnyModel,
  Schema extends keyof ModelCoreSchemas<M>,
> = SchemaInput<ModelCoreSchemas<M>[Schema]>;

export type ModelRelationNestedInput<
  M extends AnyModel,
  Schema extends keyof ModelCoreSchemas<M>,
> = ModelCoreInput<M, Schema>;

export const getModelSchemas = <
  M extends AnyModel,
  F extends ScalarSchemas<M> = ScalarSchemas<M>,
>(
  model: M,
  schemas: F
): ModelSchemas<M, F> => {
  const core = getCoreSchemas(model, schemas);
  const args = getArgsSchemas(model, schemas, core);
  return {
    core,
    args,
    scalars: schemas.scalars,
    relations: schemas.relations,
  };
};
