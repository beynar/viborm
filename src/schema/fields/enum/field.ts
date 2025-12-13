// Enum Field
// Lean class delegating schema selection to schema factories

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
} from "../common";
import type { NativeType } from "../native-types";
import { type EnumFieldState, getFieldEnumSchemas } from "./schemas";

export class EnumField<
  TEnum extends string[] = string[],
  State extends EnumFieldState<TEnum> = EnumFieldState<TEnum>
> {
  private enumValues: TEnum;
  private _names: SchemaNames = {};

  constructor(
    enumValues: TEnum,
    private state: State,
    private _nativeType?: NativeType
  ) {
    this.enumValues = enumValues;
  }

  nullable(): EnumField<
    TEnum,
    UpdateState<State, { nullable: true }> & EnumFieldState<TEnum>
  > {
    return new EnumField(
      this.enumValues,
      { ...this.state, nullable: true } as UpdateState<
        State,
        { nullable: true }
      > &
        EnumFieldState<TEnum>,
      this._nativeType
    );
  }

  array(): EnumField<
    TEnum,
    UpdateState<State, { array: true }> & EnumFieldState<TEnum>
  > {
    return new EnumField(
      this.enumValues,
      { ...this.state, array: true } as UpdateState<State, { array: true }> &
        EnumFieldState<TEnum>,
      this._nativeType
    );
  }

  default(
    value: DefaultValue<TEnum[number], State["array"], State["nullable"]>
  ): EnumField<
    TEnum,
    UpdateState<State, { hasDefault: true }> & EnumFieldState<TEnum>
  > {
    return new EnumField(
      this.enumValues,
      {
        ...this.state,
        hasDefault: true,
        defaultValue: value,
      } as UpdateState<State, { hasDefault: true }> & EnumFieldState<TEnum>,
      this._nativeType
    );
  }

  schema(
    schema: StandardSchemaV1
  ): EnumField<
    TEnum,
    UpdateState<State, { schema: StandardSchemaV1 }> & EnumFieldState<TEnum>
  > {
    return new EnumField(
      this.enumValues,
      {
        ...this.state,
        schema: schema,
      } as UpdateState<State, { schema: StandardSchemaV1 }> &
        EnumFieldState<TEnum>,
      this._nativeType
    );
  }

  map(columnName: string): this {
    return new EnumField(
      this.enumValues,
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: getFieldEnumSchemas(this.state),
      enumValues: this.enumValues,
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

export const enumField = <const T extends string[]>(
  values: T,
  nativeType?: NativeType
) => {
  const baseState = createDefaultState("enum") as EnumFieldState<T>;
  return new EnumField<T, EnumFieldState<T>>(
    values,
    { ...baseState, enumValues: values },
    nativeType
  );
};
