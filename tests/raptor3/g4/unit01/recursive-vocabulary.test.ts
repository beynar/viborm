/**
 * G4-01 RF-16 — recursive reads keep the fuller codec vocabulary.
 *
 * This cell once entered the retired private root-only `Queries.recursive`
 * through an `OperationContext`; that slice is gone
 * (features-docs/recursive-query.md §3.6). The same read is now an ordinary
 * `include` of the `children` relation modified by `recurse`, through the
 * command engine: decimal, DateTime and list leaves decode at every occurrence
 * exactly as they do in any other projection. Depth 8 still reaches every row;
 * the last row is a natural end before that cutoff, so it carries `[]`.
 */
import assert from "node:assert/strict";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import type { Input } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const node = s
  .model({
    id: s.int().id(),
    label: s.string(),
    amount: s.decimal({ precision: 10, scale: 2 }),
    seenAt: s.dateTime().map("seen_at"),
    tags: s.string().array(),
    parentId: s.int().nullable().map("parent_id"),
    parent: s.toOne(() => node).fields("parentId").references("id").name("tree"),
    children: s.toMany(() => node).name("tree"),
  })
  .map("g4_nodes");

const schema = { node };

function createWorld() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE g4_nodes(
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL,
      amount INTEGER NOT NULL,
      seen_at TEXT NOT NULL,
      tags TEXT NOT NULL,
      parent_id INTEGER
    );
  `);
  const insert = database.prepare(
    "INSERT INTO g4_nodes(id, label, amount, seen_at, tags, parent_id) VALUES (?, ?, ?, ?, ?, ?)"
  );
  insert.run(1, "root", 1000n, "2024-01-01T00:00:00.000Z", '["a"]', null);
  insert.run(2, "child", 250n, "2024-02-02T00:00:00.000Z", '["b","c"]', 1);
  insert.run(3, "grandchild", 25n, "2024-03-03T00:00:00.000Z", "[]", 2);
  const driver = new SQLite3Driver({ client: database });
  return { database, driver };
}

describe("G4-01 recursive reads keep the fuller codec vocabulary (RF-16)", () => {
  it("decodes decimal, DateTime and list leaves at every occurrence", async () => {
    const world = createWorld();
    try {
      const rows = (await createCommandEngine({
        schema,
        driver: world.driver,
      }).execute("node", "findMany", {
        where: { id: 1 },
        include: {
          children: { recurse: { depth: 8 }, orderBy: { id: "asc" } },
        },
      })) as Input[];
      assert.equal(rows.length, 1);
      const root = rows[0]!;
      assert.equal(root.label, "root");
      assert.equal(String(root.amount), "10");
      assert.ok(root.seenAt instanceof Date);
      assert.deepEqual(root.tags, ["a"]);
      const children = root.children as Input[];
      assert.equal(children.length, 1);
      assert.equal(String(children[0]!.amount), "2.5");
      assert.deepEqual(children[0]!.tags, ["b", "c"]);
      const grandchildren = children[0]!.children as Input[];
      assert.equal(String(grandchildren[0]!.amount), "0.25");
      assert.deepEqual(grandchildren[0]!.tags, []);
      assert.equal(
        (grandchildren[0]!.seenAt as Date).toISOString(),
        "2024-03-03T00:00:00.000Z"
      );
      assert.deepEqual(grandchildren[0]!.children, []);
    } finally {
      await world.driver.disconnect();
      world.database.close();
    }
  });
});
