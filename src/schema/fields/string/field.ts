// String Field
// Standalone field class with State generic pattern

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  createDefaultState,
} from "../common";
import type { NativeType } from "../native-types";
import * as schemas from "./schemas";

// =============================================================================
// SCHEMA TYPE DERIVATION
// =============================================================================

/**
 * Derives the correct schema types based on field state.
 * Uses conditional types to compute the exact schema type.
 */
type StringFieldSchemas<State extends FieldState<"string">> = {
  base: State["array"] extends true
    ? State["nullable"] extends true
      ? typeof schemas.stringNullableArray
      : typeof schemas.stringArray
    : State["nullable"] extends true
    ? typeof schemas.stringNullable
    : typeof schemas.stringBase;

  filter: State["array"] extends true
    ? State["nullable"] extends true
      ? typeof schemas.stringNullableListFilter
      : typeof schemas.stringListFilter
    : State["nullable"] extends true
    ? typeof schemas.stringNullableFilter
    : typeof schemas.stringFilter;

  create: State["array"] extends true
    ? State["hasDefault"] extends true
      ? State["nullable"] extends true
        ? typeof schemas.stringOptionalNullableArrayCreate
        : typeof schemas.stringOptionalArrayCreate
      : State["nullable"] extends true
      ? typeof schemas.stringNullableArrayCreate
      : typeof schemas.stringArrayCreate
    : State["hasDefault"] extends true
    ? State["nullable"] extends true
      ? typeof schemas.stringOptionalNullableCreate
      : typeof schemas.stringOptionalCreate
    : State["nullable"] extends true
    ? typeof schemas.stringNullableCreate
    : typeof schemas.stringCreate;

  update: State["array"] extends true
    ? State["nullable"] extends true
      ? typeof schemas.stringNullableArrayUpdate
      : typeof schemas.stringArrayUpdate
    : State["nullable"] extends true
    ? typeof schemas.stringNullableUpdate
    : typeof schemas.stringUpdate;
};

// =============================================================================
// STRING FIELD CLASS
// =============================================================================

export class StringField<State extends FieldState<"string">> {
  constructor(private state: State, private _nativeType?: NativeType) {}

  // ===========================================================================
  // CHAINABLE MODIFIERS - Each returns properly typed new instance
  // ===========================================================================

  nullable(): StringField<UpdateState<State, { nullable: true }>> {
    return new StringField({ ...this.state, nullable: true }, this._nativeType);
  }

  array(): StringField<UpdateState<State, { array: true }>> {
    return new StringField({ ...this.state, array: true }, this._nativeType);
  }

  id(): StringField<UpdateState<State, { isId: true; isUnique: true }>> {
    return new StringField(
      { ...this.state, isId: true, isUnique: true },
      this._nativeType
    );
  }

  unique(): StringField<UpdateState<State, { isUnique: true }>> {
    return new StringField({ ...this.state, isUnique: true }, this._nativeType);
  }

  default(
    value: DefaultValue<string, State["array"], State["nullable"]>
  ): StringField<UpdateState<State, { hasDefault: true }>> {
    return new StringField(
      {
        ...this.state,
        hasDefault: true,
        defaultValue: value,
      },
      this._nativeType
    );
  }

  validator(
    schema: StandardSchemaV1
  ): StringField<UpdateState<State, { customValidator: StandardSchemaV1 }>> {
    return new StringField(
      {
        ...this.state,
        customValidator: schema,
      },
      this._nativeType
    );
  }

  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this {
    return new StringField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  // ===========================================================================
  // AUTO-GENERATION METHODS
  // ===========================================================================

  uuid(): StringField<
    UpdateState<State, { hasDefault: true; autoGenerate: "uuid" }>
  > {
    return new StringField(
      {
        ...this.state,
        hasDefault: true,
        autoGenerate: "uuid",
      },
      this._nativeType
    );
  }

  ulid(): StringField<
    UpdateState<State, { hasDefault: true; autoGenerate: "ulid" }>
  > {
    return new StringField(
      {
        ...this.state,
        hasDefault: true,
        autoGenerate: "ulid",
      },
      this._nativeType
    );
  }

  nanoid(): StringField<
    UpdateState<State, { hasDefault: true; autoGenerate: "nanoid" }>
  > {
    return new StringField(
      {
        ...this.state,
        hasDefault: true,
        autoGenerate: "nanoid",
      },
      this._nativeType
    );
  }

  cuid(): StringField<
    UpdateState<State, { hasDefault: true; autoGenerate: "cuid" }>
  > {
    return new StringField(
      {
        ...this.state,
        hasDefault: true,
        autoGenerate: "cuid",
      },
      this._nativeType
    );
  }

  // ===========================================================================
  // SCHEMA GETTER
  // ===========================================================================

  /**
   * Returns the ArkType schemas for this field based on current state.
   * Type is derived from state generics for perfect inference.
   */
  get schemas(): StringFieldSchemas<State> {
    const { nullable, array, hasDefault } = this.state;

    // Runtime schema selection
    const base = array
      ? nullable
        ? schemas.stringNullableArray
        : schemas.stringArray
      : nullable
      ? schemas.stringNullable
      : schemas.stringBase;

    const filter = array
      ? nullable
        ? schemas.stringNullableListFilter
        : schemas.stringListFilter
      : nullable
      ? schemas.stringNullableFilter
      : schemas.stringFilter;

    const create = array
      ? hasDefault
        ? nullable
          ? schemas.stringOptionalNullableArrayCreate
          : schemas.stringOptionalArrayCreate
        : nullable
        ? schemas.stringNullableArrayCreate
        : schemas.stringArrayCreate
      : hasDefault
      ? nullable
        ? schemas.stringOptionalNullableCreate
        : schemas.stringOptionalCreate
      : nullable
      ? schemas.stringNullableCreate
      : schemas.stringCreate;

    const update = array
      ? nullable
        ? schemas.stringNullableArrayUpdate
        : schemas.stringArrayUpdate
      : nullable
      ? schemas.stringNullableUpdate
      : schemas.stringUpdate;

    return { base, filter, create, update } as StringFieldSchemas<State>;
  }

  // ===========================================================================
  // ACCESSORS
  // ===========================================================================

  get ["~"]() {
    return {
      state: this.state,
      schemas: this.schemas,
      nativeType: this._nativeType,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Creates a string field with optional native database type override
 *
 * @example
 * // Default string field
 * s.string()
 *
 * // With PostgreSQL native type
 * s.string(PG.STRING.VARCHAR(255))
 * s.string(PG.STRING.CITEXT)
 *
 * // With MySQL native type
 * s.string(MYSQL.STRING.TEXT)
 */
export const string = (nativeType?: NativeType) =>
  new StringField(createDefaultState("string"), nativeType);
