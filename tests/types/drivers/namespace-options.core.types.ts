/**
 * The namespace option's static surface, spelled the way a caller spells it.
 *
 * ONE public spelling exists — `namespace` — on exactly the five PostgreSQL and
 * two MySQL boundaries. Every dialect-native alias the design rejected, every
 * SQLite spelling, and every attestation value but the exact literal are
 * compile errors here, in fresh and held configuration objects alike.
 *
 * A `@ts-expect-error` that stops being an error fails this file (TS2578), so
 * a surface that silently re-opens turns the type-check red. Nothing is called.
 */

import {
  BunSQLDriver,
  createClient as bunSqlCreateClient,
} from "@drivers/bun-sql";
import { createClient as bunSqliteCreateClient } from "@drivers/bun-sqlite";
import {
  type D1DriverOptions,
  createClient as d1CreateClient,
} from "@drivers/d1";
import { createClient as libsqlCreateClient } from "@drivers/libsql";
import {
  MySQL2Driver,
  createClient as mysql2CreateClient,
} from "@drivers/mysql2";
import {
  NeonHTTPDriver,
  createClient as neonCreateClient,
} from "@drivers/neon-http";
import { PgDriver, createClient as pgCreateClient } from "@drivers/pg";
import {
  PGliteDriver,
  createClient as pgliteCreateClient,
} from "@drivers/pglite";
import {
  PlanetScaleDriver,
  createClient as planetscaleCreateClient,
} from "@drivers/planetscale";
import {
  PostgresDriver,
  createClient as postgresCreateClient,
} from "@drivers/postgres";
import { createClient as sqlite3CreateClient } from "@drivers/sqlite3";
import { s } from "@schema";
import { createClient } from "@src/index";
import { describe, expectTypeOf, test } from "vitest";

const user = s.model({ id: s.string().id(), email: s.string() });
const schema = { user };
declare const d1Database: D1DriverOptions["database"];

// ============================================================================
// ACCEPTANCE — the seven boundaries that own a namespace
// ============================================================================

describe("every PostgreSQL and MySQL boundary accepts namespace", () => {
  const _wrappers = () => [
    pgCreateClient({ schema, namespace: "alpha" }),
    postgresCreateClient({ schema, namespace: "alpha" }),
    pgliteCreateClient({ schema, namespace: "alpha" }),
    neonCreateClient({
      schema,
      databaseUrl: "postgres://h/d",
      namespace: "alpha",
    }),
    bunSqlCreateClient({ schema, namespace: "alpha" }),
    mysql2CreateClient({ schema, namespace: "alpha" }),
    planetscaleCreateClient({ schema, namespace: "alpha" }),
  ];

  const _constructors = () => [
    new PgDriver({ namespace: "alpha" }),
    new PostgresDriver({ namespace: "alpha" }),
    new PGliteDriver({ namespace: "alpha" }),
    new NeonHTTPDriver({ namespace: "alpha" }),
    new BunSQLDriver({ namespace: "alpha" }),
    new MySQL2Driver({ namespace: "alpha" }),
    new PlanetScaleDriver({ namespace: "alpha" }),
  ];

  const _valueTypeIsString = () => [
    // @ts-expect-error - a namespace is a string, not a number
    new PgDriver({ namespace: 3 }),
    // @ts-expect-error - a namespace is a string, not a boolean
    new MySQL2Driver({ namespace: true }),
    // @ts-expect-error - a namespace is a string, not an object
    new PlanetScaleDriver({ namespace: { name: "alpha" } }),
  ];

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_wrappers).toBeFunction();
    expectTypeOf(_constructors).toBeFunction();
    expectTypeOf(_valueTypeIsString).toBeFunction();
  });
});

// ============================================================================
// NO ALIAS, ANY SPELLING
// ============================================================================

const heldPgAliasConfig = {
  schema,
  namespace: "alpha",
  databaseSchema: "alpha",
} as const;

const heldMySQL2AliasConfig = {
  schema,
  namespace: "alpha",
  keyspace: "alpha",
} as const;

describe("dialect-native aliases are refused beside the real key", () => {
  const _pgAliasesFresh = () =>
    pgCreateClient({
      schema,
      namespace: "alpha",
      // @ts-expect-error - "databaseSchema" is not an option
      databaseSchema: "alpha",
      // @ts-expect-error - "databaseName" is not an option
      databaseName: "alpha",
      // @ts-expect-error - "databaseNamespace" is not an option
      databaseNamespace: "alpha",
      // @ts-expect-error - "pgSchema" is not an option
      pgSchema: "alpha",
      // @ts-expect-error - "keyspace" is not an option
      keyspace: "alpha",
      // @ts-expect-error - "searchPath" is not an option
      searchPath: "alpha",
    });

  const _pgAliasesHeld = () =>
    // @ts-expect-error - a held alias is refused structurally too
    pgCreateClient(heldPgAliasConfig);

  const _mysql2AliasesFresh = () =>
    mysql2CreateClient({
      schema,
      namespace: "alpha",
      // @ts-expect-error - "databaseName" is not an option
      databaseName: "alpha",
      // @ts-expect-error - "databaseNamespace" is not an option
      databaseNamespace: "alpha",
      // @ts-expect-error - "keyspace" is not an option
      keyspace: "alpha",
      // @ts-expect-error - "databaseSchema" is not an option
      databaseSchema: "alpha",
      // @ts-expect-error - "pgSchema" is not an option
      pgSchema: "alpha",
    });

  const _mysql2AliasesHeld = () =>
    // @ts-expect-error - a held alias is refused structurally too
    mysql2CreateClient(heldMySQL2AliasConfig);

  const _planetscaleAliasesFresh = () =>
    planetscaleCreateClient({
      schema,
      namespace: "alpha",
      // @ts-expect-error - "keyspace" is not an option
      keyspace: "alpha",
      // @ts-expect-error - "databaseName" is not an option
      databaseName: "alpha",
    });

  const _remainingPostgresWrappers = () => [
    postgresCreateClient({
      schema,
      namespace: "alpha",
      // @ts-expect-error - "pgSchema" is not an option
      pgSchema: "alpha",
      // @ts-expect-error - "databaseSchema" is not an option
      databaseSchema: "alpha",
      // @ts-expect-error - "databaseName" is not an option
      databaseName: "alpha",
      // @ts-expect-error - "databaseNamespace" is not an option
      databaseNamespace: "alpha",
      // @ts-expect-error - "keyspace" is not an option
      keyspace: "alpha",
    }),
    pgliteCreateClient({
      schema,
      namespace: "alpha",
      // @ts-expect-error - "pgSchema" is not an option
      pgSchema: "alpha",
      // @ts-expect-error - "databaseSchema" is not an option
      databaseSchema: "alpha",
      // @ts-expect-error - "databaseName" is not an option
      databaseName: "alpha",
      // @ts-expect-error - "databaseNamespace" is not an option
      databaseNamespace: "alpha",
      // @ts-expect-error - "keyspace" is not an option
      keyspace: "alpha",
    }),
    neonCreateClient({
      schema,
      databaseUrl: "postgres://h/d",
      namespace: "alpha",
      // @ts-expect-error - "pgSchema" is not an option
      pgSchema: "alpha",
      // @ts-expect-error - "databaseSchema" is not an option
      databaseSchema: "alpha",
      // @ts-expect-error - "databaseName" is not an option
      databaseName: "alpha",
      // @ts-expect-error - "databaseNamespace" is not an option
      databaseNamespace: "alpha",
      // @ts-expect-error - "keyspace" is not an option
      keyspace: "alpha",
    }),
    bunSqlCreateClient({
      schema,
      namespace: "alpha",
      // @ts-expect-error - "pgSchema" is not an option
      pgSchema: "alpha",
      // @ts-expect-error - "databaseSchema" is not an option
      databaseSchema: "alpha",
      // @ts-expect-error - "databaseName" is not an option
      databaseName: "alpha",
      // @ts-expect-error - "databaseNamespace" is not an option
      databaseNamespace: "alpha",
      // @ts-expect-error - "keyspace" is not an option
      keyspace: "alpha",
    }),
  ];

  const _constructorAliases = () => [
    // @ts-expect-error - "pgSchema" is not a driver option
    new PostgresDriver({ namespace: "alpha", pgSchema: "alpha" }),
    // @ts-expect-error - "keyspace" is not a driver option
    new PlanetScaleDriver({ namespace: "alpha", keyspace: "alpha" }),
  ];

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_pgAliasesFresh).toBeFunction();
    expectTypeOf(_pgAliasesHeld).toBeFunction();
    expectTypeOf(_mysql2AliasesFresh).toBeFunction();
    expectTypeOf(_mysql2AliasesHeld).toBeFunction();
    expectTypeOf(_planetscaleAliasesFresh).toBeFunction();
    expectTypeOf(_remainingPostgresWrappers).toBeFunction();
    expectTypeOf(_constructorAliases).toBeFunction();
  });
});

// ============================================================================
// SQLITE HAS NO NAMESPACE, UNDER ANY SPELLING
// ============================================================================

const heldSqlite3NamespaceConfig = {
  schema,
  dataDir: "memory://",
  namespace: "alpha",
} as const;

const heldLibsqlAliasConfig = {
  schema,
  dataDir: "memory://",
  databaseNamespace: "alpha",
} as const;

const heldBunSqliteNamespaceConfig = {
  schema,
  dataDir: "memory://",
  namespace: "alpha",
} as const;

const heldD1NamespaceConfig = {
  schema,
  database: d1Database,
  namespace: "alpha",
} as const;

describe("SQLite wrappers refuse namespace and every alias", () => {
  const _sqlite3Fresh = () =>
    sqlite3CreateClient({
      schema,
      dataDir: "memory://",
      // @ts-expect-error - SQLite has no namespace
      namespace: "alpha",
    });

  const _sqlite3Held = () =>
    // @ts-expect-error - a held SQLite namespace is refused structurally too
    sqlite3CreateClient(heldSqlite3NamespaceConfig);

  const _sqlite3Aliases = () =>
    sqlite3CreateClient({
      schema,
      dataDir: "memory://",
      // @ts-expect-error - "databaseSchema" is not an option
      databaseSchema: "alpha",
      // @ts-expect-error - "databaseName" is not an option
      databaseName: "alpha",
      // @ts-expect-error - "databaseNamespace" is not an option
      databaseNamespace: "alpha",
      // @ts-expect-error - "pgSchema" is not an option
      pgSchema: "alpha",
      // @ts-expect-error - "keyspace" is not an option
      keyspace: "alpha",
      // @ts-expect-error - "attachment" is not an option either
      attachment: "alpha",
    });

  const _bunSqliteFresh = () =>
    bunSqliteCreateClient({
      schema,
      dataDir: "memory://",
      // @ts-expect-error - SQLite has no namespace
      namespace: "alpha",
      // @ts-expect-error - "databaseSchema" is not an option
      databaseSchema: "alpha",
      // @ts-expect-error - "databaseName" is not an option
      databaseName: "alpha",
      // @ts-expect-error - "databaseNamespace" is not an option
      databaseNamespace: "alpha",
      // @ts-expect-error - "pgSchema" is not an option
      pgSchema: "alpha",
      // @ts-expect-error - "keyspace" is not an option
      keyspace: "alpha",
      // @ts-expect-error - and no attachment alias for one
      attachment: "alpha",
    });

  const _bunSqliteHeld = () =>
    // @ts-expect-error - a held SQLite namespace is refused structurally too
    bunSqliteCreateClient(heldBunSqliteNamespaceConfig);

  const _libsqlFresh = () =>
    libsqlCreateClient({
      schema,
      dataDir: "memory://",
      // @ts-expect-error - SQLite has no namespace
      namespace: "alpha",
      // @ts-expect-error - "databaseSchema" is not an option
      databaseSchema: "alpha",
      // @ts-expect-error - "databaseName" is not an option
      databaseName: "alpha",
      // @ts-expect-error - "pgSchema" is not an option
      pgSchema: "alpha",
      // @ts-expect-error - "keyspace" is not an option
      keyspace: "alpha",
    });

  const _libsqlHeld = () =>
    // @ts-expect-error - a held SQLite alias is refused structurally too
    libsqlCreateClient(heldLibsqlAliasConfig);

  const _d1Fresh = () =>
    d1CreateClient({
      schema,
      database: d1Database,
      // @ts-expect-error - SQLite has no namespace
      namespace: "alpha",
      // @ts-expect-error - "databaseSchema" is not an option
      databaseSchema: "alpha",
      // @ts-expect-error - "databaseName" is not an option
      databaseName: "alpha",
      // @ts-expect-error - "databaseNamespace" is not an option
      databaseNamespace: "alpha",
      // @ts-expect-error - "pgSchema" is not an option
      pgSchema: "alpha",
      // @ts-expect-error - "keyspace" is not an option
      keyspace: "alpha",
    });

  const _d1Held = () =>
    // @ts-expect-error - a held SQLite namespace is refused structurally too
    d1CreateClient(heldD1NamespaceConfig);

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_sqlite3Fresh).toBeFunction();
    expectTypeOf(_sqlite3Held).toBeFunction();
    expectTypeOf(_sqlite3Aliases).toBeFunction();
    expectTypeOf(_bunSqliteFresh).toBeFunction();
    expectTypeOf(_bunSqliteHeld).toBeFunction();
    expectTypeOf(_libsqlFresh).toBeFunction();
    expectTypeOf(_libsqlHeld).toBeFunction();
    expectTypeOf(_d1Fresh).toBeFunction();
    expectTypeOf(_d1Held).toBeFunction();
  });
});

// ============================================================================
// THE ATTESTATION IS MYSQL2's ALONE, AND IS ONE LITERAL
// ============================================================================

const heldMySQL2WrongAttestation = {
  schema,
  namespace: "alpha",
  migrationNamespaceAttestation: "non_redirecting",
} as const;

const heldPlanetScaleAttestation = {
  schema,
  namespace: "alpha",
  migrationNamespaceAttestation: "non-redirecting",
} as const;

const heldPgAttestation = {
  schema,
  namespace: "alpha",
  migrationNamespaceAttestation: "non-redirecting",
} as const;

const heldSqlite3Attestation = {
  schema,
  dataDir: "memory://",
  migrationNamespaceAttestation: "non-redirecting",
} as const;

describe("MySQL2 admits one attestation literal", () => {
  const _admitted = () => [
    mysql2CreateClient({
      schema,
      namespace: "alpha",
      migrationNamespaceAttestation: "non-redirecting",
    }),
    new MySQL2Driver({
      namespace: "alpha",
      migrationNamespaceAttestation: "non-redirecting",
    }),
    mysql2CreateClient({
      schema,
      namespace: "alpha",
      migrationNamespaceAttestation: undefined,
    }),
  ];

  const _refusedValues = () => [
    new MySQL2Driver({
      namespace: "alpha",
      // @ts-expect-error - a boolean is not the assertion
      migrationNamespaceAttestation: true,
    }),
    new MySQL2Driver({
      namespace: "alpha",
      // @ts-expect-error - no other literal is the assertion
      migrationNamespaceAttestation: "non_redirecting",
    }),
    new MySQL2Driver({
      namespace: "alpha",
      // @ts-expect-error - a near-miss spelling is not the assertion
      migrationNamespaceAttestation: "nonredirecting",
    }),
  ];

  const _refusedHeldValue = () =>
    // @ts-expect-error - a held wrong literal is refused structurally too
    mysql2CreateClient(heldMySQL2WrongAttestation);

  const _misspelledKeyBesideReal = () =>
    mysql2CreateClient({
      schema,
      migrationNamespaceAttestation: "non-redirecting",
      // @ts-expect-error - "migrationNamespaceAtestation" is not an option
      migrationNamespaceAtestation: "non-redirecting",
    });

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_admitted).toBeFunction();
    expectTypeOf(_refusedValues).toBeFunction();
    expectTypeOf(_refusedHeldValue).toBeFunction();
    expectTypeOf(_misspelledKeyBesideReal).toBeFunction();
  });
});

describe("no other family exposes the attestation", () => {
  const _planetscaleFresh = () =>
    planetscaleCreateClient({
      schema,
      namespace: "alpha",
      // @ts-expect-error - PlanetScale never exposes the assertion
      migrationNamespaceAttestation: "non-redirecting",
    });

  const _planetscaleHeld = () =>
    // @ts-expect-error - held PlanetScale attestation is refused structurally
    planetscaleCreateClient(heldPlanetScaleAttestation);

  const _planetscaleConstructor = () =>
    new PlanetScaleDriver({
      namespace: "alpha",
      // @ts-expect-error - PlanetScale never exposes the assertion
      migrationNamespaceAttestation: "non-redirecting",
    });

  const _postgresFresh = () =>
    pgCreateClient({
      schema,
      namespace: "alpha",
      // @ts-expect-error - PostgreSQL has no routing assertion
      migrationNamespaceAttestation: "non-redirecting",
    });

  const _postgresHeld = () =>
    // @ts-expect-error - held PostgreSQL attestation is refused structurally
    pgCreateClient(heldPgAttestation);

  const _sqliteFresh = () =>
    sqlite3CreateClient({
      schema,
      dataDir: "memory://",
      // @ts-expect-error - SQLite has no routing assertion
      migrationNamespaceAttestation: "non-redirecting",
    });

  const _sqliteHeld = () =>
    // @ts-expect-error - held SQLite attestation is refused structurally
    sqlite3CreateClient(heldSqlite3Attestation);

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_planetscaleFresh).toBeFunction();
    expectTypeOf(_planetscaleHeld).toBeFunction();
    expectTypeOf(_planetscaleConstructor).toBeFunction();
    expectTypeOf(_postgresFresh).toBeFunction();
    expectTypeOf(_postgresHeld).toBeFunction();
    expectTypeOf(_sqliteFresh).toBeFunction();
    expectTypeOf(_sqliteHeld).toBeFunction();
  });
});

// ============================================================================
// GENERIC CLIENT CONFIGURATION OWNS NO TARGET
// ============================================================================

const heldGenericNamespaceConfig = {
  schema,
  driver: new PGliteDriver({ namespace: "alpha" }),
  namespace: "alpha",
} as const;

const heldGenericAliasConfig = {
  schema,
  driver: new PGliteDriver({ namespace: "alpha" }),
  pgSchema: "alpha",
} as const;

describe("generic createClient({ driver }) has no namespace of its own", () => {
  const _namespaceFresh = () =>
    createClient({
      schema,
      driver: new PGliteDriver({ namespace: "alpha" }),
      decimal: "string",
      // @ts-expect-error - the driver already owns the physical target
      namespace: "alpha",
    });

  const _namespaceHeld = () =>
    // @ts-expect-error - held generic namespace is refused structurally too
    createClient(heldGenericNamespaceConfig);

  const _aliasesFresh = () =>
    createClient({
      schema,
      driver: new PGliteDriver({ namespace: "alpha" }),
      // @ts-expect-error - "databaseSchema" is not a config key
      databaseSchema: "alpha",
      // @ts-expect-error - "databaseName" is not a config key
      databaseName: "alpha",
      // @ts-expect-error - "databaseNamespace" is not a config key
      databaseNamespace: "alpha",
      // @ts-expect-error - "pgSchema" is not a config key
      pgSchema: "alpha",
      // @ts-expect-error - "keyspace" is not a config key
      keyspace: "alpha",
    });

  const _aliasesHeld = () =>
    // @ts-expect-error - held generic alias is refused structurally too
    createClient(heldGenericAliasConfig);

  const _attestation = () =>
    createClient({
      schema,
      driver: new MySQL2Driver({ namespace: "alpha" }),
      // @ts-expect-error - the assertion is a driver fact, not client config
      migrationNamespaceAttestation: "non-redirecting",
    });

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_namespaceFresh).toBeFunction();
    expectTypeOf(_namespaceHeld).toBeFunction();
    expectTypeOf(_aliasesFresh).toBeFunction();
    expectTypeOf(_aliasesHeld).toBeFunction();
    expectTypeOf(_attestation).toBeFunction();
  });
});

// ============================================================================
// A TYPO BESIDE THE REAL KEY, PER WRAPPER
// ============================================================================

const heldPgTypoConfig = {
  schema,
  namespace: "alpha",
  namespce: "alpha",
} as const;

const heldMySQL2TypoConfig = {
  schema,
  namespace: "alpha",
  nameSpace: "alpha",
} as const;

const heldPostgresTypoConfig = {
  schema,
  namespace: "alpha",
  Namespace: "alpha",
} as const;

const heldPGliteTypoConfig = {
  schema,
  namespace: "alpha",
  namespaces: "alpha",
} as const;

const heldNeonTypoConfig = {
  schema,
  databaseUrl: "postgres://h/d",
  namespace: "alpha",
  nameSpace: "alpha",
} as const;

const heldBunSqlTypoConfig = {
  schema,
  namespace: "alpha",
  namspace: "alpha",
} as const;

const heldPlanetScaleTypoConfig = {
  schema,
  namespace: "alpha",
  keySpace: "alpha",
} as const;

describe("a namespace typo beside the real key is refused", () => {
  const _freshTypos = () => [
    // @ts-expect-error - "namespce" is not an option
    pgCreateClient({ schema, namespace: "alpha", namespce: "alpha" }),
    // @ts-expect-error - "Namespace" is not an option
    postgresCreateClient({ schema, namespace: "alpha", Namespace: "alpha" }),
    // @ts-expect-error - "namespaces" is not an option
    pgliteCreateClient({ schema, namespace: "alpha", namespaces: "alpha" }),
    neonCreateClient({
      schema,
      databaseUrl: "postgres://h/d",
      namespace: "alpha",
      // @ts-expect-error - "nameSpace" is not an option
      nameSpace: "alpha",
    }),
    // @ts-expect-error - "namspace" is not an option
    bunSqlCreateClient({ schema, namespace: "alpha", namspace: "alpha" }),
    // @ts-expect-error - "namespac" is not an option
    mysql2CreateClient({ schema, namespace: "alpha", namespac: "alpha" }),
    planetscaleCreateClient({
      schema,
      namespace: "alpha",
      // @ts-expect-error - "keySpace" is not an option
      keySpace: "alpha",
    }),
  ];

  const _heldTypos = () => [
    // @ts-expect-error - a held typo is refused structurally too
    pgCreateClient(heldPgTypoConfig),
    // @ts-expect-error - a held typo is refused structurally too
    postgresCreateClient(heldPostgresTypoConfig),
    // @ts-expect-error - a held typo is refused structurally too
    pgliteCreateClient(heldPGliteTypoConfig),
    // @ts-expect-error - a held typo is refused structurally too
    neonCreateClient(heldNeonTypoConfig),
    // @ts-expect-error - a held typo is refused structurally too
    bunSqlCreateClient(heldBunSqlTypoConfig),
    // @ts-expect-error - a held typo is refused structurally too
    mysql2CreateClient(heldMySQL2TypoConfig),
    // @ts-expect-error - a held typo is refused structurally too
    planetscaleCreateClient(heldPlanetScaleTypoConfig),
  ];

  const _constructorTypos = () => [
    // @ts-expect-error - "namespce" is not a driver option
    new PgDriver({ namespace: "alpha", namespce: "alpha" }),
    // @ts-expect-error - "nameSpace" is not a driver option
    new MySQL2Driver({ namespace: "alpha", nameSpace: "alpha" }),
  ];

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_freshTypos).toBeFunction();
    expectTypeOf(_heldTypos).toBeFunction();
    expectTypeOf(_constructorTypos).toBeFunction();
  });
});
