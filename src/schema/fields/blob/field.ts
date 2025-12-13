// Blob Field
// Lean field class delegating schema selection to schema factory

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
} from "../common";
import type { NativeType } from "../native-types";
import { getFieldBlobSchemas } from "./schemas";

export class BlobField<State extends FieldState<"blob">> {
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): BlobField<UpdateState<State, { nullable: true }>> {
    return new BlobField({ ...this.state, nullable: true }, this._nativeType);
  }

  default(
    value: DefaultValue<Uint8Array, false, State["nullable"]>
  ): BlobField<UpdateState<State, { hasDefault: true }>> {
    return new BlobField(
      {
        ...this.state,
        hasDefault: true,
        defaultValue: value,
      },
      this._nativeType
    );
  }

  schema(
    schema: StandardSchemaV1
  ): BlobField<UpdateState<State, { schema: StandardSchemaV1 }>> {
    return new BlobField(
      {
        ...this.state,
        schema: schema,
      },
      this._nativeType
    );
  }

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
      schemas: getFieldBlobSchemas(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

export const blob = (nativeType?: NativeType) =>
  new BlobField(createDefaultState("blob"), nativeType);
