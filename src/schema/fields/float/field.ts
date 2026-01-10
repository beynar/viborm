import type { StandardSchemaOf } from "@standard-schema/spec";
import v from "@validation";
import {
  createDefaultState,
  type DefaultValueInput,
  type FieldState,
  updateState,
} from "../common";
import type { NativeType } from "../native-types";
import { buildFloatSchema, type FloatSchemas, floatBase } from "./schemas";

export class FloatField<State extends FieldState<"float">> {
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;
  private _schemas: FloatSchemas<State> | undefined;

  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new FloatField(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.number<{
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
    return new FloatField(
      updateState(this, {
        array: true,
        base: v.number<{
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
    return new FloatField(
      updateState(this, { isId: true, isUnique: true }),
      this._nativeType
    );
  }

  unique() {
    return new FloatField(
      updateState(this, { isUnique: true }),
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(value: V) {
    return new FloatField(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<number>>(schema: S) {
    return new FloatField(
      updateState(this, {
        schema,
        base: v.number<{
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

  map(columnName: string) {
    return new FloatField(updateState(this, { columnName }), this._nativeType);
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildFloatSchema(this.state)),
      nativeType: this._nativeType,
    };
  }
}

export const float = (nativeType?: NativeType) =>
  new FloatField(createDefaultState("float", floatBase), nativeType);
