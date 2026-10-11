/**
 * engine-08 — a counter upsert is ONE `INSERT … ON CONFLICT DO UPDATE`.
 *
 * The targeted fold (`Commands.#rootUpsert` → `OperationContext.upsertOne`)
 * served set-only update arms; an arm that increments, decrements, multiplies
 * or divides took the probe-first form: 3 statements to insert and 4 to update
 * on 1.1.0 (`docs/architecture/status-1.1.0.md`, `track-a/engine-08`). The
 * fold now names the conflicting row's own column on the right-hand side
 * (`"visits" = "<table>"."visits" + $n`): PostgreSQL also sees `excluded` there,
 * so a bare column is ambiguous.
 *
 * Every answer is checked against the multi-statement route on a twin row —
 * `create` for the insert arm, `update` for the found arm — including the
 * null-strict arithmetic of a NULL column. The shapes the fold cannot spell (an
 * exact decimal's rounding multiply, a list operator) keep that route and its
 * answer.
 */

import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { instrumentation } from "@instrumentation/extension";
import { s } from "@schema";
import { sql } from "@sql";
import {
  type PGliteSchemaFamily,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeEach, describe, expect, test } from "vitest";

const counter = s
  .model({
    id: s.int().id(),
    email: s.string().unique(),
    visits: s.int().default(0),
    bonus: s.int().nullable(),
    ratio: s.number().default(1),
    credit: s.decimal({ precision: 10, scale: 2 }).default("0.00"),
    tags: s.string().array(),
  })
  .map("e08_counters");
const schema = { counter };

const ON_CONFLICT_QUALIFIED = /ON CONFLICT.*"e08_counters"\."visits"/;

/** The arithmetic every operator spells over a row, null column included. */
const counterUpdate = {
  visits: { increment: 2 },
  bonus: { increment: 5 },
  ratio: { multiply: 3 },
  credit: { decrement: "1.25" },
} as const;

type Client = PGliteSchemaFamily<typeof schema>["client"];

function recorded(base: Client) {
  const statements: string[] = [];
  const client = base.$extends(
    instrumentation({
      logging: {
        includeSql: true,
        query: (event) => {
          statements.push(String(event.sql ?? ""));
        },
      },
    })
  );
  return {
    client,
    async count<T>(run: () => Promise<T>) {
      statements.length = 0;
      const result = await run();
      return { result, statements: [...statements] };
    },
  };
}

const plain = (row: unknown) => JSON.parse(JSON.stringify(row));

function counterCells(substrate: () => Client) {
  const seed = async (client: Client) => {
    await client.counter.createMany({
      data: Array.from({ length: 200 }, (_, i) => ({
        id: i + 1,
        email: `seed${i + 1}@x.io`,
        tags: [],
      })),
    });
  };
  const create = (id: number, email: string) => ({
    id,
    email,
    visits: 1,
    bonus: null,
    ratio: 2,
    credit: "10.50",
    tags: ["a"],
  });

  test("insert path and update path are each ONE statement, answering as create and update do", async () => {
    const { client, count } = recorded(substrate());
    await seed(client);
    const upsert = () =>
      client.counter.upsert({
        where: { email: "counter@x.io" },
        create: create(1001, "counter@x.io"),
        update: counterUpdate,
      });

    const inserted = await count(upsert);
    expect(inserted.statements).toHaveLength(1);
    const twin = await client.counter.create({
      data: create(1002, "twin@x.io"),
    });
    expect(plain({ ...inserted.result, id: 0, email: "" })).toEqual(
      plain({ ...twin, id: 0, email: "" })
    );

    const updated = await count(upsert);
    expect(updated.statements).toHaveLength(1);
    expect(updated.statements[0]).toMatch(ON_CONFLICT_QUALIFIED);
    const twinUpdated = await client.counter.update({
      where: { email: "twin@x.io" },
      data: counterUpdate,
    });
    expect(plain({ ...updated.result, id: 0, email: "" })).toEqual(
      plain({ ...twinUpdated, id: 0, email: "" })
    );
    // The NULL column stays NULL under increment, exactly as `update` leaves it.
    expect(updated.result).toMatchObject({ visits: 3, bonus: null, ratio: 6 });
    expect(String(updated.result.credit)).toBe("9.25");
  });

  test("an integer divide truncates as the multi-statement route does", async () => {
    const { client, count } = recorded(substrate());
    await client.counter.create({
      data: { ...create(1, "d@x.io"), visits: -7 },
    });
    await client.counter.create({
      data: { ...create(2, "twin@x.io"), visits: -7 },
    });
    const folded = await count(() =>
      client.counter.upsert({
        where: { email: "d@x.io" },
        create: create(1, "d@x.io"),
        update: { visits: { divide: 2 } },
      })
    );
    expect(folded.statements).toHaveLength(1);
    const twin = await client.counter.update({
      where: { email: "twin@x.io" },
      data: { visits: { divide: 2 } },
    });
    expect(folded.result.visits).toBe(twin.visits);
    expect(folded.result.visits).toBe(-3);
  });

  test("an exact decimal's rounding multiply and a list operator keep the multi-statement route", async () => {
    const { client, count } = recorded(substrate());
    await client.counter.create({ data: create(1, "r@x.io") });
    const rounding = await count(() =>
      client.counter.upsert({
        where: { email: "r@x.io" },
        create: create(1, "r@x.io"),
        update: { credit: { multiply: "1.5" } },
      })
    );
    expect(rounding.statements.length).toBeGreaterThan(1);
    expect(String(rounding.result.credit)).toBe("15.75");
    const listed = await count(() =>
      client.counter.upsert({
        where: { email: "r@x.io" },
        create: create(1, "r@x.io"),
        update: { tags: { push: ["b"] } },
      })
    );
    expect(listed.statements.length).toBeGreaterThan(1);
    expect(listed.result.tags).toEqual(["a", "b"]);
  });
}

describe("engine-08 counter upsert — SQLite", () => {
  let base: Client | undefined;
  beforeEach(async () => {
    await base?.$disconnect();
    const driver: AnyDriver = new SQLite3Driver();
    base = createClient({ schema, driver });
    await syncLiveSchema(base);
  });
  afterAll(async () => {
    await base?.$disconnect();
  });
  counterCells(() => base!);
});

describe("engine-08 counter upsert — PGlite", () => {
  const family = usePGliteSchemaFamily(schema);
  counterCells(() => family().client);
});

test("MySQL spells a counter's conflict update as ON DUPLICATE KEY UPDATE col = col + ?, and keeps its target-aware branch", () => {
  const mysql = new MySQLAdapter();
  const visits = mysql.identifiers.escape("visits");
  const clause = mysql.mutations.onConflict(
    null,
    mysql.mutations.onConflictUpdate(mysql.set.increment(visits, sql`${1}`))
  );
  expect(clause.toStatement()).toBe(
    "ON DUPLICATE KEY UPDATE `visits` = `visits` + ?"
  );
  // `ON DUPLICATE KEY UPDATE` fires on ANY unique collision, so the fold
  // stays off MySQL (`adapter-capabilities.ts`, `supportsTargetedUpsert`).
  expect(mysql.capabilities.supportsTargetedUpsert).toBe(false);
});
