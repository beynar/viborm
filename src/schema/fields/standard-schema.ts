// StandardSchema to VibSchema Bridge
// Allows using any StandardSchema (Zod, Valibot, etc.) as custom validators
import type { StandardSchemaV1 } from "../../standardSchema";
import { VibSchema } from "../../validation";

export type StandardSchemaToSchema<schema extends StandardSchemaV1> = VibSchema<
  StandardSchemaV1.InferInput<schema>,
  StandardSchemaV1.InferOutput<schema>
>;

export const schemaFromStandardSchema = <
  B extends VibSchema,
  schema extends StandardSchemaV1
>(
  _base: B,
  schema: schema
): VibSchema<
  StandardSchemaV1.InferInput<schema>,
  StandardSchemaV1.InferOutput<schema>
> => {
  // Create a custom schema that wraps the StandardSchema validator
  return {
    " vibInferred": undefined as any,
    "~standard": {
      vendor: "viborm",
      version: 1,
      validate: (value: unknown) => {
        const result = schema["~standard"].validate(
          value
        ) as StandardSchemaV1.Result<unknown>;
        if (result.issues) {
          return { issues: result.issues.map((i) => ({ message: String(i) })) };
        }
        return { value: result.value };
      },
    },
  } as VibSchema<
    StandardSchemaV1.InferInput<schema>,
    StandardSchemaV1.InferOutput<schema>
  >;
};
