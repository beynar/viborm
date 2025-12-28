// Number Fields (int, float, decimal)
// Standalone field classes with State generic pattern

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
import {
  buildIntSchema,
  buildFloatSchema,
  buildDecimalSchema,
  intBase,
  floatBase,
  decimalBase,
  IntSchemas,
  FloatSchemas,
  DecimalSchemas,
} from "./schemas";
import v, { BaseIntegerSchema, BaseNumberSchema } from "../../../validation";

export class IntField<State extends FieldState<"int">> {
  private _names: SchemaNames = {};
  private _schemas: IntSchemas<State> | undefined;

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): IntField<
    UpdateState<
      State,
      {
        nullable: true;
        hasDefault: true;
        default: DefaultValue<null>;
        optional: true;
        base: BaseIntegerSchema<{
          nullable: true;
          array: State["array"];
        }>;
      }
    >
  > {
    return new IntField(
      {
        ...this.state,
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.integer<{
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

  array(): IntField<
    UpdateState<
      State,
      {
        array: true;
        base: BaseIntegerSchema<{
          nullable: State["nullable"];
          array: true;
        }>;
      }
    >
  > {
    return new IntField(
      {
        ...this.state,
        array: true,
        base: v.integer<{
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

  id(): IntField<UpdateState<State, { isId: true; isUnique: true }>> {
    return new IntField(
      { ...this.state, isId: true, isUnique: true },
      this._nativeType
    );
  }

  unique(): IntField<UpdateState<State, { isUnique: true }>> {
    return new IntField({ ...this.state, isUnique: true }, this._nativeType);
  }

  default<V extends DefaultValueInput<State>>(
    value: V
  ): IntField<
    UpdateState<State, { hasDefault: true; default: V; optional: true }>
  > {
    return new IntField(
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
  ): IntField<
    UpdateState<
      State,
      {
        schema: S;
        base: BaseIntegerSchema<{
          nullable: State["nullable"];
          array: State["array"];
          schema: S;
        }>;
      }
    >
  > {
    return new IntField(
      {
        ...this.state,
        schema: schema,
        base: v.integer<{
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

  map(columnName: string): this {
    return new IntField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  increment(): IntField<
    UpdateState<
      State,
      {
        hasDefault: true;
        autoGenerate: "increment";
        default: DefaultValue<number>;
        optional: true;
      }
    >
  > {
    return new IntField(
      {
        ...this.state,
        hasDefault: true,
        autoGenerate: "increment",
        default: 0, // Placeholder, actual value set by DB
        optional: true,
      },
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildIntSchema(this.state)),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

export class FloatField<State extends FieldState<"float">> {
  private _names: SchemaNames = {};
  private _schemas: FloatSchemas<State> | undefined;

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): FloatField<
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
    return new FloatField(
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

  array(): FloatField<
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
    return new FloatField(
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

  id(): FloatField<UpdateState<State, { isId: true; isUnique: true }>> {
    return new FloatField(
      { ...this.state, isId: true, isUnique: true },
      this._nativeType
    );
  }

  unique(): FloatField<UpdateState<State, { isUnique: true }>> {
    return new FloatField({ ...this.state, isUnique: true }, this._nativeType);
  }

  default<V extends DefaultValueInput<State>>(
    value: V
  ): FloatField<
    UpdateState<State, { hasDefault: true; default: V; optional: true }>
  > {
    return new FloatField(
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
  ): FloatField<
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
    return new FloatField(
      {
        ...this.state,
        schema: schema,
        base: v.number<{
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

  map(columnName: string): this {
    return new FloatField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildFloatSchema(this.state)),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

export class DecimalField<State extends FieldState<"decimal">> {
  private _names: SchemaNames = {};
  private _schemas: DecimalSchemas<State> | undefined;

  constructor(private state: State, private _nativeType?: NativeType) {}

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
        schema: schema,
        base: v.number<{
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
      names: this._names,
    };
  }
}

export const int = (nativeType?: NativeType) =>
  new IntField(createDefaultState("int", intBase), nativeType);
export const float = (nativeType?: NativeType) =>
  new FloatField(createDefaultState("float", floatBase), nativeType);
export const decimal = (nativeType?: NativeType) =>
  new DecimalField(createDefaultState("decimal", decimalBase), nativeType);
