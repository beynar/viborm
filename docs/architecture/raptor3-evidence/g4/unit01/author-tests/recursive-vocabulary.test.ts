import assert from "node:assert/strict";
import { SQLite3Driver } from "@drivers/sqlite3";
import { OperationContext } from "@query-engine/raptor3/shared/operation-context";
import type { Queries } from "@query-engine/raptor3/shared/query";
import { EngineSchema, type Input } from "@query-engine/raptor3/shared/schema";
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
  return { database, driver, engineSchema: new EngineSchema(schema) };
}

interface RecursiveQueries {
  recursive(
    model: typeof node,
    traversal: {
      seeds: readonly { args: Record<string, unknown> }[];
      relation: string;
      depth: number;
      args?: Record<string, unknown>;
    }
  ): Parameters<OperationContext["read"]>[0];
}

describe("G4-01 recursive-read fit keeps the fuller codec vocabulary (RF-16)", () => {
  it("decodes decimal, DateTime and list leaves at every occurrence", async () => {
    const world = createWorld();
    try {
      const context = new OperationContext(
        world.engineSchema,
        world.driver,
        "node",
        "findMany"
      );
      const queries = context.queries as Queries & RecursiveQueries;
      const query = queries.recursive(node, {
        seeds: [{ args: { where: { id: 1 } } }],
        relation: "children",
        depth: 8,
        args: { orderBy: { id: "asc" } },
      });
      const rows = (await context.run(() => context.read(query))) as Input[];
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
    } finally {
      await world.driver.disconnect();
      world.database.close();
    }
  });
});
