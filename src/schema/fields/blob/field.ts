// Blob Field
// Standalone field class with State generic pattern

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
} from "../common";
import type { NativeType } from "../native-types";
import * as schemas from "./schemas";

// =============================================================================
// BLOB FIELD SCHEMA TYPE DERIVATION
// =============================================================================

type BlobFieldSchemas<State extends FieldState<"blob">> = {
  base: State["nullable"] extends true
    ? typeof schemas.blobNullable
    : typeof schemas.blobBase;

  filter: State["nullable"] extends true
    ? typeof schemas.blobNullableFilter
    : typeof schemas.blobFilter;

  create: State["hasDefault"] extends true
    ? State["nullable"] extends true
      ? typeof schemas.blobOptionalNullableCreate
      : typeof schemas.blobOptionalCreate
    : State["nullable"] extends true
      ? typeof schemas.blobNullableCreate
      : typeof schemas.blobCreate;

  update: State["nullable"] extends true
    ? typeof schemas.blobNullableUpdate
    : typeof schemas.blobUpdate;
};

// =============================================================================
// BLOB FIELD CLASS
// =============================================================================

export class BlobField<State extends FieldState<"blob">> {
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};

  constructor(
    private state: State,
    private _nativeType?: NativeType
  ) {}

  // ===========================================================================
  // CHAINABLE MODIFIERS
  // ===========================================================================

  nullable(): BlobField<UpdateState<State, { nullable: true }>> {
    return new BlobField({ ...this.state, nullable: true });
  }

  default(
    value: DefaultValue<Uint8Array, false, State["nullable"]>
  ): BlobField<UpdateState<State, { hasDefault: true }>> {
    return new BlobField({
      ...this.state,
      hasDefault: true,
      defaultValue: value,
    });
  }

  validator(
    schema: StandardSchemaV1
  ): BlobField<UpdateState<State, { customValidator: StandardSchemaV1 }>> {
    return new BlobField({
      ...this.state,
      customValidator: schema,
    });
  }

  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this {
    return new BlobField({ ...this.state, columnName }) as this;
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

  // ===========================================================================
  // SCHEMA GETTER
  // ===========================================================================

  get schemas(): BlobFieldSchemas<State> {
    const { nullable, hasDefault } = this.state;

    const base = nullable ? schemas.blobNullable : schemas.blobBase;

    const filter = nullable
      ? schemas.blobNullableFilter
      : schemas.blobFilter;

    const create = hasDefault
      ? nullable
        ? schemas.blobOptionalNullableCreate
        : schemas.blobOptionalCreate
      : nullable
        ? schemas.blobNullableCreate
        : schemas.blobCreate;

    const update = nullable
      ? schemas.blobNullableUpdate
      : schemas.blobUpdate;

    return { base, filter, create, update } as BlobFieldSchemas<State>;
  }

  // ===========================================================================
  // ACCESSORS
  // ===========================================================================

  get ["~"]() {
    return {
      state: this.state,
      schemas: this.schemas,
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

export const blob = (nativeType?: NativeType) =>
  new BlobField(createDefaultState("blob"), nativeType);
