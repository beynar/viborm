// Point Scalar
// Standalone scalar class with State generic pattern

import v from "@validation/primitives/v";
import {
  createDefaultState,
  type DefaultValueInput,
  type ScalarState,
  updateState,
} from "../common";
import type { NativeType } from "../native-types";

const pointBase = v.point();

export class PointScalar<State extends ScalarState<"point">> {
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;
  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new PointScalar(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.point<{
          nullable: true;
        }>({
          nullable: true,
        }),
      }),
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(value: V) {
    return new PointScalar(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  map(columnName: string) {
    return new PointScalar(updateState(this, { columnName }), this._nativeType);
  }

  get ["~"]() {
    return {
      state: this.state,
      nativeType: this._nativeType,
    };
  }
}

export const point = (nativeType?: NativeType) =>
  new PointScalar(createDefaultState("point", pointBase), nativeType);
