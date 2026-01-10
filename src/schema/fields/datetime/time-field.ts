// Time Field
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
import { buildTimeSchema, type TimeSchemas, timeBase } from "./schemas";

const defaultNow = () => {
  const now = new Date();
  return now.toISOString().split("T")[1]?.split(".")[0] ?? ""; // "HH:MM:SS"
};
const defaultUpdatedAt = () => {
  const now = new Date();
  return now.toISOString().split("T")[1]?.split(".")[0] ?? ""; // "HH:MM:SS"
};

export class TimeField<State extends FieldState<"time">> {
  private _schemas: TimeSchemas<State> | undefined;
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;

  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new TimeField(
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
    return new TimeField(
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
    return new TimeField(
      updateState(this, { isId: true, isUnique: true }),
      this._nativeType
    );
  }

  unique() {
    return new TimeField(
      updateState(this, { isUnique: true }),
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<string>>(schema: S) {
    return new TimeField(
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
    return new TimeField(
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
    return new TimeField(updateState(this, { columnName }), this._nativeType);
  }

  now() {
    return new TimeField(
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
    return new TimeField(
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
      schemas: (this._schemas ??= buildTimeSchema(this.state)),
      nativeType: this._nativeType,
    };
  }
}

export const time = (nativeType?: NativeType) =>
  new TimeField(createDefaultState("time", timeBase), nativeType);
