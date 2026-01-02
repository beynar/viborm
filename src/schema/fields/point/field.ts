// Point Field
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
import { buildPointSchema, pointBase, PointSchemas } from "./schemas";
import v, { BasePointSchema } from "@validation";

export class PointField<State extends FieldState<"point">> {
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};
  private _schemas: PointSchemas<State> | undefined;

  constructor(private state: State, private _nativeType?: NativeType) {}

  nullable(): PointField<
    UpdateState<
      State,
      {
        nullable: true;
        hasDefault: true;
        default: DefaultValue<null>;
        optional: true;
        base: BasePointSchema<{
          nullable: true;
        }>;
      }
    >
  > {
    return new PointField(
      {
        ...this.state,
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.point<{
          nullable: true;
        }>({
          nullable: true,
        }),
      },
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(
    value: V
  ): PointField<
    UpdateState<State, { hasDefault: true; default: V; optional: true }>
  > {
    return new PointField(
      {
        ...this.state,
        hasDefault: true,
        default: value,
        optional: true,
      },
      this._nativeType
    );
  }

  map(columnName: string): this {
    return new PointField(
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildPointSchema(this.state)),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

export const point = (nativeType?: NativeType) =>
  new PointField(createDefaultState("point", pointBase), nativeType);
