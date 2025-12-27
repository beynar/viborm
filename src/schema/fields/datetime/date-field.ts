// Date Field
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
import { buildDateSchema, dateBase } from "./schemas";
import v, { BaseIsoDateSchema } from "../../../validation";

// =============================================================================
// AUTO-GENERATION DEFAULT VALUE FACTORIES
// =============================================================================

const defaultNow = () => new Date().toISOString().split("T")[0]!;
const defaultUpdatedAt = () => new Date().toISOString().split("T")[0]!;

// =============================================================================
// DATE FIELD CLASS
// =============================================================================

export class DateField<State extends FieldState<"date">> {
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): DateField<
    UpdateState<
      State,
      {
        nullable: true;
        hasDefault: true;
        default: DefaultValue<null>;
        optional: true;
        base: BaseIsoDateSchema<{
          nullable: true;
          array: State["array"];
        }>;
      }
    >
  > {
    return new DateField(
      {
        ...this.state,
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.isoDate<{
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

  array(): DateField<
    UpdateState<
      State,
      {
        array: true;
        base: BaseIsoDateSchema<{
          nullable: State["nullable"];
          array: true;
        }>;
      }
    >
  > {
    return new DateField(
      {
        ...this.state,
        array: true,
        base: v.isoDate<{
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

  id(): DateField<UpdateState<State, { isId: true; isUnique: true }>> {
    return new DateField(
      { ...this.state, isId: true, isUnique: true },
      this._nativeType
    );
  }

  unique(): DateField<UpdateState<State, { isUnique: true }>> {
    return new DateField({ ...this.state, isUnique: true }, this._nativeType);
  }

  schema<S extends StandardSchemaOf<string>>(
    schema: S
  ): DateField<
    UpdateState<
      State,
      {
        schema: S;
        base: BaseIsoDateSchema<{
          nullable: State["nullable"];
          array: State["array"];
          schema: S;
        }>;
      }
    >
  > {
    return new DateField(
      {
        ...this.state,
        schema: schema,
        base: v.isoDate<{
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
  ): DateField<
    UpdateState<State, { hasDefault: true; default: V; optional: true }>
  > {
    return new DateField(
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
    return new DateField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  // ===========================================================================
  // AUTO-GENERATION METHODS
  // ===========================================================================

  now(): DateField<
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
    return new DateField(
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

  updatedAt(): DateField<
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
    return new DateField(
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

  // ===========================================================================
  // ACCESSORS
  // ===========================================================================

  #cached_schemas: ReturnType<typeof buildDateSchema<State>> | undefined;

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this.#cached_schemas ??= buildDateSchema(this.state)),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

export const date = (nativeType?: NativeType) =>
  new DateField(createDefaultState("date", dateBase), nativeType);
