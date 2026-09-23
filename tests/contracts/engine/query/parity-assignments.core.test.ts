import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { type Dialect, Driver } from "@drivers";
import { hydrateSchemaNames, s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * Lane Q / U4 — the update language is consumed once.
 *
 * `Assignments` holds the ADMITTED payload; `Queries.prepareUpdate` is its one
 * interpreter. What is pinned here is the PAYLOAD that reaches the provider —
 * a document that looks like the envelope must cross verbatim — and the two
 * halves a naive "stop unwrapping" breaks: an operator still compiles to the
 * provider's arithmetic, and a relation key still refuses one.
 *
 * The nested (record-route) half is witnessed live by
 * `tests/providers/local/sqlite3-nested-write.test.ts`'s seven
 * `delegated nested update — JSON write envelope` cells.
 */

class CapturingDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;
  readonly calls: { sql: string; params: unknown[] }[] = [];
  constructor(adapter: DatabaseAdapter, dialect: Dialect) {
    super(dialect, `parity-assignments-${dialect}`);
    this.adapter = adapter;
  }
  protected async initClient() {
    return null;
  }
  protected async closeClient() {
    // The capture owns no provider resource.
  }
  protected async execute<T>(
    _client: null,
    sql: string,
    params: unknown[]
  ): Promise<{ rows: T[]; rowCount: number }> {
    this.calls.push({ sql, params });
    // One row that satisfies every projection in this file's two models, so
    // the capture exercises the WRITE path rather than a missing-row refusal.
    return {
      rows: [{ id: 1, name: "p", score: 3, payload: null, ownerId: null } as T],
      rowCount: 1,
    };
  }
  protected async executeRaw<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }
  protected async transaction<T>(
    _client: null,
    fn: (client: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

const person = s
  .model({
    id: s.int().id(),
    name: s.string(),
    accounts: s.toMany(() => account),
  })
  .map("parity_assignments_people");

const account = s
  .model({
    id: s.int().id(),
    score: s.int(),
    payload: s.json().nullable(),
    ownerId: s.int().nullable(),
    owner: s
      .toOne(() => person)
      .fields("ownerId")
      .references("id"),
  })
  .map("parity_assignments_accounts");

const schema = { person, account };
hydrateSchemaNames(schema);

/** The one document that is also the update envelope's own spelling. */
const ADVERSARIAL = { set: { z: 1 }, increment: 4 };

/** The registered relation-key refusal, named once. */
const RELATION_KEY_REFUSAL = /Cannot update relation key field 'ownerId'/;

function world(dialect: Dialect = "sqlite") {
  const driver = new CapturingDriver(
    dialect === "postgresql" ? new PostgresAdapter() : new SQLiteAdapter(),
    dialect
  );
  return { driver, client: createClient({ schema, driver }) };
}

const parameters = (driver: CapturingDriver, verb: string): unknown[] =>
  driver.calls.find((call) => call.sql.startsWith(verb))?.params ?? [];

describe("the update language is consumed once", () => {
  test("a JSON document that LOOKS like the envelope crosses verbatim", async () => {
    const { driver, client } = world();
    await client.account.update({
      where: { id: 1 },
      data: { payload: ADVERSARIAL },
    });
    await client.$disconnect();
    // The admitted payload is `{ set: <document> }`; the one interpreter
    // resolves it, and the document — including its own `set` key — is what is
    // bound.
    expect(parameters(driver, "UPDATE")).toContainEqual(
      JSON.stringify(ADVERSARIAL)
    );
  });

  test("…and so does the same document on the create route", async () => {
    const { driver, client } = world();
    await client.account.create({
      data: { id: 2, score: 1, payload: ADVERSARIAL },
    });
    await client.$disconnect();
    expect(parameters(driver, "INSERT")).toContainEqual(
      JSON.stringify(ADVERSARIAL)
    );
  });

  test("an operator still compiles to the provider's arithmetic", async () => {
    const { driver, client } = world();
    await client.account.update({
      where: { id: 1 },
      data: { score: { increment: 2 } },
    });
    await client.$disconnect();
    const update = driver.calls.find((call) => call.sql.startsWith("UPDATE"));
    expect(update?.sql).toContain('"score" = "score" + ?');
    expect(update?.params).toContain(2);
  });

  test("…on the RECORD route too, where Assignments holds the payload", async () => {
    // Naming a relation takes the update off the set-oriented fold and through
    // `Assignments` — the route where the payload used to be unwrapped at
    // storage time and interpreted a second time.
    const { driver, client } = world();
    await client.account.update({
      where: { id: 1 },
      data: {
        score: { increment: 2 },
        payload: ADVERSARIAL,
        owner: { connect: { id: 1 } },
      },
    });
    await client.$disconnect();
    const update = driver.calls.find((call) => call.sql.startsWith("UPDATE"));
    expect(update?.sql).toContain('"score" = "score" + ?');
    expect(update?.params).toContain(2);
    expect(update?.params).toContainEqual(JSON.stringify(ADVERSARIAL));
  });

  test("a relation key still refuses an operator while a relation is written", async () => {
    const { client } = world();
    await expect(
      client.account.update({
        where: { id: 1 },
        data: {
          ownerId: { increment: 1 },
          owner: { connect: { id: 1 } },
        },
      })
    ).rejects.toThrow(RELATION_KEY_REFUSAL);
    await client.$disconnect();
  });

  test("…and still accepts the `{ set: … }` spelling the sentence names", async () => {
    const { driver, client } = world();
    await client.account.update({
      where: { id: 1 },
      data: { ownerId: { set: 7 }, score: { increment: 1 } },
    });
    await client.$disconnect();
    expect(parameters(driver, "UPDATE")).toContain(7);
  });
});
