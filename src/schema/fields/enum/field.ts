// Enum Field
// Standalone field class with State generic pattern

import v, { type EnumSchema } from "@validation";
import type { EnumValues } from "@validation/schemas/enum";
import {
  createDefaultState,
  type DefaultValueInput,
  type FieldState,
  updateState,
} from "../common";
import type { NativeType } from "../native-types";
import { buildEnumSchema, type EnumSchemas } from "./schemas";

export class EnumField<State extends FieldState<"enum">> {
  private _schemas: EnumSchemas<EnumValues<State["base"]>, State> | undefined;
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;
  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  get enumValues() {
    return ("values" in this.state.base ? this.state.base.values : [])as EnumValues<State["base"]> ;
  }

  nullable() {
    return new EnumField(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.enum<
          typeof this.enumValues,
          {
            nullable: true;
            array: State["array"];
          }
        >(this.enumValues, {
          nullable: true,
          array: this.state.array,
        }),
      }),
      this._nativeType
    );
  }

  array() {
    return new EnumField(
      updateState(this, {
        array: true,
        base: v.enum<
          typeof this.enumValues,
          {
            nullable: State["nullable"];
            array: true;
          }
        >(this.enumValues, {
          nullable: this.state.nullable,
          array: true,
        }),
      }),
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(value: V) {
    return new EnumField(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  map(columnName: string) {
    return new EnumField(updateState(this, { columnName }), this._nativeType);
  }

  /**
   * Set a custom name for the enum type in the database.
   * This allows reusing the same enum across multiple tables.
   *
   * @example
   * ```ts
   * const Status = s.enum(["PENDING", "ACTIVE"]).name("status");
   *
   * const user = s.model({ status: Status });
   * const order = s.model({ status: Status }); // Same "status" enum type
   * ```
   */
  name(enumName: string) {
    return new EnumField(updateState(this, { enumName }), this._nativeType);
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildEnumSchema<
        EnumValues<State["base"]>,
        State
      >(this.enumValues, this.state)),
      nativeType: this._nativeType,
    };
  }
}

export const enumField = <const T extends string[]>(
  values: T,
  nativeType?: NativeType
) => {
  return new EnumField(createDefaultState("enum", v.enum(values)), nativeType);
};
