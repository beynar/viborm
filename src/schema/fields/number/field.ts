// Number Fields (int, float, decimal)
// Standalone field classes with State generic pattern

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  createDefaultState,
} from "../common";
import * as schemas from "./schemas";

// =============================================================================
// INT FIELD SCHEMA TYPE DERIVATION
// =============================================================================

type IntFieldSchemas<State extends FieldState<"int">> = {
  base: State["array"] extends true
    ? State["nullable"] extends true
      ? typeof schemas.intNullableArray
      : typeof schemas.intArray
    : State["nullable"] extends true
      ? typeof schemas.intNullable
      : typeof schemas.intBase;

  filter: State["array"] extends true
    ? State["nullable"] extends true
      ? typeof schemas.intNullableListFilter
      : typeof schemas.intListFilter
    : State["nullable"] extends true
      ? typeof schemas.intNullableFilter
      : typeof schemas.intFilter;

  create: State["array"] extends true
    ? State["hasDefault"] extends true
      ? State["nullable"] extends true
        ? typeof schemas.intOptionalNullableArrayCreate
        : typeof schemas.intOptionalArrayCreate
      : State["nullable"] extends true
        ? typeof schemas.intNullableArrayCreate
        : typeof schemas.intArrayCreate
    : State["hasDefault"] extends true
      ? State["nullable"] extends true
        ? typeof schemas.intOptionalNullableCreate
        : typeof schemas.intOptionalCreate
      : State["nullable"] extends true
        ? typeof schemas.intNullableCreate
        : typeof schemas.intCreate;

  update: State["array"] extends true
    ? State["nullable"] extends true
      ? typeof schemas.intNullableArrayUpdate
      : typeof schemas.intArrayUpdate
    : State["nullable"] extends true
      ? typeof schemas.intNullableUpdate
      : typeof schemas.intUpdate;
};

// =============================================================================
// INT FIELD CLASS
// =============================================================================

export class IntField<State extends FieldState<"int">> {
  constructor(private state: State) {}

  // ===========================================================================
  // CHAINABLE MODIFIERS
  // ===========================================================================

  nullable(): IntField<UpdateState<State, { nullable: true }>> {
    return new IntField({ ...this.state, nullable: true });
  }

  array(): IntField<UpdateState<State, { array: true }>> {
    return new IntField({ ...this.state, array: true });
  }

  id(): IntField<UpdateState<State, { isId: true; isUnique: true }>> {
    return new IntField({ ...this.state, isId: true, isUnique: true });
  }

  unique(): IntField<UpdateState<State, { isUnique: true }>> {
    return new IntField({ ...this.state, isUnique: true });
  }

  default(
    value: DefaultValue<number, State["array"], State["nullable"]>
  ): IntField<UpdateState<State, { hasDefault: true }>> {
    return new IntField({
      ...this.state,
      hasDefault: true,
      defaultValue: value,
    });
  }

  validator(
    schema: StandardSchemaV1
  ): IntField<UpdateState<State, { customValidator: StandardSchemaV1 }>> {
    return new IntField({
      ...this.state,
      customValidator: schema,
    });
  }

  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this {
    return new IntField({ ...this.state, columnName }) as this;
  }

  // ===========================================================================
  // AUTO-GENERATION
  // ===========================================================================

  increment(): IntField<
    UpdateState<State, { hasDefault: true; autoGenerate: "increment" }>
  > {
    return new IntField({
      ...this.state,
      hasDefault: true,
      autoGenerate: "increment",
    });
  }

  // ===========================================================================
  // SCHEMA GETTER
  // ===========================================================================

  get schemas(): IntFieldSchemas<State> {
    const { nullable, array, hasDefault } = this.state;

    const base = array
      ? nullable
        ? schemas.intNullableArray
        : schemas.intArray
      : nullable
        ? schemas.intNullable
        : schemas.intBase;

    const filter = array
      ? nullable
        ? schemas.intNullableListFilter
        : schemas.intListFilter
      : nullable
        ? schemas.intNullableFilter
        : schemas.intFilter;

    const create = array
      ? hasDefault
        ? nullable
          ? schemas.intOptionalNullableArrayCreate
          : schemas.intOptionalArrayCreate
        : nullable
          ? schemas.intNullableArrayCreate
          : schemas.intArrayCreate
      : hasDefault
        ? nullable
          ? schemas.intOptionalNullableCreate
          : schemas.intOptionalCreate
        : nullable
          ? schemas.intNullableCreate
          : schemas.intCreate;

    const update = array
      ? nullable
        ? schemas.intNullableArrayUpdate
        : schemas.intArrayUpdate
      : nullable
        ? schemas.intNullableUpdate
        : schemas.intUpdate;

    return { base, filter, create, update } as IntFieldSchemas<State>;
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
// FLOAT FIELD SCHEMA TYPE DERIVATION
// =============================================================================

type FloatFieldSchemas<State extends FieldState<"float">> = {
  base: State["array"] extends true
    ? State["nullable"] extends true
      ? typeof schemas.floatNullableArray
      : typeof schemas.floatArray
    : State["nullable"] extends true
      ? typeof schemas.floatNullable
      : typeof schemas.floatBase;

  filter: State["array"] extends true
    ? State["nullable"] extends true
      ? typeof schemas.floatNullableListFilter
      : typeof schemas.floatListFilter
    : State["nullable"] extends true
      ? typeof schemas.floatNullableFilter
      : typeof schemas.floatFilter;

  create: State["array"] extends true
    ? State["hasDefault"] extends true
      ? State["nullable"] extends true
        ? typeof schemas.floatOptionalNullableArrayCreate
        : typeof schemas.floatOptionalArrayCreate
      : State["nullable"] extends true
        ? typeof schemas.floatNullableArrayCreate
        : typeof schemas.floatArrayCreate
    : State["hasDefault"] extends true
      ? State["nullable"] extends true
        ? typeof schemas.floatOptionalNullableCreate
        : typeof schemas.floatOptionalCreate
      : State["nullable"] extends true
        ? typeof schemas.floatNullableCreate
        : typeof schemas.floatCreate;

  update: State["array"] extends true
    ? State["nullable"] extends true
      ? typeof schemas.floatNullableArrayUpdate
      : typeof schemas.floatArrayUpdate
    : State["nullable"] extends true
      ? typeof schemas.floatNullableUpdate
      : typeof schemas.floatUpdate;
};

// =============================================================================
// FLOAT FIELD CLASS
// =============================================================================

export class FloatField<State extends FieldState<"float">> {
  constructor(private state: State) {}

  // ===========================================================================
  // CHAINABLE MODIFIERS
  // ===========================================================================

  nullable(): FloatField<UpdateState<State, { nullable: true }>> {
    return new FloatField({ ...this.state, nullable: true });
  }

  array(): FloatField<UpdateState<State, { array: true }>> {
    return new FloatField({ ...this.state, array: true });
  }

  id(): FloatField<UpdateState<State, { isId: true; isUnique: true }>> {
    return new FloatField({ ...this.state, isId: true, isUnique: true });
  }

  unique(): FloatField<UpdateState<State, { isUnique: true }>> {
    return new FloatField({ ...this.state, isUnique: true });
  }

  default(
    value: DefaultValue<number, State["array"], State["nullable"]>
  ): FloatField<UpdateState<State, { hasDefault: true }>> {
    return new FloatField({
      ...this.state,
      hasDefault: true,
      defaultValue: value,
    });
  }

  validator(
    schema: StandardSchemaV1
  ): FloatField<UpdateState<State, { customValidator: StandardSchemaV1 }>> {
    return new FloatField({
      ...this.state,
      customValidator: schema,
    });
  }

  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this {
    return new FloatField({ ...this.state, columnName }) as this;
  }

  // ===========================================================================
  // SCHEMA GETTER
  // ===========================================================================

  get schemas(): FloatFieldSchemas<State> {
    const { nullable, array, hasDefault } = this.state;

    const base = array
      ? nullable
        ? schemas.floatNullableArray
        : schemas.floatArray
      : nullable
        ? schemas.floatNullable
        : schemas.floatBase;

    const filter = array
      ? nullable
        ? schemas.floatNullableListFilter
        : schemas.floatListFilter
      : nullable
        ? schemas.floatNullableFilter
        : schemas.floatFilter;

    const create = array
      ? hasDefault
        ? nullable
          ? schemas.floatOptionalNullableArrayCreate
          : schemas.floatOptionalArrayCreate
        : nullable
          ? schemas.floatNullableArrayCreate
          : schemas.floatArrayCreate
      : hasDefault
        ? nullable
          ? schemas.floatOptionalNullableCreate
          : schemas.floatOptionalCreate
        : nullable
          ? schemas.floatNullableCreate
          : schemas.floatCreate;

    const update = array
      ? nullable
        ? schemas.floatNullableArrayUpdate
        : schemas.floatArrayUpdate
      : nullable
        ? schemas.floatNullableUpdate
        : schemas.floatUpdate;

    return { base, filter, create, update } as FloatFieldSchemas<State>;
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
// DECIMAL FIELD CLASS (uses float schemas)
// =============================================================================

type DecimalFieldSchemas<State extends FieldState<"decimal">> = FloatFieldSchemas<State & FieldState<"float">>;

export class DecimalField<State extends FieldState<"decimal">> {
  constructor(private state: State) {}

  // ===========================================================================
  // CHAINABLE MODIFIERS
  // ===========================================================================

  nullable(): DecimalField<UpdateState<State, { nullable: true }>> {
    return new DecimalField({ ...this.state, nullable: true });
  }

  array(): DecimalField<UpdateState<State, { array: true }>> {
    return new DecimalField({ ...this.state, array: true });
  }

  id(): DecimalField<UpdateState<State, { isId: true; isUnique: true }>> {
    return new DecimalField({ ...this.state, isId: true, isUnique: true });
  }

  unique(): DecimalField<UpdateState<State, { isUnique: true }>> {
    return new DecimalField({ ...this.state, isUnique: true });
  }

  default(
    value: DefaultValue<number, State["array"], State["nullable"]>
  ): DecimalField<UpdateState<State, { hasDefault: true }>> {
    return new DecimalField({
      ...this.state,
      hasDefault: true,
      defaultValue: value,
    });
  }

  validator(
    schema: StandardSchemaV1
  ): DecimalField<UpdateState<State, { customValidator: StandardSchemaV1 }>> {
    return new DecimalField({
      ...this.state,
      customValidator: schema,
    });
  }

  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this {
    return new DecimalField({ ...this.state, columnName }) as this;
  }

  // ===========================================================================
  // SCHEMA GETTER (uses float schemas)
  // ===========================================================================

  get schemas(): DecimalFieldSchemas<State> {
    const { nullable, array, hasDefault } = this.state;

    const base = array
      ? nullable
        ? schemas.floatNullableArray
        : schemas.floatArray
      : nullable
        ? schemas.floatNullable
        : schemas.floatBase;

    const filter = array
      ? nullable
        ? schemas.floatNullableListFilter
        : schemas.floatListFilter
      : nullable
        ? schemas.floatNullableFilter
        : schemas.floatFilter;

    const create = array
      ? hasDefault
        ? nullable
          ? schemas.floatOptionalNullableArrayCreate
          : schemas.floatOptionalArrayCreate
        : nullable
          ? schemas.floatNullableArrayCreate
          : schemas.floatArrayCreate
      : hasDefault
        ? nullable
          ? schemas.floatOptionalNullableCreate
          : schemas.floatOptionalCreate
        : nullable
          ? schemas.floatNullableCreate
          : schemas.floatCreate;

    const update = array
      ? nullable
        ? schemas.floatNullableArrayUpdate
        : schemas.floatArrayUpdate
      : nullable
        ? schemas.floatNullableUpdate
        : schemas.floatUpdate;

    return { base, filter, create, update } as DecimalFieldSchemas<State>;
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
// FACTORY FUNCTIONS
// =============================================================================

export const int = () => new IntField(createDefaultState("int"));
export const float = () => new FloatField(createDefaultState("float"));
export const decimal = () => new DecimalField(createDefaultState("decimal"));
