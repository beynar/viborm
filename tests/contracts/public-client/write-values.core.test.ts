/**
 * The values a write computes, as a caller or an extension author writes
 * them through the public entry: `computed`, `stored`, and a model's `$sql`
 * (`viborm/ordering` is built on them, and its tests cover `joined`).
 */

import { computed, createClient, s, sql, stored } from "@src/index";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const schema = () => ({
  counter: s.model({
    id: s.string().id(),
    label: s.string(),
    hits: s.int().default(0),
    touchedAt: s.dateTime().updatedAt(),
  }),
});

describe("write values", () => {
  const opened: { $disconnect(): Promise<void> }[] = [];
  afterEach(async () => {
    for (const client of opened.splice(0)) await client.$disconnect();
  });
  async function open() {
    const db = createClient({
      schema: schema(),
      driver: createInMemorySQLite3Driver(),
    });
    opened.push(db);
    await syncLiveSchema(db);
    await db.counter.createMany({
      data: [
        { id: "a", label: "first", hits: 1 },
        { id: "b", label: "second", hits: 5 },
      ],
    });
    return db;
  }

  test("$sql spells the model's table, columns and values as the client's statements do", async () => {
    const db = await open();
    const q = db.counter.$sql;
    expect(q.dialect).toBe("sqlite");
    const rows = await db.$queryRaw<{ hits: number }[]>`
      SELECT ${q.column("hits", "c")} AS hits FROM ${q.table("c")}
      WHERE ${q.column("id", "c")} = ${q.value("id", "b")}
    `;
    expect(rows).toEqual([{ hits: 5 }]);
    expect(q.name("r", "k").toStatement()).toBe('"r"."k"');
  });

  test("computed: an update writes a value its statement computes, from the context's own spelling", async () => {
    const db = await open();
    const seen: unknown[] = [];
    const updated = await db.counter.update({
      where: { id: "a" },
      data: {
        hits: computed<number>((context) => {
          seen.push([context.model, context.field, context.dialect]);
          const q = context.sql;
          return [
            sql`(SELECT MAX(${q.column("hits", "m")}) + 1 FROM ${q.table("m")})`,
          ];
        }),
      },
    });
    expect(updated.hits).toBe(6);
    expect(seen).toEqual([["counter", "hits", "sqlite"]]);
  });

  test("stored: the update leaves a generated field as it is stored", async () => {
    const db = await open();
    const before = await db.counter.findUniqueOrThrow({ where: { id: "a" } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const kept = await db.counter.update({
      where: { id: "a" },
      data: { label: "kept", touchedAt: stored() },
    });
    expect(kept.label).toBe("kept");
    expect(kept.touchedAt).toEqual(before.touchedAt);
    const touched = await db.counter.update({
      where: { id: "a" },
      data: { label: "touched" },
    });
    expect(touched.touchedAt.getTime()).toBeGreaterThan(
      before.touchedAt.getTime()
    );
  });

  test("a filter's expression reads the rows the call may see through $sql.visible", async () => {
    const db = await open();
    const q = db.counter.$sql;
    const rows = await db.counter.findMany({
      where: {
        hits: {
          equals: () =>
            sql`(SELECT MAX(${q.column("hits", "v")}) FROM ${q.table("v")} WHERE ${q.visible("v")})`,
        },
      },
    });
    expect(rows.map((row) => row.id)).toEqual(["b"]);
  });
});
