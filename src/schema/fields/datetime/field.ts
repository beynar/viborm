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
import * as schemas from "./schemas";

// =============================================================================
// DATETIME FIELD SCHEMA TYPE DERIVATION
// =============================================================================

type DateTimeFieldSchemas<State extends FieldState<"datetime">> = {
  base: State["array"] extends true
    ? State["nullable"] extends true
      ? typeof schemas.dateTimeNullableArray
      : typeof schemas.dateTimeArray
    : State["nullable"] extends true
      ? typeof schemas.dateTimeNullable
      : typeof schemas.dateTimeBase;

  filter: State["array"] extends true
    ? State["nullable"] extends true
      ? typeof schemas.dateTimeNullableListFilter
      : typeof schemas.dateTimeListFilter
    : State["nullable"] extends true
      ? typeof schemas.dateTimeNullableFilter
      : typeof schemas.dateTimeFilter;

  create: State["array"] extends true
    ? State["hasDefault"] extends true
      ? State["nullable"] extends true
        ? typeof schemas.dateTimeOptionalNullableArrayCreate
        : typeof schemas.dateTimeOptionalArrayCreate
      : State["nullable"] extends true
        ? typeof schemas.dateTimeNullableArrayCreate
        : typeof schemas.dateTimeArrayCreate
    : State["hasDefault"] extends true
      ? State["nullable"] extends true
        ? typeof schemas.dateTimeOptionalNullableCreate
        : typeof schemas.dateTimeOptionalCreate
      : State["nullable"] extends true
        ? typeof schemas.dateTimeNullableCreate
        : typeof schemas.dateTimeCreate;

  update: State["array"] extends true
    ? State["nullable"] extends true
      ? typeof schemas.dateTimeNullableArrayUpdate
      : typeof schemas.dateTimeArrayUpdate
    : State["nullable"] extends true
      ? typeof schemas.dateTimeNullableUpdate
      : typeof schemas.dateTimeUpdate;
};

// =============================================================================
// DATETIME FIELD CLASS
// =============================================================================

export class DateTimeField<State extends FieldState<"datetime">> {
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};

  constructor(
    private state: State,
    private _nativeType?: NativeType
  ) {}

  // ===========================================================================
  // CHAINABLE MODIFIERS
  // ===========================================================================

  nullable(): DateTimeField<UpdateState<State, { nullable: true }>> {
    return new DateTimeField({ ...this.state, nullable: true });
  }

  array(): DateTimeField<UpdateState<State, { array: true }>> {
    return new DateTimeField({ ...this.state, array: true });
  }

  id(): DateTimeField<UpdateState<State, { isId: true; isUnique: true }>> {
    return new DateTimeField({ ...this.state, isId: true, isUnique: true });
  }

  unique(): DateTimeField<UpdateState<State, { isUnique: true }>> {
    return new DateTimeField({ ...this.state, isUnique: true });
  }

  default(
    value: DefaultValue<Date, State["array"], State["nullable"]>
  ): DateTimeField<UpdateState<State, { hasDefault: true }>> {
    return new DateTimeField({
      ...this.state,
      hasDefault: true,
      defaultValue: value,
    });
  }

  validator(
    schema: StandardSchemaV1
  ): DateTimeField<UpdateState<State, { customValidator: StandardSchemaV1 }>> {
    return new DateTimeField({
      ...this.state,
      customValidator: schema,
    });
  }

  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this {
    return new DateTimeField({ ...this.state, columnName }) as this;
  }

  // ===========================================================================
  // AUTO-GENERATION METHODS
  // ===========================================================================

  now(): DateTimeField<
    UpdateState<State, { hasDefault: true; autoGenerate: "now" }>
  > {
    return new DateTimeField({
      ...this.state,
      hasDefault: true,
      autoGenerate: "now",
    });
  }

  updatedAt(): DateTimeField<
    UpdateState<State, { hasDefault: true; autoGenerate: "updatedAt" }>
  > {
    return new DateTimeField({
      ...this.state,
      hasDefault: true,
      autoGenerate: "updatedAt",
    });
  }

  // ===========================================================================
  // SCHEMA GETTER
  // ===========================================================================

  get schemas(): DateTimeFieldSchemas<State> {
    const { nullable, array, hasDefault } = this.state;

    const base = array
      ? nullable
        ? schemas.dateTimeNullableArray
        : schemas.dateTimeArray
      : nullable
        ? schemas.dateTimeNullable
        : schemas.dateTimeBase;

    const filter = array
      ? nullable
        ? schemas.dateTimeNullableListFilter
        : schemas.dateTimeListFilter
      : nullable
        ? schemas.dateTimeNullableFilter
        : schemas.dateTimeFilter;

    const create = array
      ? hasDefault
        ? nullable
          ? schemas.dateTimeOptionalNullableArrayCreate
          : schemas.dateTimeOptionalArrayCreate
        : nullable
          ? schemas.dateTimeNullableArrayCreate
          : schemas.dateTimeArrayCreate
      : hasDefault
        ? nullable
          ? schemas.dateTimeOptionalNullableCreate
          : schemas.dateTimeOptionalCreate
        : nullable
          ? schemas.dateTimeNullableCreate
          : schemas.dateTimeCreate;

    const update = array
      ? nullable
        ? schemas.dateTimeNullableArrayUpdate
        : schemas.dateTimeArrayUpdate
      : nullable
        ? schemas.dateTimeNullableUpdate
        : schemas.dateTimeUpdate;

    return { base, filter, create, update } as DateTimeFieldSchemas<State>;
  }

  // ===========================================================================
  // ACCESSORS
  // ===========================================================================

  get ["~"]() {
    return {
      state: this.state,
      schemas: this.schemas,
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
