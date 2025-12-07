// Boolean Field
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
// BOOLEAN FIELD SCHEMA TYPE DERIVATION
// =============================================================================

type BooleanFieldSchemas<State extends FieldState<"boolean">> = {
  base: State["array"] extends true
    ? State["nullable"] extends true
      ? typeof schemas.booleanNullableArray
      : typeof schemas.booleanArray
    : State["nullable"] extends true
      ? typeof schemas.booleanNullable
      : typeof schemas.booleanBase;

  filter: State["array"] extends true
    ? State["nullable"] extends true
      ? typeof schemas.booleanNullableListFilter
      : typeof schemas.booleanListFilter
    : State["nullable"] extends true
      ? typeof schemas.booleanNullableFilter
      : typeof schemas.booleanFilter;

  create: State["array"] extends true
    ? State["hasDefault"] extends true
      ? State["nullable"] extends true
        ? typeof schemas.booleanOptionalNullableArrayCreate
        : typeof schemas.booleanOptionalArrayCreate
      : State["nullable"] extends true
        ? typeof schemas.booleanNullableArrayCreate
        : typeof schemas.booleanArrayCreate
    : State["hasDefault"] extends true
      ? State["nullable"] extends true
        ? typeof schemas.booleanOptionalNullableCreate
        : typeof schemas.booleanOptionalCreate
      : State["nullable"] extends true
        ? typeof schemas.booleanNullableCreate
        : typeof schemas.booleanCreate;

  update: State["array"] extends true
    ? State["nullable"] extends true
      ? typeof schemas.booleanNullableArrayUpdate
      : typeof schemas.booleanArrayUpdate
    : State["nullable"] extends true
      ? typeof schemas.booleanNullableUpdate
      : typeof schemas.booleanUpdate;
};

// =============================================================================
// BOOLEAN FIELD CLASS
// =============================================================================

export class BooleanField<State extends FieldState<"boolean">> {
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};

  constructor(
    private state: State,
    private _nativeType?: NativeType
  ) {}

  // ===========================================================================
  // CHAINABLE MODIFIERS
  // ===========================================================================

  nullable(): BooleanField<UpdateState<State, { nullable: true }>> {
    return new BooleanField({ ...this.state, nullable: true });
  }

  array(): BooleanField<UpdateState<State, { array: true }>> {
    return new BooleanField({ ...this.state, array: true });
  }

  unique(): BooleanField<UpdateState<State, { isUnique: true }>> {
    return new BooleanField({ ...this.state, isUnique: true });
  }

  default(
    value: DefaultValue<boolean, State["array"], State["nullable"]>
  ): BooleanField<UpdateState<State, { hasDefault: true }>> {
    return new BooleanField({
      ...this.state,
      hasDefault: true,
      defaultValue: value,
    });
  }

  validator(
    schema: StandardSchemaV1
  ): BooleanField<UpdateState<State, { customValidator: StandardSchemaV1 }>> {
    return new BooleanField({
      ...this.state,
      customValidator: schema,
    });
  }

  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this {
    return new BooleanField({ ...this.state, columnName }) as this;
  }

  // Boolean fields cannot be IDs
  id(): never {
    throw new Error("Boolean fields cannot be used as IDs");
  }

  // ===========================================================================
  // SCHEMA GETTER
  // ===========================================================================

  get schemas(): BooleanFieldSchemas<State> {
    const { nullable, array, hasDefault } = this.state;

    const base = array
      ? nullable
        ? schemas.booleanNullableArray
        : schemas.booleanArray
      : nullable
        ? schemas.booleanNullable
        : schemas.booleanBase;

    const filter = array
      ? nullable
        ? schemas.booleanNullableListFilter
        : schemas.booleanListFilter
      : nullable
        ? schemas.booleanNullableFilter
        : schemas.booleanFilter;

    const create = array
      ? hasDefault
        ? nullable
          ? schemas.booleanOptionalNullableArrayCreate
          : schemas.booleanOptionalArrayCreate
        : nullable
          ? schemas.booleanNullableArrayCreate
          : schemas.booleanArrayCreate
      : hasDefault
        ? nullable
          ? schemas.booleanOptionalNullableCreate
          : schemas.booleanOptionalCreate
        : nullable
          ? schemas.booleanNullableCreate
          : schemas.booleanCreate;

    const update = array
      ? nullable
        ? schemas.booleanNullableArrayUpdate
        : schemas.booleanArrayUpdate
      : nullable
        ? schemas.booleanNullableUpdate
        : schemas.booleanUpdate;

    return { base, filter, create, update } as BooleanFieldSchemas<State>;
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

export const boolean = (nativeType?: NativeType) =>
  new BooleanField(createDefaultState("boolean"), nativeType);
