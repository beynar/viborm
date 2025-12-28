// Time Field
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
import { buildTimeSchema, timeBase, TimeSchemas } from "./schemas";
import v, { BaseIsoTimeSchema } from "../../../validation";

const defaultNow = () => {
  const now = new Date();
  return now.toISOString().split("T")[1]?.split(".")[0] ?? ""; // "HH:MM:SS"
};
const defaultUpdatedAt = () => {
  const now = new Date();
  return now.toISOString().split("T")[1]?.split(".")[0] ?? ""; // "HH:MM:SS"
};

export class TimeField<State extends FieldState<"time">> {
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};
  private _schemas: TimeSchemas<State> | undefined;

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): TimeField<
    UpdateState<
      State,
      {
        nullable: true;
        hasDefault: true;
        default: DefaultValue<null>;
        optional: true;
        base: BaseIsoTimeSchema<{
          nullable: true;
          array: State["array"];
        }>;
      }
    >
  > {
    return new TimeField(
      {
        ...this.state,
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.isoTime<{
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

  array(): TimeField<
    UpdateState<
      State,
      {
        array: true;
        base: BaseIsoTimeSchema<{
          nullable: State["nullable"];
          array: true;
        }>;
      }
    >
  > {
    return new TimeField(
      {
        ...this.state,
        array: true,
        base: v.isoTime<{
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

  id(): TimeField<UpdateState<State, { isId: true; isUnique: true }>> {
    return new TimeField(
      { ...this.state, isId: true, isUnique: true },
      this._nativeType
    );
  }

  unique(): TimeField<UpdateState<State, { isUnique: true }>> {
    return new TimeField({ ...this.state, isUnique: true }, this._nativeType);
  }

  schema<S extends StandardSchemaOf<string>>(
    schema: S
  ): TimeField<
    UpdateState<
      State,
      {
        schema: S;
        base: BaseIsoTimeSchema<{
          nullable: State["nullable"];
          array: State["array"];
          schema: S;
        }>;
      }
    >
  > {
    return new TimeField(
      {
        ...this.state,
        schema: schema,
        base: v.isoTime<{
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
  ): TimeField<
    UpdateState<State, { hasDefault: true; default: V; optional: true }>
  > {
    return new TimeField(
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
    return new TimeField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  now(): TimeField<
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
    return new TimeField(
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

  updatedAt(): TimeField<
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
    return new TimeField(
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
      schemas: (this._schemas ??= buildTimeSchema(this.state)),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

export const time = (nativeType?: NativeType) =>
  new TimeField(createDefaultState("time", timeBase), nativeType);
