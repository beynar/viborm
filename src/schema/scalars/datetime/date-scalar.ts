// Date Scalar
// Standalone scalar class with State generic pattern

import type { StandardSchemaV1 } from "@standard-schema/spec";
import v from "@validation/primitives/v";
import {
  createDefaultState,
  type DefaultValueInput,
  generatorDefault,
  nullableDefault,
  refuseListGenerator,
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
import { currentTemporalValue } from "./current";

const defaultNow = generatorDefault(() => currentTemporalValue("date"));
const defaultUpdatedAt = generatorDefault(() => currentTemporalValue("date"));
const dateBase = v.isoDate();

export class DateScalar<State extends ScalarState<"date">> {
  private readonly state: State;
  private readonly _nativeType?: NativeTypeDeclaration | undefined;

  constructor(state: State, _nativeType?: NativeTypeDeclaration) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new DateScalar(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: nullableDefault(this.state),
        optional: true,
        base: v.isoDate<{
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
    if (
      this.state.autoGenerate?.kind === "now" ||
      this.state.autoGenerate?.kind === "updatedAt"
    )
      refuseListGenerator("s.date");
    return new DateScalar(
      updateState(this, {
        array: true,
        base: v.isoDate<{
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
    return new DateScalar(
      updateState(this, { isId: true, isUnique: true }),
      this._nativeType
    );
  }

  unique() {
    return new DateScalar(
      updateState(this, { isUnique: true }),
      this._nativeType
    );
  }

  schema<S extends StandardSchemaV1<string>>(schema: S) {
    return new DateScalar(
      updateState(this, {
        schema,
        base: v.isoDate<{
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

  default<V extends DefaultValueInput<State>>(value: V) {
    return new DateScalar(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  /**
   * Maps this scalar to a custom column name in the database
   */
  map(columnName: string) {
    return new DateScalar(updateState(this, { columnName }), this._nativeType);
  }

  now() {
    if (this.state.array) refuseListGenerator("s.date");
    return new DateScalar(
      updateState(this, {
        hasDefault: true,
        autoGenerate: { kind: "now" },
        default: defaultNow,
        optional: true,
      }),
      this._nativeType
    );
  }

  updatedAt() {
    if (this.state.array) refuseListGenerator("s.date");
    return new DateScalar(
      updateState(this, {
        hasDefault: true,
        autoGenerate: { kind: "updatedAt" },
        default: defaultUpdatedAt,
        optional: true,
      }),
      this._nativeType
    );
  }

  get ["~"]() {
    return {
      state: this.state,
      nativeType: this._nativeType,
    };
  }
}

export const date = <
  Db extends NativeDialect = never,
  const Given extends ExactNativeTypeMap<Given> = never,
>(
  nativeType?: NativeTypeArgument<Db, Given>
) =>
  new DateScalar(
    createDefaultState("date", dateBase),
    admitNativeType("s.date", nativeType)
  );
