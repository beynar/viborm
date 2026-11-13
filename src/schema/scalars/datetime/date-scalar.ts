// Date Scalar
// The modifiers every scalar shares are implemented once, in the chain this
// class extends; the class types them for this scalar's own state

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { IsoDateSchema } from "@validation/primitives/iso";
import v from "@validation/primitives/v";
import type { ComputeInput, ComputeOutput } from "@validation/types";
import {
  createDefaultState,
  type DefaultValueInput,
  type GeneratorDefaultBrand,
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
import { temporalScalarChain } from "./chain";

const dateBase = v.isoDate();

export class DateScalar<
  State extends ScalarState<"date">,
> extends temporalScalarChain<State> {
  private declare readonly state: State;
  declare readonly nullable: () => DateScalar<
    UpdateState<
      State,
      {
        readonly nullable: true;
        readonly hasDefault: true;
        readonly default: State["hasDefault"] extends true
          ? State["default"]
          : null;
        readonly optional: true;
        readonly base: IsoDateSchema<
          ComputeInput<
            string | Date,
            {
              nullable: true;
              array: State["array"];
              schema: State["schema"];
            }
          >,
          ComputeOutput<
            string,
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
  declare readonly array: () => DateScalar<
    UpdateState<
      State,
      {
        readonly array: true;
        readonly base: IsoDateSchema<
          ComputeInput<
            string | Date,
            {
              nullable: State["nullable"];
              array: true;
              schema: State["schema"];
            }
          >,
          ComputeOutput<
            string,
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
  declare readonly id: () => DateScalar<
    UpdateState<
      State,
      {
        readonly isId: true;
        readonly isUnique: true;
      }
    >
  >;
  declare readonly unique: () => DateScalar<
    UpdateState<
      State,
      {
        readonly isUnique: true;
      }
    >
  >;
  declare readonly schema: <S extends StandardSchemaV1<string>>(
    schema: S
  ) => DateScalar<
    UpdateState<
      State,
      {
        readonly schema: S;
        readonly base: IsoDateSchema<
          ComputeInput<
            string | Date,
            {
              nullable: State["nullable"];
              array: State["array"];
              schema: S;
            }
          >,
          ComputeOutput<
            string,
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
  declare readonly default: <V extends DefaultValueInput<State>>(
    value: V
  ) => DateScalar<
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
  declare readonly map: (columnName: string) => DateScalar<
    UpdateState<
      State,
      {
        readonly columnName: string;
      }
    >
  >;
  declare readonly now: () => DateScalar<
    UpdateState<
      State,
      {
        readonly hasDefault: true;
        readonly autoGenerate: {
          readonly kind: "now";
        };
        readonly default: (() => string) & GeneratorDefaultBrand;
        readonly optional: true;
      }
    >
  >;
  declare readonly updatedAt: () => DateScalar<
    UpdateState<
      State,
      {
        readonly hasDefault: true;
        readonly autoGenerate: {
          readonly kind: "updatedAt";
        };
        readonly default: (() => string) & GeneratorDefaultBrand;
        readonly optional: true;
      }
    >
  >;
  declare readonly ["~"]: {
    state: State;
    nativeType: NativeTypeDeclaration | undefined;
  };

  protected rebase(state: State) {
    return v.isoDate({
      nullable: state.nullable,
      array: state.array,
      schema: state.schema,
    });
  }
}

export const date = <
  Db extends NativeDialect = never,
  const Given extends ExactNativeTypeMap<Given> = never,
>(
  nativeType?: NativeTypeArgument<Db, Given>
) =>
  new DateScalar(
    createDefaultState("date", dateBase),
    admitNativeType("s.date", nativeType)
  );
