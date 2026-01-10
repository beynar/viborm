import type { StandardSchemaOf } from "@standard-schema/spec";
import v, { type JsonValue } from "@validation";
import {
  createDefaultState,
  type DefaultValueInput,
  type FieldState,
  updateState,
} from "../common";
import type { NativeType } from "../native-types";
import { buildJsonSchema, type JsonSchemas, jsonBase } from "./schemas";

export class JsonField<State extends FieldState<"json"> = FieldState<"json">> {
  private _schemas: JsonSchemas<State> | undefined;
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;
  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new JsonField(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.json<{
          nullable: true;
          schema: State["schema"];
        }>({
          nullable: true,
          schema: this.state.schema,
        }),
      }),
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(value: V) {
    return new JsonField(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<JsonValue>>(schema: S) {
    return new JsonField(
      updateState(this, {
        schema,
        base: v.json<{
          nullable: State["nullable"];
          schema: S;
        }>({
          nullable: this.state.nullable,
          schema,
        }),
      }),
      this._nativeType
    );
  }

  map(columnName: string) {
    return new JsonField(updateState(this, { columnName }), this._nativeType);
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildJsonSchema(this.state)),
      nativeType: this._nativeType,
    };
  }
}

export const json = (nativeType?: NativeType) =>
  new JsonField(createDefaultState("json", jsonBase), nativeType);
