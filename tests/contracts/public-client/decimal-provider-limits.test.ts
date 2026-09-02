/**
 * Provider-lane plan 3.1: "The selected adapter validates its
 * physical capability once when the schema is bound and before provider I/O."
 *
 * The interesting cases are the BOUNDARY values, one on each side, because a
 * limit table is exactly the kind of fact that is off by one in silence:
 *
 * | provider | admitted | refused |
 * | --- | --- | --- |
 * | PostgreSQL | `precision 1000` | `precision 1001` |
 * | MySQL | `65 + 0`, `35 + 30` | `precision 66`, `scale 31`, `36 + 30` |
 * | SQLite | `precision 18, scale 0` and `9 + 9` | `precision 19`, `10 + 9` |
 *
 * The SQLite pair is the one that is not a storage limit: `precision + scale <=
 * 18` is what the one-statement exact multiply and divide need, and it is what
 * keeps the descriptor's own range CHECK inside the widest integer literal
 * SQLite's parser reads as an integer rather than as a REAL.
 *
 * A model outside a provider's limits is still a VALID model: the same schema
 * binds on PostgreSQL, which is the whole reason this is not a definition-time
 * refusal.
 */

import { createClient } from "@client/client";
import { LibSQLDriver } from "@drivers/libsql";
import { MySQL2Driver } from "@drivers/mysql2";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import { ClientInitializationError } from "@errors";
import { s } from "@schema";
import type { Schema } from "@schema/hydration";
import { SchemaValidationError } from "@schema/validation/error";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test, vi } from "vitest";

type Domain = { precision: number; scale: number };

const schemaWith = (domain: Domain) => ({
  ledger: s.model({
    id: s.string().id(),
    amount: s.decimal(domain),
  }),
});

const listSchemaWith = (domain: Domain) => ({
  ledger: s.model({
    id: s.string().id(),
    amounts: s.decimal(domain).array(),
  }),
});

const FIELD = /ledger\.amount/;
const LIST_FIELD = /ledger\.amounts/;
const PROVIDER = /postgresql/;
const DESCRIPTOR = /precision 1001, scale 2/;
const PG_PRECISION = /maximum precision of 1000/;
const MYSQL_PRECISION = /maximum precision of 65/;
const MYSQL_SCALE = /maximum scale of 30/;
const MYSQL_SUM = /precision \+ scale <= 65/;
const SQLITE_PRECISION = /maximum precision of 18/;
const SQLITE_SUM = /precision \+ scale <= 18/;
const SQLITE_REASON = /multiply and divide/;

// The PostgreSQL driver below is CONSTRUCTED and never connected, so the
// database it holds is only ever the one the driver would have used. Borrowing
// the worker's shared database keeps that ownership shape - a caller-supplied
// client - without paying for an instance per binding.
const getFamily = usePGliteSchemaFamily(
  schemaWith({ precision: 10, scale: 2 })
);

const drivers = {
  postgresql: () => {
    const family = getFamily();
    return new PGliteDriver({
      client: family.database,
      namespace: family.namespace,
    });
  },
  mysql: () =>
    new MySQL2Driver({
      databaseUrl: "mysql://viborm:viborm@127.0.0.1:3307/unreachable",
      migrationNamespaceAttestation: "non-redirecting",
    }),
  sqlite: () => new SQLite3Driver({ dataDir: ":memory:" }),
  libsql: () => new LibSQLDriver({ dataDir: ":memory:" }),
} as const;

type Provider = keyof typeof drivers;

const bind = (
  provider: Provider,
  schema: Schema
): { client?: unknown; error?: unknown } => {
  try {
    // A client is CONSTRUCTED here and never connected: the plan's contract is
    // that the refusal happens before any provider I/O.
    return { client: createClient({ schema, driver: drivers[provider]() }) };
  } catch (error) {
    return { error };
  }
};

const refusalOf = (provider: Provider, domain: Domain): string => {
  const { error } = bind(provider, schemaWith(domain));
  if (error instanceof ClientInitializationError) return error.message;
  throw new Error(
    `expected '${provider}' to refuse precision ${domain.precision}, scale ${domain.scale}`
  );
};

const admits = (provider: Provider, domain: Domain): boolean =>
  bind(provider, schemaWith(domain)).error === undefined;

describe("a decimal domain is held to the bound provider's physical limit", () => {
  test("model registration wins before provider-domain admission", () => {
    const shared = s.model({
      id: s.string().id(),
      amount: s.decimal({ precision: 19, scale: 0 }),
    });
    const driver = new SQLite3Driver({ dataDir: ":memory:" });
    const connect = vi.spyOn(driver, "_connect");
    const execute = vi.spyOn(driver, "_execute");
    let error: unknown;

    try {
      createClient({ schema: { alpha: shared, beta: shared }, driver });
    } catch (failure) {
      error = failure;
    }

    expect(error).toBeInstanceOf(SchemaValidationError);
    if (!(error instanceof SchemaValidationError)) throw error;
    expect(error.issues).toEqual([
      expect.objectContaining({ code: "M003", model: "beta" }),
    ]);
    expect(error.message).not.toMatch(SQLITE_PRECISION);
    expect(shared["~"].names.ts).toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(0);
    expect(execute).toHaveBeenCalledTimes(0);
  });

  test("a hostile model-state getter is translated by the client construction boundary", () => {
    const cause = new TypeError("hostile decimal model state");
    let reads = 0;
    const hostile = new Proxy(
      s.model({
        id: s.string().id(),
        amount: s.decimal({ precision: 10, scale: 2 }),
      }),
      {
        get(target, property, receiver) {
          if (property === "~") {
            reads += 1;
            throw cause;
          }
          return Reflect.get(target, property, receiver);
        },
      }
    );

    const { error } = bind("sqlite", { hostile });

    expect(error).toBeInstanceOf(ClientInitializationError);
    if (!(error instanceof ClientInitializationError)) throw error;
    expect(error.message).toBe(cause.message);
    expect(error.originalCause?.name).toBe("Error");
    expect(reads).toBe(1);
  });

  test("a typed failure from a hostile scalar getter keeps its identity", () => {
    const refusal = new ClientInitializationError("typed scalar refusal");
    const hostile = s.model({
      id: s.string().id(),
      amount: s.decimal({ precision: 10, scale: 2 }),
    });
    const amount = hostile["~"].state.scalars.amount;
    if (amount === undefined) throw new Error("expected decimal scalar");
    hostile["~"].state.scalars.amount = new Proxy(amount, {
      get(target, property, receiver) {
        if (property === "~") throw refusal;
        return Reflect.get(target, property, receiver);
      },
    });

    const { error } = bind("sqlite", { hostile });

    expect(error).toBe(refusal);
  });

  test("a provider-limit refusal performs no connection or execution", () => {
    const driver = new SQLite3Driver({ dataDir: ":memory:" });
    const connect = vi.spyOn(driver, "_connect");
    const execute = vi.spyOn(driver, "_execute");
    let refusal: unknown;

    try {
      createClient({
        schema: schemaWith({ precision: 19, scale: 0 }),
        driver,
      });
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(ClientInitializationError);
    expect(connect).toHaveBeenCalledTimes(0);
    expect(execute).toHaveBeenCalledTimes(0);
  });

  test("PostgreSQL stores 1000 digits and refuses 1001", () => {
    expect(admits("postgresql", { precision: 1000, scale: 2 })).toBe(true);

    const refusal = refusalOf("postgresql", { precision: 1001, scale: 2 });
    expect(refusal).toMatch(FIELD);
    expect(refusal).toMatch(PROVIDER);
    expect(refusal).toMatch(DESCRIPTOR);
    expect(refusal).toMatch(PG_PRECISION);
  });

  test("MySQL holds every exact arithmetic intermediate to 65 digits", () => {
    expect(admits("mysql", { precision: 65, scale: 0 })).toBe(true);
    expect(admits("mysql", { precision: 35, scale: 30 })).toBe(true);

    expect(refusalOf("mysql", { precision: 66, scale: 2 })).toMatch(
      MYSQL_PRECISION
    );
    expect(refusalOf("mysql", { precision: 65, scale: 31 })).toMatch(
      MYSQL_SCALE
    );
    expect(refusalOf("mysql", { precision: 36, scale: 30 })).toMatch(MYSQL_SUM);
  });

  test("SQLite holds precision + scale to 18", () => {
    expect(admits("sqlite", { precision: 18, scale: 0 })).toBe(true);
    expect(admits("sqlite", { precision: 9, scale: 9 })).toBe(true);

    expect(refusalOf("sqlite", { precision: 19, scale: 0 })).toMatch(
      SQLITE_PRECISION
    );
    const sum = refusalOf("sqlite", { precision: 10, scale: 9 });
    expect(sum).toMatch(SQLITE_SUM);
    expect(sum).toMatch(SQLITE_REASON);
  });

  test("the LibSQL driver takes the same SQLite bound", () => {
    // Same family, same storage, same one-statement arithmetic.
    expect(admits("libsql", { precision: 9, scale: 9 })).toBe(true);
    expect(refusalOf("libsql", { precision: 10, scale: 9 })).toMatch(
      SQLITE_SUM
    );
  });

  test("the same schema is a valid model graph on a provider that fits it", () => {
    const wide = { precision: 200, scale: 4 };
    expect(admits("postgresql", wide)).toBe(true);
    expect(refusalOf("mysql", wide)).toMatch(MYSQL_PRECISION);
    expect(refusalOf("sqlite", wide)).toMatch(SQLITE_PRECISION);
  });

  test("a decimal LIST is held to the same limit as a scalar", () => {
    const { error } = bind(
      "sqlite",
      listSchemaWith({ precision: 19, scale: 0 })
    );
    expect(error).toBeInstanceOf(ClientInitializationError);
    expect((error as ClientInitializationError).message).toMatch(LIST_FIELD);
  });

  test("a schema with no decimal binds on every provider", () => {
    const plain = { ledger: s.model({ id: s.string().id() }) };
    for (const provider of Object.keys(drivers) as Provider[]) {
      expect(bind(provider, plain).error).toBeUndefined();
    }
  });
});
