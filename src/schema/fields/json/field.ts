// JSON Field
// Standalone field class with State generic pattern
// Supports both untyped (unknown) and typed (StandardSchema) JSON fields

import type { StandardSchemaV1 } from "../../../standardSchema";
import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  createDefaultState,
} from "../common";
import * as schemas from "./schemas";
import * as schemaBuilders from "./schemas";
import type {
  JsonType,
  JsonNullableType,
  JsonFilterType,
  JsonNullableFilterType,
  JsonUpdateType,
  JsonNullableUpdateType,
  JsonOptionalType,
  JsonOptionalNullableType,
} from "./schemas";

// =============================================================================
// JSON FIELD STATE (extends base with custom schema)
// =============================================================================

interface JsonFieldState<
  TSchema extends StandardSchemaV1 | undefined = undefined
> extends FieldState<"json"> {
  customSchema: TSchema;
}

// =============================================================================
// JSON FIELD SCHEMA TYPE DERIVATION
// =============================================================================

/**
 * Derives the correct schema types based on field state and optional StandardSchema.
 * When TSchema is provided, uses typed schemas with proper inference.
 * When TSchema is undefined, falls back to untyped (unknown) schemas.
 */
type JsonFieldSchemas<
  TSchema extends StandardSchemaV1 | undefined,
  State extends JsonFieldState<TSchema>
> = TSchema extends StandardSchemaV1
  ? {
      // Typed JSON schemas using StandardSchema
      base: State["nullable"] extends true
        ? JsonNullableType<TSchema>
        : JsonType<TSchema>;

      filter: State["nullable"] extends true
        ? JsonNullableFilterType<TSchema>
        : JsonFilterType<TSchema>;

      create: State["hasDefault"] extends true
        ? State["nullable"] extends true
          ? JsonOptionalNullableType<TSchema>
          : JsonOptionalType<TSchema>
        : State["nullable"] extends true
        ? JsonNullableType<TSchema>
        : JsonType<TSchema>;

      update: State["nullable"] extends true
        ? JsonNullableUpdateType<TSchema>
        : JsonUpdateType<TSchema>;
    }
  : {
      // Untyped JSON schemas (fallback to unknown)
      base: State["nullable"] extends true
        ? typeof schemas.jsonNullable
        : typeof schemas.jsonBase;

      filter: State["nullable"] extends true
        ? typeof schemas.jsonNullableFilter
        : typeof schemas.jsonFilter;

      create: State["hasDefault"] extends true
        ? State["nullable"] extends true
          ? typeof schemas.jsonOptionalNullableCreate
          : typeof schemas.jsonOptionalCreate
        : State["nullable"] extends true
        ? typeof schemas.jsonNullableCreate
        : typeof schemas.jsonCreate;

      update: State["nullable"] extends true
        ? typeof schemas.jsonNullableUpdate
        : typeof schemas.jsonUpdate;
    };

// =============================================================================
// JSON FIELD CLASS
// =============================================================================

export class JsonField<
  TSchema extends StandardSchemaV1 | undefined = undefined,
  State extends JsonFieldState<TSchema> = JsonFieldState<TSchema>
> {
  constructor(private _customSchema: TSchema, private state: State) {}

  // ===========================================================================
  // CHAINABLE MODIFIERS
  // ===========================================================================

  nullable(): JsonField<
    TSchema,
    UpdateState<State, { nullable: true }> & JsonFieldState<TSchema>
  > {
    return new JsonField(this._customSchema, {
      ...this.state,
      nullable: true,
    } as UpdateState<State, { nullable: true }> & JsonFieldState<TSchema>);
  }

  default(
    value: TSchema extends StandardSchemaV1
      ? DefaultValue<
          StandardSchemaV1.InferOutput<TSchema>,
          false,
          State["nullable"]
        >
      : DefaultValue<unknown, false, State["nullable"]>
  ): JsonField<
    TSchema,
    UpdateState<State, { hasDefault: true }> & JsonFieldState<TSchema>
  > {
    return new JsonField(this._customSchema, {
      ...this.state,
      hasDefault: true,
      defaultValue: value,
    } as UpdateState<State, { hasDefault: true }> & JsonFieldState<TSchema>);
  }

  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this {
    return new JsonField(this._customSchema, {
      ...this.state,
      columnName,
    }) as this;
  }

  // JSON fields don't support array(), id(), or unique()
  array(): never {
    throw new Error(
      "JSON fields don't support array modifier - use a json schema array instead"
    );
  }

  id(): never {
    throw new Error("JSON fields cannot be used as IDs");
  }

  unique(): never {
    throw new Error("JSON fields cannot be unique");
  }

  // ===========================================================================
  // SCHEMA GETTER
  // ===========================================================================

  get schemas(): JsonFieldSchemas<TSchema, State> {
    const { nullable, hasDefault } = this.state;

    if (this._customSchema) {
      // Use typed schema builders when StandardSchema is provided
      const schema = this._customSchema as StandardSchemaV1;

      const base = nullable
        ? schemaBuilders.createJsonNullable(schema)
        : schemaBuilders.createJsonBase(schema);

      const filter = nullable
        ? schemaBuilders.createJsonNullableFilter(schema)
        : schemaBuilders.createJsonFilter(schema);

      const create = hasDefault
        ? nullable
          ? schemaBuilders.createJsonOptionalNullableCreate(schema)
          : schemaBuilders.createJsonOptionalCreate(schema)
        : nullable
        ? schemaBuilders.createJsonNullable(schema)
        : schemaBuilders.createJsonBase(schema);

      const update = nullable
        ? schemaBuilders.createJsonNullableUpdate(schema)
        : schemaBuilders.createJsonUpdate(schema);

      return { base, filter, create, update } as JsonFieldSchemas<
        TSchema,
        State
      >;
    } else {
      // Fallback to untyped schemas
      const base = nullable ? schemas.jsonNullable : schemas.jsonBase;

      const filter = nullable ? schemas.jsonNullableFilter : schemas.jsonFilter;

      const create = hasDefault
        ? nullable
          ? schemas.jsonOptionalNullableCreate
          : schemas.jsonOptionalCreate
        : nullable
        ? schemas.jsonNullableCreate
        : schemas.jsonCreate;

      const update = nullable ? schemas.jsonNullableUpdate : schemas.jsonUpdate;

      return { base, filter, create, update } as JsonFieldSchemas<
        TSchema,
        State
      >;
    }
  }

  // ===========================================================================
  // ACCESSORS
  // ===========================================================================

  get ["~"]() {
    return {
      state: this.state,
      schemas: this.schemas,
      customSchema: this._customSchema,
    };
  }
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Creates an untyped JSON field (accepts any valid JSON value)
 */
export function json(): JsonField<undefined>;

/**
 * Creates a typed JSON field with StandardSchema validation
 * @param schema - Any StandardSchema-compatible validator (Zod, Valibot, ArkType, etc.)
 */
export function json<TSchema extends StandardSchemaV1>(
  schema: TSchema
): JsonField<TSchema>;

export function json<TSchema extends StandardSchemaV1 | undefined = undefined>(
  schema?: TSchema
): JsonField<TSchema> {
  const baseState = createDefaultState("json") as JsonFieldState<TSchema>;
  return new JsonField<TSchema, JsonFieldState<TSchema>>(schema as TSchema, {
    ...baseState,
    customSchema: schema as TSchema,
  });
}
