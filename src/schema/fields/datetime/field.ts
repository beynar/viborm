// DateTime Field
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
import { getFieldDateTimeSchemas, datetimeBase } from "./schemas";

// =============================================================================
// AUTO-GENERATION DEFAULT VALUE FACTORIES
// =============================================================================

const defaultNow = () => new Date().toISOString();
const defaultUpdatedAt = () => new Date().toISOString();

// =============================================================================
// DATETIME FIELD CLASS
// =============================================================================

export class DateTimeField<State extends FieldState<"datetime">> {
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): DateTimeField<
    UpdateState<
      State,
      { nullable: true; hasDefault: true; defaultValue: DefaultValue<null> }
    >
  > {
    return new DateTimeField(
      { ...this.state, nullable: true, hasDefault: true, defaultValue: null },
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

  default<V extends DefaultValueInput<State>>(
    value: V
  ): DateTimeField<UpdateState<State, { hasDefault: true; defaultValue: V }>> {
    return new DateTimeField(
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
    return new DateTimeField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  // ===========================================================================
  // AUTO-GENERATION METHODS
  // ===========================================================================

  now(): DateTimeField<
    UpdateState<
      State,
      {
        hasDefault: true;
        autoGenerate: "now";
        defaultValue: DefaultValue<string>;
      }
    >
  > {
    return new DateTimeField(
      {
        ...this.state,
        hasDefault: true,
        autoGenerate: "now",
        defaultValue: defaultNow,
      },
      this._nativeType
    );
  }

  updatedAt(): DateTimeField<
    UpdateState<
      State,
      {
        hasDefault: true;
        autoGenerate: "updatedAt";
        defaultValue: DefaultValue<string>;
      }
    >
  > {
    return new DateTimeField(
      {
        ...this.state,
        hasDefault: true,
        autoGenerate: "updatedAt",
        defaultValue: defaultUpdatedAt,
      },
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: getFieldDateTimeSchemas<State>(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

export const dateTime = (nativeType?: NativeType) =>
  new DateTimeField(createDefaultState("datetime", datetimeBase), nativeType);
