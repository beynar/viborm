// Boolean Scalar
// Standalone scalar class with State generic pattern

import v from "@validation/primitives/v";
import {
  createDefaultState,
  type DefaultValueInput,
  nullableDefault,
  type ScalarState,
  updateState,
} from "../common";
import { admitNativeType } from "../native-catalog";
import type {
  ExactNativeTypeMap,
  NativeDialect,
  NativeTypeArgument,
  NativeTypeDeclaration,
} from "../native-types";

const booleanBase = v.boolean();

export class BooleanScalar<State extends ScalarState<"boolean">> {
  private readonly state: State;
  private readonly _nativeType?: NativeTypeDeclaration | undefined;

  constructor(state: State, _nativeType?: NativeTypeDeclaration) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new BooleanScalar(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: nullableDefault(this.state),
        optional: true,
        base: v.boolean<{
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
    return new BooleanScalar(
      updateState(this, {
        array: true,
        base: v.boolean<{
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

  default<V extends DefaultValueInput<State>>(value: V) {
    return new BooleanScalar(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  /**
   * Maps this scalar to a custom column name in the database
   */
  map(columnName: string) {
    return new BooleanScalar(
      updateState(this, { columnName }),
      this._nativeType
    );
  }

  private _internal?: {
    state: State;
    nativeType: NativeTypeDeclaration | undefined;
  };

  get ["~"]() {
    return (this._internal ??= {
      state: this.state,
      nativeType: this._nativeType,
    });
  }
}

export const boolean = <
  Db extends NativeDialect = never,
  const Given extends ExactNativeTypeMap<Given> = never,
>(
  nativeType?: NativeTypeArgument<Db, Given>
) =>
  new BooleanScalar(
    createDefaultState("boolean", booleanBase),
    admitNativeType("s.boolean", nativeType)
  );
