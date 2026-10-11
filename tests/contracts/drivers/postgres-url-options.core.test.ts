/**
 * `databaseUrl` beside `options` on the two PostgreSQL TCP drivers: the URL
 * fills only the connection keys it carries and every key set in `options`
 * wins (platform-08), and a `databaseUrl` that is present but empty or
 * undefined, with nothing else naming a host, is refused at construction
 * instead of falling back to libpq defaults (parity-18).
 *
 * The per-tenant shape is the case that matters: one URL per tenant without a
 * password, and the password from a secret. The merged target is read from the
 * real providers without opening a socket: pg-pool builds every connection as
 * `new Client(pool.options)`, so a `Client` built from the same record shows
 * what node-postgres would send; postgres.js resolves its options eagerly and
 * connects only on the first query.
 */

import { VibORM } from "@client/client";
import { createClient as createPgClient, PgDriver } from "@drivers/pg";
import {
  createClient as createPostgresClient,
  PostgresDriver,
} from "@drivers/postgres";
import { ClientInitializationError, VibORMErrorCode } from "@errors";
import { clientUserPostSchema as schema } from "@tests/fixtures/user-post-schema";
import { Client, Pool } from "pg";
import { afterEach, describe, expect, test, vi } from "vitest";

const SECRET = "from-a-secret";
const TENANT_URL = "postgres://tenant_7@db.internal:6543/tenant_7";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The driver a wrapper handed to its client, without connecting. */
function driverFromWrapper(build: () => unknown): unknown {
  const created = vi.spyOn(VibORM, "create");
  build();
  const driver = created.mock.calls[0]?.[0]?.driver;
  if (driver === undefined) throw new Error("the wrapper built no client");
  return driver;
}

/** What node-postgres would send for one connection of the pool `driver` made. */
async function pgTarget(driver: unknown) {
  if (!(driver instanceof PgDriver)) throw new Error("expected a PgDriver");
  await driver._connect();
  const pool = Reflect.get(driver, "client");
  if (!(pool instanceof Pool)) throw new Error("expected an owned pg Pool");
  const client = new Client(pool.options);
  await driver._disconnect();
  return {
    user: client.user,
    password: client.password,
    host: client.host,
    port: client.port,
    database: client.database,
    ssl: client.ssl,
  };
}

/** The options postgres.js resolved for the client `driver` made. */
async function postgresTarget(driver: unknown) {
  if (!(driver instanceof PostgresDriver)) {
    throw new Error("expected a PostgresDriver");
  }
  await driver._connect();
  const { options } = Reflect.get(driver, "client");
  await driver._disconnect();
  return {
    user: options.user,
    password: options.pass,
    host: options.host,
    port: options.port,
    database: options.database,
  };
}

describe("platform-08: the URL fills only its keys and explicit options win", () => {
  test("pg: a per-tenant URL plus a password from a secret", async () => {
    const target = await pgTarget(
      driverFromWrapper(() =>
        createPgClient({
          schema,
          databaseUrl: TENANT_URL,
          options: { password: SECRET },
        })
      )
    );
    expect(target).toMatchObject({
      user: "tenant_7",
      password: SECRET,
      host: "db.internal",
      port: 6543,
      database: "tenant_7",
    });
  });

  test("pg: every connection key set in options overrides the URL's", async () => {
    const target = await pgTarget(
      driverFromWrapper(() =>
        createPgClient({
          schema,
          databaseUrl:
            "postgres://url_user:url-pass@url.host:1/url_db?sslmode=require",
          options: {
            user: "app",
            password: "p@ss word/+%41",
            host: "/var/run/postgresql",
            port: 6432,
            database: "tenant db",
            ssl: false,
          },
        })
      )
    );
    expect(target).toEqual({
      user: "app",
      password: "p@ss word/+%41",
      host: "/var/run/postgresql",
      port: 6432,
      database: "tenant db",
      ssl: false,
    });
  });

  test("pg: a driver built directly merges the same way", async () => {
    const target = await pgTarget(
      new PgDriver({ databaseUrl: TENANT_URL, options: { password: SECRET } })
    );
    expect(target).toMatchObject({ password: SECRET, port: 6543 });
  });

  test("postgres.js: a per-tenant URL plus a password from a secret", async () => {
    const target = await postgresTarget(
      driverFromWrapper(() =>
        createPostgresClient({
          schema,
          databaseUrl: TENANT_URL,
          options: { password: SECRET },
        })
      )
    );
    expect(target).toEqual({
      user: "tenant_7",
      password: SECRET,
      host: ["db.internal"],
      port: [6543],
      database: "tenant_7",
    });
  });

  test("postgres.js: every connection key set in options overrides the URL's", async () => {
    const target = await postgresTarget(
      driverFromWrapper(() =>
        createPostgresClient({
          schema,
          databaseUrl: "postgres://url_user:url-pass@url.host:1/url_db",
          options: {
            user: "app",
            password: SECRET,
            host: "db.internal",
            port: 6432,
            database: "tenant_7",
          },
        })
      )
    );
    expect(target).toEqual({
      user: "app",
      password: SECRET,
      host: ["db.internal"],
      port: [6432],
      database: "tenant_7",
    });
  });
});

/** The refusal construction raised, or a loud failure if it raised nothing. */
function refusalFrom(build: () => unknown): ClientInitializationError {
  try {
    build();
  } catch (thrown) {
    if (thrown instanceof ClientInitializationError) return thrown;
    throw thrown;
  }
  throw new Error("expected a ClientInitializationError");
}

describe("parity-18: a present but empty databaseUrl names no target", () => {
  const wrappers = [
    ["pg", createPgClient],
    ["postgres", createPostgresClient],
  ] as const;

  for (const [driver, create] of wrappers) {
    for (const databaseUrl of [undefined, ""]) {
      test(`${driver}: databaseUrl ${JSON.stringify(databaseUrl)} with no host is refused`, () => {
        const refusal = refusalFrom(() => create({ schema, databaseUrl }));
        expect(refusal.code).toBe(VibORMErrorCode.CLIENT_INITIALIZATION);
        expect(refusal.message).toContain(`Driver "${driver}"`);
        expect(refusal.message).toContain("databaseUrl");
      });
    }

    test(`${driver}: an explicit host still decides the target`, () => {
      expect(() =>
        create({
          schema,
          databaseUrl: undefined,
          options: { host: "127.0.0.1", port: 1 },
        })
      ).not.toThrow();
    });

    test(`${driver}: no databaseUrl key keeps libpq's environment defaults`, () => {
      expect(() => create({ schema })).not.toThrow();
    });
  }

  test("the drivers refuse it when built directly too", () => {
    for (const build of [
      () => new PgDriver({ databaseUrl: "" }),
      () => new PostgresDriver({ databaseUrl: undefined }),
    ]) {
      expect(refusalFrom(build).code).toBe(
        VibORMErrorCode.CLIENT_INITIALIZATION
      );
    }
  });

  test("pg: a connection string in options is a target", () => {
    expect(
      () =>
        new PgDriver({
          databaseUrl: "",
          options: { connectionString: TENANT_URL },
        })
    ).not.toThrow();
  });
});
