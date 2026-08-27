// Time Scalar
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

const defaultNow = generatorDefault(() => {
  return new Date().toISOString().slice(11, 19);
});
const defaultUpdatedAt = generatorDefault(() => {
  return new Date().toISOString().slice(11, 19);
});
const timeBase = v.isoTime();

export class TimeScalar<State extends ScalarState<"time">> {
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;

  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new TimeScalar(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.isoTime<{
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
    return new TimeScalar(
      updateState(this, {
        array: true,
        base: v.isoTime<{
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
    return new TimeScalar(
      updateState(this, { isId: true, isUnique: true }),
      this._nativeType
    );
  }

  unique() {
    return new TimeScalar(
      updateState(this, { isUnique: true }),
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<string>>(schema: S) {
    return new TimeScalar(
      updateState(this, {
        schema,
        base: v.isoTime<{
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
    return new TimeScalar(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  /**
   * Maps this scalar to a custom column name in the database
   */
  map(columnName: string) {
    return new TimeScalar(updateState(this, { columnName }), this._nativeType);
  }

  now() {
    return new TimeScalar(
      updateState(this, {
        hasDefault: true,
        autoGenerate: { kind: "now" },
        default: defaultNow,
        optional: true,
      }),
      this._nativeType
    );
  }

  updatedAt() {
    return new TimeScalar(
      updateState(this, {
        hasDefault: true,
        autoGenerate: { kind: "updatedAt" },
        default: defaultUpdatedAt,
        optional: true,
      }),
      this._nativeType
    );
  }

  /**
   * Stores time without timezone information.
   * Maps to PostgreSQL TIME (without time zone) instead of TIMETZ.
   *
   * Use this when:
   * - You want to store local times (e.g., "store opens at 9:00 AM")
   * - The time should not be converted based on timezone
   */
  withoutTimezone() {
    return new TimeScalar(
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

export const time = (nativeType?: NativeType) =>
  new TimeScalar(
    { ...createDefaultState("time", timeBase), withTimezone: true },
    nativeType
  );
