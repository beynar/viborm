// Boolean Field
// Standalone field class with State generic pattern

import v, { type BaseBooleanSchema } from "@validation";
import {
  createDefaultState,
  type DefaultValue,
  type DefaultValueInput,
  type FieldState,
  type UpdateState,
} from "../common";
import type { NativeType } from "../native-types";
import {
  type BooleanSchemas,
  booleanBase,
  buildBooleanSchema,
} from "./schemas";

export class BooleanField<State extends FieldState<"boolean">> {
  private _schemas: BooleanSchemas<State> | undefined;
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;

  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable(): BooleanField<
    UpdateState<
      State,
      {
        nullable: true;
        hasDefault: true;
        default: DefaultValue<null>;
        optional: true;
        base: BaseBooleanSchema<{
          nullable: true;
          array: State["array"];
        }>;
      }
    >
  > {
    return new BooleanField(
      {
        ...this.state,
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.boolean<{
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

  array(): BooleanField<
    UpdateState<
      State,
      {
        array: true;
        base: BaseBooleanSchema<{
          nullable: State["nullable"];
          array: true;
        }>;
      }
    >
  > {
    return new BooleanField(
      {
        ...this.state,
        array: true,
        base: v.boolean<{
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

  default<V extends DefaultValueInput<State>>(
    value: V
  ): BooleanField<
    UpdateState<State, { hasDefault: true; default: V; optional: true }>
  > {
    return new BooleanField(
      {
        ...this.state,
        hasDefault: true,
        default: value,
        optional: true,
      },
      this._nativeType
    );
  }

  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this {
    return new BooleanField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildBooleanSchema(this.state)),
      nativeType: this._nativeType,
    };
  }
}

export const boolean = (nativeType?: NativeType) =>
  new BooleanField(createDefaultState("boolean", booleanBase), nativeType);
