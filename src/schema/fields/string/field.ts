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
import { buildStringSchema, stringBase, StringSchemas } from "./schemas";
import {
  defaultCuid,
  defaultNanoid,
  defaultUlid,
  defaultUuid,
} from "./autogenerate";
import v, { BaseStringSchema, Prettify } from "../../../validation";

export class StringField<State extends FieldState<"string">> {
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};
  private _schemas: StringSchemas<State> | undefined;

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): StringField<
    UpdateState<
      State,
      {
        nullable: true;
        hasDefault: true;
        default: DefaultValue<null>;
        optional: true;
        base: BaseStringSchema<{
          nullable: true;
          array: State["array"];
          schema: State["schema"];
        }>;
      }
    >
  > {
    return new StringField(
      {
        ...this.state,
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.string<{
          nullable: true;
          array: State["array"];
          schema: State["schema"];
        }>({
          nullable: true,
          array: this.state.array,
          schema: this.state.schema,
        }),
      },
      this._nativeType
    );
  }

  array(): StringField<
    UpdateState<
      State,
      {
        array: true;
        base: BaseStringSchema<{
          nullable: State["nullable"];
          array: true;
          schema: State["schema"];
        }>;
      }
    >
  > {
    return new StringField(
      {
        ...this.state,
        array: true,
        base: v.string<{
          nullable: State["nullable"];
          array: true;
          schema: State["schema"];
        }>({
          nullable: this.state.nullable,
          array: true,
          schema: this.state.schema,
        }),
      },
      this._nativeType
    );
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
    UpdateState<
      State,
      {
        schema: S;
        base: BaseStringSchema<{
          nullable: State["nullable"];
          array: State["array"];
          schema: S;
        }>;
      }
    >
  > {
    return new StringField(
      {
        ...this.state,
        schema: schema,
        base: v.string<{
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

  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this {
    return new StringField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

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
      schemas: (this._schemas ??= buildStringSchema(this.state)),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

export const string = (nativeType?: NativeType) =>
  new StringField(createDefaultState("string", stringBase), nativeType);
