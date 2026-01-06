// Blob Field
// Standalone field class with State generic pattern

import v, { type BaseBlobSchema } from "@validation";
import {
  createDefaultState,
  type DefaultValue,
  type DefaultValueInput,
  type FieldState,
  type UpdateState,
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

  nullable(): BlobField<
    UpdateState<
      State,
      {
        nullable: true;
        hasDefault: true;
        default: DefaultValue<null>;
        optional: true;
        base: BaseBlobSchema<{
          nullable: true;
        }>;
      }
    >
  > {
    return new BlobField(
      {
        ...this.state,
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.blob<{
          nullable: true;
        }>({
          nullable: true,
        }),
      },
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(
    value: V
  ): BlobField<
    UpdateState<State, { hasDefault: true; default: V; optional: true }>
  > {
    return new BlobField(
      {
        ...this.state,
        hasDefault: true,
        default: value,
        optional: true,
      },
      this._nativeType
    );
  }

  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this {
    return new BlobField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
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
