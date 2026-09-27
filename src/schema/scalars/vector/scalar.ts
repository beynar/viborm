// Vector Scalar
// Standalone scalar class with State generic pattern

import v from "@validation/primitives/v";
import {
  createDefaultState,
  type DefaultValueInput,
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

const vectorBase = v.vector();

export class VectorScalar<State extends ScalarState<"vector">> {
  private readonly state: State;
  private readonly _nativeType?: NativeTypeDeclaration | undefined;

  constructor(state: State, _nativeType?: NativeTypeDeclaration) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new VectorScalar(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.vector<{
          nullable: true;
        }>(undefined, {
          nullable: true,
        }),
      }),
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(value: V) {
    return new VectorScalar(
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
    return new VectorScalar(
      updateState(this, { columnName }),
      this._nativeType
    );
  }

  dimension(dim: number) {
    return new VectorScalar(
      updateState(this, { dimension: dim }),
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

export const vector = <
  Db extends NativeDialect = never,
  const Given extends ExactNativeTypeMap<Given> = never,
>(
  nativeType?: NativeTypeArgument<Db, Given>
) =>
  new VectorScalar(
    createDefaultState("vector", vectorBase),
    admitNativeType("s.vector", nativeType)
  );
