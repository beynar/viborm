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
import { buildStringSchema } from "./schemas";
import {
  defaultCuid,
  defaultNanoid,
  defaultUlid,
  defaultUuid,
} from "./autogenerate";
import v, { Prettify } from "../../../validation";
import { InferInput } from "valibot";

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
      {
        nullable: true;
        hasDefault: true;
        defaultValue: DefaultValue<null>;
        optional: true;
      }
    >
  > {
    return new StringField(
      {
        ...this.state,
        nullable: true,
        hasDefault: true,
        defaultValue: null,
        optional: true,
      },
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
  ): StringField<
    UpdateState<State, { hasDefault: true; default: V; optional: true }>
  > {
    return new StringField(
      {
        ...this.state,
        hasDefault: true,
        default: value,
        optional: true,
      },
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<string>>(
    schema: S
  ): StringField<UpdateState<State, { schema: S }>> {
    return new StringField(
      {
        ...this.state,
        schema: schema,
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
        default: DefaultValue<string>;
        optional: true;
      }
    >
  > {
    return new StringField(
      {
        ...this.state,
        hasDefault: true,
        default: defaultUuid,
        autoGenerate: "uuid",
        optional: true,
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
        default: DefaultValue<string>;
        optional: true;
      }
    >
  > {
    return new StringField(
      {
        ...this.state,
        hasDefault: true,
        default: defaultUlid,
        autoGenerate: "ulid",
        optional: true,
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
        default: DefaultValue<string>;
        optional: true;
      }
    >
  > {
    return new StringField(
      {
        ...this.state,
        hasDefault: true,
        default: defaultNanoid(length),
        autoGenerate: "nanoid",
        optional: true,
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
        default: DefaultValue<string>;
        optional: true;
      }
    >
  > {
    return new StringField(
      {
        ...this.state,
        hasDefault: true,
        default: defaultCuid,
        autoGenerate: "cuid",
        optional: true,
      },
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: buildStringSchema(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

export const string = (nativeType?: NativeType) =>
  new StringField(createDefaultState("string"), nativeType);

const stringTest = string().array().nullable();

type Schemas = (typeof stringTest)["~"]["schemas"];
type CreateInput = Prettify<Schemas["create"][" vibInferred"]["0"]>;
type CreateOutput = Prettify<Schemas["create"][" vibInferred"]["1"]>;
type UpdateInput = Prettify<Schemas["update"][" vibInferred"]["0"]>;
type UpdateOutput = Prettify<Schemas["update"][" vibInferred"]["1"]>;
type FilterInput = Prettify<Schemas["filter"][" vibInferred"]["0"]>;
type FilterOutput = Prettify<Schemas["filter"][" vibInferred"]["1"]>;
