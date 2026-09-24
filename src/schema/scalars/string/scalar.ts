// String Scalar
// Standalone scalar class with State generic pattern

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { hasIdPrefix, refuseId } from "@validation/primitives/id-formats";
import v from "@validation/primitives/v";
import {
  createDefaultState,
  type DefaultValueInput,
  generatorDefault,
  type ScalarState,
  updateState,
} from "../common";
import type { NativeType } from "../native-types";
import {
  defaultCuid,
  defaultKsuid,
  defaultNanoid,
  defaultUlid,
  defaultUuid,
  defaultUuidV7,
} from "./autogenerate";

const stringBase = v.string();

export class StringScalar<State extends ScalarState<"string">> {
  private readonly state: State;
  private readonly _nativeType?: NativeType | undefined;

  constructor(state: State, _nativeType?: NativeType) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new StringScalar(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: null,
        optional: true,
        base: v.string<{
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
    return new StringScalar(
      updateState(this, {
        array: true,
        base: v.string<{
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

  /**
   * Marks this field as the model's primary key, and — only when no generator
   * has been declared yet — installs a ULID.
   *
   * `.id()` is a KEY declaration that carries a convenience default, not a
   * generator of its own, so it never replaces one the caller already spelled:
   * `.uuid("a").id()` is a prefixed UUID primary key, exactly like
   * `.id().uuid("a")`. A PREFIX passed after a generator is refused instead of
   * silently winning or silently losing — `.uuid("a").id("b")` names two
   * prefixes for one field and only its author knows which was meant. What
   * counts as a prefix is `hasIdPrefix`'s answer, here as everywhere: `.id("")`
   * names none, so it contradicts nothing and is a plain key declaration.
   *
   * `hasDefault` is part of the declaration: a field whose id the runtime
   * generates must be optional in the create TYPE too.
   */
  id(prefix?: string) {
    const declared = this.state.autoGenerate;
    if (declared !== undefined) {
      if (hasIdPrefix(prefix)) {
        refuseId(
          "s.string().id",
          "prefix",
          `This field already declares a '${declared.kind}' generator${declared.prefix ? ` with the prefix '${declared.prefix}'` : ""}. A prefix is spelled once, on the call that declares the format`
        );
      }
      return new StringScalar(
        updateState(this, {
          isId: true,
          isUnique: true,
          hasDefault: true,
          optional: true,
        }),
        this._nativeType
      );
    }
    return new StringScalar(
      updateState(this, {
        isId: true,
        isUnique: true,
        hasDefault: true,
        autoGenerate: { kind: "ulid", prefix, implicit: true },
        default: generatorDefault(defaultUlid(prefix)),
        optional: true,
      }),
      this._nativeType
    );
  }

  unique() {
    return new StringScalar(
      updateState(this, {
        isUnique: true,
      }),
      this._nativeType
    );
  }

  default<V extends DefaultValueInput<State>>(value: V) {
    return new StringScalar(
      updateState(this, {
        hasDefault: true,
        default: value,
        optional: true,
      }),
      this._nativeType
    );
  }

  schema<S extends StandardSchemaV1<string>>(schema: S) {
    return new StringScalar(
      updateState(this, {
        schema,
        base: v.string<{
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

  /**
   * Maps this scalar to a custom column name in the database
   */
  map(columnName: string) {
    return new StringScalar(
      updateState(this, { columnName }),
      this._nativeType
    );
  }

  uuid(prefix?: string) {
    return new StringScalar(
      updateState(this, {
        hasDefault: true,
        default: generatorDefault(defaultUuid(prefix)),
        autoGenerate: { kind: "uuid", prefix },
        optional: true,
      }),
      this._nativeType
    );
  }

  uuidv7(prefix?: string) {
    return new StringScalar(
      updateState(this, {
        hasDefault: true,
        default: generatorDefault(defaultUuidV7(prefix)),
        autoGenerate: { kind: "uuidv7", prefix },
        optional: true,
      }),
      this._nativeType
    );
  }

  ksuid(prefix?: string) {
    return new StringScalar(
      updateState(this, {
        hasDefault: true,
        default: generatorDefault(defaultKsuid(prefix)),
        autoGenerate: { kind: "ksuid", prefix },
        optional: true,
      }),
      this._nativeType
    );
  }

  ulid(prefix?: string) {
    return new StringScalar(
      updateState(this, {
        hasDefault: true,
        default: generatorDefault(defaultUlid(prefix)),
        autoGenerate: { kind: "ulid", prefix },
        optional: true,
      }),
      this._nativeType
    );
  }

  nanoid(length?: number, prefix?: string) {
    return new StringScalar(
      updateState(this, {
        hasDefault: true,
        default: generatorDefault(defaultNanoid(length, prefix)),
        autoGenerate: { kind: "nanoid", prefix, length },
        optional: true,
      }),
      this._nativeType
    );
  }

  cuid(prefix?: string) {
    return new StringScalar(
      updateState(this, {
        hasDefault: true,
        default: generatorDefault(defaultCuid(prefix)),
        autoGenerate: { kind: "cuid", prefix },
        optional: true,
      }),
      this._nativeType
    );
  }

  private _internal?: { state: State; nativeType: NativeType | undefined };

  get ["~"]() {
    return (this._internal ??= {
      state: this.state,
      nativeType: this._nativeType,
    });
  }
}

export const string = (nativeType?: NativeType) => {
  return new StringScalar(createDefaultState("string", stringBase), nativeType);
};
