/**
 * Factory for creating JSON Schema converters.
 * Each schema gets its own jsonSchema property with input/output methods.
 */

import type { VibSchema } from "../types";
import { toJsonSchema } from "./converters";
import type { JsonSchemaConverter, JsonSchemaOptions } from "./types";

/**
 * Creates a JSON Schema converter for a VibORM schema.
 * The converter provides `input` and `output` methods that generate
 * JSON Schema representations of the schema's input and output types.
 *
 * @param schema - The VibORM schema to create a converter for
 * @returns A JsonSchemaConverter with input and output methods
 */
export function createJsonSchemaConverter(
  schema: VibSchema<unknown, unknown>
): JsonSchemaConverter {
  return {
    input(options: JsonSchemaOptions): Record<string, unknown> {
      // For input type, we use the same conversion
      // (VibORM doesn't have separate input/output transformations at schema level)
      return toJsonSchema(schema, options.target) as Record<string, unknown>;
    },

    output(options: JsonSchemaOptions): Record<string, unknown> {
      // For output type, we use the same conversion
      // (VibORM doesn't have separate input/output transformations at schema level)
      return toJsonSchema(schema, options.target) as Record<string, unknown>;
    },
  };
}
