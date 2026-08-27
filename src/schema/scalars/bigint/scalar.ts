// BigInt Scalar
// Standalone scalar class with State generic pattern

import type { StandardSchemaOf } from "@standard-schema/spec";
import v from "@validation/primitives/v";
import {
  createDefaultState,
  type DefaultValueInput,
  type ScalarState,
  updateState,
} from "../common";
import type { NativeType } from "../native-types";

const bigIntBase = v.bigint();

export class BigIntScalar<State extends ScalarState<"bigint">> {
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;

  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new BigIntScalar(
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
    return new BigIntScalar(
      updateState(this, {
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
    return new BigIntScalar(
      updateState(this, { isId: true, isUnique: true }),
      this._nativeType
    );
  }

  unique() {
    return new BigIntScalar(
      updateState(this, { isUnique: true }),
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(value: V) {
    return new BigIntScalar(
      updateState(this, { hasDefault: true, default: value, optional: true }),
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<bigint>>(schema: S) {
    return new BigIntScalar(
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
    return new BigIntScalar(
      updateState(this, { columnName }),
      this._nativeType
    );
  }

  increment() {
    return new BigIntScalar(
      updateState(this, {
        hasDefault: true,
        autoGenerate: { kind: "increment" },
        default: undefined,
        disallowZero: true,
        optional: true,
      }),
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      nativeType: this._nativeType,
    };
  }
}

export const bigInt = (nativeType?: NativeType) =>
  new BigIntScalar(createDefaultState("bigint", bigIntBase), nativeType);
