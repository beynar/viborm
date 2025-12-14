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
  getFieldIntSchemas,
  getFieldFloatSchemas,
  getFieldDecimalSchemas,
  intBase,
  floatBase,
  decimalBase,
} from "./schemas";
import { schemaFromStandardSchema, StandardSchemaToSchema } from "..";

// =============================================================================
// INT FIELD CLASS
// =============================================================================

export class IntField<State extends FieldState<"int">> {
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): IntField<
    UpdateState<
      State,
      { nullable: true; hasDefault: true; defaultValue: DefaultValue<null> }
    >
  > {
    return new IntField(
      { ...this.state, nullable: true, hasDefault: true, defaultValue: null },
      this._nativeType
    );
  }

  array(): IntField<UpdateState<State, { array: true }>> {
    return new IntField({ ...this.state, array: true }, this._nativeType);
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
  ): IntField<UpdateState<State, { hasDefault: true; defaultValue: V }>> {
    return new IntField(
      {
        ...this.state,
        hasDefault: true,
        defaultValue: value,
      },
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<number>>(
    schema: S
  ): IntField<
    UpdateState<State, { schema: S; base: StandardSchemaToSchema<S> }>
  > {
    return new IntField(
      {
        ...this.state,
        schema: schema,
        base: schemaFromStandardSchema(this.state.base, schema),
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
        defaultValue: DefaultValue<number>;
      }
    >
  > {
    return new IntField(
      {
        ...this.state,
        hasDefault: true,
        autoGenerate: "increment",
        defaultValue: 0, // Placeholder, actual value set by DB
      },
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: getFieldIntSchemas<State>(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// FLOAT FIELD CLASS
// =============================================================================

export class FloatField<State extends FieldState<"float">> {
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): FloatField<
    UpdateState<
      State,
      { nullable: true; hasDefault: true; defaultValue: DefaultValue<null> }
    >
  > {
    return new FloatField(
      { ...this.state, nullable: true, hasDefault: true, defaultValue: null },
      this._nativeType
    );
  }

  array(): FloatField<UpdateState<State, { array: true }>> {
    return new FloatField({ ...this.state, array: true }, this._nativeType);
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
  ): FloatField<UpdateState<State, { hasDefault: true; defaultValue: V }>> {
    return new FloatField(
      {
        ...this.state,
        hasDefault: true,
        defaultValue: value,
      },
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<number>>(
    schema: S
  ): FloatField<
    UpdateState<State, { schema: S; base: StandardSchemaToSchema<S> }>
  > {
    return new FloatField(
      {
        ...this.state,
        schema: schema,
        base: schemaFromStandardSchema(this.state.base, schema),
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
      schemas: getFieldFloatSchemas<State>(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// DECIMAL FIELD CLASS
// =============================================================================

export class DecimalField<State extends FieldState<"decimal">> {
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): DecimalField<
    UpdateState<
      State,
      { nullable: true; hasDefault: true; defaultValue: DefaultValue<null> }
    >
  > {
    return new DecimalField(
      { ...this.state, nullable: true, hasDefault: true, defaultValue: null },
      this._nativeType
    );
  }

  array(): DecimalField<UpdateState<State, { array: true }>> {
    return new DecimalField({ ...this.state, array: true }, this._nativeType);
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
  ): DecimalField<UpdateState<State, { hasDefault: true; defaultValue: V }>> {
    return new DecimalField(
      {
        ...this.state,
        hasDefault: true,
        defaultValue: value,
      },
      this._nativeType
    );
  }

  schema<S extends StandardSchemaOf<number>>(
    schema: S
  ): DecimalField<
    UpdateState<State, { schema: S; base: StandardSchemaToSchema<S> }>
  > {
    return new DecimalField(
      {
        ...this.state,
        schema: schema,
        base: schemaFromStandardSchema(this.state.base, schema),
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
      schemas: getFieldDecimalSchemas<State>(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

export const int = (nativeType?: NativeType) =>
  new IntField(createDefaultState("int", intBase), nativeType);
export const float = (nativeType?: NativeType) =>
  new FloatField(createDefaultState("float", floatBase), nativeType);
export const decimal = (nativeType?: NativeType) =>
  new DecimalField(createDefaultState("decimal", decimalBase), nativeType);
