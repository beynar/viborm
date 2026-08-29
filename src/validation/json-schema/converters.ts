/**
 * Schema to JSON Schema converters.
 * Handles conversion of VibORM schemas to JSON Schema format.
 */

import { ValidationError } from "@errors";
import type { DecimalSchema } from "../primitives/decimal";
import {
  GEO_BOUNDS_KEYS,
  GEO_POLYGON_MIN_RING_POINTS,
} from "../primitives/geo-area-codec";
import {
  GEO_LATITUDE_MAX,
  GEO_LATITUDE_MIN,
  GEO_LONGITUDE_MAX,
  GEO_LONGITUDE_MIN,
  GEO_POINT_KEYS,
} from "../primitives/geo-point-codec";
import type { ExactlyOneSchema } from "../scalars/decimal";
import type { VibSchema } from "../types";
import { isFunction, isString } from "../value-guards";
import type {
  ConversionContext,
  ConversionFrame,
  JsonSchema,
  JsonSchemaTarget,
} from "./types";
import { createContext, SUPPORTED_TARGETS } from "./types";

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Wrapper schema types that should be traversed to find inner schemas.
 */
const WRAPPER_TYPES = new Set(["array", "nullable", "optional", "lazyRef"]);
const DECIMAL_INPUT_PATTERN = "^[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)$";
const DECIMAL_OUTPUT_PATTERN =
  "^(?:0|-?(?:[1-9]\\d*(?:\\.\\d*[1-9])?|0\\.\\d*[1-9]))$";

function geoPointJsonSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      [GEO_POINT_KEYS[0]]: {
        type: "number",
        minimum: GEO_LONGITUDE_MIN,
        maximum: GEO_LONGITUDE_MAX,
      },
      [GEO_POINT_KEYS[1]]: {
        type: "number",
        minimum: GEO_LATITUDE_MIN,
        maximum: GEO_LATITUDE_MAX,
      },
    },
    required: [...GEO_POINT_KEYS],
    additionalProperties: false,
  };
}

function geoBoundsJsonSchema(): JsonSchema {
  const latitude = {
    type: "number" as const,
    minimum: GEO_LATITUDE_MIN,
    maximum: GEO_LATITUDE_MAX,
  };
  const longitude = {
    type: "number" as const,
    minimum: GEO_LONGITUDE_MIN,
    maximum: GEO_LONGITUDE_MAX,
  };
  return {
    type: "object",
    properties: {
      [GEO_BOUNDS_KEYS[0]]: latitude,
      [GEO_BOUNDS_KEYS[1]]: longitude,
      [GEO_BOUNDS_KEYS[2]]: latitude,
      [GEO_BOUNDS_KEYS[3]]: longitude,
    },
    required: [...GEO_BOUNDS_KEYS],
    additionalProperties: false,
  };
}

type ConvertibleExactOneSchema = ExactlyOneSchema<
  Record<
    string,
    VibSchema<unknown, unknown> | (() => VibSchema<unknown, unknown>)
  >
>;

type ConvertibleDecimalSchema = DecimalSchema<unknown, unknown> & {
  readonly options:
    | (NonNullable<DecimalSchema["options"]> & {
        readonly array?: boolean | undefined;
        readonly nullable?: boolean | undefined;
      })
    | undefined;
};

/** Internal schema tags are the discriminants for their complete metadata. */
function isDecimalSchema(
  schema: VibSchema<unknown, unknown>
): schema is ConvertibleDecimalSchema {
  return schema.type === "decimal";
}

function isExactOneSchema(
  schema: VibSchema<unknown, unknown>
): schema is ConvertibleExactOneSchema {
  return schema.type === "exact_one";
}

/**
 * Traverse through wrapper schemas to find the innermost schema.
 * Wrappers include: array, nullable, optional
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
 * The `$ref` value for an open frame something has just referred back to,
 * allocating it on first use.
 *
 * A cycle back to the document ROOT is the whole document, so it is spelled
 * `#` and hoists nothing. Anything else gets a `$defs` entry: a schema that
 * declares a name keeps it, an anonymous one — every recursive scalar filter,
 * whose `not` arm points back at the filter object itself — gets a generated
 * one. The key is reserved immediately so a second, concurrently-open frame
 * cannot claim it; the placeholder is overwritten with the real body when the
 * frame completes.
 */
function framePointer(
  frame: ConversionFrame,
  context: ConversionContext
): string {
  if (frame.pointer !== null) {
    return frame.pointer;
  }

  if (frame.schema === context.rootSchema) {
    frame.pointer = "#";
    return frame.pointer;
  }

  const declared = (frame.schema as { options?: { name?: string } }).options
    ?.name;
  let name = declared === "" ? undefined : declared;

  while (name === undefined || name in context.definitions) {
    context.refCount += 1;
    name = `Recursive${context.refCount}`;
  }

  frame.name = name;
  frame.pointer = `#/$defs/${name}`;
  // Reserve the key; the body lands here when the frame finishes converting.
  context.definitions[name] = {};
  return frame.pointer;
}

// =============================================================================
// Main Converter
// =============================================================================

/**
 * Converts a VibORM schema to JSON Schema format.
 *
 * Cycle-aware: a schema graph may point back at itself (a scalar filter's
 * `not` arm is the filter itself, a model's `where` comes back round through
 * `AND`/`OR`/`NOT`). JSON Schema expresses that with `$ref`, so a schema
 * reached again while its own conversion is still open emits a reference —
 * `#` when it is the document root, otherwise a `$defs` entry holding its
 * body. A schema nothing points back at is unaffected: it is still inlined,
 * byte for byte as before.
 *
 * @param schema - The VibORM schema to convert
 * @param context - The conversion context for tracking references
 * @param skipRef - Whether to skip reference lookup (for inline conversion)
 * @returns The converted JSON Schema
 */
export function convertSchema(
  schema: VibSchema<unknown, unknown>,
  context: ConversionContext,
  skipRef = false
): JsonSchema {
  if (!skipRef) {
    // Check for existing reference (circular schema support)
    const existingRef = context.referenceMap.get(schema);
    if (existingRef) {
      return { $ref: `#/$defs/${existingRef}` };
    }

    // Reached a schema that is still being converted further up the stack:
    // the graph is cyclic. Close it with a $ref rather than recursing forever.
    const openFrame = context.activeFrames.get(schema);
    if (openFrame) {
      return { $ref: framePointer(openFrame, context) };
    }
  }

  const shadowed = context.activeFrames.get(schema);
  const frame: ConversionFrame = { schema, pointer: null, name: null };
  context.activeFrames.set(schema, frame);

  let body: JsonSchema;
  try {
    body = convertSchemaBody(schema, context);
  } finally {
    if (shadowed) {
      context.activeFrames.set(schema, shadowed);
    } else {
      context.activeFrames.delete(schema);
    }
  }

  if (frame.name === null) {
    // Either nothing pointed back at this schema, or it IS the document root
    // and the back-references already say `#`. Either way it stays inline.
    return body;
  }

  context.definitions[frame.name] = body;
  // Later occurrences of the same schema reuse the definition instead of
  // re-emitting the body.
  context.referenceMap.set(schema, frame.name);
  return { $ref: frame.pointer as string };
}

/**
 * The per-type conversion itself. Never call this directly — {@link convertSchema}
 * wraps it with the cycle bookkeeping every recursive schema depends on.
 */
function convertSchemaBody(
  schema: VibSchema<unknown, unknown>,
  context: ConversionContext
): JsonSchema {
  const jsonSchema: JsonSchema = {};

  if (isDecimalSchema(schema)) {
    // A decimal accepts a `Decimal`, a string, or a number, and validates to
    // the canonical string. A `Decimal` object has no JSON Schema because a
    // class instance is not a JSON value; its own `toJSON()` produces the
    // string arm.
    //
    // The DECLARED DOMAIN is NOT expressible here and is stated rather than
    // silently dropped. `precision` counts the SIGNIFICANT digits of the
    // unscaled coefficient and `scale` the significant fractional digits, and
    // both are counted AFTER canonicalization — `"1.500"` fits a scale-2
    // field because it names 1.5. A `pattern` counting raw digits would
    // therefore refuse values this schema accepts, which is a worse lie than
    // an unexpressed bound.
    const options = schema.options;
    const domain = options?.decimal;
    if (domain) {
      jsonSchema.description = `Exact decimal with at most ${domain.precision} total digits and at most ${domain.scale} fractional digits`;
    }
    if (context.direction === "output") {
      jsonSchema.type = "string";
      // Output is the codec's ONE canonical spelling, not the broader literal
      // grammar accepted on input: no leading plus/zero, dangling point,
      // trailing fractional zero, or signed zero survives validation.
      jsonSchema.pattern = DECIMAL_OUTPUT_PATTERN;
    } else {
      jsonSchema.anyOf = [
        { type: "string", pattern: DECIMAL_INPUT_PATTERN },
        { type: "number" },
      ];
    }

    // Scalar options compose arity and nullability inside `v.decimal(...)`
    // rather than through standalone wrapper schemas. Project them here at the
    // same owner, or a decimal-list/nullable validator and its JSON Schema
    // describe different value families.
    const withArity: JsonSchema = options?.array
      ? { type: "array", items: jsonSchema }
      : jsonSchema;
    if (!options?.nullable) return withArity;
    if (context.target === "openapi-3.0") {
      return { ...withArity, nullable: true };
    }
    return { anyOf: [withArity, { type: "null" }] };
  }

  if (isExactOneSchema(schema)) {
    // Decimal updates own one runtime rule: exactly one declared operation.
    // Each JSON arm carries and requires only its selected property, so a
    // two-key bag cannot satisfy any arm.
    const arms: JsonSchema[] = [];
    for (const [key, entry] of Object.entries(schema.entries)) {
      const entrySchema = isFunction<() => VibSchema<unknown, unknown>>(entry)
        ? entry()
        : entry;
      // A refused entry exists only to give an untyped runtime caller a useful
      // explanation. It accepts no value and is not part of the JSON language.
      if (entrySchema.type === "refused") continue;
      arms.push({
        type: "object",
        properties: { [key]: convertSchema(entrySchema, context) },
        required: [key],
        additionalProperties: false,
      });
    }
    jsonSchema.oneOf = arms;
    return jsonSchema;
  }

  // Get schema type
  const schemaType = schema.type;

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

    // =========================================================================
    // Composite Schemas
    // =========================================================================

    case "object": {
      const entries = (schema as any).entries as Record<string, unknown>;
      const options = (schema as any).options as
        | { partial?: boolean; strict?: boolean }
        | undefined;
      const partial = options?.partial ?? true;
      const strict = options?.strict ?? true;

      jsonSchema.type = "object";
      jsonSchema.properties = {};
      jsonSchema.required = [];

      for (const key in entries) {
        const entry = entries[key];
        const isThunk = isFunction(entry);

        // Resolve thunks to get the actual schema
        const entrySchema = isThunk
          ? (entry as () => VibSchema<unknown, unknown>)()
          : (entry as VibSchema<unknown, unknown>);

        // Find the inner named object (if any) and pre-register it
        const innerSchema = getInnerSchema(entrySchema);
        const schemaName = innerSchema?.options?.name;

        if (
          schemaName &&
          isString(schemaName) &&
          !context.referenceMap.has(innerSchema)
        ) {
          // Pre-register the inner named object (not the wrapper)
          context.referenceMap.set(innerSchema, schemaName);
          // Convert the inner object and add to definitions
          context.definitions[schemaName] = convertSchema(
            innerSchema,
            context,
            true
          );
        }

        // Now convert the entry normally - if it hits a registered schema, it will emit $ref
        jsonSchema.properties[key] = convertSchema(entrySchema as any, context);

        // Determine if field is required
        const entryType = (entrySchema as any).type;
        const isOptionalWrapper =
          entryType === "optional" || entryType === "nullish";

        if (!(partial || isOptionalWrapper)) {
          jsonSchema.required.push(key);
        }
      }

      // Handle strict mode
      if (strict) {
        jsonSchema.additionalProperties = false;
      }

      // Remove empty required array
      if (jsonSchema.required.length === 0) {
        jsonSchema.required = undefined;
      }

      break;
    }

    case "record": {
      const valueSchema = (schema as any).value as VibSchema<unknown, unknown>;
      jsonSchema.type = "object";
      jsonSchema.additionalProperties = convertSchema(
        valueSchema as any,
        context
      );
      break;
    }

    case "union": {
      const options = (schema as any).options as VibSchema<unknown, unknown>[];
      jsonSchema.anyOf = options.map((opt) =>
        convertSchema(opt as any, context)
      );
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

    case "refused":
      // A key that exists only to explain why it is refused: it accepts
      // nothing, and `not: {}` is the JSON Schema that accepts nothing.
      jsonSchema.not = {};
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
      Object.assign(jsonSchema, geoPointJsonSchema());
      break;

    case "geo_area": {
      const ring: JsonSchema = {
        type: "array",
        items: geoPointJsonSchema(),
        minItems: GEO_POLYGON_MIN_RING_POINTS,
      };
      jsonSchema.oneOf = [
        {
          type: "object",
          properties: {
            bounds: {
              ...geoBoundsJsonSchema(),
            },
          },
          required: ["bounds"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            polygon: {
              type: "object",
              properties: {
                outer: ring,
                holes: { type: "array", items: ring },
              },
              required: ["outer"],
              additionalProperties: false,
            },
          },
          required: ["polygon"],
          additionalProperties: false,
        },
      ];
      break;
    }

    case "transform": {
      // Transform wraps another schema - use the wrapped schema for JSON representation
      const wrapped = (schema as any).wrapped as VibSchema<unknown, unknown>;
      return convertSchema(wrapped as any, context);
    }

    case "field_ref_or":
    case "comparison_operand": {
      // A field reference, an SQL fragment, and the callback that returns one
      // are in-process values with no JSON representation: only the literal
      // operand they stand beside can cross a JSON boundary.
      const operand = (schema as any).wrapped as VibSchema<unknown, unknown>;
      return convertSchema(operand as any, context);
    }

    case "lazyRef": {
      // A deferred reference to a schema built elsewhere (args → core schemas,
      // and a scalar filter's `not` arm pointing back at the filter itself).
      // Resolving it here is what makes the reference transparent in JSON
      // Schema; the cycle bookkeeping in convertSchema is what keeps a
      // SELF-referential target from inlining forever.
      const target = (schema as any).wrapped as VibSchema<unknown, unknown>;
      return convertSchema(target as any, context);
    }

    case "no_field_ref": {
      // The mirror image: this wrapper only REMOVES in-process tokens, which
      // have no JSON representation to remove in the first place, so the JSON
      // shape is exactly the wrapped schema's.
      const inner = (schema as any).wrapped as VibSchema<unknown, unknown>;
      return convertSchema(inner as any, context);
    }

    case "json_null_or":
    case "json_write": {
      // The JSON null sentinels are in-process tokens (class instances), so
      // like a field reference they have no JSON representation: only the
      // document operand they wrap can cross a JSON boundary. `json_write`
      // additionally forbids a bare top-level null, which JSON Schema cannot
      // express here without contradicting the wrapped scalar's own nullable
      // shape — the runtime refusal is the enforcement, and this projection
      // stays the document language.
      const operand = (schema as any).wrapped as VibSchema<unknown, unknown>;
      return convertSchema(operand as any, context);
    }

    case "pipe": {
      // Pipe contains a base schema and actions - use the base schema
      const baseSchema = (schema as any).schema as VibSchema<unknown, unknown>;
      return convertSchema(baseSchema as any, context);
    }

    default:
      throw new ValidationError({ kind: "json-schema", schemaType }, [
        {
          path: "type",
          message: `Cannot convert "${schemaType}" schema to JSON Schema: unsupported type`,
        },
      ]);
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
  return toJsonSchemaForDirection(schema, target, "input");
}

/** Internal directional route used by the Standard Schema converter. */
export function toJsonSchemaForDirection(
  schema: VibSchema<unknown, unknown>,
  target: JsonSchemaTarget,
  direction: "input" | "output"
): JsonSchema {
  if (!SUPPORTED_TARGETS.includes(target)) {
    throw new ValidationError({ kind: "json-schema", target }, [
      {
        path: "target",
        message: `Unsupported JSON Schema target: ${target}`,
      },
    ]);
  }

  const context = createContext(target, schema, direction);

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
