// BigInt Field
// Lean field class delegating schema selection to schema factory

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
} from "../common";
import type { NativeType } from "../native-types";
import { getFieldBigIntSchemas } from "./schemas";

export class BigIntField<State extends FieldState<"bigint">> {
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): BigIntField<UpdateState<State, { nullable: true }>> {
    return new BigIntField({ ...this.state, nullable: true }, this._nativeType);
  }

  array(): BigIntField<UpdateState<State, { array: true }>> {
    return new BigIntField({ ...this.state, array: true }, this._nativeType);
  }

  default(
    value: DefaultValue<bigint, State["array"], State["nullable"]>
  ): BigIntField<UpdateState<State, { hasDefault: true }>> {
    return new BigIntField(
      {
        ...this.state,
        hasDefault: true,
        defaultValue: value,
      },
      this._nativeType
    );
  }

  schema(
    schema: StandardSchemaV1
  ): BigIntField<UpdateState<State, { schema: StandardSchemaV1 }>> {
    return new BigIntField(
      {
        ...this.state,
        schema: schema,
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
    UpdateState<State, { hasDefault: true; autoGenerate: "increment" }>
  > {
    return new BigIntField(
      {
        ...this.state,
        hasDefault: true,
        autoGenerate: "increment",
      },
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: getFieldBigIntSchemas(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

export const bigInt = (nativeType?: NativeType) =>
  new BigIntField(createDefaultState("bigint"), nativeType);
