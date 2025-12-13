// Vector Field
// Standalone field class with State generic pattern

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
} from "../common";
import type { NativeType } from "../native-types";
import * as schemas from "./schemas";

// =============================================================================
// VECTOR FIELD STATE (extends base with dimension)
// =============================================================================

interface VectorFieldState extends FieldState<"vector"> {
  dimension?: number;
}

// =============================================================================
// VECTOR FIELD SCHEMA TYPE DERIVATION
// =============================================================================

type VectorFieldSchemas<State extends VectorFieldState> = {
  base: State["nullable"] extends true
    ? typeof schemas.vectorNullable
    : typeof schemas.vectorBase;

  filter: State["nullable"] extends true
    ? typeof schemas.vectorNullableFilter
    : typeof schemas.vectorFilter;

  create: State["hasDefault"] extends true
    ? State["nullable"] extends true
      ? typeof schemas.vectorOptionalNullableCreate
      : typeof schemas.vectorOptionalCreate
    : State["nullable"] extends true
    ? typeof schemas.vectorNullableCreate
    : typeof schemas.vectorCreate;

  update: State["nullable"] extends true
    ? typeof schemas.vectorNullableUpdate
    : typeof schemas.vectorUpdate;
};

// =============================================================================
// VECTOR FIELD CLASS
// =============================================================================

export class VectorField<State extends VectorFieldState = VectorFieldState> {
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  // ===========================================================================
  // CHAINABLE MODIFIERS
  // ===========================================================================

  nullable(): VectorField<
    UpdateState<State, { nullable: true }> & VectorFieldState
  > {
    return new VectorField({
      ...this.state,
      nullable: true,
    } as UpdateState<State, { nullable: true }> & VectorFieldState);
  }

  default(
    value: DefaultValue<number[], false, State["nullable"]>
  ): VectorField<UpdateState<State, { hasDefault: true }> & VectorFieldState> {
    return new VectorField({
      ...this.state,
      hasDefault: true,
      defaultValue: value,
    } as UpdateState<State, { hasDefault: true }> & VectorFieldState);
  }

  schema(
    schema: StandardSchemaV1
  ): VectorField<
    UpdateState<State, { schema: StandardSchemaV1 }> & VectorFieldState
  > {
    return new VectorField({
      ...this.state,
      schema: schema,
    } as UpdateState<State, { schema: StandardSchemaV1 }> & VectorFieldState);
  }

  /**
   * Maps this field to a custom column name in the database
   */
  map(columnName: string): this {
    return new VectorField({ ...this.state, columnName }) as this;
  }

  // ===========================================================================
  // VECTOR-SPECIFIC METHODS
  // ===========================================================================

  dimension(dim: number): VectorField<State & { dimension: number }> {
    return new VectorField({
      ...this.state,
      dimension: dim,
    } as State & { dimension: number });
  }

  // Vector fields don't support array(), id(), or unique()
  array(): never {
    throw new Error(
      "Vector fields are already arrays - use dimension() to set size"
    );
  }

  id(): never {
    throw new Error("Vector fields cannot be used as IDs");
  }

  unique(): never {
    throw new Error("Vector fields cannot be unique");
  }

  // ===========================================================================
  // SCHEMA GETTER
  // ===========================================================================

  get schemas(): VectorFieldSchemas<State> {
    const { nullable, hasDefault } = this.state;

    const base = nullable ? schemas.vectorNullable : schemas.vectorBase;

    const filter = nullable
      ? schemas.vectorNullableFilter
      : schemas.vectorFilter;

    const create = hasDefault
      ? nullable
        ? schemas.vectorOptionalNullableCreate
        : schemas.vectorOptionalCreate
      : nullable
      ? schemas.vectorNullableCreate
      : schemas.vectorCreate;

    const update = nullable
      ? schemas.vectorNullableUpdate
      : schemas.vectorUpdate;

    return { base, filter, create, update } as VectorFieldSchemas<State>;
  }

  // ===========================================================================
  // ACCESSORS
  // ===========================================================================

  get ["~"]() {
    return {
      state: this.state,
      schemas: this.schemas,
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

export const vector = (dimension?: number, nativeType?: NativeType) => {
  const state: VectorFieldState = createDefaultState("vector");
  if (dimension !== undefined) {
    state.dimension = dimension;
  }
  return new VectorField(state, nativeType);
};
