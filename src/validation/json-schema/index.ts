/**
 * JSON Schema module for VibORM.
 * Provides StandardJSONSchemaV1 compliance.
 */

// Types
export type {
  JsonSchema,
  JsonSchemaTarget,
  JsonSchemaOptions,
  JsonSchemaConverter,
  ConversionContext,
} from "./types";

export { SUPPORTED_TARGETS, createContext } from "./types";

// Converters
export { convertSchema, toJsonSchema } from "./converters";

// Factory
export { createJsonSchemaConverter } from "./factory";
