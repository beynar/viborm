// Enum Field
// Standalone field class with State generic pattern
import {
  type FieldState,
  type DefaultValue,
  type SchemaNames,
  createDefaultState,
  DefaultValueInput,
  UpdateState,
} from "../common";
import type { NativeType } from "../native-types";
import { buildEnumSchema, EnumSchemas } from "./schemas";
import v, {
  BaseEnumSchema,
  InferInput,
  InferOutput,
  Prettify,
} from "@validation";
import { AnyEnumSchema } from "@validation/schemas/enum";

export class EnumField<
  Values extends string[],
  State extends FieldState<"enum"> = FieldState<"enum">
> {
  private _names: SchemaNames = {};
  private _schemas: EnumSchemas<Values, State> | undefined;

  constructor(
    public values: Values,
    private state: State,
    private _nativeType?: NativeType
  ) {}

  nullable(): EnumField<
    Values,
    UpdateState<
      State,
      {
        nullable: true;
        hasDefault: true;
        default: DefaultValue<null>;
        optional: true;
        base: BaseEnumSchema<
          Values,
          {
            nullable: true;
            array: State["array"];
          }
        >;
      }
    >
  > {
    return new EnumField(
      this.values,
      {
        ...this.state,
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.enum<
          Values,
          {
            nullable: true;
            array: State["array"];
          }
        >(this.values, {
          nullable: true,
          array: this.state.array,
        }),
      },
      this._nativeType
    );
  }

  array(): EnumField<
    Values,
    UpdateState<
      State,
      {
        array: true;
        base: BaseEnumSchema<
          Values,
          {
            nullable: State["nullable"];
            array: true;
          }
        >;
      }
    >
  > {
    return new EnumField(
      this.values,
      {
        ...this.state,
        array: true,
        base: v.enum<
          Values,
          {
            nullable: State["nullable"];
            array: true;
          }
        >(this.values, {
          nullable: this.state.nullable,
          array: true,
        }),
      },
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(
    value: V
  ): EnumField<
    Values,
    UpdateState<State, { hasDefault: true; default: V; optional: true }>
  > {
    return new EnumField(
      this.values,
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
    return new EnumField(
      this.values,
      { ...this.state, columnName },
      this._nativeType
    ) as this;
  }

  get ["~"]() {
    return {
      state: this.state,
      schemas: (this._schemas ??= buildEnumSchema(this.values, this.state)),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

export const enumField = <const T extends string[]>(
  values: T,
  nativeType?: NativeType
) => {
  const base = v.enum(values);
  return new EnumField(values, createDefaultState("enum", base), nativeType);
};
