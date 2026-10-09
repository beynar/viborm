import { ValidationError } from "@errors";
import {
  JsonNull,
  type JsonNullSentinel,
  jsonNullKindOf,
} from "@schema/json-null";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { JsonValue } from "@validation";
import type { JsonInput } from "@validation/primitives/json";
import v from "@validation/primitives/v";
import {
  createDefaultState,
  type DefaultValue,
  type DefaultValueInput,
  nullableDefault,
  type ScalarState,
  updateState,
} from "../common";
import { admitNativeType } from "../native-catalog";
import type {
  ExactNativeTypeMap,
  NativeDialect,
  NativeTypeArgument,
  NativeTypeDeclaration,
} from "../native-types";

const jsonBase = v.json();

export class JsonScalar<
  State extends ScalarState<"json"> = ScalarState<"json">,
> {
  private readonly state: State;
  private readonly _nativeType?: NativeTypeDeclaration | undefined;
  constructor(state: State, _nativeType?: NativeTypeDeclaration) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new JsonScalar(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: nullableDefault(this.state),
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

  default<
    V extends
      | DefaultValueInput<State>
      | DefaultValue<
          JsonNullSentinel<
            State["nullable"] extends true ? "JsonNull" | "DbNull" : "JsonNull"
          >
        >,
  >(value: V) {
    const kind = jsonNullKindOf(value);
    if (kind === "AnyNull" || (kind === "DbNull" && !this.state.nullable)) {
      throw new ValidationError(
        { kind: "schema-builder", builder: "s.json", path: "default" },
        [
          {
            path: "default",
            message: "JSON default must name a null this column can store",
          },
        ]
      );
    }
    const defaultValue =
      value === null && !this.state.nullable ? JsonNull : value;
    return new JsonScalar(
      updateState(this, {
        hasDefault: true,
        default: defaultValue,
        optional: true,
      }),
      this._nativeType
    );
  }

  schema<S extends StandardSchemaV1<JsonInput, JsonValue>>(schema: S) {
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

export const json = <
  Db extends NativeDialect = never,
  const Given extends ExactNativeTypeMap<Given> = never,
>(
  nativeType?: NativeTypeArgument<Db, Given>
) =>
  new JsonScalar(
    createDefaultState("json", jsonBase),
    admitNativeType("s.json", nativeType)
  );
