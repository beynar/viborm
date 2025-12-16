// Time Field
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
import { getFieldTimeSchemas, timeBase } from "./schemas";

// =============================================================================
// AUTO-GENERATION DEFAULT VALUE FACTORIES
// =============================================================================

const defaultNow = () => {
  const now = new Date();
  return now.toISOString().split("T")[1]?.split(".")[0] ?? ""; // "HH:MM:SS"
};
const defaultUpdatedAt = () => {
  const now = new Date();
  return now.toISOString().split("T")[1]?.split(".")[0] ?? ""; // "HH:MM:SS"
};

// =============================================================================
// TIME FIELD CLASS
// =============================================================================

export class TimeField<State extends FieldState<"time">> {
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): TimeField<
    UpdateState<
      State,
      { nullable: true; hasDefault: true; defaultValue: DefaultValue<null> }
    >
  > {
    return new TimeField(
      { ...this.state, nullable: true, hasDefault: true, defaultValue: null },
      this._nativeType
    );
  }

  array(): TimeField<UpdateState<State, { array: true }>> {
    return new TimeField({ ...this.state, array: true }, this._nativeType);
  }

  id(): TimeField<UpdateState<State, { isId: true; isUnique: true }>> {
    return new TimeField(
      { ...this.state, isId: true, isUnique: true },
      this._nativeType
    );
  }

  unique(): TimeField<UpdateState<State, { isUnique: true }>> {
    return new TimeField({ ...this.state, isUnique: true }, this._nativeType);
  }

  schema<S extends StandardSchemaOf<string>>(
    schema: S
  ): TimeField<
    UpdateState<State, { schema: S; base: StandardSchemaToSchema<S> }>
  > {
    return new TimeField(
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
  ): TimeField<UpdateState<State, { hasDefault: true; defaultValue: V }>> {
    return new TimeField(
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
    return new TimeField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  // ===========================================================================
  // AUTO-GENERATION METHODS
  // ===========================================================================

  now(): TimeField<
    UpdateState<
      State,
      {
        hasDefault: true;
        autoGenerate: "now";
        defaultValue: DefaultValue<string>;
      }
    >
  > {
    return new TimeField(
      {
        ...this.state,
        hasDefault: true,
        autoGenerate: "now",
        defaultValue: defaultNow,
      },
      this._nativeType
    );
  }

  updatedAt(): TimeField<
    UpdateState<
      State,
      {
        hasDefault: true;
        autoGenerate: "updatedAt";
        defaultValue: DefaultValue<string>;
      }
    >
  > {
    return new TimeField(
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
      schemas: getFieldTimeSchemas<State>(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

export const time = (nativeType?: NativeType) =>
  new TimeField(createDefaultState("time", timeBase), nativeType);
