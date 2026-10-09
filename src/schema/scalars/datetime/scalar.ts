// DateTime Scalar
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

const defaultNow = generatorDefault(() => currentTemporalValue("datetime"));
const defaultUpdatedAt = generatorDefault(() =>
  currentTemporalValue("datetime")
);
const datetimeBase = v.isoTimestamp();

export class DateTimeScalar<State extends ScalarState<"datetime">> {
  private readonly state: State;
  private readonly _nativeType?: NativeTypeDeclaration | undefined;
  constructor(state: State, _nativeType?: NativeTypeDeclaration) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new DateTimeScalar(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: nullableDefault(this.state),
        optional: true,
        base: v.isoTimestamp<{
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
      refuseListGenerator("s.dateTime");
    return new DateTimeScalar(
      updateState(this, {
        array: true,
        base: v.isoTimestamp<{
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
    return new DateTimeScalar(
      updateState(this, { isId: true, isUnique: true }),
      this._nativeType
    );
  }

  unique() {
    return new DateTimeScalar(
      updateState(this, { isUnique: true }),
      this._nativeType
    );
  }

  schema<S extends StandardSchemaV1<string>>(schema: S) {
    return new DateTimeScalar(
      updateState(this, {
        schema,
        base: v.isoTimestamp<{
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
    return new DateTimeScalar(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  map(columnName: string) {
    return new DateTimeScalar(
      updateState(this, { columnName }),
      this._nativeType
    );
  }

  now() {
    if (this.state.array) refuseListGenerator("s.dateTime");
    return new DateTimeScalar(
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
    if (this.state.array) refuseListGenerator("s.dateTime");
    return new DateTimeScalar(
      updateState(this, {
        hasDefault: true,
        autoGenerate: { kind: "updatedAt" },
        default: defaultUpdatedAt,
        optional: true,
      }),
      this._nativeType
    );
  }

  withoutTimezone() {
    return new DateTimeScalar(
      updateState(this, { withTimezone: false }),
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

export const dateTime = <
  Db extends NativeDialect = never,
  const Given extends ExactNativeTypeMap<Given> = never,
>(
  nativeType?: NativeTypeArgument<Db, Given>
) =>
  new DateTimeScalar(
    { ...createDefaultState("datetime", datetimeBase), withTimezone: true },
    admitNativeType("s.dateTime", nativeType)
  );
