// Boolean Field
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
import { getFieldBooleanSchemas, booleanBase } from "./schemas";

// =============================================================================
// BOOLEAN FIELD CLASS
// =============================================================================

export class BooleanField<State extends FieldState<"boolean">> {
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): BooleanField<
    UpdateState<
      State,
      { nullable: true; hasDefault: true; defaultValue: DefaultValue<null> }
    >
  > {
    return new BooleanField(
      { ...this.state, nullable: true, hasDefault: true, defaultValue: null },
      this._nativeType
    );
  }

  array(): BooleanField<UpdateState<State, { array: true }>> {
    return new BooleanField({ ...this.state, array: true }, this._nativeType);
  }

  default<V extends DefaultValueInput<State>>(
    value: V
  ): BooleanField<UpdateState<State, { hasDefault: true; defaultValue: V }>> {
    return new BooleanField(
      {
        ...this.state,
        hasDefault: true,
        defaultValue: value,
      },
      this._nativeType
    );
  }

  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this {
    return new BooleanField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  // ===========================================================================
  // ACCESSORS
  // ===========================================================================

  get ["~"]() {
    return {
      state: this.state,
      schemas: getFieldBooleanSchemas<State>(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

export const boolean = (nativeType?: NativeType) =>
  new BooleanField(createDefaultState("boolean", booleanBase), nativeType);
