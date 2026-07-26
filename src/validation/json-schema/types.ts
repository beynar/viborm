/**
 * Standard JSON Schema types for VibORM.
 * Implements the StandardJSONSchemaV1 specification.
 * @see https://standardschema.dev/json-schema
 */

// =============================================================================
// JSON Schema Target Versions
// =============================================================================

/**
 * Supported JSON Schema target versions.
 * - draft-07: JSON Schema Draft 7 (widely used)
 * - draft-2020-12: JSON Schema Draft 2020-12 (latest)
 * - openapi-3.0: OpenAPI 3.0 compatible (superset of draft-04)
 */
export type JsonSchemaTarget =
  | "draft-07"
  | "draft-2020-12"
  | "openapi-3.0"
  | ({} & string); // Allows future targets

/**
 * Supported targets for validation.
 */
export const SUPPORTED_TARGETS: JsonSchemaTarget[] = [
  "draft-07",
  "draft-2020-12",
  "openapi-3.0",
];

// =============================================================================
// JSON Schema Options
// =============================================================================

/**
 * Options for JSON Schema conversion methods.
 */
export interface JsonSchemaOptions {
  /** Target JSON Schema version */
  readonly target: JsonSchemaTarget;
  /** Vendor-specific options */
  readonly libraryOptions?: Record<string, unknown> | undefined;
}

// =============================================================================
// JSON Schema Types
// =============================================================================

/**
 * JSON Schema object type.
 * A flexible record that can hold any JSON Schema properties.
 */
export interface JsonSchema {
  $schema?: string;
  $defs?: Record<string, JsonSchema>;
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema | JsonSchema[];
  prefixItems?: JsonSchema[];
  minItems?: number;
  maxItems?: number;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  nullable?: boolean; // OpenAPI 3.0 specific
  format?: string;
  contentEncoding?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  default?: unknown;
  description?: string;
  title?: string;
  [key: string]: unknown;
}

// =============================================================================
// JSON Schema Converter Interface
// =============================================================================

/**
 * JSON Schema converter interface.
 * Provides methods to convert to input/output JSON Schema.
 */
export interface JsonSchemaConverter {
  /**
   * Converts the input type to JSON Schema.
   * @throws If conversion is not supported for the given target.
   */
  readonly input: (options: JsonSchemaOptions) => Record<string, unknown>;

  /**
   * Converts the output type to JSON Schema.
   * @throws If conversion is not supported for the given target.
   */
  readonly output: (options: JsonSchemaOptions) => Record<string, unknown>;
}

// =============================================================================
// Conversion Context
// =============================================================================

/**
 * One schema whose conversion is currently OPEN — i.e. sits somewhere on the
 * conversion call stack. Reaching the same schema again (through a `lazyRef`
 * or a thunk) means the schema graph is cyclic, and JSON Schema spells a cycle
 * with `$ref` rather than by inlining forever.
 *
 * `pointer` is allocated LAZILY, the first time something actually refers back
 * to the frame: a frame nobody points at emits its body inline, exactly as
 * before cycles were understood at all.
 */
export interface ConversionFrame {
  /** The schema this frame is converting (identity, not structure). */
  schema: unknown;
  /** The `$ref` value pointing at this frame, or null while unreferenced. */
  pointer: string | null;
  /** The `$defs` key holding the body — null when the frame is the root. */
  name: string | null;
}

/**
 * Context for JSON Schema conversion.
 * Used to track definitions and references for circular schemas.
 */
export interface ConversionContext {
  /** Accumulated definitions for $defs */
  definitions: Record<string, JsonSchema>;
  /** Map of schema objects to their reference IDs */
  referenceMap: Map<unknown, string>;
  /** Schemas whose conversion is currently open, keyed by identity */
  activeFrames: Map<unknown, ConversionFrame>;
  /**
   * The schema at the document root, if known. A cycle back to it is the whole
   * document, so it is spelled `#` and needs no definition of its own.
   */
  rootSchema?: unknown;
  /** Counter for generating unique reference IDs */
  refCount: number;
  /** The target version being generated */
  target: JsonSchemaTarget;
}

/**
 * Creates a new conversion context.
 *
 * @param target - The target JSON Schema version
 * @param rootSchema - The schema being converted at the document root, so a
 *   cycle back to it can be spelled as the root pointer `#`
 */
export function createContext(
  target: JsonSchemaTarget,
  rootSchema?: unknown
): ConversionContext {
  return {
    definitions: {},
    referenceMap: new Map(),
    activeFrames: new Map(),
    rootSchema,
    refCount: 0,
    target,
  };
}
