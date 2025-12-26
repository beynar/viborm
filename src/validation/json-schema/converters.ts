/**
 * Schema to JSON Schema converters.
 * Handles conversion of VibORM schemas to JSON Schema format.
 */

import type { VibSchema } from "../types";
import type { JsonSchema, ConversionContext, JsonSchemaTarget } from "./types";

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Wrapper schema types that should be traversed to find inner schemas.
 */
const WRAPPER_TYPES = new Set([
  "array",
  "nullable",
  "optional",
  "nonNullable",
  "nonOptional",
  "nonArray",
]);

/**
 * Traverse through wrapper schemas to find the innermost schema.
 * Wrappers include: array, nullable, optional, nonNullable, nonOptional, nonArray
 */
function getInnerSchema(schema: any): any {
  let current = schema;
  while (current && WRAPPER_TYPES.has(current.type)) {
    // array uses 'item', others use 'wrapped'
    current = current.item ?? current.wrapped;
  }
  return current;
}

/**
 * Get the name of a schema by traversing wrappers to find an inner named object.
 * Returns null if no name is found - in that case, the schema should be inlined.
 */
function getSchemaName(schema: any): string | null {
  const inner = getInnerSchema(schema);
  const name = inner?.options?.name;
  return name && typeof name === "string" ? name : null;
}

// =============================================================================
// Main Converter
// =============================================================================

/**
 * Converts a VibORM schema to JSON Schema format.
 *
 * @param schema - The VibORM schema to convert
 * @param context - The conversion context for tracking references
 * @param skipRef - Whether to skip reference lookup (for inline conversion)
 * @returns The converted JSON Schema
 */
export function convertSchema(
  schema: VibSchema<unknown, unknown> & { type: string; [key: string]: unknown },
  context: ConversionContext,
  skipRef = false
): JsonSchema {
  const jsonSchema: JsonSchema = {};

  // Check for existing reference (circular schema support)
  if (!skipRef) {
    const existingRef = context.referenceMap.get(schema);
    if (existingRef) {
      return { $ref: `#/$defs/${existingRef}` };
    }
  }

  // Get schema type
  const schemaType = schema.type as string;

  // Convert based on schema type
  switch (schemaType) {
    // =========================================================================
    // Primitive Schemas
    // =========================================================================

    case "string":
      jsonSchema.type = "string";
      break;

    case "number":
    case "integer":
      jsonSchema.type = schemaType === "integer" ? "integer" : "number";
      break;

    case "boolean":
      jsonSchema.type = "boolean";
      break;

    case "bigint":
      // BigInt maps to integer in JSON Schema
      jsonSchema.type = "integer";
      break;

    case "literal": {
      const value = (schema as any).value;
      if (context.target === "openapi-3.0") {
        // OpenAPI 3.0 doesn't support const, use enum
        jsonSchema.enum = [value];
      } else {
        jsonSchema.const = value;
      }
      break;
    }

    case "enum": {
      const values = (schema as any).values;
      jsonSchema.enum = values;
      break;
    }

    // =========================================================================
    // Wrapper Schemas
    // =========================================================================

    case "nullable": {
      const wrapped = (schema as any).wrapped as VibSchema<unknown, unknown>;
      const wrappedSchema = convertSchema(wrapped as any, context);

      if (context.target === "openapi-3.0") {
        // OpenAPI 3.0 uses nullable property
        Object.assign(jsonSchema, wrappedSchema);
        jsonSchema.nullable = true;
      } else {
        // Use anyOf with null
        jsonSchema.anyOf = [wrappedSchema, { type: "null" }];
      }
      break;
    }

    case "optional": {
      // Optional just passes through - optionality is handled at object level
      const wrapped = (schema as any).wrapped as VibSchema<unknown, unknown>;
      return convertSchema(wrapped as any, context);
    }

    case "array": {
      const item = (schema as any).item as VibSchema<unknown, unknown>;
      jsonSchema.type = "array";
      jsonSchema.items = convertSchema(item as any, context);
      break;
    }

    case "nonNullable":
    case "nonOptional":
    case "nonArray": {
      // These are just type narrowers, pass through to wrapped
      const wrapped = (schema as any).wrapped as VibSchema<unknown, unknown>;
      return convertSchema(wrapped as any, context);
    }

    // =========================================================================
    // Composite Schemas
    // =========================================================================

    case "object": {
      const entries = (schema as any).entries as Record<string, unknown>;
      const options = (schema as any).options as { partial?: boolean; strict?: boolean } | undefined;
      const partial = options?.partial ?? true;
      const strict = options?.strict ?? true;

      jsonSchema.type = "object";
      jsonSchema.properties = {};
      jsonSchema.required = [];

      for (const key in entries) {
        const entry = entries[key];
        const isThunk = typeof entry === "function";

        // Resolve thunks to get the actual schema
        const entrySchema = isThunk
          ? (entry as () => VibSchema<unknown, unknown>)()
          : (entry as VibSchema<unknown, unknown>);

        // Find the inner named object (if any) and pre-register it
        const innerSchema = getInnerSchema(entrySchema);
        const schemaName = innerSchema?.options?.name;

        if (schemaName && typeof schemaName === "string") {
          // Pre-register the inner named object (not the wrapper)
          if (!context.referenceMap.has(innerSchema)) {
            context.referenceMap.set(innerSchema, schemaName);
            // Convert the inner object and add to definitions
            context.definitions[schemaName] = convertSchema(
              innerSchema as any,
              context,
              true
            );
          }
        }

        // Now convert the entry normally - if it hits a registered schema, it will emit $ref
        jsonSchema.properties[key] = convertSchema(entrySchema as any, context);

        // Determine if field is required
        const entryType = (entrySchema as any).type;
        const isOptionalWrapper =
          entryType === "optional" || entryType === "nullish";

        if (!partial && !isOptionalWrapper) {
          jsonSchema.required.push(key);
        }
      }

      // Handle strict mode
      if (strict) {
        jsonSchema.additionalProperties = false;
      }

      // Remove empty required array
      if (jsonSchema.required.length === 0) {
        delete jsonSchema.required;
      }

      break;
    }

    case "record": {
      const valueSchema = (schema as any).value as VibSchema<unknown, unknown>;
      jsonSchema.type = "object";
      jsonSchema.additionalProperties = convertSchema(valueSchema as any, context);
      break;
    }

    case "union": {
      const options = (schema as any).options as VibSchema<unknown, unknown>[];
      jsonSchema.anyOf = options.map((opt) => convertSchema(opt as any, context));
      break;
    }

    // =========================================================================
    // Date Schemas
    // =========================================================================

    case "date":
      jsonSchema.type = "string";
      jsonSchema.format = "date-time";
      break;

    case "iso_timestamp":
      jsonSchema.type = "string";
      jsonSchema.format = "date-time";
      break;

    case "iso_date":
      jsonSchema.type = "string";
      jsonSchema.format = "date";
      break;

    case "iso_time":
      jsonSchema.type = "string";
      jsonSchema.format = "time";
      break;

    // =========================================================================
    // Special Schemas
    // =========================================================================

    case "json":
      // JSON accepts any valid JSON value - empty schema accepts anything
      break;

    case "blob":
      jsonSchema.type = "string";
      jsonSchema.contentEncoding = "base64";
      break;

    case "vector": {
      const dimensions = (schema as any).dimensions as number | undefined;
      jsonSchema.type = "array";
      jsonSchema.items = { type: "number" };
      if (dimensions !== undefined) {
        jsonSchema.minItems = dimensions;
        jsonSchema.maxItems = dimensions;
      }
      break;
    }

    case "point":
      jsonSchema.type = "object";
      jsonSchema.properties = {
        x: { type: "number" },
        y: { type: "number" },
      };
      jsonSchema.required = ["x", "y"];
      jsonSchema.additionalProperties = false;
      break;

    case "instance":
      throw new Error(
        `Cannot convert "instance" schema to JSON Schema: class instances are not JSON-representable`
      );

    case "transform": {
      // Transform wraps another schema - use the wrapped schema for JSON representation
      const wrapped = (schema as any).wrapped as VibSchema<unknown, unknown>;
      return convertSchema(wrapped as any, context);
    }

    case "pipe": {
      // Pipe contains a base schema and actions - use the base schema
      const baseSchema = (schema as any).schema as VibSchema<unknown, unknown>;
      if (baseSchema) {
        return convertSchema(baseSchema as any, context);
      }
      break;
    }

    default:
      throw new Error(
        `Cannot convert "${schemaType}" schema to JSON Schema: unsupported type`
      );
  }

  return jsonSchema;
}

// =============================================================================
// Top-Level Conversion
// =============================================================================

/**
 * Converts a VibORM schema to a complete JSON Schema document.
 *
 * @param schema - The VibORM schema to convert
 * @param target - The target JSON Schema version
 * @returns Complete JSON Schema with $schema and $defs if needed
 */
export function toJsonSchema(
  schema: VibSchema<unknown, unknown>,
  target: JsonSchemaTarget = "draft-07"
): JsonSchema {
  const context: ConversionContext = {
    definitions: {},
    referenceMap: new Map(),
    refCount: 0,
    target,
  };

  const jsonSchema = convertSchema(schema as any, context);

  // Add $schema URI based on target
  if (target === "draft-2020-12") {
    jsonSchema.$schema = "https://json-schema.org/draft/2020-12/schema";
  } else if (target === "draft-07") {
    jsonSchema.$schema = "http://json-schema.org/draft-07/schema#";
  }
  // OpenAPI 3.0 does not use $schema

  // Add definitions if any
  if (Object.keys(context.definitions).length > 0) {
    jsonSchema.$defs = context.definitions;
  }

  return jsonSchema;
}

