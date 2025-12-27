// BigInt Field
// Standalone field class with State generic pattern

import type { StandardSchemaOf } from "@standard-schema/spec";
import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
  DefaultValueInput,
} from "../common";
import type { NativeType } from "../native-types";
import { buildBigIntSchema, bigIntBase } from "./schemas";
import v, { BaseBigIntSchema } from "../../../validation";

// =============================================================================
// BIGINT FIELD CLASS
// =============================================================================

export class BigIntField<State extends FieldState<"bigint">> {
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): BigIntField<
    UpdateState<
      State,
      {
        nullable: true;
        hasDefault: true;
        default: DefaultValue<null>;
        optional: true;
        base: BaseBigIntSchema<{
          nullable: true;
          array: State["array"];
        }>;
      }
    >
  > {
    return new BigIntField(
      {
        ...this.state,
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.bigint<{
          nullable: true;
          array: State["array"];
        }>({
          nullable: true,
          array: this.state.array,
        }),
      },
      this._nativeType
    );
  }

  array(): BigIntField<
    UpdateState<
      State,
      {
        array: true;
        base: BaseBigIntSchema<{
          nullable: State["nullable"];
          array: true;
        }>;
      }
    >
  > {
    return new BigIntField(
      {
        ...this.state,
        array: true,
        base: v.bigint<{
          nullable: State["nullable"];
          array: true;
        }>({
          nullable: this.state.nullable,
          array: true,
        }),
      },
      this._nativeType
    );
  }

  id(): BigIntField<UpdateState<State, { isId: true; isUnique: true }>> {
    return new BigIntField(
      { ...this.state, isId: true, isUnique: true },
      this._nativeType
    );
  }

  unique(): BigIntField<UpdateState<State, { isUnique: true }>> {
    return new BigIntField({ ...this.state, isUnique: true }, this._nativeType);
  }

  default<V extends DefaultValueInput<State>>(
    value: V
  ): BigIntField<
    UpdateState<State, { hasDefault: true; default: V; optional: true }>
  > {
    return new BigIntField(
      {
        ...this.state,
        hasDefault: true,
        default: value,
        optional: true,
      },
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<bigint>>(
    schema: S
  ): BigIntField<
    UpdateState<
      State,
      {
        schema: S;
        base: BaseBigIntSchema<{
          nullable: State["nullable"];
          array: State["array"];
          schema: S;
        }>;
      }
    >
  > {
    return new BigIntField(
      {
        ...this.state,
        schema: schema,
        base: v.bigint<{
          nullable: State["nullable"];
          array: State["array"];
          schema: S;
        }>({
          nullable: this.state.nullable,
          array: this.state.array,
          schema: schema,
        }),
      },
      this._nativeType
    );
  }

  map(columnName: string): this {
    return new BigIntField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  increment(): BigIntField<
    UpdateState<
      State,
      {
        hasDefault: true;
        autoGenerate: "increment";
        default: DefaultValue<bigint>;
        optional: true;
      }
    >
  > {
    return new BigIntField(
      {
        ...this.state,
        hasDefault: true,
        autoGenerate: "increment",
        default: 0n, // Placeholder, actual value set by DB
        optional: true,
      },
      this._nativeType
    );
  }

  // ===========================================================================
  // ACCESSORS
  // ===========================================================================

  #cached_schemas: ReturnType<typeof buildBigIntSchema<State>> | undefined;

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this.#cached_schemas ??= buildBigIntSchema(this.state)),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

export const bigInt = (nativeType?: NativeType) =>
  new BigIntField(createDefaultState("bigint", bigIntBase), nativeType);
