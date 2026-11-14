import { ValidationError } from "@errors";
import {
  JsonNull,
  type JsonNullSentinel,
  jsonNullKindOf,
} from "@schema/json-null";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { JsonValue } from "@validation";
import type { JsonInput, JsonSchema } from "@validation/primitives/json";
import v from "@validation/primitives/v";
import type { ComputeInput, ComputeOutput } from "@validation/types";
import {
  createDefaultState,
  type DefaultValue,
  type DefaultValueInput,
  type ScalarState,
  scalarChain,
  type UpdateState,
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
> extends scalarChain<State> {
  private declare readonly state: State;
  private declare readonly _nativeType: NativeTypeDeclaration | undefined;
  declare readonly nullable: () => JsonScalar<
    UpdateState<
      State,
      {
        readonly nullable: true;
        readonly hasDefault: true;
        readonly default: State["hasDefault"] extends true
          ? State["default"]
          : null;
        readonly optional: true;
        readonly base: JsonSchema<
          ComputeInput<
            JsonInput,
            {
              nullable: true;
              schema: State["schema"];
            }
          >,
          ComputeOutput<
            JsonValue,
            {
              nullable: true;
              schema: State["schema"];
            }
          >
        >;
      }
    >
  >;
  declare readonly map: (columnName: string) => JsonScalar<
    UpdateState<
      State,
      {
        readonly columnName: string;
      }
    >
  >;
  declare readonly ["~"]: {
    state: State;
    nativeType: NativeTypeDeclaration | undefined;
  };

  protected rebase(state: State) {
    return v.json({
      nullable: state.nullable,
      schema: state.schema,
    });
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
