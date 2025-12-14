// StandardSchema to Zod Bridge
// Allows using any StandardSchema (Zod, Valibot, etc.) as custom validators
import { BaseSchema, custom } from "valibot";
import type { StandardSchemaV1 } from "../../standardSchema";
import { pipe } from "valibot";
import { AnySchema } from "./common";

export type StandardSchemaToSchema<schema extends StandardSchemaV1> =
  BaseSchema<
    StandardSchemaV1.InferInput<schema>,
    StandardSchemaV1.InferOutput<schema>,
    any
  >;

export const schemaFromStandardSchema = <
  B extends AnySchema,
  schema extends StandardSchemaV1
>(
  base: B,
  schema: schema
) => {
  return pipe(
    base,
    custom<StandardSchemaV1.InferInput<schema>>((input) => {
      const result = schema["~standard"].validate(
        input
      ) as StandardSchemaV1.Result<unknown>;
      if (result.issues) {
        return false;
      }
      return true;
    })
  );
};
