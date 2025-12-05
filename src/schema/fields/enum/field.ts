// Enum Field
// Standalone field class with State generic pattern

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  createDefaultState,
} from "../common";
import * as schemaBuilders from "./schemas";
import type {
  EnumType,
  EnumNullableType,
  EnumArrayType,
  EnumNullableArrayType,
  EnumFilterType,
  EnumNullableFilterType,
  EnumListFilterType,
  EnumUpdateType,
  EnumNullableUpdateType,
  EnumArrayUpdateType,
  EnumOptionalType,
  EnumOptionalNullableType,
} from "./schemas";

// =============================================================================
// ENUM FIELD STATE (extends base with enum values)
// =============================================================================

interface EnumFieldState<TEnum extends readonly string[] = readonly string[]>
  extends FieldState<"enum"> {
  enumValues: TEnum;
}

// =============================================================================
// ENUM FIELD SCHEMA TYPE DERIVATION
// =============================================================================

/**
 * Derives the correct schema types based on field state and enum values.
 * Uses conditional types to compute the exact schema type.
 */
type EnumFieldSchemas<
  TEnum extends readonly string[],
  State extends EnumFieldState<TEnum>
> = {
  base: State["array"] extends true
    ? State["nullable"] extends true
      ? EnumNullableArrayType<TEnum>
      : EnumArrayType<TEnum>
    : State["nullable"] extends true
    ? EnumNullableType<TEnum>
    : EnumType<TEnum>;

  filter: State["array"] extends true
    ? EnumListFilterType<TEnum>
    : State["nullable"] extends true
    ? EnumNullableFilterType<TEnum>
    : EnumFilterType<TEnum>;

  create: State["array"] extends true
    ? State["hasDefault"] extends true
      ? State["nullable"] extends true
        ? EnumOptionalNullableType<TEnum>
        : EnumOptionalType<TEnum>
      : State["nullable"] extends true
      ? EnumNullableArrayType<TEnum>
      : EnumArrayType<TEnum>
    : State["hasDefault"] extends true
    ? State["nullable"] extends true
      ? EnumOptionalNullableType<TEnum>
      : EnumOptionalType<TEnum>
    : State["nullable"] extends true
    ? EnumNullableType<TEnum>
    : EnumType<TEnum>;

  update: State["array"] extends true
    ? EnumArrayUpdateType<TEnum>
    : State["nullable"] extends true
    ? EnumNullableUpdateType<TEnum>
    : EnumUpdateType<TEnum>;
};

// =============================================================================
// ENUM FIELD CLASS
// =============================================================================

export class EnumField<
  TEnum extends readonly string[] = readonly string[],
  State extends EnumFieldState<TEnum> = EnumFieldState<TEnum>
> {
  readonly enumValues: TEnum;

  constructor(enumValues: TEnum, private state: State) {
    this.enumValues = enumValues;
  }

  // ===========================================================================
  // CHAINABLE MODIFIERS
  // ===========================================================================

  nullable(): EnumField<
    TEnum,
    UpdateState<State, { nullable: true }> & EnumFieldState<TEnum>
  > {
    return new EnumField(this.enumValues, {
      ...this.state,
      nullable: true,
    } as UpdateState<State, { nullable: true }> & EnumFieldState<TEnum>);
  }

  array(): EnumField<
    TEnum,
    UpdateState<State, { array: true }> & EnumFieldState<TEnum>
  > {
    return new EnumField(this.enumValues, {
      ...this.state,
      array: true,
    } as UpdateState<State, { array: true }> & EnumFieldState<TEnum>);
  }

  id(): EnumField<
    TEnum,
    UpdateState<State, { isId: true; isUnique: true }> & EnumFieldState<TEnum>
  > {
    return new EnumField(this.enumValues, {
      ...this.state,
      isId: true,
      isUnique: true,
    } as UpdateState<State, { isId: true; isUnique: true }> & EnumFieldState<TEnum>);
  }

  unique(): EnumField<
    TEnum,
    UpdateState<State, { isUnique: true }> & EnumFieldState<TEnum>
  > {
    return new EnumField(this.enumValues, {
      ...this.state,
      isUnique: true,
    } as UpdateState<State, { isUnique: true }> & EnumFieldState<TEnum>);
  }

  default(
    value: DefaultValue<TEnum[number], State["array"], State["nullable"]>
  ): EnumField<
    TEnum,
    UpdateState<State, { hasDefault: true }> & EnumFieldState<TEnum>
  > {
    return new EnumField(this.enumValues, {
      ...this.state,
      hasDefault: true,
      defaultValue: value,
    } as UpdateState<State, { hasDefault: true }> & EnumFieldState<TEnum>);
  }

  validator(
    schema: StandardSchemaV1
  ): EnumField<
    TEnum,
    UpdateState<State, { customValidator: StandardSchemaV1 }> &
      EnumFieldState<TEnum>
  > {
    return new EnumField(this.enumValues, {
      ...this.state,
      customValidator: schema,
    } as UpdateState<State, { customValidator: StandardSchemaV1 }> & EnumFieldState<TEnum>);
  }

  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this {
    return new EnumField(this.enumValues, {
      ...this.state,
      columnName,
    }) as this;
  }

  // ===========================================================================
  // SCHEMA GETTER
  // ===========================================================================

  get schemas(): EnumFieldSchemas<TEnum, State> {
    const { nullable, array, hasDefault } = this.state;

    const base = schemaBuilders.createEnumBase(this.enumValues);
    const nullableBase = schemaBuilders.createEnumNullable(this.enumValues);

    const baseSchema = array
      ? nullable
        ? schemaBuilders.createEnumNullableArray(this.enumValues)
        : schemaBuilders.createEnumArray(this.enumValues)
      : nullable
      ? nullableBase
      : base;

    const filter = array
      ? schemaBuilders.createEnumListFilter(this.enumValues)
      : nullable
      ? schemaBuilders.createEnumNullableFilter(this.enumValues)
      : schemaBuilders.createEnumFilter(this.enumValues);

    const create = array
      ? hasDefault
        ? nullable
          ? schemaBuilders.createEnumOptionalNullableCreate(this.enumValues)
          : schemaBuilders.createEnumOptionalCreate(this.enumValues)
        : nullable
        ? schemaBuilders.createEnumNullableArray(this.enumValues)
        : schemaBuilders.createEnumArray(this.enumValues)
      : hasDefault
      ? nullable
        ? schemaBuilders.createEnumOptionalNullableCreate(this.enumValues)
        : schemaBuilders.createEnumOptionalCreate(this.enumValues)
      : nullable
      ? nullableBase
      : base;

    const update = array
      ? schemaBuilders.createEnumArrayUpdate(this.enumValues)
      : nullable
      ? schemaBuilders.createEnumNullableUpdate(this.enumValues)
      : schemaBuilders.createEnumUpdate(this.enumValues);

    return { base: baseSchema, filter, create, update } as EnumFieldSchemas<
      TEnum,
      State
    >;
  }

  // ===========================================================================
  // ACCESSORS
  // ===========================================================================

  get ["~"]() {
    return {
      state: this.state,
      schemas: this.schemas,
      enumValues: this.enumValues,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

export const enumField = <const T extends readonly string[]>(values: T) => {
  const baseState = createDefaultState("enum") as EnumFieldState<T>;
  return new EnumField<T, EnumFieldState<T>>(values, {
    ...baseState,
    enumValues: values,
  });
};
