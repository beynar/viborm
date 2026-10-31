/**
 * viborm/ordering and how rows are named, on in-memory SQLite: compound and
 * secondary unique inputs in move, a stored key read back by a nested foreign
 * key, whole lists respaced by rekey, per-call controls. From the adversarial
 * review of PR #127.
 */

import { createClient } from "@client/client";
import { s } from "@schema";
import { ordering, orderingKey } from "@src/ordering";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";

test("compound unique anchor is accepted by move", async () => {
  const card = s
    .model({
      tenant: s.string(),
      local: s.string(),
      rank: s.string().schema(orderingKey),
    })
    .id(["tenant", "local"]);
  const base = createClient({
    schema: { card },
    driver: createInMemorySQLite3Driver(),
  });
  await syncLiveSchema(base);
  const db = ordering({ card: { key: "rank", within: ["tenant"] } })(base);
  await db.card.createMany({
    data: [
      { tenant: "t", local: "a" },
      { tenant: "t", local: "b" },
      { tenant: "t", local: "c" },
    ],
  });
  await db.card.move({
    where: { tenant_local: { tenant: "t", local: "a" } },
    after: { tenant_local: { tenant: "t", local: "b" } },
  });
  expect((await db.card.findMany()).map((x) => x.local)).toEqual([
    "b",
    "a",
    "c",
  ]);
  await base.$disconnect();
});

test("rekey where selects complete matched lists", async () => {
  const card = s.model({
    id: s.string().id(),
    group: s.string(),
    rank: s.string().schema(orderingKey),
  });
  const base = createClient({
    schema: { card },
    driver: createInMemorySQLite3Driver(),
  });
  await syncLiveSchema(base);
  const db = ordering({ card: { key: "rank", within: ["group"] } })(base);
  await db.card.createMany({
    data: [
      { id: "a", group: "g", rank: "15" },
      { id: "b", group: "g", rank: "16" },
      { id: "c", group: "g", rank: "17" },
    ],
  });
  await db.card.rekey({ where: { id: "b" } });
  expect((await db.card.findMany()).map((x) => x.id)).toEqual(["a", "b", "c"]);
  await base.$disconnect();
});

test("generated rank used as a nested foreign key is its stored value", async () => {
  const parent = s.model({
    id: s.string().id(),
    rank: s.string().unique().schema(orderingKey),
    children: s.toMany(() => child),
  });
  const child = s.model({
    id: s.string().id(),
    parentRank: s.string(),
    parent: s
      .toOne(() => parent)
      .fields("parentRank")
      .references("rank"),
  });
  const base = createClient({
    schema: { parent, child },
    driver: createInMemorySQLite3Driver(),
  });
  await syncLiveSchema(base);
  const db = ordering({ parent: { key: "rank" } })(base);
  const result = await db.parent.create({
    data: { id: "p", children: { create: { id: "c" } } },
    include: { children: true },
  });
  expect(result.children[0]?.parentRank).toBe(result.rank);
  await base.$disconnect();
});

test("secondary unique anchor resolves even when not selected by the helper", async () => {
  const card = s.model({
    id: s.string().id(),
    slug: s.string().unique(),
    rank: s.string().schema(orderingKey),
  });
  const base = createClient({
    schema: { card },
    driver: createInMemorySQLite3Driver(),
  });
  await syncLiveSchema(base);
  const db = ordering({ card: { key: "rank" } })(base);
  await db.card.createMany({
    data: [
      { id: "a", slug: "aa" },
      { id: "b", slug: "bb" },
      { id: "c", slug: "cc" },
    ],
  });
  await db.card.move({ where: { id: "a" }, after: { slug: "bb" } });
  expect((await db.card.findMany()).map((x) => x.id)).toEqual(["b", "a", "c"]);
  await base.$disconnect();
});

test("equal DateTime list values preserve createMany array order", async () => {
  const card = s.model({
    id: s.string().id(),
    at: s.dateTime(),
    rank: s.string().schema(orderingKey),
  });
  const base = createClient({
    schema: { card },
    driver: createInMemorySQLite3Driver(),
  });
  await syncLiveSchema(base);
  const db = ordering({ card: { key: "rank", within: ["at"] } })(base);
  const data = Array.from({ length: 20 }, (_, i) => ({
    id: String(i).padStart(2, "0"),
    at: new Date("2026-10-31T00:00:00Z"),
  }));
  await db.card.createMany({ data });
  expect((await db.card.findMany()).map((x) => x.id)).toEqual(
    data.map((x) => x.id)
  );
  await base.$disconnect();
});

test("rekey forwards required per-call controls to updates", async () => {
  const card = s.model({
    id: s.string().id(),
    rank: s.string().schema(orderingKey),
  });
  const base = createClient({
    schema: { card },
    driver: createInMemorySQLite3Driver(),
  });
  await syncLiveSchema(base);
  await base.card.createMany({
    data: [
      { id: "a", rank: "15" },
      { id: "b", rank: "15" },
    ],
  });
  const keys = ordering({ card: { key: "rank" } }).keys(base);
  const controlled = keys.$extends({
    name: "required-mode",
    controls: { mode: { oneOf: ["yes"], required: true } },
  });
  const db = ordering({ card: { key: "rank" } }).methods(controlled);
  await (db.card.rekey as (args: object) => PromiseLike<unknown>)({
    mode: "yes",
  });
  expect((await base.card.findMany())[0]?.rank).not.toBe("15");
  await base.$disconnect();
});
