// Blob Field
// Standalone field class with State generic pattern

import v from "@validation";
import {
  createDefaultState,
  type DefaultValueInput,
  type FieldState,
  updateState,
} from "../common";
import type { NativeType } from "../native-types";
import { type BlobSchemas, blobBase, buildBlobSchema } from "./schemas";

export class BlobField<State extends FieldState<"blob">> {
  private _schemas: BlobSchemas<State> | undefined;
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;

  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new BlobField(
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
    return new BlobField(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string) {
    return new BlobField(updateState(this, { columnName }), this._nativeType);
  }

  // Blob fields don't support array(), id(), or unique()
  array(): never {
    throw new Error("Blob fields don't support array modifier");
  }

  id(): never {
    throw new Error("Blob fields cannot be used as IDs");
  }

  unique(): never {
    throw new Error("Blob fields cannot be unique");
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildBlobSchema(this.state)),
      nativeType: this._nativeType,
    };
  }
}

export const blob = (nativeType?: NativeType) =>
  new BlobField(createDefaultState("blob", blobBase), nativeType);
