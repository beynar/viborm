/**
 * JSON Schema module for VibORM.
 * Provides StandardJSONSchemaV1 compliance.
 */

// Converters
export { convertSchema, toJsonSchema } from "./converters";
// Factory
export { createJsonSchemaConverter } from "./factory";
// Types
export type {
  ConversionContext,
  JsonSchema,
  JsonSchemaConverter,
  JsonSchemaOptions,
  JsonSchemaTarget,
} from "./types";
export { createContext, SUPPORTED_TARGETS } from "./types";
