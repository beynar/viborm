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

  nullable(): DecimalField<
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
    return new DecimalField(
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

  array(): DecimalField<
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
    return new DecimalField(
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

  id(): DecimalField<UpdateState<State, { isId: true; isUnique: true }>> {
    return new DecimalField(
      { ...this.state, isId: true, isUnique: true },
      this._nativeType
    );
  }

  unique(): DecimalField<UpdateState<State, { isUnique: true }>> {
    return new DecimalField(
      { ...this.state, isUnique: true },
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(
    value: V
  ): DecimalField<
    UpdateState<State, { hasDefault: true; default: V; optional: true }>
  > {
    return new DecimalField(
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
  ): DecimalField<
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
    return new DecimalField(
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
    return new DecimalField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
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
