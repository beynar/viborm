// Date Field
// Standalone field class with State generic pattern

import type { StandardSchemaOf } from "@standard-schema/spec";
import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
  DefaultValueInput,
} from "../common";
import type { NativeType } from "../native-types";
import { schemaFromStandardSchema, StandardSchemaToSchema } from "..";
import { getFieldDateSchemas, dateBase } from "./schemas";

// =============================================================================
// AUTO-GENERATION DEFAULT VALUE FACTORIES
// =============================================================================

const defaultNow = () => new Date().toISOString().split("T")[0];
const defaultUpdatedAt = () => new Date().toISOString().split("T")[0];

// =============================================================================
// DATE FIELD CLASS
// =============================================================================

export class DateField<State extends FieldState<"date">> {
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): DateField<
    UpdateState<
      State,
      { nullable: true; hasDefault: true; defaultValue: DefaultValue<null> }
    >
  > {
    return new DateField(
      { ...this.state, nullable: true, hasDefault: true, defaultValue: null },
      this._nativeType
    );
  }

  array(): DateField<UpdateState<State, { array: true }>> {
    return new DateField({ ...this.state, array: true }, this._nativeType);
  }

  id(): DateField<UpdateState<State, { isId: true; isUnique: true }>> {
    return new DateField(
      { ...this.state, isId: true, isUnique: true },
      this._nativeType
    );
  }

  unique(): DateField<UpdateState<State, { isUnique: true }>> {
    return new DateField({ ...this.state, isUnique: true }, this._nativeType);
  }

  schema<S extends StandardSchemaOf<string>>(
    schema: S
  ): DateField<
    UpdateState<State, { schema: S; base: StandardSchemaToSchema<S> }>
  > {
    return new DateField(
      {
        ...this.state,
        schema: schema,
        base: schemaFromStandardSchema(this.state.base, schema),
      },
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(
    value: V
  ): DateField<UpdateState<State, { hasDefault: true; defaultValue: V }>> {
    return new DateField(
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
    return new DateField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  // ===========================================================================
  // AUTO-GENERATION METHODS
  // ===========================================================================

  now(): DateField<
    UpdateState<
      State,
      {
        hasDefault: true;
        autoGenerate: "now";
        defaultValue: DefaultValue<string>;
      }
    >
  > {
    return new DateField(
      {
        ...this.state,
        hasDefault: true,
        autoGenerate: "now",
        defaultValue: defaultNow,
      },
      this._nativeType
    );
  }

  updatedAt(): DateField<
    UpdateState<
      State,
      {
        hasDefault: true;
        autoGenerate: "updatedAt";
        defaultValue: DefaultValue<string>;
      }
    >
  > {
    return new DateField(
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
      schemas: getFieldDateSchemas<State>(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

export const date = (nativeType?: NativeType) =>
  new DateField(createDefaultState("date", dateBase), nativeType);
