// Blob Scalar
// Standalone scalar class with State generic pattern

import v from "@validation/primitives/v";
import {
  createDefaultState,
  type DefaultValueInput,
  type ScalarState,
  updateState,
} from "../common";
import type { NativeType } from "../native-types";

const blobBase = v.blob();

export class BlobScalar<State extends ScalarState<"blob">> {
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;

  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new BlobScalar(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.blob<{
          nullable: true;
        }>({
          nullable: true,
        }),
      }),
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(value: V) {
    return new BlobScalar(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  /**
   * Maps this scalar to a custom column name in the database
   */
  map(columnName: string) {
    return new BlobScalar(updateState(this, { columnName }), this._nativeType);
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

  get ["~"]() {
    return {
      state: this.state,
      nativeType: this._nativeType,
    };
  }
}

export const blob = (nativeType?: NativeType) =>
  new BlobScalar(createDefaultState("blob", blobBase), nativeType);
