// Point Field
// Standalone field class with State generic pattern

import v, { type BasePointSchema } from "@validation";
import {
  createDefaultState,
  type DefaultValue,
  type DefaultValueInput,
  type FieldState,
  type UpdateState,
} from "../common";
import type { NativeType } from "../native-types";
import { buildPointSchema, type PointSchemas, pointBase } from "./schemas";

export class PointField<State extends FieldState<"point">> {
  private _schemas: PointSchemas<State> | undefined;
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;
  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

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
    };
  }
}

export const point = (nativeType?: NativeType) =>
  new PointField(createDefaultState("point", pointBase), nativeType);
