// Number Fields (int, float, decimal)
// Lean field classes delegating schema selection to schema factories

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
} from "../common";
import type { NativeType } from "../native-types";
import {
  getFieldIntSchemas,
  getFieldFloatSchemas,
  getFieldDecimalSchemas,
} from "./schemas";

// =============================================================================
// INT FIELD CLASS
// =============================================================================

export class IntField<State extends FieldState<"int">> {
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): IntField<UpdateState<State, { nullable: true }>> {
    return new IntField({ ...this.state, nullable: true }, this._nativeType);
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

  default(
    value: DefaultValue<number, State["array"], State["nullable"]>
  ): IntField<UpdateState<State, { hasDefault: true }>> {
    return new IntField(
      {
        ...this.state,
        hasDefault: true,
        defaultValue: value,
      },
      this._nativeType
    );
  }

  schema(
    schema: StandardSchemaV1
  ): IntField<UpdateState<State, { schema: StandardSchemaV1 }>> {
    return new IntField(
      {
        ...this.state,
        schema: schema,
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
    UpdateState<State, { hasDefault: true; autoGenerate: "increment" }>
  > {
    return new IntField(
      {
        ...this.state,
        hasDefault: true,
        autoGenerate: "increment",
      },
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: getFieldIntSchemas(this.state),
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

  nullable(): FloatField<UpdateState<State, { nullable: true }>> {
    return new FloatField({ ...this.state, nullable: true }, this._nativeType);
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

  default(
    value: DefaultValue<number, State["array"], State["nullable"]>
  ): FloatField<UpdateState<State, { hasDefault: true }>> {
    return new FloatField(
      {
        ...this.state,
        hasDefault: true,
        defaultValue: value,
      },
      this._nativeType
    );
  }

  schema(
    schema: StandardSchemaV1
  ): FloatField<UpdateState<State, { schema: StandardSchemaV1 }>> {
    return new FloatField(
      {
        ...this.state,
        schema: schema,
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
      schemas: getFieldFloatSchemas(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// DECIMAL FIELD CLASS (reuses float schemas)
// =============================================================================

export class DecimalField<State extends FieldState<"decimal">> {
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): DecimalField<UpdateState<State, { nullable: true }>> {
    return new DecimalField(
      { ...this.state, nullable: true },
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

  default(
    value: DefaultValue<number, State["array"], State["nullable"]>
  ): DecimalField<UpdateState<State, { hasDefault: true }>> {
    return new DecimalField(
      {
        ...this.state,
        hasDefault: true,
        defaultValue: value,
      },
      this._nativeType
    );
  }

  schema(
    schema: StandardSchemaV1
  ): DecimalField<UpdateState<State, { schema: StandardSchemaV1 }>> {
    return new DecimalField(
      {
        ...this.state,
        schema: schema,
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
      schemas: getFieldDecimalSchemas(this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

export const int = (nativeType?: NativeType) =>
  new IntField(createDefaultState("int"), nativeType);
export const float = (nativeType?: NativeType) =>
  new FloatField(createDefaultState("float"), nativeType);
export const decimal = (nativeType?: NativeType) =>
  new DecimalField(createDefaultState("decimal"), nativeType);
