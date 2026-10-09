// String Scalar
// Standalone scalar class with State generic pattern

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { hasIdPrefix, refuseId } from "@validation/primitives/id-formats";
import v from "@validation/primitives/v";
import {
  type AutoGenerate,
  createDefaultState,
  type DefaultValueInput,
  type GeneratorDefaultBrand,
  generatorDefault,
  isGeneratorDefault,
  nullableDefault,
  refuseListGenerator,
  type ScalarState,
  type UpdateState,
  updateState,
} from "../common";
import { admitNativeType } from "../native-catalog";
import type {
  ExactNativeTypeMap,
  NativeDialect,
  NativeTypeArgument,
  NativeTypeDeclaration,
} from "../native-types";
import {
  defaultCuid,
  defaultKsuid,
  defaultNanoid,
  defaultUlid,
  defaultUuid,
  defaultUuidV7,
} from "./autogenerate";

interface FormatOptions {
  prefix?: string;
  generate?: true;
}
interface NanoidOptions extends FormatOptions {
  length?: number;
}
interface KeyOptions {
  generate: false;
  prefix?: string;
}
type IdentifierKind = "uuid" | "uuidv7" | "ulid" | "ksuid" | "nanoid" | "cuid";
type ExactOptions<Given, Allowed> = Given extends string | number | undefined
  ? unknown
  : Record<Exclude<keyof Given, keyof Allowed>, never>;
type GenerationRequested<
  State extends ScalarState<"string">,
  Given,
> = Given extends { generate: true }
  ? true
  : Given extends { generate: false }
    ? false
    : State["autoGenerate"] extends { generate: false }
      ? false
      : State["autoGenerate"] extends { generate: true }
        ? true
        : State["isId"];
type GenerationChoice<
  State extends ScalarState<"string">,
  Given,
> = Given extends { generate: true }
  ? true
  : Given extends { generate: false }
    ? false
    : State["autoGenerate"] extends {
          generate: infer Choice extends boolean | undefined;
        }
      ? Choice
      : undefined;
type HasCustomDefault<State extends ScalarState<"string">> =
  State["default"] extends GeneratorDefaultBrand ? false : State["hasDefault"];
type FormatState<
  State extends ScalarState<"string">,
  Given,
  Kind extends IdentifierKind = IdentifierKind,
> = {
  autoGenerate: AutoGenerate & {
    kind: Kind;
    implicit?: undefined;
    generate: GenerationChoice<State, Given>;
  };
  hasDefault: HasCustomDefault<State> extends true
    ? true
    : GenerationRequested<State, Given>;
  optional: HasCustomDefault<State> extends true
    ? true
    : GenerationRequested<State, Given>;
  default: HasCustomDefault<State> extends true
    ? State["default"]
    : GenerationRequested<State, Given> extends true
      ? (() => string) & GeneratorDefaultBrand
      : undefined;
};
type KeyState<State extends ScalarState<"string">, Given> = Omit<
  FormatState<UpdateState<State, { isId: true }>, Given>,
  "autoGenerate"
> & {
  isId: true;
  isUnique: true;
  autoGenerate: State["autoGenerate"] extends AutoGenerate
    ? Omit<State["autoGenerate"], "generate"> & {
        generate: GenerationChoice<State, Given>;
      }
    : {
        kind: "ulid";
        implicit: true;
        prefix?: string;
        generate: GenerationChoice<State, Given>;
      };
};

function identifierGenerator(declaration: AutoGenerate): () => string {
  const { kind, prefix, length } = declaration;
  switch (kind) {
    case "uuid":
      return defaultUuid(prefix);
    case "uuidv7":
      return defaultUuidV7(prefix);
    case "ulid":
      return defaultUlid(prefix);
    case "ksuid":
      return defaultKsuid(prefix);
    case "nanoid":
      return defaultNanoid(length, prefix);
    case "cuid":
      return defaultCuid(prefix);
    default:
      return refuseId(
        "s.string",
        "generate",
        "This generator is not a string identifier format"
      );
  }
}

const stringBase = v.string();

export class StringScalar<State extends ScalarState<"string">> {
  private readonly state: State;
  private readonly _nativeType?: NativeTypeDeclaration | undefined;

  constructor(state: State, _nativeType?: NativeTypeDeclaration) {
    this.state = state;
    this._nativeType = _nativeType;
  }

  nullable() {
    return new StringScalar(
      updateState(this, {
        nullable: true,
        hasDefault: true,
        default: nullableDefault(this.state),
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
    if (isGeneratorDefault(this.state.default)) refuseListGenerator("s.string");
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

  id<const Given extends string | KeyOptions | undefined = undefined>(
    options?: Given & ExactOptions<Given, KeyOptions>
  ): StringScalar<UpdateState<State, KeyState<State, Given>>>;
  id(options?: string | KeyOptions): StringScalar<ScalarState<"string">> {
    const generate = typeof options === "object" ? options.generate : undefined;
    const prefix = typeof options === "string" ? options : options?.prefix;
    const declared = this.state.autoGenerate;
    if (declared && hasIdPrefix(prefix)) refuseSecondIdPrefix(declared);
    const declaration: AutoGenerate = declared
      ? { ...declared, generate: generate ?? declared.generate }
      : { kind: "ulid", prefix, implicit: true, generate };
    return this.withIdentifier(declaration, true);
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

  uuid<const Given extends string | FormatOptions | undefined = undefined>(
    options?: Given & ExactOptions<Given, FormatOptions>
  ): StringScalar<UpdateState<State, FormatState<State, Given, "uuid">>>;
  uuid(options?: string | FormatOptions): StringScalar<ScalarState<"string">> {
    return this.withFormat("uuid", options);
  }

  uuidv7<const Given extends string | FormatOptions | undefined = undefined>(
    options?: Given & ExactOptions<Given, FormatOptions>
  ): StringScalar<UpdateState<State, FormatState<State, Given, "uuidv7">>>;
  uuidv7(
    options?: string | FormatOptions
  ): StringScalar<ScalarState<"string">> {
    return this.withFormat("uuidv7", options);
  }

  ksuid<const Given extends string | FormatOptions | undefined = undefined>(
    options?: Given & ExactOptions<Given, FormatOptions>
  ): StringScalar<UpdateState<State, FormatState<State, Given, "ksuid">>>;
  ksuid(options?: string | FormatOptions): StringScalar<ScalarState<"string">> {
    return this.withFormat("ksuid", options);
  }

  ulid<const Given extends string | FormatOptions | undefined = undefined>(
    options?: Given & ExactOptions<Given, FormatOptions>
  ): StringScalar<UpdateState<State, FormatState<State, Given, "ulid">>>;
  ulid(options?: string | FormatOptions): StringScalar<ScalarState<"string">> {
    return this.withFormat("ulid", options);
  }

  cuid<const Given extends string | FormatOptions | undefined = undefined>(
    options?: Given & ExactOptions<Given, FormatOptions>
  ): StringScalar<UpdateState<State, FormatState<State, Given, "cuid">>>;
  cuid(options?: string | FormatOptions): StringScalar<ScalarState<"string">> {
    return this.withFormat("cuid", options);
  }

  nanoid<const Given extends number | NanoidOptions | undefined = undefined>(
    options?: Given & ExactOptions<Given, NanoidOptions>,
    prefix?: string
  ): StringScalar<UpdateState<State, FormatState<State, Given, "nanoid">>>;
  nanoid(
    options?: number | NanoidOptions,
    prefix?: string
  ): StringScalar<ScalarState<"string">> {
    return this.withFormat(
      "nanoid",
      typeof options === "number"
        ? { length: options, prefix }
        : (options ?? { prefix })
    );
  }

  private withFormat(kind: IdentifierKind, options?: string | NanoidOptions) {
    const configuration: NanoidOptions | undefined =
      typeof options === "string" ? { prefix: options } : options;
    return this.withIdentifier(
      {
        kind,
        prefix: configuration?.prefix,
        length: kind === "nanoid" ? configuration?.length : undefined,
        generate: configuration?.generate ?? this.state.autoGenerate?.generate,
      },
      this.state.isId
    );
  }

  private withIdentifier(declaration: AutoGenerate, isId: boolean) {
    const generator = identifierGenerator(declaration);
    const customDefault =
      this.state.hasDefault && !isGeneratorDefault(this.state.default);
    const generate =
      declaration.generate === true || (isId && declaration.generate !== false);
    const installed = generate && !customDefault;
    if (this.state.array && installed) refuseListGenerator("s.string");
    return new StringScalar(
      updateState(this, {
        isId,
        isUnique: isId || this.state.isUnique,
        autoGenerate: declaration,
        hasDefault: customDefault || installed,
        optional: customDefault || installed,
        default: installed
          ? generatorDefault(generator)
          : customDefault
            ? this.state.default
            : undefined,
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

export const string = <
  Db extends NativeDialect = never,
  const Given extends ExactNativeTypeMap<Given> = never,
>(
  nativeType?: NativeTypeArgument<Db, Given>
) => {
  return new StringScalar(
    createDefaultState("string", stringBase),
    admitNativeType("s.string", nativeType)
  );
};

function refuseSecondIdPrefix(declared: {
  readonly kind: string;
  readonly prefix?: string | undefined;
}): never {
  return refuseId(
    "s.string().id",
    "prefix",
    `This field already declares a '${declared.kind}' generator${declared.prefix ? ` with the prefix '${declared.prefix}'` : ""}. A prefix is spelled once, on the call that declares the format`
  );
}
