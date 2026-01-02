// Boolean Field
// Standalone field class with State generic pattern

import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
  DefaultValueInput,
} from "../common";
import type { NativeType } from "../native-types";
import { buildBooleanSchema, booleanBase, BooleanSchemas } from "./schemas";
import v, { BaseBooleanSchema } from "@validation";

export class BooleanField<State extends FieldState<"boolean">> {
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};
  private _schemas: BooleanSchemas<State> | undefined;

  constructor(private state: State, private _nativeType?: NativeType) {}

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
      names: this._names,
    };
  }
}

export const boolean = (nativeType?: NativeType) =>
  new BooleanField(createDefaultState("boolean", booleanBase), nativeType);
