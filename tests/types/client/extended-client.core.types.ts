/** Public probes for naming a client after an ordered extension chain. */

import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/exports";
import {
  type ExtendedClient as ClientSubpathExtendedClient,
  defaultOmit,
} from "@src/client/exports";
import { PGliteDriver } from "@src/drivers/pglite";
import {
  createClient,
  type ExtendedClient,
  extension,
  methods as extMethods,
  parts,
  s,
} from "@src/index";
import { instrumentation } from "@src/instrumentation/exports";
import { expectTypeOf } from "vitest";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  passwordHash: s.string(),
});
const schema = { user };
const baseClient = () => createClient({ schema, driver: new PGliteDriver() });
type BaseClient = ReturnType<typeof baseClient>;

const cached = cache({ driver: new MemoryCache() });
const observed = instrumentation({ logging: { query: true } });
const methods = extension(
  "application-methods",
  extMethods(() => ({
    $ping: () => "pong" as const,
    user: { $label: (name: string) => `user:${name}` },
  }))
);
const applicationExtensions = [cached, observed, methods] as const;

type ApplicationClient = ExtendedClient<
  BaseClient,
  typeof applicationExtensions
>;
type ApplicationClientFromSubpath = ClientSubpathExtendedClient<
  BaseClient,
  typeof applicationExtensions
>;

type _clientSubpathMatchesRoot = Expect<
  Equal<ApplicationClientFromSubpath, ApplicationClient>
>;
type _emptyTupleKeepsTheBase = Expect<
  Equal<ExtendedClient<BaseClient, readonly []>, BaseClient>
>;

const _applicationSurface = (applicationClient: ApplicationClient) => {
  applicationClient.$withCache();
  applicationClient.user.create({
    data: { id: "u1", name: "Ada", passwordHash: "secret" },
    cache: { autoInvalidate: true },
  });
  expectTypeOf(applicationClient.$ping()).toEqualTypeOf<"pong">();
  expectTypeOf(applicationClient.user.$label("Ada")).toEqualTypeOf<string>();
};

const moreMethods = extension(
  "more-methods",
  extMethods(() => ({ $answer: () => 42 as const }))
);
type FurtherExtendedClient = ExtendedClient<
  ApplicationClient,
  readonly [typeof moreMethods]
>;

const hidden = defaultOmit({
  user: { passwordHash: true },
});
type OmittedClient = ExtendedClient<
  BaseClient,
  readonly [typeof hidden, typeof cached]
>;

const _omittedResult = async (client: OmittedClient) => {
  const row = await client.user.findUnique({ where: { id: "u1" } });
  expectTypeOf(row).toEqualTypeOf<{
    id: string;
    name: string;
  } | null>();
};

const schemaBound = parts<typeof schema>().extension(
  "schema-bound",
  extMethods(() => ({ user: { $schemaLabel: () => "schema" as const } }))
);
type SchemaBoundClient = ExtendedClient<
  BaseClient,
  readonly [typeof schemaBound]
>;
const _schemaBoundSurface = (client: SchemaBoundClient) => {
  expectTypeOf(client.user.$schemaLabel()).toEqualTypeOf<"schema">();
};

const tail1 = extension("tail-1");
const tail2 = extension("tail-2");
const tail3 = extension("tail-3");
const tail4 = extension("tail-4");
const tail5 = extension("tail-5");
const tail6 = extension("tail-6");
const tail7 = extension("tail-7");
const tail8 = extension("tail-8");
const tail9 = extension("tail-9");
type FiveExtensionClient = ExtendedClient<
  BaseClient,
  readonly [
    typeof methods,
    typeof tail1,
    typeof tail2,
    typeof tail3,
    typeof tail4,
  ]
>;
type TenExtensionClient = ExtendedClient<
  BaseClient,
  readonly [
    typeof methods,
    typeof tail1,
    typeof tail2,
    typeof tail3,
    typeof tail4,
    typeof tail5,
    typeof tail6,
    typeof tail7,
    typeof tail8,
    typeof tail9,
  ]
>;
const _longChainSurfaces = (
  five: FiveExtensionClient,
  ten: TenExtensionClient
) => {
  expectTypeOf(five.$ping()).toEqualTypeOf<"pong">();
  expectTypeOf(ten.$ping()).toEqualTypeOf<"pong">();
};

type OmitThenMethods = ExtendedClient<
  BaseClient,
  readonly [typeof hidden, typeof methods]
>;
type _omitBeforeResultConsumerIsValid = Expect<
  Equal<OmitThenMethods extends never ? true : false, false>
>;
// A factory typed against the client it extends reads its results: omit
// after it is refused. One that takes no scope is no result consumer: omit
// may follow it.
const reader = parts<BaseClient>().extension(
  "reader",
  extMethods((scope) => ({ user: { $first: () => scope.user.findFirst() } }))
);
type _resultConsumerBeforeOmitIsRejected = Expect<
  Equal<
    ExtendedClient<BaseClient, readonly [typeof reader, typeof hidden]>,
    never
  >
>;
type _blindMethodsBeforeOmitAreValid = Expect<
  Equal<
    ExtendedClient<
      BaseClient,
      readonly [typeof methods, typeof hidden]
    > extends never
      ? true
      : false,
    false
  >
>;

type _dynamicArraysAreNotAProvableChain = Expect<
  Equal<ExtendedClient<BaseClient, readonly unknown[]>, never>
>;
type _duplicateOfficialCacheIsRejected = Expect<
  Equal<ExtendedClient<OmittedClient, readonly [typeof cached]>, never>
>;

const _runtimeParity = () => {
  const base = baseClient();
  const runtimeExtended = base
    .$extends(cached)
    .$extends(observed)
    .$extends(methods);
  const runtimeFurtherExtended = runtimeExtended.$extends(moreMethods);
  const runtimeOmitted = base.$extends(hidden).$extends(cached);
  const runtimeSchemaBound = base.$extends(schemaBound);
  expectTypeOf<ApplicationClient>().toEqualTypeOf<typeof runtimeExtended>();
  expectTypeOf<FurtherExtendedClient>().toEqualTypeOf<
    typeof runtimeFurtherExtended
  >();
  expectTypeOf<OmittedClient>().toEqualTypeOf<typeof runtimeOmitted>();
  const utilityFromRuntime: SchemaBoundClient = runtimeSchemaBound;
  const runtimeFromUtility: typeof runtimeSchemaBound = utilityFromRuntime;
  return runtimeFromUtility;
};
