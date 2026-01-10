// Boolean Field
// Standalone field class with State generic pattern

import v from "@validation";
import {
  createDefaultState,
  type DefaultValueInput,
  type FieldState,
  updateState,
} from "../common";
import type { NativeType } from "../native-types";
import {
  type BooleanSchemas,
  booleanBase,
  buildBooleanSchema,
} from "./schemas";

export class BooleanField<State extends FieldState<"boolean">> {
  private _schemas: BooleanSchemas<State> | undefined;
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;

  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new BooleanField(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.boolean<{
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
    return new BooleanField(
      updateState(this, {
        array: true,
        base: v.boolean<{
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

  default<V extends DefaultValueInput<State>>(value: V) {
    return new BooleanField(
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
    return new BooleanField(
      updateState(this, { columnName }),
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildBooleanSchema(this.state)),
      nativeType: this._nativeType,
    };
  }
}

export const boolean = (nativeType?: NativeType) =>
  new BooleanField(createDefaultState("boolean", booleanBase), nativeType);
