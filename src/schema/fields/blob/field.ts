// Blob Field
// Standalone field class with State generic pattern

import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
  DefaultValueInput,
} from "../common";
import type { NativeType } from "../native-types";
import { buildBlobSchema, blobBase, BlobSchemas } from "./schemas";
import v, { BaseBlobSchema } from "../../../validation";

export class BlobField<State extends FieldState<"blob">> {
  private _names: SchemaNames = {};
  private _schemas: BlobSchemas<State> | undefined;

  constructor(private state: State, private _nativeType?: NativeType) {}

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
      names: this._names,
    };
  }
}

export const blob = (nativeType?: NativeType) =>
  new BlobField(createDefaultState("blob", blobBase), nativeType);
