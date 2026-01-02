// DateTime Field
// Standalone field class with State generic pattern

import type { StandardSchemaOf } from "@standard-schema/spec";
import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
  DefaultValueInput,
} from "../common";
import type { NativeType } from "../native-types";
import { buildDateTimeSchema, datetimeBase, DateTimeSchemas } from "./schemas";
import v, { BaseIsoTimestampSchema } from "@validation";

const defaultNow = () => new Date().toISOString();
const defaultUpdatedAt = () => new Date().toISOString();

export class DateTimeField<State extends FieldState<"datetime">> {
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};
  private _schemas: DateTimeSchemas<State> | undefined;

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): DateTimeField<
    UpdateState<
      State,
      {
        nullable: true;
        hasDefault: true;
        default: DefaultValue<null>;
        optional: true;
        base: BaseIsoTimestampSchema<{
          nullable: true;
          array: State["array"];
        }>;
      }
    >
  > {
    return new DateTimeField(
      {
        ...this.state,
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.isoTimestamp<{
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

  array(): DateTimeField<
    UpdateState<
      State,
      {
        array: true;
        base: BaseIsoTimestampSchema<{
          nullable: State["nullable"];
          array: true;
        }>;
      }
    >
  > {
    return new DateTimeField(
      {
        ...this.state,
        array: true,
        base: v.isoTimestamp<{
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

  id(): DateTimeField<UpdateState<State, { isId: true; isUnique: true }>> {
    return new DateTimeField(
      { ...this.state, isId: true, isUnique: true },
      this._nativeType
    );
  }

  unique(): DateTimeField<UpdateState<State, { isUnique: true }>> {
    return new DateTimeField(
      { ...this.state, isUnique: true },
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<string>>(
    schema: S
  ): DateTimeField<
    UpdateState<
      State,
      {
        schema: S;
        base: BaseIsoTimestampSchema<{
          nullable: State["nullable"];
          array: State["array"];
          schema: S;
        }>;
      }
    >
  > {
    return new DateTimeField(
      {
        ...this.state,
        schema: schema,
        base: v.isoTimestamp<{
          nullable: State["nullable"];
          array: State["array"];
          schema: S;
        }>({
          nullable: this.state.nullable,
          array: this.state.array,
          schema: schema,
        }),
      },
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(
    value: V
  ): DateTimeField<
    UpdateState<State, { hasDefault: true; default: V; optional: true }>
  > {
    return new DateTimeField(
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
    return new DateTimeField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  now(): DateTimeField<
    UpdateState<
      State,
      {
        hasDefault: true;
        autoGenerate: "now";
        default: DefaultValue<string>;
        optional: true;
      }
    >
  > {
    return new DateTimeField(
      {
        ...this.state,
        hasDefault: true,
        autoGenerate: "now",
        default: defaultNow,
        optional: true,
      },
      this._nativeType
    );
  }

  updatedAt(): DateTimeField<
    UpdateState<
      State,
      {
        hasDefault: true;
        autoGenerate: "updatedAt";
        default: DefaultValue<string>;
        optional: true;
      }
    >
  > {
    return new DateTimeField(
      {
        ...this.state,
        hasDefault: true,
        autoGenerate: "updatedAt",
        default: defaultUpdatedAt,
        optional: true,
      },
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildDateTimeSchema(this.state)),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

export const dateTime = (nativeType?: NativeType) =>
  new DateTimeField(createDefaultState("datetime", datetimeBase), nativeType);
