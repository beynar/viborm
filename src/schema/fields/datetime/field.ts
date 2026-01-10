// DateTime Field
// Standalone field class with State generic pattern

import type { StandardSchemaOf } from "@standard-schema/spec";
import v from "@validation";
import {
  createDefaultState,
  type DefaultValueInput,
  type FieldState,
  updateState,
} from "../common";
import type { NativeType } from "../native-types";
import {
  buildDateTimeSchema,
  type DateTimeSchemas,
  datetimeBase,
} from "./schemas";

const defaultNow = () => new Date().toISOString();
const defaultUpdatedAt = () => new Date().toISOString();

export class DateTimeField<State extends FieldState<"datetime">> {
  private _schemas: DateTimeSchemas<State> | undefined;
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;
  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new DateTimeField(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.isoTimestamp<{
          nullable: true;
          array: State["array"];
        }>({
          nullable: true,
          array: this.state.array,
        }),
      }),
      this._nativeType
    );
  }

  array() {
    return new DateTimeField(
      updateState(this, {
        array: true,
        base: v.isoTimestamp<{
          nullable: State["nullable"];
          array: true;
        }>({
          nullable: this.state.nullable,
          array: true,
        }),
      }),
      this._nativeType
    );
  }

  id() {
    return new DateTimeField(
      updateState(this, { isId: true, isUnique: true }),
      this._nativeType
    );
  }

  unique() {
    return new DateTimeField(
      updateState(this, { isUnique: true }),
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<string>>(schema: S) {
    return new DateTimeField(
      updateState(this, {
        schema,
        base: v.isoTimestamp<{
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

  default<V extends DefaultValueInput<State>>(value: V) {
    return new DateTimeField(
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
    return new DateTimeField(
      updateState(this, { columnName }),
      this._nativeType
    );
  }

  now() {
    return new DateTimeField(
      updateState(this, {
        hasDefault: true,
        autoGenerate: "now",
        default: defaultNow,
        optional: true,
      }),
      this._nativeType
    );
  }

  updatedAt() {
    return new DateTimeField(
      updateState(this, {
        hasDefault: true,
        autoGenerate: "updatedAt",
        default: defaultUpdatedAt,
        optional: true,
      }),
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildDateTimeSchema(this.state)),
      nativeType: this._nativeType,
    };
  }
}

export const dateTime = (nativeType?: NativeType) =>
  new DateTimeField(createDefaultState("datetime", datetimeBase), nativeType);
