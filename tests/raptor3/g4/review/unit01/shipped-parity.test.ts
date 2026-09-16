import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

/**
 * A broad differential probe: the SAME public arguments answered by the shipped
 * engine and by the candidate over identical data. Anything that differs is an
 * observable public-contract change.
 */
const owner = s
  .model({
    id: s.int().id(),
    name: s.string().map("owner_name"),
    tier: s.enum(["basic", "pro"]).nullable(),
    score: s.number().nullable(),
    things: s.toMany(() => thing).name("ownerThings"),
  })
  .map("sp_owners");

const thing = s
  .model({
    id: s.int().id(),
    ownerId: s.int().nullable().map("owner_id"),
    label: s.string(),
    rank: s.int(),
    bucket: s.string(),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id")
      .name("ownerThings"),
  })
  .map("sp_things");

const schema = { owner, thing };

function database(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sp_owners(id INTEGER PRIMARY KEY, owner_name TEXT NOT NULL, tier TEXT, score REAL);
    CREATE TABLE sp_things(id INTEGER PRIMARY KEY, owner_id INTEGER, label TEXT NOT NULL, rank INTEGER NOT NULL, bucket TEXT NOT NULL);
    INSERT INTO sp_owners VALUES (1,'Ada','pro',4.5),(2,'BOB','basic',NULL),(3,'cy',NULL,2.5);
    INSERT INTO sp_things VALUES
      (1,1,'alpha one',10,'a'),(2,1,'alpha two',20,'a'),(3,1,'beta',30,'b'),
      (4,2,'gamma',15,'b'),(5,NULL,'orphan',5,'c');
  `);
  return db;
}

async function parity(
  model: "owner" | "thing",
  operation: string,
  args: Record<string, unknown>
): Promise<void> {
  const shippedDb = database();
  const shippedDriver = new SQLite3Driver({ client: shippedDb });
  const candidateDb = database();
  const candidateDriver = new SQLite3Driver({ client: candidateDb });
  try {
    const client = createClient({ schema, driver: shippedDriver }) as any;
    const shipped = await client[model][operation](args);
    const engine = createCommandEngine({ schema, driver: candidateDriver });
    const candidate = await engine.execute(
      model,
      operation as Parameters<typeof engine.execute>[1],
      args
    );
    assert.deepEqual(
      candidate,
      shipped,
      `${model}.${operation}(${JSON.stringify(args)})\n  candidate ${JSON.stringify(candidate)}\n  shipped   ${JSON.stringify(shipped)}`
    );
  } finally {
    await shippedDriver.disconnect();
    shippedDb.close();
    await candidateDriver.disconnect();
    candidateDb.close();
  }
}

describe("G4-01 review — differential parity with the shipped engine", () => {
  it("findMany with include and nested window", async () => {
    await parity("owner", "findMany", {
      orderBy: { id: "asc" },
      include: { things: { orderBy: { rank: "asc" }, take: 2 } },
    });
  });

  it("findMany with select, omit and a to-one include", async () => {
    await parity("thing", "findMany", {
      orderBy: { id: "asc" },
      omit: { bucket: true },
      include: { owner: true },
    });
  });

  it("findMany with distinct, cursor and signed take", async () => {
    await parity("thing", "findMany", {
      orderBy: { rank: "asc" },
      distinct: ["bucket"],
    });
    await parity("thing", "findMany", {
      orderBy: { rank: "asc" },
      cursor: { id: 4 },
      take: 2,
    });
    await parity("thing", "findMany", {
      orderBy: { rank: "asc" },
      take: -2,
    });
  });

  it("findUnique and findFirst", async () => {
    await parity("thing", "findUnique", { where: { id: 3 } });
    await parity("thing", "findFirst", {
      where: { bucket: "b" },
      orderBy: { rank: "desc" },
    });
  });

  it("count, aggregate and groupBy", async () => {
    await parity("thing", "count", {});
    await parity("owner", "count", { select: { _all: true, score: true } });
    await parity("thing", "aggregate", {
      _count: true,
      _avg: { rank: true },
      _sum: { rank: true },
      _min: { label: true },
      _max: { rank: true },
    });
    await parity("thing", "groupBy", {
      by: ["bucket"],
      _count: true,
      _sum: { rank: true },
      orderBy: { bucket: "asc" },
    });
    await parity("thing", "groupBy", {
      by: ["bucket"],
      _count: true,
      having: { rank: { _sum: { gt: 20 } } },
      orderBy: { bucket: "asc" },
    });
  });

  it("relation filters and _count projection", async () => {
    await parity("owner", "findMany", {
      where: { things: { some: { bucket: "a" } } },
      orderBy: { id: "asc" },
      select: { id: true, _count: { select: { things: true } } },
    });
    await parity("owner", "findMany", {
      where: { things: { every: { rank: { gt: 5 } } } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    await parity("owner", "findMany", {
      where: { things: { none: {} } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
  });

  it("orders by a relation count and by a to-one path", async () => {
    await parity("owner", "findMany", {
      orderBy: [{ things: { _count: "desc" } }, { id: "asc" }],
      select: { id: true },
    });
    await parity("thing", "findMany", {
      orderBy: [{ owner: { name: "asc" } }, { id: "asc" }],
      select: { id: true },
    });
  });

  it("string modes and enum equality", async () => {
    await parity("owner", "findMany", {
      where: { name: { contains: "b", mode: "insensitive" } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    await parity("owner", "findMany", {
      where: { tier: "pro" },
      orderBy: { id: "asc" },
      select: { id: true, tier: true },
    });
    await parity("owner", "findMany", {
      where: { tier: null },
      orderBy: { id: "asc" },
      select: { id: true },
    });
  });
});
