// Enum Field
// Standalone field class with State generic pattern

import v from "@validation";
import {
  createDefaultState,
  type DefaultValueInput,
  type FieldState,
  updateState,
} from "../common";
import type { NativeType } from "../native-types";
import { buildEnumSchema, type EnumSchemas } from "./schemas";

export class EnumField<
  Values extends string[],
  State extends FieldState<"enum"> = FieldState<"enum">,
> {
  readonly values: Values;
  private _schemas: EnumSchemas<Values, State> | undefined;
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;
  constructor(values: Values, state: State, _nativeType?: NativeType) {
    this.values = values;
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new EnumField(
      this.values,
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.enum<
          Values,
          {
            nullable: true;
            array: State["array"];
          }
        >(this.values, {
          nullable: true,
          array: this.state.array,
        }),
      }),
      this._nativeType
    );
  }

  array() {
    return new EnumField(
      this.values,
      updateState(this, {
        array: true,
        base: v.enum<
          Values,
          {
            nullable: State["nullable"];
            array: true;
          }
        >(this.values, {
          nullable: this.state.nullable,
          array: true,
        }),
      }),
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(value: V) {
    return new EnumField(
      this.values,
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  map(columnName: string) {
    return new EnumField(
      this.values,
      updateState(this, { columnName }),
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildEnumSchema(this.values, this.state)),
      nativeType: this._nativeType,
    };
  }
}

export const enumField = <const T extends string[]>(
  values: T,
  nativeType?: NativeType
) => {
  return new EnumField<T>(
    values,
    createDefaultState("enum", v.enum(values)),
    nativeType
  );
};
