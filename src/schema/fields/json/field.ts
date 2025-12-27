// JSON Field
// Standalone field class with State generic pattern

import type { StandardSchemaOf } from "@standard-schema/spec";
import {
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
  FieldState,
  DefaultValueInput,
} from "../common";
import type { NativeType } from "../native-types";
import { buildJsonSchema, jsonBase } from "./schemas";
import v, { BaseJsonSchema, InferOutput, JsonValue } from "../../../validation";

// =============================================================================
// JSON FIELD CLASS
// =============================================================================

export class JsonField<State extends FieldState<"json"> = FieldState<"json">> {
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): JsonField<
    UpdateState<
      State,
      {
        nullable: true;
        hasDefault: true;
        default: DefaultValue<null>;
        optional: true;
        base: BaseJsonSchema<{
          nullable: true;
          schema: State["schema"];
        }>;
      }
    >
  > {
    return new JsonField(
      {
        ...this.state,
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.json<{
          nullable: true;
          schema: State["schema"];
        }>({
          nullable: true,
          schema: this.state.schema,
        }),
      },
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(
    value: V
  ): JsonField<
    UpdateState<State, { hasDefault: true; default: V; optional: true }>
  > {
    return new JsonField(
      {
        ...this.state,
        hasDefault: true,
        default: value,
        optional: true,
      },
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<JsonValue>>(
    schema: S
  ): JsonField<
    UpdateState<
      State,
      {
        schema: S;
        base: BaseJsonSchema<{
          nullable: State["nullable"];
          schema: S;
        }>;
      }
    >
  > {
    return new JsonField(
      {
        ...this.state,
        schema: schema,
        base: v.json<{
          nullable: State["nullable"];
          schema: S;
        }>({
          nullable: this.state.nullable,
          schema: schema,
        }),
      },
      this._nativeType
    );
  }

  map(columnName: string): this {
    return new JsonField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  // ===========================================================================
  // ACCESSORS
  // ===========================================================================

  #cached_schemas: ReturnType<typeof buildJsonSchema<State>> | undefined;

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this.#cached_schemas ??= buildJsonSchema(this.state)),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

export const json = (nativeType?: NativeType) =>
  new JsonField(createDefaultState("json", jsonBase), nativeType);
