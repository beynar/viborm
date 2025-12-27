// Vector Field
// Standalone field class with State generic pattern

import {
  type FieldState,
  type UpdateState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
  DefaultValueInput,
} from "../common";
import type { NativeType } from "../native-types";
import { buildVectorSchema, vectorBase } from "./schemas";
import v, { BaseVectorSchema } from "../../../validation";

// =============================================================================
// VECTOR FIELD CLASS
// =============================================================================

export class VectorField<State extends FieldState<"vector">> {
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): VectorField<
    UpdateState<
      State,
      {
        nullable: true;
        hasDefault: true;
        default: DefaultValue<null>;
        optional: true;
        base: BaseVectorSchema<{
          nullable: true;
        }>;
      }
    >
  > {
    return new VectorField(
      {
        ...this.state,
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.vector<{
          nullable: true;
        }>(undefined, {
          nullable: true,
        }),
      },
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(
    value: V
  ): VectorField<
    UpdateState<State, { hasDefault: true; default: V; optional: true }>
  > {
    return new VectorField(
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
    return new VectorField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  // ===========================================================================
  // VECTOR-SPECIFIC METHODS
  // ===========================================================================

  dimension(dim: number): VectorField<State & { dimension: number }> {
    return new VectorField(
      {
        ...this.state,
        dimension: dim,
      } as State & { dimension: number },
      this._nativeType
    );
  }

  // ===========================================================================
  // ACCESSORS
  // ===========================================================================

  #cached_schemas: ReturnType<typeof buildVectorSchema<State>> | undefined;

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this.#cached_schemas ??= buildVectorSchema(this.state)),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

export const vector = (nativeType?: NativeType) =>
  new VectorField(createDefaultState("vector", vectorBase), nativeType);
