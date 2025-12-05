// BigInt Field
// Standalone field class with State generic pattern

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  createDefaultState,
} from "../common";
import * as schemas from "./schemas";

// =============================================================================
// BIGINT FIELD SCHEMA TYPE DERIVATION
// =============================================================================

type BigIntFieldSchemas<State extends FieldState<"bigint">> = {
  base: State["array"] extends true
    ? State["nullable"] extends true
      ? typeof schemas.bigIntNullableArray
      : typeof schemas.bigIntArray
    : State["nullable"] extends true
      ? typeof schemas.bigIntNullable
      : typeof schemas.bigIntBase;

  filter: State["array"] extends true
    ? State["nullable"] extends true
      ? typeof schemas.bigIntNullableListFilter
      : typeof schemas.bigIntListFilter
    : State["nullable"] extends true
      ? typeof schemas.bigIntNullableFilter
      : typeof schemas.bigIntFilter;

  create: State["array"] extends true
    ? State["hasDefault"] extends true
      ? State["nullable"] extends true
        ? typeof schemas.bigIntOptionalNullableArrayCreate
        : typeof schemas.bigIntOptionalArrayCreate
      : State["nullable"] extends true
        ? typeof schemas.bigIntNullableArrayCreate
        : typeof schemas.bigIntArrayCreate
    : State["hasDefault"] extends true
      ? State["nullable"] extends true
        ? typeof schemas.bigIntOptionalNullableCreate
        : typeof schemas.bigIntOptionalCreate
      : State["nullable"] extends true
        ? typeof schemas.bigIntNullableCreate
        : typeof schemas.bigIntCreate;

  update: State["array"] extends true
    ? State["nullable"] extends true
      ? typeof schemas.bigIntNullableArrayUpdate
      : typeof schemas.bigIntArrayUpdate
    : State["nullable"] extends true
      ? typeof schemas.bigIntNullableUpdate
      : typeof schemas.bigIntUpdate;
};

// =============================================================================
// BIGINT FIELD CLASS
// =============================================================================

export class BigIntField<State extends FieldState<"bigint">> {
  constructor(private state: State) {}

  // ===========================================================================
  // CHAINABLE MODIFIERS
  // ===========================================================================

  nullable(): BigIntField<UpdateState<State, { nullable: true }>> {
    return new BigIntField({ ...this.state, nullable: true });
  }

  array(): BigIntField<UpdateState<State, { array: true }>> {
    return new BigIntField({ ...this.state, array: true });
  }

  id(): BigIntField<UpdateState<State, { isId: true; isUnique: true }>> {
    return new BigIntField({ ...this.state, isId: true, isUnique: true });
  }

  unique(): BigIntField<UpdateState<State, { isUnique: true }>> {
    return new BigIntField({ ...this.state, isUnique: true });
  }

  default(
    value: DefaultValue<bigint, State["array"], State["nullable"]>
  ): BigIntField<UpdateState<State, { hasDefault: true }>> {
    return new BigIntField({
      ...this.state,
      hasDefault: true,
      defaultValue: value,
    });
  }

  validator(
    schema: StandardSchemaV1
  ): BigIntField<UpdateState<State, { customValidator: StandardSchemaV1 }>> {
    return new BigIntField({
      ...this.state,
      customValidator: schema,
    });
  }

  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this {
    return new BigIntField({ ...this.state, columnName }) as this;
  }

  // ===========================================================================
  // AUTO-GENERATION
  // ===========================================================================

  increment(): BigIntField<
    UpdateState<State, { hasDefault: true; autoGenerate: "increment" }>
  > {
    return new BigIntField({
      ...this.state,
      hasDefault: true,
      autoGenerate: "increment",
    });
  }

  // ===========================================================================
  // SCHEMA GETTER
  // ===========================================================================

  get schemas(): BigIntFieldSchemas<State> {
    const { nullable, array, hasDefault } = this.state;

    const base = array
      ? nullable
        ? schemas.bigIntNullableArray
        : schemas.bigIntArray
      : nullable
        ? schemas.bigIntNullable
        : schemas.bigIntBase;

    const filter = array
      ? nullable
        ? schemas.bigIntNullableListFilter
        : schemas.bigIntListFilter
      : nullable
        ? schemas.bigIntNullableFilter
        : schemas.bigIntFilter;

    const create = array
      ? hasDefault
        ? nullable
          ? schemas.bigIntOptionalNullableArrayCreate
          : schemas.bigIntOptionalArrayCreate
        : nullable
          ? schemas.bigIntNullableArrayCreate
          : schemas.bigIntArrayCreate
      : hasDefault
        ? nullable
          ? schemas.bigIntOptionalNullableCreate
          : schemas.bigIntOptionalCreate
        : nullable
          ? schemas.bigIntNullableCreate
          : schemas.bigIntCreate;

    const update = array
      ? nullable
        ? schemas.bigIntNullableArrayUpdate
        : schemas.bigIntArrayUpdate
      : nullable
        ? schemas.bigIntNullableUpdate
        : schemas.bigIntUpdate;

    return { base, filter, create, update } as BigIntFieldSchemas<State>;
  }

  // ===========================================================================
  // ACCESSORS
  // ===========================================================================

  get ["~"]() {
    return {
      state: this.state,
      schemas: this.schemas,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

export const bigInt = () => new BigIntField(createDefaultState("bigint"));
