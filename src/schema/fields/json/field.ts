// JSON Field
// Standalone field class with State generic pattern

import type { StandardSchemaOf } from "@standard-schema/spec";
import { InferOutput } from "valibot";
import {
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
  FieldState,
  DefaultValueInput,
  json as jsonSchema,
} from "../common";
import type { NativeType } from "../native-types";
import { getFieldJsonSchemas } from "./schemas";
import { schemaFromStandardSchema, StandardSchemaToSchema } from "..";

// =============================================================================
// JSON FIELD CLASS
// =============================================================================

export class JsonField<State extends FieldState<"json"> = FieldState<"json">> {
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): JsonField<
    UpdateState<
      State,
      { nullable: true; hasDefault: true; defaultValue: DefaultValue<null> }
    >
  > {
    return new JsonField(
      {
        ...this.state,
        nullable: true,
        hasDefault: true,
        defaultValue: null,
      } as UpdateState<
        State,
        { nullable: true; hasDefault: true; defaultValue: DefaultValue<null> }
      >,
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(
    value: V
  ): JsonField<UpdateState<State, { hasDefault: true; defaultValue: V }>> {
    return new JsonField(
      {
        ...this.state,
        hasDefault: true,
        defaultValue: value,
      } as UpdateState<State, { hasDefault: true; defaultValue: V }>,
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<InferOutput<State["base"]>>>(
    schema: S
  ): JsonField<
    UpdateState<State, { schema: S; base: StandardSchemaToSchema<S> }>
  > {
    return new JsonField(
      {
        ...this.state,
        schema: schema,
        base: schemaFromStandardSchema(this.state.base, schema),
      } as UpdateState<State, { schema: S; base: StandardSchemaToSchema<S> }>,
      this._nativeType
    );
  }

  map(columnName: string): this {
    return new JsonField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: getFieldJsonSchemas<State>(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

export const json = (nativeType?: NativeType) =>
  new JsonField(createDefaultState("json", jsonSchema), nativeType);
