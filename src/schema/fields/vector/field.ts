// Vector Field
// Standalone field class with State generic pattern

import v from "@validation";
import {
  createDefaultState,
  type DefaultValueInput,
  type FieldState,
  updateState,
} from "../common";
import type { NativeType } from "../native-types";
import { buildVectorSchema, type VectorSchemas, vectorBase } from "./schemas";

export class VectorField<State extends FieldState<"vector">> {
  private _schemas: VectorSchemas<State> | undefined;
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;

  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new VectorField(
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
    return new VectorField(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string) {
    return new VectorField(updateState(this, { columnName }), this._nativeType);
  }

  dimension(dim: number) {
    return new VectorField(
      updateState(this, { dimension: dim } as any),
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildVectorSchema(this.state)),
      nativeType: this._nativeType,
    };
  }
}

export const vector = (nativeType?: NativeType) =>
  new VectorField(createDefaultState("vector", vectorBase), nativeType);
