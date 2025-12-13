// StandardSchema to Zod Bridge
// Allows using any StandardSchema (Zod, Valibot, etc.) as custom validators
import type { StandardSchemaV1 } from "../../standardSchema";
import { core, type ZodMiniType, transform } from "zod/v4-mini";

/**
 * Type helper that converts a StandardSchema type to a Zod type.
 * Preserves input/output type distinction for transforming schemas.
 */
export type StandardSchemaToZod<schema extends StandardSchemaV1> = ZodMiniType<
  StandardSchemaV1.InferInput<schema>,
  StandardSchemaV1.InferOutput<schema>,
  core.$ZodTypeInternals<
    StandardSchemaV1.InferOutput<schema>,
    StandardSchemaV1.InferInput<schema>
  >
>;

/**
 * Converts a StandardSchema validator to a Zod validator.
 * This allows using Zod, Valibot, or any StandardSchema-compliant library
 * as custom field validators.
 *
 * @example
 * ```ts
 * import { string } from "zod/v4-mini";
 * const emailType = zodFromStandardSchema(myEmailStandardSchema);
 * ```
 */

export const zodFromStandardSchema = <schema extends StandardSchemaV1>(
  schema: schema
) =>
  transform((v, ctx) => {
    const result = schema["~standard"].validate(
      v
    ) as StandardSchemaV1.Result<unknown>;

    if (result.issues) {
      for (const { message, path } of result.issues) {
        ctx.issues.push({
          code: "custom",
          message,
          input: v,
        });
      }
      // Return original value; issues will cause validation failure.
      return v as unknown as StandardSchemaV1.InferOutput<schema>;
    }

    return result.value as StandardSchemaV1.InferOutput<schema>;
  }) as StandardSchemaToZod<schema>;
