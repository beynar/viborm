import type { StandardSchemaOf } from "@standard-schema/spec";
import v from "@validation/primitives/v";
import {
  createDefaultState,
  type DefaultValueInput,
  type ScalarState,
  updateState,
} from "../common";
import type { NativeType } from "../native-types";

const floatBase = v.number();

export class FloatScalar<State extends ScalarState<"float">> {
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;

  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new FloatScalar(
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
    return new FloatScalar(
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
    return new FloatScalar(
      updateState(this, { isId: true, isUnique: true }),
      this._nativeType
    );
  }

  unique() {
    return new FloatScalar(
      updateState(this, { isUnique: true }),
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(value: V) {
    return new FloatScalar(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<number>>(schema: S) {
    return new FloatScalar(
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
    return new FloatScalar(updateState(this, { columnName }), this._nativeType);
  }

  get ["~"]() {
    return {
      state: this.state,
      nativeType: this._nativeType,
    };
  }
}

export const float = (nativeType?: NativeType) =>
  new FloatScalar(createDefaultState("float", floatBase), nativeType);
