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
} from "../../../validation";
import { AnyEnumSchema } from "../../../validation/schemas/enum";

// =============================================================================
// ENUM FIELD CLASS
// =============================================================================

export class EnumField<
  Values extends string[],
  State extends FieldState<"enum"> = FieldState<"enum">
> {
  private _names: SchemaNames = {};

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

  // ===========================================================================
  // ACCESSORS
  // ===========================================================================

  #cached_schemas:
    | ReturnType<typeof buildEnumSchema<Values, State>>
    | undefined;

  get ["~"]() {
    return {
      state: this.state,
      schemas: buildEnumSchema(this.values, this.state),
      nativeType: this._nativeType,
      names: this._names,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

export const enumField = <const T extends string[]>(
  values: T,
  nativeType?: NativeType
) => {
  const base = v.enum(values);
  return new EnumField(values, createDefaultState("enum", base), nativeType);
};

const test = enumField(["a", "b", "c"]).nullable();

const base = test["~"].schemas.base;

type In = (typeof base)[" vibInferred"]["0"];

const e = v.enum(["a", "b", "c"]);
const s = v.string();
type In2 = Prettify<InferInput<typeof e>>;
type In3 = Prettify<InferInput<typeof s>>;
type Test = typeof e extends AnyEnumSchema ? true : false;
type Test2 = typeof e extends BaseEnumSchema<["a", "b", "c"], any>
  ? true
  : false;

type Test3 = typeof base extends BaseEnumSchema<["a", "b", "c"], any>
  ? true
  : false;
type Test4 = typeof base extends AnyEnumSchema ? true : false;
