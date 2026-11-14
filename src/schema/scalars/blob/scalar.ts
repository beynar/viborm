// Blob Scalar
// The modifiers every scalar shares are implemented once, in the chain this
// class extends; the class types them for this scalar's own state

import type { BlobSchema } from "@validation/primitives/blob";
import v from "@validation/primitives/v";
import {
  createDefaultState,
  type DefaultValueInput,
  type ScalarState,
  scalarChain,
  type UpdateState,
} from "../common";
import { admitNativeType } from "../native-catalog";
import type {
  ExactNativeTypeMap,
  NativeDialect,
  NativeTypeArgument,
  NativeTypeDeclaration,
} from "../native-types";

const blobBase = v.blob();

export class BlobScalar<
  State extends ScalarState<"blob">,
> extends scalarChain<State> {
  private declare readonly state: State;
  declare readonly nullable: () => BlobScalar<
    UpdateState<
      State,
      {
        readonly nullable: true;
        readonly hasDefault: true;
        readonly default: State["hasDefault"] extends true
          ? State["default"]
          : null;
        readonly optional: true;
        readonly base: BlobSchema<
          Uint8Array<ArrayBufferLike> | null,
          Uint8Array<ArrayBufferLike> | null
        >;
      }
    >
  >;
  declare readonly default: <V extends DefaultValueInput<State>>(
    value: V
  ) => BlobScalar<
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
  declare readonly map: (columnName: string) => BlobScalar<
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
    return v.blob({
      nullable: state.nullable,
    });
  }

  // Blob scalars don't support array(), id(), or unique()
  array(): never {
    throw new Error("Blob scalars don't support array modifier");
  }

  id(): never {
    throw new Error("Blob scalars cannot be used as IDs");
  }

  unique(): never {
    throw new Error("Blob scalars cannot be unique");
  }
}

export const blob = <
  Db extends NativeDialect = never,
  const Given extends ExactNativeTypeMap<Given> = never,
>(
  nativeType?: NativeTypeArgument<Db, Given>
) =>
  new BlobScalar(
    createDefaultState("blob", blobBase),
    admitNativeType("s.blob", nativeType)
  );
