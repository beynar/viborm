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
  buildDecimalSchema,
  type DecimalSchemas,
  decimalBase,
} from "./schemas";

export class DecimalField<State extends FieldState<"decimal">> {
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;
  private _schemas: DecimalSchemas<State> | undefined;

  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new DecimalField(
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
    return new DecimalField(
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
    return new DecimalField(
      updateState(this, { isId: true, isUnique: true }),
      this._nativeType
    );
  }

  unique() {
    return new DecimalField(
      updateState(this, { isUnique: true }),
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(value: V) {
    return new DecimalField(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<number>>(schema: S) {
    return new DecimalField(
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
    return new DecimalField(
      updateState(this, { columnName }),
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildDecimalSchema(this.state)),
      nativeType: this._nativeType,
    };
  }
}

export const decimal = (nativeType?: NativeType) =>
  new DecimalField(createDefaultState("decimal", decimalBase), nativeType);
