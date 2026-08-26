/** Public extension and removed-config probes for every driver-package wrapper. */

import type { D1Database } from "@cloudflare/workers-types";
import { createClient as createBunSQLClient } from "@drivers/bun-sql";
import { createClient as createBunSQLiteClient } from "@drivers/bun-sqlite";
import { createClient as createD1Client } from "@drivers/d1";
import { createClient as createLibSQLClient } from "@drivers/libsql";
import { createClient as createMySQL2Client } from "@drivers/mysql2";
import { createClient as createNeonHTTPClient } from "@drivers/neon-http";
import { createClient as createPgClient } from "@drivers/pg";
import { createClient as createPGliteClient } from "@drivers/pglite";
import { createClient as createPlanetScaleClient } from "@drivers/planetscale";
import { createClient as createPostgresClient } from "@drivers/postgres";
import { createClient as createSQLite3Client } from "@drivers/sqlite3";
import { MemoryCache } from "@src/cache/drivers/memory";
import { defineExtension, s } from "@src/index";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

const record = s.model({
  id: s.string().id(),
  name: s.string(),
  secret: s.string(),
});
const schema = { record };

declare const database: D1Database;

const wrapperExtension = defineExtension<typeof schema>()({
  name: "wrapper-surface",
  client(scope) {
    return {
      $ids() {
        return scope.record.findMany({ select: { id: true } });
      },
    };
  },
  model: {
    record(delegate) {
      return {
        byName(name: string) {
          return delegate.findFirst({
            where: { name },
            select: { id: true },
          });
        },
      };
    },
  },
});

const bunSQL = () => createBunSQLClient({ schema }).$extends(wrapperExtension);
const bunSQLite = () =>
  createBunSQLiteClient({ schema }).$extends(wrapperExtension);
const d1 = () =>
  createD1Client({ schema, database }).$extends(wrapperExtension);
const libSQL = () => createLibSQLClient({ schema }).$extends(wrapperExtension);
const mysql2 = () => createMySQL2Client({ schema }).$extends(wrapperExtension);
const neonHTTP = () =>
  createNeonHTTPClient({ schema }).$extends(wrapperExtension);
const pg = () => createPgClient({ schema }).$extends(wrapperExtension);
const pglite = () => createPGliteClient({ schema }).$extends(wrapperExtension);
const planetScale = () =>
  createPlanetScaleClient({ schema }).$extends(wrapperExtension);
const postgres = () =>
  createPostgresClient({ schema }).$extends(wrapperExtension);
const sqlite3 = () =>
  createSQLite3Client({ schema }).$extends(wrapperExtension);

type WrapperResults<
  Client extends {
    $ids(): unknown;
    record: { byName(name: string): unknown };
  },
> = [
  Awaited<ReturnType<Client["$ids"]>>,
  Awaited<ReturnType<Client["record"]["byName"]>>,
];

type ExpectedWrapperResults = [{ id: string }[], { id: string } | null];

type _BunSQLResults = Expect<
  Equal<WrapperResults<ReturnType<typeof bunSQL>>, ExpectedWrapperResults>
>;
type _BunSQLiteResults = Expect<
  Equal<WrapperResults<ReturnType<typeof bunSQLite>>, ExpectedWrapperResults>
>;
type _D1Results = Expect<
  Equal<WrapperResults<ReturnType<typeof d1>>, ExpectedWrapperResults>
>;
type _LibSQLResults = Expect<
  Equal<WrapperResults<ReturnType<typeof libSQL>>, ExpectedWrapperResults>
>;
type _MySQL2Results = Expect<
  Equal<WrapperResults<ReturnType<typeof mysql2>>, ExpectedWrapperResults>
>;
type _NeonHTTPResults = Expect<
  Equal<WrapperResults<ReturnType<typeof neonHTTP>>, ExpectedWrapperResults>
>;
type _PgResults = Expect<
  Equal<WrapperResults<ReturnType<typeof pg>>, ExpectedWrapperResults>
>;
type _PGliteResults = Expect<
  Equal<WrapperResults<ReturnType<typeof pglite>>, ExpectedWrapperResults>
>;
type _PlanetScaleResults = Expect<
  Equal<WrapperResults<ReturnType<typeof planetScale>>, ExpectedWrapperResults>
>;
type _PostgresResults = Expect<
  Equal<WrapperResults<ReturnType<typeof postgres>>, ExpectedWrapperResults>
>;
type _SQLite3Results = Expect<
  Equal<WrapperResults<ReturnType<typeof sqlite3>>, ExpectedWrapperResults>
>;

const heldUnknownConfig = { schema, unknownClientOption: true };
const heldUnknownD1Config = { ...heldUnknownConfig, database };

const _heldUnknownConfigs = () => {
  // @ts-expect-error - held unknown configuration is refused by bun-sql
  createBunSQLClient(heldUnknownConfig);
  // @ts-expect-error - held unknown configuration is refused by bun-sqlite
  createBunSQLiteClient(heldUnknownConfig);
  // @ts-expect-error - held unknown configuration is refused by D1
  createD1Client(heldUnknownD1Config);
  // @ts-expect-error - held unknown configuration is refused by libsql
  createLibSQLClient(heldUnknownConfig);
  // @ts-expect-error - held unknown configuration is refused by mysql2
  createMySQL2Client(heldUnknownConfig);
  // @ts-expect-error - held unknown configuration is refused by neon-http
  createNeonHTTPClient(heldUnknownConfig);
  // @ts-expect-error - held unknown configuration is refused by pg
  createPgClient(heldUnknownConfig);
  // @ts-expect-error - held unknown configuration is refused by pglite
  createPGliteClient(heldUnknownConfig);
  // @ts-expect-error - held unknown configuration is refused by planetscale
  createPlanetScaleClient(heldUnknownConfig);
  // @ts-expect-error - held unknown configuration is refused by postgres
  createPostgresClient(heldUnknownConfig);
  // @ts-expect-error - held unknown configuration is refused by sqlite3
  createSQLite3Client(heldUnknownConfig);
};

const _freshRemovedConfigs = () => {
  createBunSQLClient({
    schema,
    // @ts-expect-error - cache belongs to cache({...})
    cache: new MemoryCache(),
    // @ts-expect-error - instrumentation belongs to instrumentation({...})
    instrumentation: {},
    // @ts-expect-error - omit belongs to defaultOmit<typeof schema>()({...})
    omit: { record: { secret: true } },
  });
  createBunSQLiteClient({
    schema,
    // @ts-expect-error - cache belongs to cache({...})
    cache: new MemoryCache(),
    // @ts-expect-error - instrumentation belongs to instrumentation({...})
    instrumentation: {},
    // @ts-expect-error - omit belongs to defaultOmit<typeof schema>()({...})
    omit: { record: { secret: true } },
  });
  createD1Client({
    schema,
    database,
    // @ts-expect-error - cache belongs to cache({...})
    cache: new MemoryCache(),
    // @ts-expect-error - instrumentation belongs to instrumentation({...})
    instrumentation: {},
    // @ts-expect-error - omit belongs to defaultOmit<typeof schema>()({...})
    omit: { record: { secret: true } },
  });
  createLibSQLClient({
    schema,
    // @ts-expect-error - cache belongs to cache({...})
    cache: new MemoryCache(),
    // @ts-expect-error - instrumentation belongs to instrumentation({...})
    instrumentation: {},
    // @ts-expect-error - omit belongs to defaultOmit<typeof schema>()({...})
    omit: { record: { secret: true } },
  });
  createMySQL2Client({
    schema,
    // @ts-expect-error - cache belongs to cache({...})
    cache: new MemoryCache(),
    // @ts-expect-error - instrumentation belongs to instrumentation({...})
    instrumentation: {},
    // @ts-expect-error - omit belongs to defaultOmit<typeof schema>()({...})
    omit: { record: { secret: true } },
  });
  createNeonHTTPClient({
    schema,
    // @ts-expect-error - cache belongs to cache({...})
    cache: new MemoryCache(),
    // @ts-expect-error - instrumentation belongs to instrumentation({...})
    instrumentation: {},
    // @ts-expect-error - omit belongs to defaultOmit<typeof schema>()({...})
    omit: { record: { secret: true } },
  });
  createPgClient({
    schema,
    // @ts-expect-error - cache belongs to cache({...})
    cache: new MemoryCache(),
    // @ts-expect-error - instrumentation belongs to instrumentation({...})
    instrumentation: {},
    // @ts-expect-error - omit belongs to defaultOmit<typeof schema>()({...})
    omit: { record: { secret: true } },
  });
  createPGliteClient({
    schema,
    // @ts-expect-error - cache belongs to cache({...})
    cache: new MemoryCache(),
    // @ts-expect-error - instrumentation belongs to instrumentation({...})
    instrumentation: {},
    // @ts-expect-error - omit belongs to defaultOmit<typeof schema>()({...})
    omit: { record: { secret: true } },
  });
  createPlanetScaleClient({
    schema,
    // @ts-expect-error - cache belongs to cache({...})
    cache: new MemoryCache(),
    // @ts-expect-error - instrumentation belongs to instrumentation({...})
    instrumentation: {},
    // @ts-expect-error - omit belongs to defaultOmit<typeof schema>()({...})
    omit: { record: { secret: true } },
  });
  createPostgresClient({
    schema,
    // @ts-expect-error - cache belongs to cache({...})
    cache: new MemoryCache(),
    // @ts-expect-error - instrumentation belongs to instrumentation({...})
    instrumentation: {},
    // @ts-expect-error - omit belongs to defaultOmit<typeof schema>()({...})
    omit: { record: { secret: true } },
  });
  createSQLite3Client({
    schema,
    // @ts-expect-error - cache belongs to cache({...})
    cache: new MemoryCache(),
    // @ts-expect-error - instrumentation belongs to instrumentation({...})
    instrumentation: {},
    // @ts-expect-error - omit belongs to defaultOmit<typeof schema>()({...})
    omit: { record: { secret: true } },
  });
};
