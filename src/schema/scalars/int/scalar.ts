import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { IntegerSchema } from "@validation/primitives/number";
import v from "@validation/primitives/v";
import type { ComputeInput, ComputeOutput } from "@validation/types";
import {
  createDefaultState,
  type DefaultValueInput,
  keyedScalarChain,
  type ScalarState,
  type UpdateState,
  updateState,
} from "../common";
import { admitNativeType } from "../native-catalog";
import type {
  ExactNativeTypeMap,
  NativeDialect,
  NativeTypeArgument,
  NativeTypeDeclaration,
} from "../native-types";

const intBase = v.integer();

export class IntScalar<
  State extends ScalarState<"int">,
> extends keyedScalarChain<State> {
  private declare readonly state: State;
  private declare readonly _nativeType: NativeTypeDeclaration | undefined;
  declare readonly nullable: () => IntScalar<
    UpdateState<
      State,
      {
        readonly nullable: true;
        readonly hasDefault: true;
        readonly default: State["hasDefault"] extends true
          ? State["default"]
          : null;
        readonly optional: true;
        readonly base: IntegerSchema<
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
  declare readonly array: () => IntScalar<
    UpdateState<
      State,
      {
        readonly array: true;
        readonly base: IntegerSchema<
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
  declare readonly id: () => IntScalar<
    UpdateState<
      State,
      {
        readonly isId: true;
        readonly isUnique: true;
      }
    >
  >;
  declare readonly unique: () => IntScalar<
    UpdateState<
      State,
      {
        readonly isUnique: true;
      }
    >
  >;
  declare readonly default: <V extends DefaultValueInput<State>>(
    value: V
  ) => IntScalar<
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
  ) => IntScalar<
    UpdateState<
      State,
      {
        readonly schema: S;
        readonly base: IntegerSchema<
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
  declare readonly map: (columnName: string) => IntScalar<
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
    return v.integer({
      nullable: state.nullable,
      array: state.array,
      schema: state.schema,
    });
  }

  increment() {
    return new IntScalar(
      updateState(this, {
        hasDefault: true,
        autoGenerate: { kind: "increment" },
        default: undefined,
        disallowZero: true,
        optional: true,
      }),
      this._nativeType
    );
  }
}

export const int = <
  Db extends NativeDialect = never,
  const Given extends ExactNativeTypeMap<Given> = never,
>(
  nativeType?: NativeTypeArgument<Db, Given>
) =>
  new IntScalar(
    createDefaultState("int", intBase),
    admitNativeType("s.int", nativeType)
  );
