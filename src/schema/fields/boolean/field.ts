// Boolean Field
// Standalone field class mirroring the string field pattern

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
} from "../common";
import type { NativeType } from "../native-types";
import { getFieldBooleanSchemas } from "./schemas";

// =============================================================================
// BOOLEAN FIELD CLASS
// =============================================================================

export class BooleanField<State extends FieldState<"boolean">> {
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  // ===========================================================================
  // CHAINABLE MODIFIERS
  // ===========================================================================

  nullable(): BooleanField<UpdateState<State, { nullable: true }>> {
    return new BooleanField(
      { ...this.state, nullable: true },
      this._nativeType
    );
  }

  array(): BooleanField<UpdateState<State, { array: true }>> {
    return new BooleanField({ ...this.state, array: true }, this._nativeType);
  }

  default(
    value: DefaultValue<boolean, State["array"], State["nullable"]>
  ): BooleanField<UpdateState<State, { hasDefault: true }>> {
    return new BooleanField(
      {
        ...this.state,
        hasDefault: true,
        defaultValue: value,
      },
      this._nativeType
    );
  }

  schema(
    schema: StandardSchemaV1
  ): BooleanField<UpdateState<State, { schema: StandardSchemaV1 }>> {
    return new BooleanField(
      {
        ...this.state,
        schema: schema,
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
      schemas: getFieldBooleanSchemas(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

export const boolean = (nativeType?: NativeType) =>
  new BooleanField(createDefaultState("boolean"), nativeType);
