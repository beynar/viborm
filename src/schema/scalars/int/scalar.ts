import type { StandardSchemaV1 } from "@standard-schema/spec";
import v from "@validation/primitives/v";
import {
  createDefaultState,
  type DefaultValueInput,
  nullableDefault,
  type ScalarState,
  updateState,
} from "../common";
import { admitNativeType } from "../native-catalog";
import type {
  ExactNativeTypeMap,
  NativeDialect,
  NativeTypeArgument,
  NativeTypeDeclaration,
} from "../native-types";

const intBase = v.integer();

export class IntScalar<State extends ScalarState<"int">> {
  private readonly state: State;
  private readonly _nativeType?: NativeTypeDeclaration | undefined;

  constructor(state: State, _nativeType?: NativeTypeDeclaration) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new IntScalar(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: nullableDefault(this.state),
        optional: true,
        base: v.integer<{
          nullable: true;
          array: State["array"];
          schema: State["schema"];
        }>({
          nullable: true,
          array: this.state.array,
          schema: this.state.schema,
        }),
      }),
      this._nativeType
    );
  }

  array() {
    return new IntScalar(
      updateState(this, {
        array: true,
        base: v.integer<{
          nullable: State["nullable"];
          array: true;
          schema: State["schema"];
        }>({
          nullable: this.state.nullable,
          array: true,
          schema: this.state.schema,
        }),
      }),
      this._nativeType
    );
  }

  id() {
    return new IntScalar(
      updateState(this, { isId: true, isUnique: true }),
      this._nativeType
    );
  }

  unique() {
    return new IntScalar(
      updateState(this, { isUnique: true }),
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(value: V) {
    return new IntScalar(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  schema<S extends StandardSchemaV1<number>>(schema: S) {
    return new IntScalar(
      updateState(this, {
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
      }),
      this._nativeType
    );
  }

  map(columnName: string) {
    return new IntScalar(updateState(this, { columnName }), this._nativeType);
  }

  increment() {
    return new IntScalar(
      updateState(this, {
        hasDefault: true,
        autoGenerate: { kind: "increment" },
        default: undefined,
        disallowZero: true,
        optional: true,
      }),
      this._nativeType
    );
  }

  private _internal?: {
    state: State;
    nativeType: NativeTypeDeclaration | undefined;
  };

  get ["~"]() {
    return (this._internal ??= {
      state: this.state,
      nativeType: this._nativeType,
    });
  }
}

export const int = <
  Db extends NativeDialect = never,
  const Given extends ExactNativeTypeMap<Given> = never,
>(
  nativeType?: NativeTypeArgument<Db, Given>
) =>
  new IntScalar(
    createDefaultState("int", intBase),
    admitNativeType("s.int", nativeType)
  );
