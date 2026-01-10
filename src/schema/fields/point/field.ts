// Point Field
// Standalone field class with State generic pattern

import v from "@validation";
import {
  createDefaultState,
  type DefaultValueInput,
  type FieldState,
  updateState,
} from "../common";
import type { NativeType } from "../native-types";
import { buildPointSchema, type PointSchemas, pointBase } from "./schemas";

export class PointField<State extends FieldState<"point">> {
  private _schemas: PointSchemas<State> | undefined;
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;
  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new PointField(
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
    return new PointField(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  map(columnName: string) {
    return new PointField(updateState(this, { columnName }), this._nativeType);
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildPointSchema(this.state)),
      nativeType: this._nativeType,
    };
  }
}

export const point = (nativeType?: NativeType) =>
  new PointField(createDefaultState("point", pointBase), nativeType);
