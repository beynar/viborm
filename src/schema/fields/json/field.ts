import type { StandardSchemaOf } from "@standard-schema/spec";
import v, { type BaseJsonSchema, type JsonValue } from "@validation";
import {
  createDefaultState,
  type DefaultValue,
  type DefaultValueInput,
  type FieldState,
  type SchemaNames,
  type UpdateState,
} from "../common";
import type { NativeType } from "../native-types";
import { buildJsonSchema, type JsonSchemas, jsonBase } from "./schemas";

export class JsonField<State extends FieldState<"json"> = FieldState<"json">> {
  // biome-ignore lint/style/useReadonlyClassProperties: <it is reassigned when hydrating schemas>
  private _names: SchemaNames = {};
  private _schemas: JsonSchemas<State> | undefined;
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;
  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable(): JsonField<
    UpdateState<
      State,
      {
        nullable: true;
        hasDefault: true;
        default: DefaultValue<null>;
        optional: true;
        base: BaseJsonSchema<{
          nullable: true;
          schema: State["schema"];
        }>;
      }
    >
  > {
    return new JsonField(
      {
        ...this.state,
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
      },
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(
    value: V
  ): JsonField<
    UpdateState<State, { hasDefault: true; default: V; optional: true }>
  > {
    return new JsonField(
      {
        ...this.state,
        hasDefault: true,
        default: value,
        optional: true,
      },
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<JsonValue>>(
    schema: S
  ): JsonField<
    UpdateState<
      State,
      {
        schema: S;
        base: BaseJsonSchema<{
          nullable: State["nullable"];
          schema: S;
        }>;
      }
    >
  > {
    return new JsonField(
      {
        ...this.state,
        schema,
        base: v.json<{
          nullable: State["nullable"];
          schema: S;
        }>({
          nullable: this.state.nullable,
          schema,
        }),
      },
      this._nativeType
    );
  }

  map(columnName: string): this {
    return new JsonField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildJsonSchema(this.state)),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

export const json = (nativeType?: NativeType) =>
  new JsonField(createDefaultState("json", jsonBase), nativeType);
