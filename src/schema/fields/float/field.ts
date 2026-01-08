import type { StandardSchemaOf } from "@standard-schema/spec";
import v, { type BaseNumberSchema } from "@validation";
import {
  createDefaultState,
  type DefaultValue,
  type DefaultValueInput,
  type FieldState,
  type UpdateState,
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

  nullable(): FloatField<
    UpdateState<
      State,
      {
        nullable: true;
        hasDefault: true;
        default: DefaultValue<null>;
        optional: true;
        base: BaseNumberSchema<{
          nullable: true;
          array: State["array"];
        }>;
      }
    >
  > {
    return new FloatField(
      {
        ...this.state,
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
      },
      this._nativeType
    );
  }

  array(): FloatField<
    UpdateState<
      State,
      {
        array: true;
        base: BaseNumberSchema<{
          nullable: State["nullable"];
          array: true;
        }>;
      }
    >
  > {
    return new FloatField(
      {
        ...this.state,
        array: true,
        base: v.number<{
          nullable: State["nullable"];
          array: true;
        }>({
          nullable: this.state.nullable,
          array: true,
        }),
      },
      this._nativeType
    );
  }

  id(): FloatField<UpdateState<State, { isId: true; isUnique: true }>> {
    return new FloatField(
      { ...this.state, isId: true, isUnique: true },
      this._nativeType
    );
  }

  unique(): FloatField<UpdateState<State, { isUnique: true }>> {
    return new FloatField({ ...this.state, isUnique: true }, this._nativeType);
  }

  default<V extends DefaultValueInput<State>>(
    value: V
  ): FloatField<
    UpdateState<State, { hasDefault: true; default: V; optional: true }>
  > {
    return new FloatField(
      {
        ...this.state,
        hasDefault: true,
        default: value,
        optional: true,
      },
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<number>>(
    schema: S
  ): FloatField<
    UpdateState<
      State,
      {
        schema: S;
        base: BaseNumberSchema<{
          nullable: State["nullable"];
          array: State["array"];
          schema: S;
        }>;
      }
    >
  > {
    return new FloatField(
      {
        ...this.state,
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
      },
      this._nativeType
    );
  }

  map(columnName: string): this {
    return new FloatField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
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
