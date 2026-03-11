import { AnyModel } from "@schema/model";
import { GetRelationsSchemas } from "@validation/relations";
import { GetScalarsSchemas } from "@validation/scalars";

export type ModelSchemas<M extends AnyModel, F extends FieldSchemas<M>> = {
  core: CoreSchemas<M, F>;
  args: ArgsSchemas<M, F>;
} & F;
export const getModelSchemas = <M extends AnyModel, F extends FieldSchemas<M>>(
  model: M,
  schemas: F,
) => {
  const core = getCoreSchemas(model, schemas);
  const args = getArgsSchemas(model, schemas, core);
  return {
    core,
    args,
    scalars: schemas.scalars,
    relations: schemas.relations,
  };
};
