import type { AnyModel } from "@schema/model";
import { getCompoundIdSchema, getCompoundUniqueSchemas } from "./compound";
import { getIdSchema } from "./id";
import { getUniqueSchema } from "./unique";

export const getConstraintSchemas = (model: AnyModel) => {
  return {
    unique: getUniqueSchema(model),
    id: getIdSchema(model),
    compoundUnique: getCompoundUniqueSchemas(model),
    compoundId: getCompoundIdSchema(model),
  };
};
