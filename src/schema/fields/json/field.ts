// JSON Field
// Lean class delegating to schema factories

import { object, string, type ZodMiniJSONSchemaInternals } from "zod/v4-mini";
import type { StandardSchemaV1 } from "../../../standardSchema";
import {
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
  FieldState,
  isOptional,
} from "../common";
import type { NativeType } from "../native-types";
import { InferJsonInput, getFieldJsonSchemas, jsonSchemas } from "./schemas";

type JsonDefault<State extends FieldState<"json">> =
  State["schema"] extends StandardSchemaV1
    ? DefaultValue<
        StandardSchemaV1.InferOutput<State["schema"]>,
        false,
        State["nullable"]
      >
    : DefaultValue<
        ZodMiniJSONSchemaInternals["output"],
        false,
        State["nullable"]
      >;

export class JsonField<State extends FieldState<"json">> {
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): JsonField<UpdateState<State, { nullable: true }>> {
    return new JsonField({ ...this.state, nullable: true }, this._nativeType);
  }

  default(
    value: DefaultValue<JsonDefault<State>, false, State["nullable"]>
  ): JsonField<UpdateState<State, { hasDefault: true }>> {
    return new JsonField(
      {
        ...this.state,
        hasDefault: true,
        defaultValue: value,
      } as UpdateState<State, { hasDefault: true }>,
      this._nativeType
    );
  }

  map(
    columnName: string
  ): JsonField<UpdateState<State, { columnName: string }>> {
    return new JsonField({ ...this.state, columnName }, this._nativeType);
  }

  schema = <TSchema extends StandardSchemaV1>(
    s: TSchema
  ): JsonField<UpdateState<State, { schema: TSchema }>> => {
    return new JsonField({ ...this.state, schema: s }, this._nativeType);
  };

  get ["~"]() {
    return {
      state: this.state,
      schemas: getFieldJsonSchemas<State>(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

export function json(nativeType?: NativeType) {
  return new JsonField(createDefaultState("json"), nativeType);
}

const test = json()
  .schema(
    object({
      name: string(),
      age: string(),
    })
  )
  .nullable();

const state = test["~"]["state"];

const schema_test = test["~"]["schemas"];

type Test = InferJsonInput<typeof state, "base">;
type Test2 = InferJsonInput<typeof state, "create">;
type Test3 = InferJsonInput<typeof state, "update">;
type Test4 = InferJsonInput<typeof state, "filter">;

const base = jsonSchemas(state).base;
