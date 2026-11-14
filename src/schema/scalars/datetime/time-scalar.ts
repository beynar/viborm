// Time Scalar
// The modifiers every scalar shares are implemented once, in the chain this
// class extends; the class types them for this scalar's own state

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { IsoTimeSchema } from "@validation/primitives/iso";
import v from "@validation/primitives/v";
import type { ComputeInput, ComputeOutput } from "@validation/types";
import {
  createDefaultState,
  type DefaultValueInput,
  type GeneratorDefaultBrand,
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
import { temporalScalarChain } from "./chain";

const timeBase = v.isoTime();

export class TimeScalar<
  State extends ScalarState<"time">,
> extends temporalScalarChain<State> {
  private declare readonly state: State;
  private declare readonly _nativeType: NativeTypeDeclaration | undefined;
  declare readonly nullable: () => TimeScalar<
    UpdateState<
      State,
      {
        readonly nullable: true;
        readonly hasDefault: true;
        readonly default: State["hasDefault"] extends true
          ? State["default"]
          : null;
        readonly optional: true;
        readonly base: IsoTimeSchema<
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
  declare readonly array: () => TimeScalar<
    UpdateState<
      State,
      {
        readonly array: true;
        readonly base: IsoTimeSchema<
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
  declare readonly id: () => TimeScalar<
    UpdateState<
      State,
      {
        readonly isId: true;
        readonly isUnique: true;
      }
    >
  >;
  declare readonly unique: () => TimeScalar<
    UpdateState<
      State,
      {
        readonly isUnique: true;
      }
    >
  >;
  declare readonly schema: <S extends StandardSchemaV1<string>>(
    schema: S
  ) => TimeScalar<
    UpdateState<
      State,
      {
        readonly schema: S;
        readonly base: IsoTimeSchema<
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
  ) => TimeScalar<
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
  declare readonly map: (columnName: string) => TimeScalar<
    UpdateState<
      State,
      {
        readonly columnName: string;
      }
    >
  >;
  declare readonly now: () => TimeScalar<
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
  declare readonly updatedAt: () => TimeScalar<
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
    return v.isoTime({
      nullable: state.nullable,
      array: state.array,
      schema: state.schema,
    });
  }

  /**
   * Stores time without timezone information (the default).
   * Use an explicit native type for an existing TIMETZ column.
   *
   * Use this when:
   * - You want to store local times (e.g., "store opens at 9:00 AM")
   * - The time should not be converted based on timezone
   */
  withoutTimezone() {
    return new TimeScalar(
      updateState(this, { withTimezone: false }),
      this._nativeType
    );
  }
}

export const time = <
  Db extends NativeDialect = never,
  const Given extends ExactNativeTypeMap<Given> = never,
>(
  nativeType?: NativeTypeArgument<Db, Given>
) =>
  new TimeScalar(
    { ...createDefaultState("time", timeBase), withTimezone: false },
    admitNativeType("s.time", nativeType)
  );
