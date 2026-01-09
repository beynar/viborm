// BigInt Field
// Standalone field class with State generic pattern

import type { StandardSchemaOf } from "@standard-schema/spec";
import v from "@validation";
import {
  createDefaultState,
  type DefaultValueInput,
  type FieldState,
  updateState,
} from "../common";
import type { NativeType } from "../native-types";
import { type BigIntSchemas, bigIntBase, buildBigIntSchema } from "./schemas";

export class BigIntField<State extends FieldState<"bigint">> {
  private _schemas: BigIntSchemas<State> | undefined;
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;

  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new BigIntField(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.bigint<{
          nullable: true;
          array: State["array"];
        }>({
          nullable: true,
          array: this.state.array,
        }),
      }),
      this._nativeType
    );
  }

  array() {
    return new BigIntField(
      updateState(this, {
        ...this.state,
        array: true,
        base: v.bigint<{
          nullable: State["nullable"];
          array: true;
        }>({
          nullable: this.state.nullable,
          array: true,
        }),
      }),
      this._nativeType
    );
  }

  id() {
    return new BigIntField(
      updateState(this, { isId: true, isUnique: true }),
      this._nativeType
    );
  }

  unique() {
    return new BigIntField(
      updateState(this, { isUnique: true }),
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(value: V) {
    return new BigIntField(
      updateState(this, { hasDefault: true, default: value, optional: true }),
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<bigint>>(schema: S) {
    return new BigIntField(
      updateState(this, {
        schema,
        base: v.bigint<{
          nullable: State["nullable"];
          array: State["array"];
          schema: S;
        }>({
          nullable: this.state.nullable,
          array: this.state.array,
          schema,
        }),
      }),
      this._nativeType
    );
  }

  map(columnName: string) {
    return new BigIntField(updateState(this, { columnName }), this._nativeType);
  }

  increment() {
    return new BigIntField(
      updateState(this, {
        hasDefault: true,
        autoGenerate: "increment",
        default: 0n,
        optional: true,
      }),
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildBigIntSchema(this.state)),
      nativeType: this._nativeType,
    };
  }
}

export const bigInt = (nativeType?: NativeType) =>
  new BigIntField(createDefaultState("bigint", bigIntBase), nativeType);
