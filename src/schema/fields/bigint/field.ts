// BigInt Field
// Standalone field class with State generic pattern

import type { StandardSchemaOf } from "@standard-schema/spec";
import v, { type BaseBigIntSchema } from "@validation";
import {
  createDefaultState,
  type DefaultValue,
  type DefaultValueInput,
  type FieldState,
  type UpdateState,
} from "../common";
import type { NativeType } from "../native-types";
import { type BigIntSchemas, bigIntBase, buildBigIntSchema } from "./schemas";

export class BigIntField<State extends FieldState<"bigint">> {
  private _schemas: BigIntSchemas<State> | undefined;
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;

  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

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
        schema,
        base: v.bigint<{
          nullable: State["nullable"];
          array: State["array"];
          schema: S;
        }>({
          nullable: this.state.nullable,
          array: this.state.array,
          schema,
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

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildBigIntSchema(this.state)),
      nativeType: this._nativeType,
    };
  }
}

export const bigInt = (nativeType?: NativeType) =>
  new BigIntField(createDefaultState("bigint", bigIntBase), nativeType);
