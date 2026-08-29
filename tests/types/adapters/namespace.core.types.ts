/**
 * `viborm/adapters` publishes the namespace fact, and publishes it once.
 *
 * The interface member is optional, so an adapter written before this feature
 * still satisfies `DatabaseAdapter`; the two stock constructors narrow it to
 * what their dialect can promise. No alias spelling exists on the type.
 */

import {
  type DatabaseAdapter,
  MySQLAdapter,
  mysqlAdapter,
  PostgresAdapter,
  postgresAdapter,
  SQLiteAdapter,
  sqliteAdapter,
} from "@src/adapters";

type GeoPointSql = NonNullable<DatabaseAdapter["geoPoint"]>;

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

// The interface fact, and the absence of every alias for it.
type _namespaceIsOptionalOnTheInterface = Expect<
  Equal<DatabaseAdapter["namespace"], string | undefined>
>;
type _aCustomAdapterMayOmitIt = Expect<
  Omit<DatabaseAdapter, "namespace"> extends DatabaseAdapter ? true : false
>;
type _noDatabaseNamespace = Expect<
  Equal<"databaseNamespace" extends keyof DatabaseAdapter ? true : false, false>
>;
type _noDatabaseSchema = Expect<
  Equal<"databaseSchema" extends keyof DatabaseAdapter ? true : false, false>
>;
type _noKeyspace = Expect<
  Equal<"keyspace" extends keyof DatabaseAdapter ? true : false, false>
>;
type _noQueryParts = Expect<
  Equal<"assemble" extends keyof DatabaseAdapter ? true : false, false>
>;
type _noBatchReferences = Expect<
  Equal<"batchRefs" extends keyof DatabaseAdapter ? true : false, false>
>;

// PostgreSQL always has one; MySQL may not; SQLite declares none.
type _postgresNarrowsToString = Expect<
  Equal<PostgresAdapter["namespace"], string>
>;
type _mysqlKeepsTheUnboundCase = Expect<
  Equal<MySQLAdapter["namespace"], string | undefined>
>;
type _sqliteDeclaresNone = Expect<
  Equal<"namespace" extends keyof SQLiteAdapter ? true : false, false>
>;

const _boundSchema: string = postgresAdapter.namespace;
const _optionalDatabase: string | undefined = mysqlAdapter.namespace;
// @ts-expect-error - an unbound MySQL adapter promises no string
const _mysqlIsNotAlwaysBound: string = mysqlAdapter.namespace;
// @ts-expect-error - SQLite adapters have no namespace to read
const _sqliteHasNothingToRead = sqliteAdapter.namespace;

// PostgreSQL's second primitive settles its optional PostGIS protocol.
const _constructors = () => [
  new PostgresAdapter(),
  new PostgresAdapter("alpha"),
  new PostgresAdapter(undefined),
  new PostgresAdapter("alpha", true),
  new MySQLAdapter(),
  new MySQLAdapter("alpha"),
  new MySQLAdapter(undefined),
];
const _refusedConstructorInputs = () => [
  // @ts-expect-error - a namespace is a string, not a number
  new PostgresAdapter(3),
  // @ts-expect-error - there is no adapter options bag
  new MySQLAdapter({ namespace: "alpha" }),
  // @ts-expect-error - PostGIS is an exact boolean, not an options bag
  new PostgresAdapter("alpha", { postgis: true }),
  // @ts-expect-error - SQLite adapters take no namespace
  new SQLiteAdapter("alpha"),
];

// Protocol presence, not a parallel support flag, proves the physical tier.
type _geoPointProtocolIsOptional = Expect<
  Equal<DatabaseAdapter["geoPoint"], GeoPointSql | undefined>
>;

export {
  _boundSchema,
  _constructors,
  _mysqlIsNotAlwaysBound,
  _optionalDatabase,
  _refusedConstructorInputs,
  _sqliteHasNothingToRead,
};
