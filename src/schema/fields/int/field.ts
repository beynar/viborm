import type { StandardSchemaOf } from "@standard-schema/spec";
import v from "@validation";
import {
  createDefaultState,
  type DefaultValueInput,
  type FieldState,
  updateState,
} from "../common";
import type { NativeType } from "../native-types";
import { buildIntSchema, type IntSchemas, intBase } from "./schemas";

export class IntField<State extends FieldState<"int">> {
  private _schemas: IntSchemas<State> | undefined;
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;

  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new IntField(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.integer<{
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
    return new IntField(
      updateState(this, {
        array: true,
        base: v.integer<{
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
    return new IntField(
      updateState(this, { isId: true, isUnique: true }),
      this._nativeType
    );
  }

  unique() {
    return new IntField(
      updateState(this, { isUnique: true }),
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(value: V) {
    return new IntField(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<number>>(schema: S) {
    return new IntField(
      updateState(this, {
        schema,
        base: v.integer<{
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
    return new IntField(updateState(this, { columnName }), this._nativeType);
  }

  increment() {
    return new IntField(
      updateState(this, {
        hasDefault: true,
        autoGenerate: "increment",
        default: 0,
        optional: true,
      }),
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildIntSchema(this.state)),
      nativeType: this._nativeType,
    };
  }
}

export const int = (nativeType?: NativeType) =>
  new IntField(createDefaultState("int", intBase), nativeType);
