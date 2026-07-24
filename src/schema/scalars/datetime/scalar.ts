// DateTime Scalar
// Standalone scalar class with State generic pattern

import type { StandardSchemaOf } from "@standard-schema/spec";
import v from "@validation/primitives/v";
import {
  createDefaultState,
  type DefaultValueInput,
  type ScalarState,
  updateState,
} from "../common";
import type { NativeType } from "../native-types";

const defaultNow = () => new Date().toISOString();
const defaultUpdatedAt = () => new Date().toISOString();
const datetimeBase = v.isoTimestamp();

export class DateTimeScalar<State extends ScalarState<"datetime">> {
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;
  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new DateTimeScalar(
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
    return new DateTimeScalar(
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
    return new DateTimeScalar(
      updateState(this, { isId: true, isUnique: true }),
      this._nativeType
    );
  }

  unique() {
    return new DateTimeScalar(
      updateState(this, { isUnique: true }),
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<string>>(schema: S) {
    return new DateTimeScalar(
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
    return new DateTimeScalar(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  map(columnName: string) {
    return new DateTimeScalar(
      updateState(this, { columnName }),
      this._nativeType
    );
  }

  now() {
    return new DateTimeScalar(
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
    return new DateTimeScalar(
      updateState(this, {
        hasDefault: true,
        autoGenerate: "updatedAt",
        default: defaultUpdatedAt,
        optional: true,
      }),
      this._nativeType
    );
  }

  withoutTimezone() {
    return new DateTimeScalar(
      updateState(this, { withTimezone: false }),
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      nativeType: this._nativeType,
    };
  }
}

export const dateTime = (nativeType?: NativeType) =>
  new DateTimeScalar(
    { ...createDefaultState("datetime", datetimeBase), withTimezone: true },
    nativeType
  );
