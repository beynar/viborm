import type { StandardSchemaOf } from "@standard-schema/spec";
import type { JsonValue } from "@validation";
import v from "@validation/primitives/v";
import {
  createDefaultState,
  type DefaultValueInput,
  type ScalarState,
  updateState,
} from "../common";
import type { NativeType } from "../native-types";

const jsonBase = v.json();

export class JsonScalar<
  State extends ScalarState<"json"> = ScalarState<"json">,
> {
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;
  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new JsonScalar(
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
    return new JsonScalar(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<JsonValue>>(schema: S) {
    return new JsonScalar(
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
    return new JsonScalar(updateState(this, { columnName }), this._nativeType);
  }

  get ["~"]() {
    return {
      state: this.state,
      nativeType: this._nativeType,
    };
  }
}

export const json = (nativeType?: NativeType) =>
  new JsonScalar(createDefaultState("json", jsonBase), nativeType);
