// DateTime Field
// Standalone field class with State generic pattern

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
} from "../common";
import type { NativeType } from "../native-types";
import { getFieldDateTimeSchemas } from "./schemas";

// =============================================================================
// DATETIME FIELD CLASS
// =============================================================================

export class DateTimeField<State extends FieldState<"datetime">> {
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  // ===========================================================================
  // CHAINABLE MODIFIERS
  // ===========================================================================

  nullable(): DateTimeField<UpdateState<State, { nullable: true }>> {
    return new DateTimeField(
      { ...this.state, nullable: true },
      this._nativeType
    );
  }

  array(): DateTimeField<UpdateState<State, { array: true }>> {
    return new DateTimeField({ ...this.state, array: true }, this._nativeType);
  }

  id(): DateTimeField<UpdateState<State, { isId: true; isUnique: true }>> {
    return new DateTimeField(
      { ...this.state, isId: true, isUnique: true },
      this._nativeType
    );
  }

  unique(): DateTimeField<UpdateState<State, { isUnique: true }>> {
    return new DateTimeField(
      { ...this.state, isUnique: true },
      this._nativeType
    );
  }

  default(
    value: DefaultValue<Date, State["array"], State["nullable"]>
  ): DateTimeField<UpdateState<State, { hasDefault: true }>> {
    return new DateTimeField(
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
  ): DateTimeField<UpdateState<State, { schema: StandardSchemaV1 }>> {
    return new DateTimeField(
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
    return new DateTimeField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  // ===========================================================================
  // AUTO-GENERATION METHODS
  // ===========================================================================

  now(): DateTimeField<
    UpdateState<State, { hasDefault: true; autoGenerate: "now" }>
  > {
    return new DateTimeField(
      {
        ...this.state,
        hasDefault: true,
        autoGenerate: "now",
      },
      this._nativeType
    );
  }

  updatedAt(): DateTimeField<
    UpdateState<State, { hasDefault: true; autoGenerate: "updatedAt" }>
  > {
    return new DateTimeField(
      {
        ...this.state,
        hasDefault: true,
        autoGenerate: "updatedAt",
      },
      this._nativeType
    );
  }

  // ===========================================================================
  // ACCESSORS
  // ===========================================================================

  get ["~"]() {
    return {
      state: this.state,
      schemas: getFieldDateTimeSchemas(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

export const dateTime = (nativeType?: NativeType) =>
  new DateTimeField(createDefaultState("datetime"), nativeType);
