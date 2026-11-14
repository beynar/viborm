// Vector Scalar
// The modifiers every scalar shares are implemented once, in the chain this
// class extends; the class types them for this scalar's own state

import { ValidationError } from "@errors";
import v from "@validation/primitives/v";
import type { VectorSchema } from "@validation/primitives/vector";
import {
  createDefaultState,
  type DefaultValueInput,
  type ScalarState,
  scalarChain,
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

const vectorBase = v.vector();

export class VectorScalar<
  State extends ScalarState<"vector">,
> extends scalarChain<State> {
  private declare readonly state: State;
  private declare readonly _nativeType: NativeTypeDeclaration | undefined;
  declare readonly nullable: () => VectorScalar<
    UpdateState<
      State,
      {
        readonly nullable: true;
        readonly hasDefault: true;
        readonly default: State["hasDefault"] extends true
          ? State["default"]
          : null;
        readonly optional: true;
        readonly base: VectorSchema<number[] | null, number[] | null> & {
          dimensions?: number;
        };
      }
    >
  >;
  declare readonly default: <V extends DefaultValueInput<State>>(
    value: V
  ) => VectorScalar<
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
  declare readonly map: (columnName: string) => VectorScalar<
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
    return v.vector(state.dimension, {
      nullable: state.nullable,
    });
  }

  dimension(dim: number) {
    if (!Number.isSafeInteger(dim) || dim <= 0) {
      throw new ValidationError(
        { kind: "schema-builder", builder: "s.vector", path: "dimension" },
        [
          {
            path: "dimension",
            message: "Vector dimension must be a positive safe integer",
          },
        ]
      );
    }
    return new VectorScalar(
      updateState(this, {
        dimension: dim,
        base: v.vector(dim, { nullable: this.state.nullable }),
      }),
      this._nativeType
    );
  }
}

export const vector = <
  Db extends NativeDialect = never,
  const Given extends ExactNativeTypeMap<Given> = never,
>(
  nativeType?: NativeTypeArgument<Db, Given>
) =>
  new VectorScalar(
    createDefaultState("vector", vectorBase),
    admitNativeType("s.vector", nativeType)
  );
