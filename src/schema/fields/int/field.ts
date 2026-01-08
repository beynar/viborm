import type { StandardSchemaOf } from "@standard-schema/spec";
import v, { type BaseIntegerSchema } from "@validation";
import {
  createDefaultState,
  type DefaultValue,
  type DefaultValueInput,
  type FieldState,
  type UpdateState,
} from "../common";
import type { NativeType } from "../native-types";
import { buildIntSchema, type IntSchemas, intBase } from "./schemas";

export class IntField<State extends FieldState<"int">> {
  private _schemas: IntSchemas<State> | undefined;
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;

  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

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
        schema,
        base: v.integer<{
          nullable: State["nullable"];
          array: State["array"];
          schema: S;
        }>({
          nullable: this.state.nullable,
          array: this.state.array,
          schema,
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
        default: 0,
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
    };
  }
}

export const int = (nativeType?: NativeType) =>
  new IntField(createDefaultState("int", intBase), nativeType);
