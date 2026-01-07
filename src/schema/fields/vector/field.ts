// Vector Field
// Standalone field class with State generic pattern

import v, { type BaseVectorSchema } from "@validation";
import {
  createDefaultState,
  type DefaultValue,
  type DefaultValueInput,
  type FieldState,
  type UpdateState,
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

  nullable(): VectorField<
    UpdateState<
      State,
      {
        nullable: true;
        hasDefault: true;
        default: DefaultValue<null>;
        optional: true;
        base: BaseVectorSchema<{
          nullable: true;
        }>;
      }
    >
  > {
    return new VectorField(
      {
        ...this.state,
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.vector<{
          nullable: true;
        }>(undefined, {
          nullable: true,
        }),
      },
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(
    value: V
  ): VectorField<
    UpdateState<State, { hasDefault: true; default: V; optional: true }>
  > {
    return new VectorField(
      {
        ...this.state,
        hasDefault: true,
        default: value,
        optional: true,
      },
      this._nativeType
    );
  }

  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this {
    return new VectorField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  dimension(dim: number): VectorField<State & { dimension: number }> {
    return new VectorField(
      {
        ...this.state,
        dimension: dim,
      } as State & { dimension: number },
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
