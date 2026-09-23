import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

/**
 * Q-W01 probe. `AND` / `OR` / `NOT` each accept ONE object OR an array of them
 * (`src/validation/model/core/where.ts:70`). `NOT: [c1, c2]` is
 * `NOT c1 AND NOT c2` (`builders/where-builder.ts:281-311`).
 */
const item = s
  .model({ id: s.int().id(), label: s.string(), rank: s.int() })
  .map("lf_items");

const schema = { item };

function database(): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE lf_items(id INTEGER PRIMARY KEY, label TEXT NOT NULL, rank INTEGER NOT NULL)");
  const insert = db.prepare("INSERT INTO lf_items(id, label, rank) VALUES (?, ?, ?)");
  insert.run(1, "a", 1);
  insert.run(2, "b", 2);
  insert.run(3, "c", 3);
  return db;
}

async function bothEngines(
  where: Record<string, unknown>
): Promise<{ shipped: number[]; candidate: number[] }> {
  const shippedDb = database();
  const shippedDriver = new SQLite3Driver({ client: shippedDb });
  const candidateDb = database();
  const candidateDriver = new SQLite3Driver({ client: candidateDb });
  try {
    const client = createClient({ schema, driver: shippedDriver }) as any;
    const shipped = (await client.item.findMany({
      where,
      orderBy: { id: "asc" },
      select: { id: true },
    })) as { id: number }[];
    const engine = createCommandEngine({ schema, driver: candidateDriver });
    const candidate = (await engine.execute("item", "findMany", {
      where,
      orderBy: { id: "asc" },
      select: { id: true },
    })) as { id: number }[];
    return {
      shipped: shipped.map((r) => r.id),
      candidate: candidate.map((r) => r.id),
    };
  } finally {
    await shippedDriver.disconnect();
    shippedDb.close();
    await candidateDriver.disconnect();
    candidateDb.close();
  }
}

describe("G4-01 review — logical combinator forms", () => {
  it("negates each arm of an array NOT and ANDs the negations", async () => {
    const { shipped, candidate } = await bothEngines({
      NOT: [{ label: "a" }, { rank: 3 }],
    });
    assert.deepEqual(shipped, [2]);
    assert.deepEqual(candidate, shipped);
  });

  it("accepts an array AND and an array OR", async () => {
    const and = await bothEngines({ AND: [{ rank: { gte: 2 } }, { label: "b" }] });
    assert.deepEqual(and.shipped, [2]);
    assert.deepEqual(and.candidate, and.shipped);
    const or = await bothEngines({ OR: [{ label: "a" }, { rank: 3 }] });
    assert.deepEqual(or.shipped, [1, 3]);
    assert.deepEqual(or.candidate, or.shipped);
  });

  it("agrees on empty logical arrays", async () => {
    const or = await bothEngines({ OR: [] });
    assert.deepEqual(or.candidate, or.shipped);
    const and = await bothEngines({ AND: [] });
    assert.deepEqual(and.candidate, and.shipped);
  });
});
