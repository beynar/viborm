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
import { buildVectorSchema, vectorBase, VectorSchemas } from "./schemas";
import v, { BaseVectorSchema } from "@validation";

export class VectorField<State extends FieldState<"vector">> {
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};
  private _schemas: VectorSchemas<State> | undefined;

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

  dimension(dim: number): VectorField<State & { dimension: number }> {
    return new VectorField(
      {
        ...this.state,
        dimension: dim,
      } as State & { dimension: number },
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildVectorSchema(this.state)),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

export const vector = (nativeType?: NativeType) =>
  new VectorField(createDefaultState("vector", vectorBase), nativeType);
