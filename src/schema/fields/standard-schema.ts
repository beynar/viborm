// StandardSchema to ArkType Bridge
// Allows using any StandardSchema (Zod, Valibot, etc.) as custom validators
import type { StandardSchemaV1 } from "../../standardSchema";
import { type, type Out, Type } from "arktype";

/**
 * Type helper that converts a StandardSchema type to an ArkType type
 * Preserves input/output type distinction for transforming schemas
 */
export type StandardSchemaToArkType<
  schema extends StandardSchemaV1,
  i = StandardSchemaV1.InferInput<schema>,
  o = StandardSchemaV1.InferOutput<schema>
> = [i, o] extends [o, i] ? Type<i> : Type<(In: i) => Out<o>>;

/**
 * Converts a StandardSchema validator to an ArkType validator
 * This allows using Zod, Valibot, or any StandardSchema-compliant library
 * as custom field validators while keeping ArkType as the core.
 *
 * @example
 * ```ts
 * import z from "zod";
 * const emailType = typeFromStandardSchema(z.string().email());
 * ```
 */
export const typeFromStandardSchema = <schema extends StandardSchemaV1>(
  schema: schema
): StandardSchemaToArkType<schema> =>
  type.unknown.pipe((v, ctx) => {
    const result = schema["~standard"].validate(
      v
    ) as StandardSchemaV1.Result<unknown>;

    if (result.issues) {
      for (const { message, path } of result.issues) {
        if (path) {
          ctx.error({
            message: message,
            path: path.map((k) => (typeof k === "object" ? k.key : k)),
          });
        } else {
          ctx.error({
            message,
          });
        }
      }
    } else {
      return result.value;
    }
  }) as never;
