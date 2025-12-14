// Enum Field
// Standalone field class with State generic pattern

import type { StandardSchemaOf } from "@standard-schema/spec";
import { InferOutput, picklist } from "valibot";
import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
  DefaultValueInput,
} from "../common";
import type { NativeType } from "../native-types";
import { getFieldEnumSchemas } from "./schemas";
import { schemaFromStandardSchema, StandardSchemaToSchema } from "..";

// =============================================================================
// ENUM FIELD CLASS
// =============================================================================

export class EnumField<State extends FieldState<"enum"> = FieldState<"enum">> {
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): EnumField<
    UpdateState<
      State,
      { nullable: true; hasDefault: true; defaultValue: DefaultValue<null> }
    >
  > {
    return new EnumField(
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

  array(): EnumField<UpdateState<State, { array: true }>> {
    return new EnumField(
      { ...this.state, array: true } as UpdateState<State, { array: true }>,
      this._nativeType
    ) as EnumField<UpdateState<State, { array: true }>>;
  }

  default<V extends DefaultValueInput<State>>(
    value: V
  ): EnumField<UpdateState<State, { hasDefault: true; defaultValue: V }>> {
    return new EnumField(
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
  ): EnumField<
    UpdateState<State, { schema: S; base: StandardSchemaToSchema<S> }>
  > {
    return new EnumField(
      {
        ...this.state,
        schema: schema,
        base: schemaFromStandardSchema(this.state.base, schema),
      } as UpdateState<State, { schema: S; base: StandardSchemaToSchema<S> }>,
      this._nativeType
    );
  }

  map(columnName: string): this {
    return new EnumField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: getFieldEnumSchemas<State>(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

export const enumField = <const T extends string[]>(
  values: T,
  nativeType?: NativeType
) => {
  const base = picklist(values);
  return new EnumField(createDefaultState("enum", base), nativeType);
};
