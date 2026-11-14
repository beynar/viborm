// Enum Scalar
// The modifiers every scalar shares are implemented once, in the chain this
// class extends; an enum keeps them as methods, typed on its own values

import type { EnumSchema } from "@validation/primitives/enum";
import v from "@validation/primitives/v";
import type { ComputeInput, ComputeOutput, VibSchema } from "@validation/types";
import {
  createDefaultState,
  type DefaultValueInput,
  type ScalarState,
  type UpdateState,
  untypedListScalarChain,
} from "../common";
import { admitNativeType } from "../native-catalog";
import type {
  ExactNativeTypeMap,
  NativeDialect,
  NativeTypeArgument,
  NativeTypeDeclaration,
} from "../native-types";

/**
 * The values of an enum in this state. A state that names no values (the wide
 * one a model's fields are read through) has some strings, not none: a precise
 * enum is then an enum of the wide kind member by member.
 */
type Values<State extends ScalarState<"enum">> =
  State["base"] extends EnumSchema<infer T, any, any> ? T : readonly string[];

export class EnumScalar<
  out State extends ScalarState<"enum">,
> extends untypedListScalarChain<State> {
  private declare readonly state: State;
  private declare readonly _nativeType: NativeTypeDeclaration | undefined;

  get enumValues() {
    return (
      "values" in this.state.base ? this.state.base.values : []
    ) as Values<State>;
  }

  protected rebase(state: State): VibSchema {
    return v.enum(this.enumValues, {
      nullable: state.nullable,
      array: state.array,
    });
  }

  override nullable() {
    return super.nullable() as EnumScalar<
      UpdateState<
        this["~"]["state"],
        {
          readonly nullable: true;
          readonly hasDefault: true;
          readonly default: State["hasDefault"] extends false
            ? null
            : State["default"];
          readonly optional: true;
          readonly base: EnumSchema<
            Values<State>,
            ComputeInput<
              Values<State>[number],
              { nullable: true; array: State["array"] }
            >,
            ComputeOutput<
              Values<State>[number],
              { nullable: true; array: State["array"] }
            >
          >;
        }
      >
    >;
  }

  override array() {
    return super.array() as EnumScalar<
      UpdateState<
        this["~"]["state"],
        {
          readonly array: true;
          readonly base: EnumSchema<
            Values<State>,
            ComputeInput<
              Values<State>[number],
              { nullable: State["nullable"]; array: true }
            >,
            ComputeOutput<
              Values<State>[number],
              { nullable: State["nullable"]; array: true }
            >
          >;
        }
      >
    >;
  }

  override default<V extends DefaultValueInput<State>>(value: V) {
    return super.default(value) as EnumScalar<
      UpdateState<
        this["~"]["state"],
        {
          readonly hasDefault: true;
          readonly default: V;
          readonly optional: true;
        }
      >
    >;
  }

  override map(columnName: string) {
    return super.map(columnName) as EnumScalar<
      UpdateState<this["~"]["state"], { readonly columnName: string }>
    >;
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
    return new EnumScalar(
      { ...this.state, enumName } as UpdateState<
        State,
        { readonly enumName: string }
      >,
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      nativeType: this._nativeType,
    };
  }
}

export const enumScalar = <
  // A readonly tuple is admitted; see `enum_` for the mutable arm.
  const T extends string[] | readonly string[],
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
