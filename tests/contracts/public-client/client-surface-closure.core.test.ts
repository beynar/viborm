/**
 * Client construction refusals and the two property surfaces a caller reaches
 * only from inside the client: the transaction view handed to a `$transaction`
 * callback, and the concrete scope handed to an extension's `client` factory.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import type { Schema } from "@client/types";
import type { QueryResult } from "@drivers";
import { Driver } from "@drivers";
import { ClientInitializationError, VibORMError } from "@errors";
import { s } from "@schema";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { afterEach, describe, expect, test } from "vitest";

const record = s.model({
  id: s.string().id(),
  label: s.string(),
});
const schema = { record };

/**
 * A PostgreSQL driver whose adapter declares no namespace — the exact shape the
 * construction gate refuses, because unqualified SQL would follow whatever the
 * connection's `search_path` happens to be.
 */
class NamespacelessPostgresDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();

  constructor() {
    super("postgresql", "namespaceless-postgres");
  }

  protected async initClient(): Promise<null> {
    return null;
  }

  protected async closeClient(): Promise<void> {
    // This fixture owns no provider resource.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    throw new Error("A construction-only contract dispatched provider work.");
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    throw new Error("A construction-only contract dispatched raw work.");
  }

  protected async transaction<T>(): Promise<T> {
    throw new Error("A construction-only contract opened a transaction.");
  }
}

const clients: Array<{ $disconnect(): Promise<void> }> = [];

function trackedClient() {
  const client = createClient({ schema, driver: new PlanningDriver("sqlite") });
  clients.push(client);
  return client;
}

function applyUnsafe(client: object, definition: unknown): object {
  const extend = Reflect.get(client, "$extends");
  if (typeof extend !== "function") throw new Error("Expected $extends");
  return Reflect.apply(extend, client, [definition]);
}

function callNoArgs(value: unknown): unknown {
  if (typeof value !== "function") throw new Error("Expected a function");
  return Reflect.apply(value, undefined, []);
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

describe("client construction refusals", () => {
  test("refuses a PostgreSQL driver whose adapter declares no namespace", () => {
    let caught: unknown;
    try {
      createClient({ schema, driver: new NamespacelessPostgresDriver() });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ClientInitializationError);
    if (!(caught instanceof VibORMError)) throw new Error("expected VibORM");
    expect(caught.message).toContain("must supply an adapter with a namespace");
  });

  test("re-types a construction fault that threw no Error at all", () => {
    const hostileSchema = new Proxy<Schema>(
      {},
      {
        ownKeys() {
          // biome-ignore lint/style/useThrowOnlyError: exercises non-Error normalization
          throw "private-hostile-schema-keys";
        },
      }
    );

    let caught: unknown;
    try {
      createClient({
        schema: hostileSchema,
        driver: new PlanningDriver("sqlite"),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ClientInitializationError);
    if (!(caught instanceof VibORMError)) throw new Error("expected VibORM");
    // No Error was thrown, so there is no cause to keep and no message to reuse.
    expect(caught.message).toBe("Failed to create the VibORM client");
    expect(caught.originalCause).toBeUndefined();
    expect(String(caught)).not.toContain("private-hostile-schema-keys");
  });
});

describe("the transaction view's own property surface", () => {
  test("answers $schema and refuses an unknown dollar-prefixed member", async () => {
    const client = trackedClient();

    const observed = await client.$transaction(async (transaction) => ({
      schema: Reflect.get(transaction, "$schema"),
      unknownDollar: Reflect.get(transaction, "$notAClientMember"),
      model: typeof Reflect.get(transaction, "record"),
    }));

    expect(observed.schema).toBe(schema);
    expect(observed.unknownDollar).toBeUndefined();
    expect(observed.model).toBe("function");
  });
});

describe("the concrete scope handed to an extension factory", () => {
  test("exposes prior methods, the core surface, and nothing else dollar-prefixed", () => {
    const base = trackedClient();
    const observed: Record<string, unknown> = {};

    const first = applyUnsafe(base, {
      name: "closure-scope-first",
      client: () => ({ $first: () => "one" }),
    });
    const second = applyUnsafe(first, {
      name: "closure-scope-second",
      client: (scope: object) => {
        observed.prior = callNoArgs(Reflect.get(scope, "$first"));
        observed.schema = Reflect.get(scope, "$schema");
        observed.transaction = typeof Reflect.get(scope, "$transaction");
        observed.raw = typeof Reflect.get(scope, "$queryRaw");
        observed.unknownDollar = Reflect.get(scope, "$notAClientMember");
        // A non-dollar key is a model name as far as this scope is concerned,
        // so it falls through to the model proxy rather than answering nothing.
        observed.plain = typeof Reflect.get(scope, "notAModelName");
        return { $second: () => "two" };
      },
    });

    expect(observed.prior).toBe("one");
    expect(observed.schema).toBe(schema);
    expect(observed.transaction).toBe("function");
    expect(observed.raw).toBe("function");
    expect(observed.unknownDollar).toBeUndefined();
    expect(observed.plain).toBe("function");
    expect(callNoArgs(Reflect.get(second, "$second"))).toBe("two");
  });
});
