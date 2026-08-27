// String Scalar
// Standalone scalar class with State generic pattern

import type { StandardSchemaOf } from "@standard-schema/spec";
import v from "@validation/primitives/v";
import {
  createDefaultState,
  type DefaultValueInput,
  generatorDefault,
  type ScalarState,
  updateState,
} from "../common";
import type { NativeType } from "../native-types";
import {
  defaultCuid,
  defaultNanoid,
  defaultUlid,
  defaultUuid,
} from "./autogenerate";

const stringBase = v.string();

export class StringScalar<State extends ScalarState<"string">> {
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;

  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new StringScalar(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.string<{
          nullable: true;
          array: State["array"];
          schema: State["schema"];
        }>({
          nullable: true,
          array: this.state.array,
          schema: this.state.schema,
        }),
      }),
      this._nativeType
    );
  }

  array() {
    return new StringScalar(
      updateState(this, {
        array: true,
        base: v.string<{
          nullable: State["nullable"];
          array: true;
          schema: State["schema"];
        }>({
          nullable: this.state.nullable,
          array: true,
          schema: this.state.schema,
        }),
      }),
      this._nativeType
    );
  }

  id(prefix?: string) {
    return new StringScalar(
      updateState(this, {
        isId: true,
        isUnique: true,
        autoGenerate: { kind: "ulid", prefix },
        default: generatorDefault(defaultUlid(prefix)),
        optional: true,
      }),
      this._nativeType
    );
  }

  unique() {
    return new StringScalar(
      updateState(this, {
        isUnique: true,
      }),
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(value: V) {
    return new StringScalar(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<string>>(schema: S) {
    return new StringScalar(
      updateState(this, {
        schema,
        base: v.string<{
          nullable: State["nullable"];
          array: State["array"];
          schema: S;
        }>({
          nullable: this.state.nullable,
          array: this.state.array,
          schema,
        }),
      }),
      this._nativeType
    );
  }

  /**
   * Maps this scalar to a custom column name in the database
   */
  map(columnName: string) {
    return new StringScalar(
      updateState(this, { columnName }),
      this._nativeType
    );
  }

  uuid(prefix?: string) {
    return new StringScalar(
      updateState(this, {
        hasDefault: true,
        default: generatorDefault(defaultUuid(prefix)),
        autoGenerate: { kind: "uuid", prefix },
        optional: true,
      }),
      this._nativeType
    );
  }

  ulid(prefix?: string) {
    return new StringScalar(
      updateState(this, {
        hasDefault: true,
        default: generatorDefault(defaultUlid(prefix)),
        autoGenerate: { kind: "ulid", prefix },
        optional: true,
      }),
      this._nativeType
    );
  }

  nanoid(length?: number, prefix?: string) {
    return new StringScalar(
      updateState(this, {
        hasDefault: true,
        default: generatorDefault(defaultNanoid(length, prefix)),
        autoGenerate: { kind: "nanoid", prefix, length },
        optional: true,
      }),
      this._nativeType
    );
  }

  cuid(prefix?: string) {
    return new StringScalar(
      updateState(this, {
        hasDefault: true,
        default: generatorDefault(defaultCuid(prefix)),
        autoGenerate: { kind: "cuid", prefix },
        optional: true,
      }),
      this._nativeType
    );
  }

  private _internal?: { state: State; nativeType: NativeType | undefined };

  get ["~"]() {
    return (this._internal ??= {
      state: this.state,
      nativeType: this._nativeType,
    });
  }
}

export const string = (nativeType?: NativeType) => {
  return new StringScalar(createDefaultState("string", stringBase), nativeType);
};
