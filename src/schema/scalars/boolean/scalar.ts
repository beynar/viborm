// Boolean Scalar
// The modifiers every scalar shares are implemented once, in the chain this
// class extends; the class types them for this scalar's own state

import type { BooleanSchema } from "@validation/primitives/boolean";
import v from "@validation/primitives/v";
import type { ComputeInput, ComputeOutput } from "@validation/types";
import {
  createDefaultState,
  type DefaultValueInput,
  listScalarChain,
  type ScalarState,
  type UpdateState,
} from "../common";
import { admitNativeType } from "../native-catalog";
import type {
  ExactNativeTypeMap,
  NativeDialect,
  NativeTypeArgument,
  NativeTypeDeclaration,
} from "../native-types";

const booleanBase = v.boolean();

export class BooleanScalar<
  State extends ScalarState<"boolean">,
> extends listScalarChain<State> {
  private declare readonly state: State;
  declare readonly nullable: () => BooleanScalar<
    UpdateState<
      State,
      {
        readonly nullable: true;
        readonly hasDefault: true;
        readonly default: State["hasDefault"] extends true
          ? State["default"]
          : null;
        readonly optional: true;
        readonly base: BooleanSchema<
          ComputeInput<
            boolean,
            {
              nullable: true;
              array: State["array"];
            }
          >,
          ComputeOutput<
            boolean,
            {
              nullable: true;
              array: State["array"];
            }
          >
        >;
      }
    >
  >;
  declare readonly array: () => BooleanScalar<
    UpdateState<
      State,
      {
        readonly array: true;
        readonly base: BooleanSchema<
          ComputeInput<
            boolean,
            {
              nullable: State["nullable"];
              array: true;
            }
          >,
          ComputeOutput<
            boolean,
            {
              nullable: State["nullable"];
              array: true;
            }
          >
        >;
      }
    >
  >;
  declare readonly default: <V extends DefaultValueInput<State>>(
    value: V
  ) => BooleanScalar<
    UpdateState<
      State,
      {
        readonly hasDefault: true;
        readonly default: V;
        readonly optional: true;
      }
    >
  >;
  /**
   * Maps this scalar to a custom column name in the database
   */
  declare readonly map: (columnName: string) => BooleanScalar<
    UpdateState<
      State,
      {
        readonly columnName: string;
      }
    >
  >;
  declare readonly ["~"]: {
    state: State;
    nativeType: NativeTypeDeclaration | undefined;
  };

  protected rebase(state: State) {
    return v.boolean({
      nullable: state.nullable,
      array: state.array,
    });
  }
}

export const boolean = <
  Db extends NativeDialect = never,
  const Given extends ExactNativeTypeMap<Given> = never,
>(
  nativeType?: NativeTypeArgument<Db, Given>
) =>
  new BooleanScalar(
    createDefaultState("boolean", booleanBase),
    admitNativeType("s.boolean", nativeType)
  );
