import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { NumberSchema } from "@validation/primitives/number";
import v from "@validation/primitives/v";
import type { ComputeInput, ComputeOutput } from "@validation/types";
import {
  createDefaultState,
  type DefaultValueInput,
  keyedScalarChain,
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

const numberBase = v.number();

export class NumberScalar<
  State extends ScalarState<"number">,
> extends keyedScalarChain<State> {
  private declare readonly state: State;
  declare readonly nullable: () => NumberScalar<
    UpdateState<
      State,
      {
        readonly nullable: true;
        readonly hasDefault: true;
        readonly default: State["hasDefault"] extends true
          ? State["default"]
          : null;
        readonly optional: true;
        readonly base: NumberSchema<
          ComputeInput<
            number,
            {
              nullable: true;
              array: State["array"];
              schema: State["schema"];
            }
          >,
          ComputeOutput<
            number,
            {
              nullable: true;
              array: State["array"];
              schema: State["schema"];
            }
          >
        >;
      }
    >
  >;
  declare readonly array: () => NumberScalar<
    UpdateState<
      State,
      {
        readonly array: true;
        readonly base: NumberSchema<
          ComputeInput<
            number,
            {
              nullable: State["nullable"];
              array: true;
              schema: State["schema"];
            }
          >,
          ComputeOutput<
            number,
            {
              nullable: State["nullable"];
              array: true;
              schema: State["schema"];
            }
          >
        >;
      }
    >
  >;
  declare readonly id: () => NumberScalar<
    UpdateState<
      State,
      {
        readonly isId: true;
        readonly isUnique: true;
      }
    >
  >;
  declare readonly unique: () => NumberScalar<
    UpdateState<
      State,
      {
        readonly isUnique: true;
      }
    >
  >;
  declare readonly default: <V extends DefaultValueInput<State>>(
    value: V
  ) => NumberScalar<
    UpdateState<
      State,
      {
        readonly hasDefault: true;
        readonly default: V;
        readonly optional: true;
      }
    >
  >;
  declare readonly schema: <S extends StandardSchemaV1<number>>(
    schema: S
  ) => NumberScalar<
    UpdateState<
      State,
      {
        readonly schema: S;
        readonly base: NumberSchema<
          ComputeInput<
            number,
            {
              nullable: State["nullable"];
              array: State["array"];
              schema: S;
            }
          >,
          ComputeOutput<
            number,
            {
              nullable: State["nullable"];
              array: State["array"];
              schema: S;
            }
          >
        >;
      }
    >
  >;
  declare readonly map: (columnName: string) => NumberScalar<
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
    return v.number({
      nullable: state.nullable,
      array: state.array,
      schema: state.schema,
    });
  }
}

export const number = <
  Db extends NativeDialect = never,
  const Given extends ExactNativeTypeMap<Given> = never,
>(
  nativeType?: NativeTypeArgument<Db, Given>
) =>
  new NumberScalar(
    createDefaultState("number", numberBase),
    admitNativeType("s.number", nativeType)
  );
