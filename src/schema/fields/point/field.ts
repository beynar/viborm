// Point Field
// Standalone field class with State generic pattern

import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
  DefaultValueInput,
} from "../common";
import type { NativeType } from "../native-types";
import { getFieldPointSchemas, pointBase } from "./schemas";

// =============================================================================
// POINT FIELD CLASS
// =============================================================================

export class PointField<State extends FieldState<"point">> {
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): PointField<
    UpdateState<
      State,
      { nullable: true; hasDefault: true; defaultValue: DefaultValue<null> }
    >
  > {
    return new PointField(
      { ...this.state, nullable: true, hasDefault: true, defaultValue: null },
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(
    value: V
  ): PointField<UpdateState<State, { hasDefault: true; defaultValue: V }>> {
    return new PointField(
      {
        ...this.state,
        hasDefault: true,
        defaultValue: value,
      },
      this._nativeType
    );
  }

  map(columnName: string): this {
    return new PointField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: getFieldPointSchemas<State>(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

export const point = (nativeType?: NativeType) =>
  new PointField(createDefaultState("point", pointBase), nativeType);
