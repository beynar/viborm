// String Field
// Standalone field class with State generic pattern

import type { StandardSchemaOf } from "@standard-schema/spec";
import v, { type BaseStringSchema } from "@validation";
import {
  createDefaultState,
  type DefaultValueInput,
  type FieldState,
  type UpdateState,
  updateState,
} from "../common";
import type { NativeType } from "../native-types";
import {
  defaultCuid,
  defaultNanoid,
  defaultUlid,
  defaultUuid,
} from "./autogenerate";
import { buildStringSchema, type StringSchemas, stringBase } from "./schemas";

export class StringField<State extends FieldState<"string">> {
  private _schemas: StringSchemas<State> | undefined;
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;

  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new StringField(
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
    return new StringField(
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
    return new StringField(
      updateState(this, {
        isId: true,
        isUnique: true,
        autoGenerate: "ulid",
        default: defaultUlid(prefix),
        optional: true,
      }),
      this._nativeType
    );
  }

  unique() {
    return new StringField(
      updateState(this, {
        isUnique: true,
      }),
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(value: V) {
    return new StringField(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<string>>(
    schema: S
  ): StringField<
    UpdateState<
      State,
      {
        schema: S;
        base: BaseStringSchema<{
          nullable: State["nullable"];
          array: State["array"];
          schema: S;
        }>;
      }
    >
  > {
    return new StringField(
      {
        ...this.state,
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
      },
      this._nativeType
    );
  }

  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string) {
    return new StringField(updateState(this, { columnName }), this._nativeType);
  }

  uuid(prefix?: string) {
    return new StringField(
      updateState(this, {
        hasDefault: true,
        default: defaultUuid(prefix),
        autoGenerate: "uuid",
        optional: true,
      }),
      this._nativeType
    );
  }

  ulid(prefix?: string) {
    return new StringField(
      updateState(this, {
        hasDefault: true,
        default: defaultUlid(prefix),
        autoGenerate: "ulid",
        optional: true,
      }),
      this._nativeType
    );
  }

  nanoid(length?: number, prefix?: string) {
    return new StringField(
      updateState(this, {
        hasDefault: true,
        default: defaultNanoid(length, prefix),
        autoGenerate: "nanoid",
        optional: true,
      }),
      this._nativeType
    );
  }

  cuid(prefix?: string) {
    return new StringField(
      updateState(this, {
        hasDefault: true,
        default: defaultCuid(prefix),
        autoGenerate: "cuid",
        optional: true,
      }),
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildStringSchema(this.state)),
      nativeType: this._nativeType,
    };
  }
}

export const string = (nativeType?: NativeType) =>
  new StringField(createDefaultState("string", stringBase), nativeType);

const test = string().nullable().array();

type IsNullable<S extends FieldState<"string">> = S["nullable"] extends true
  ? true
  : false;
type TestState = (typeof test)["~"]["state"];
type TestState1 = (typeof test)["~"]["state"];
type Test = IsNullable<TestState>;
