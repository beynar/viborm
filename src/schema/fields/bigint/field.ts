// BigInt Field
// Standalone field class with State generic pattern

import type { StandardSchemaOf } from "@standard-schema/spec";
import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
  DefaultValueInput,
} from "../common";
import type { NativeType } from "../native-types";
import { getFieldBigIntSchemas, bigIntBase } from "./schemas";
import { schemaFromStandardSchema, StandardSchemaToSchema } from "..";

// =============================================================================
// BIGINT FIELD CLASS
// =============================================================================

export class BigIntField<State extends FieldState<"bigint">> {
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): BigIntField<
    UpdateState<
      State,
      { nullable: true; hasDefault: true; defaultValue: DefaultValue<null> }
    >
  > {
    return new BigIntField(
      { ...this.state, nullable: true, hasDefault: true, defaultValue: null },
      this._nativeType
    );
  }

  array(): BigIntField<UpdateState<State, { array: true }>> {
    return new BigIntField({ ...this.state, array: true }, this._nativeType);
  }

  id(): BigIntField<UpdateState<State, { isId: true; isUnique: true }>> {
    return new BigIntField(
      { ...this.state, isId: true, isUnique: true },
      this._nativeType
    );
  }

  unique(): BigIntField<UpdateState<State, { isUnique: true }>> {
    return new BigIntField({ ...this.state, isUnique: true }, this._nativeType);
  }

  default<V extends DefaultValueInput<State>>(
    value: V
  ): BigIntField<UpdateState<State, { hasDefault: true; defaultValue: V }>> {
    return new BigIntField(
      {
        ...this.state,
        hasDefault: true,
        defaultValue: value,
      },
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<bigint>>(
    schema: S
  ): BigIntField<
    UpdateState<State, { schema: S; base: StandardSchemaToSchema<S> }>
  > {
    return new BigIntField(
      {
        ...this.state,
        schema: schema,
        base: schemaFromStandardSchema(this.state.base, schema),
      },
      this._nativeType
    );
  }

  map(columnName: string): this {
    return new BigIntField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  increment(): BigIntField<
    UpdateState<
      State,
      {
        hasDefault: true;
        autoGenerate: "increment";
        defaultValue: DefaultValue<bigint>;
      }
    >
  > {
    return new BigIntField(
      {
        ...this.state,
        hasDefault: true,
        autoGenerate: "increment",
        defaultValue: 0n, // Placeholder, actual value set by DB
      },
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: getFieldBigIntSchemas<State>(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

export const bigInt = (nativeType?: NativeType) =>
  new BigIntField(createDefaultState("bigint", bigIntBase), nativeType);
