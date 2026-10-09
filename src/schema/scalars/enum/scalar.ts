// Enum Scalar
// Standalone scalar class with State generic pattern

import type { EnumValues } from "@validation/primitives/enum";
import v from "@validation/primitives/v";
import {
  createDefaultState,
  type DefaultValueInput,
  nullableDefault,
  type ScalarState,
  updateState,
} from "../common";
import { admitNativeType } from "../native-catalog";
import type {
  ExactNativeTypeMap,
  NativeDialect,
  NativeTypeArgument,
  NativeTypeDeclaration,
} from "../native-types";

export class EnumScalar<State extends ScalarState<"enum">> {
  private readonly state: State;
  private readonly _nativeType?: NativeTypeDeclaration | undefined;
  constructor(state: State, _nativeType?: NativeTypeDeclaration) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  get enumValues() {
    return (
      "values" in this.state.base ? this.state.base.values : []
    ) as EnumValues<State["base"]>;
  }

  nullable() {
    return new EnumScalar(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: nullableDefault(this.state),
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
    return new EnumScalar(
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
    return new EnumScalar(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  map(columnName: string) {
    return new EnumScalar(updateState(this, { columnName }), this._nativeType);
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
    return new EnumScalar(updateState(this, { enumName }), this._nativeType);
  }

  get ["~"]() {
    return {
      state: this.state,
      nativeType: this._nativeType,
    };
  }
}

export const enumScalar = <
  const T extends string[],
  Db extends NativeDialect = never,
  const Given extends ExactNativeTypeMap<Given> = never,
>(
  values: T,
  nativeType?: NativeTypeArgument<Db, Given>
) => {
  return new EnumScalar(
    createDefaultState("enum", v.enum(values)),
    admitNativeType("s.enum", nativeType)
  );
};
