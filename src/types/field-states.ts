// Simplified Field State Types
// Practical type system for field configuration

import type { ScalarFieldType, AutoGenerateType } from "./scalars.js";

// Basic field state configuration with literal boolean types
export interface FieldState<
  T = any,
  IsNullable extends boolean = boolean,
  IsList extends boolean = boolean,
  IsId extends boolean = boolean,
  IsUnique extends boolean = boolean,
  HasDefault extends boolean = boolean
> {
  BaseType: T;
  IsNullable: IsNullable;
  IsList: IsList;
  IsId: IsId;
  IsUnique: IsUnique;
  HasDefault: HasDefault;
  AutoGenerate: AutoGenerateType | false;
}

// Default field state with literal false values
export type DefaultFieldState<T> = FieldState<
  T,
  false,
  false,
  false,
  false,
  false
>;

// Type modifiers
export type MakeNullable<T extends FieldState<any, any, any, any, any, any>> =
  FieldState<
    T["BaseType"],
    true,
    T["IsList"],
    T["IsId"],
    T["IsUnique"],
    T["HasDefault"]
  >;

export type MakeList<T extends FieldState<any, any, any, any, any, any>> =
  FieldState<
    T["BaseType"],
    T["IsNullable"],
    true,
    T["IsId"],
    T["IsUnique"],
    T["HasDefault"]
  >;

export type MakeId<T extends FieldState<any, any, any, any, any, any>> =
  FieldState<
    T["BaseType"],
    T["IsNullable"],
    T["IsList"],
    true,
    T["IsUnique"],
    T["HasDefault"]
  >;

export type MakeUnique<T extends FieldState<any, any, any, any, any, any>> =
  FieldState<
    T["BaseType"],
    T["IsNullable"],
    T["IsList"],
    T["IsId"],
    true,
    T["HasDefault"]
  >;

export type MakeDefault<T extends FieldState<any, any, any, any, any, any>> =
  FieldState<
    T["BaseType"],
    T["IsNullable"],
    T["IsList"],
    T["IsId"],
    T["IsUnique"],
    true
  >;

export type MakeAuto<
  T extends FieldState<any, any, any, any, any, any>,
  A extends AutoGenerateType
> = FieldState<
  T["BaseType"],
  T["IsNullable"],
  T["IsList"],
  T["IsId"],
  T["IsUnique"],
  true
> & {
  AutoGenerate: A;
};

// Infer final TypeScript type from field state
export type InferType<T extends FieldState<any, any, any, any, any, any>> =
  T["IsList"] extends true
    ? T["IsNullable"] extends true
      ? T["BaseType"][] | null
      : T["BaseType"][]
    : T["IsNullable"] extends true
    ? T["BaseType"] | null
    : T["BaseType"];

// Base field interface with proper type inference
export interface BaseFieldType<
  T extends FieldState<any, any, any, any, any, any>
> {
  readonly __fieldState: T;
  readonly infer: InferType<T>;

  // Modifier methods
  nullable(): BaseFieldType<MakeNullable<T>>;
  list(): BaseFieldType<MakeList<T>>;
  id(): BaseFieldType<MakeId<T>>;
  unique(): BaseFieldType<MakeUnique<T>>;
  default(
    value: T["BaseType"] | (() => T["BaseType"])
  ): BaseFieldType<MakeDefault<T>>;
}
