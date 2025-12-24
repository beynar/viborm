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
import { schemaFromStandardSchema, StandardSchemaToSchema } from "..";
import {
  defaultCuid,
  defaultNanoid,
  defaultUlid,
  defaultUuid,
} from "./autogenerate";
import v from "../../../validation";
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
  ): StringField<
    UpdateState<State, { schema: S; base: StandardSchemaToSchema<S> }>
  > {
    return new StringField(
      {
        ...this.state,
        schema: schema,
        base: schemaFromStandardSchema(this.state.base, schema),
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
      schemas: getFieldStringSchemas<State>(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

export const string = (nativeType?: NativeType) =>
  new StringField(createDefaultState("string", stringBase), nativeType);

const test = string().nullable().array().default(["test"]);

const user = v.object({
  name: v.string(test["~"]["state"]),
  age: v.number(),
  friends: () => user,
});

type UserInput = StandardSchemaV1.InferInput<typeof user>["name"];
type UserOutput = StandardSchemaV1.InferOutput<typeof user>["name"];

type BaseNow = InferInput<(typeof test)["~"]["schemas"]["base"]>;

const createBase = <S extends FieldState<"string">>(state: S) => {
  return v.string<S>(state);
};
const baseAfter = createBase(test["~"]["state"]);
const nn = v.nonNullable(baseAfter);
const no = v.nonOptional(baseAfter);
// type BaseAfter = StandardSchemaV1.InferInput<typeof nn>;
type BaseAfter = StandardSchemaV1.InferInput<typeof nn>;
type BaseAfterNo = StandardSchemaV1.InferInput<typeof no>;
type BaseAfterNoOut = StandardSchemaV1.InferOutput<typeof no>;
