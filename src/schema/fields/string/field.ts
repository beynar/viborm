// String Field
// Standalone field class with State generic pattern

import type { StandardSchemaOf, StandardSchemaV1 } from "@standard-schema/spec";
import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
  DefaultValueInput,
} from "../common";
import type { NativeType } from "../native-types";
import { getFieldStringSchemas, stringBase } from "./schemas";
import { StandardSchemaToZod, zodFromStandardSchema } from "..";
import {
  defaultCuid,
  defaultNanoid,
  defaultUlid,
  defaultUuid,
} from "./autogenerate";

// =============================================================================
// STRING FIELD CLASS
// =============================================================================

export class StringField<State extends FieldState<"string">> {
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): StringField<
    UpdateState<
      State,
      { nullable: true; hasDefault: true; defaultValue: DefaultValue<null> }
    >
  > {
    return new StringField(
      { ...this.state, nullable: true, hasDefault: true, defaultValue: null },
      this._nativeType
    );
  }

  array(): StringField<UpdateState<State, { array: true }>> {
    return new StringField({ ...this.state, array: true }, this._nativeType);
  }

  id(): StringField<UpdateState<State, { isId: true; isUnique: true }>> {
    return new StringField(
      { ...this.state, isId: true, isUnique: true },
      this._nativeType
    );
  }

  unique(): StringField<UpdateState<State, { isUnique: true }>> {
    return new StringField({ ...this.state, isUnique: true }, this._nativeType);
  }

  default<V extends DefaultValueInput<State>>(
    value: V
  ): StringField<UpdateState<State, { hasDefault: true; defaultValue: V }>> {
    return new StringField(
      {
        ...this.state,
        hasDefault: true,
        defaultValue: value,
      },
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<string>>(
    schema: S
  ): StringField<
    UpdateState<State, { schema: S; base: StandardSchemaToZod<S> }>
  > {
    return new StringField(
      {
        ...this.state,
        schema: schema,
        base: zodFromStandardSchema(schema),
      },
      this._nativeType
    );
  }

  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this {
    return new StringField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  // ===========================================================================
  // AUTO-GENERATION METHODS
  // ===========================================================================

  uuid(): StringField<
    UpdateState<
      State,
      {
        hasDefault: true;
        autoGenerate: "uuid";
        defaultValue: DefaultValue<string>;
      }
    >
  > {
    return new StringField(
      {
        ...this.state,
        hasDefault: true,
        defaultValue: defaultUuid,
        autoGenerate: "uuid",
      },
      this._nativeType
    );
  }

  ulid(): StringField<
    UpdateState<
      State,
      {
        hasDefault: true;
        autoGenerate: "ulid";
        defaultValue: DefaultValue<string>;
      }
    >
  > {
    return new StringField(
      {
        ...this.state,
        hasDefault: true,
        defaultValue: defaultUlid,
        autoGenerate: "ulid",
      },
      this._nativeType
    );
  }

  nanoid(length?: number): StringField<
    UpdateState<
      State,
      {
        hasDefault: true;
        autoGenerate: "nanoid";
        defaultValue: DefaultValue<string>;
      }
    >
  > {
    return new StringField(
      {
        ...this.state,
        hasDefault: true,
        defaultValue: defaultNanoid(length),
        autoGenerate: "nanoid",
      },
      this._nativeType
    );
  }

  cuid(): StringField<
    UpdateState<
      State,
      {
        hasDefault: true;
        autoGenerate: "cuid";
        defaultValue: DefaultValue<string>;
      }
    >
  > {
    return new StringField(
      {
        ...this.state,
        hasDefault: true,
        defaultValue: defaultCuid,
        autoGenerate: "cuid",
      },
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: getFieldStringSchemas<State>(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

export const string = (nativeType?: NativeType) =>
  new StringField(createDefaultState("string", stringBase), nativeType);
