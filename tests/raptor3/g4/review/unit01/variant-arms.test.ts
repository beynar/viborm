import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

/** Q-S03 / Q-W10 probe: an ARM SUBSET and a to-many arm window. */
const article = s
  .model({ id: s.int().id(), title: s.string() })
  .map("rv_articles");
const clip = s.model({ id: s.int().id(), title: s.string() }).map("rv_clips");
const remark = s
  .model({
    id: s.int().id(),
    body: s.string(),
    subject: s
      .toOne(
        { article: () => article, clip: () => clip },
        { values: { article: "c.article.v1", clip: "c.clip.v1" } }
      )
      .name("subject")
      .optional(),
  })
  .map("rv_remarks");

const schema = { article, clip, remark };

function createWorld() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE rv_articles(id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE rv_clips(id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE rv_remarks(
      id INTEGER PRIMARY KEY,
      body TEXT NOT NULL,
      subject_type TEXT,
      subject_id INTEGER
    );
    INSERT INTO rv_articles VALUES (1, 'A one');
    INSERT INTO rv_clips VALUES (1, 'C one');
    INSERT INTO rv_remarks VALUES (1, 'on article', 'c.article.v1', 1);
    INSERT INTO rv_remarks VALUES (2, 'on clip', 'c.clip.v1', 1);
    INSERT INTO rv_remarks VALUES (3, 'loose', NULL, NULL);
  `);
  const driver = new SQLite3Driver({ client: database });
  return {
    database,
    driver,
    engine: createCommandEngine({ schema, driver }),
    client: createClient({ schema, driver }) as any,
  };
}

describe("G4-01 review — variant arms", () => {
  it("projects only the requested arm and leaves the other slot null", async () => {
    const world = createWorld();
    try {
      const rows = (await world.engine.execute("remark", "findMany", {
        orderBy: { id: "asc" },
        select: { id: true, subject: { article: { select: { title: true } } } },
      })) as Record<string, unknown>[];
      assert.deepEqual(rows, [
        { id: 1, subject: { type: "article", data: { title: "A one" } } },
        { id: 2, subject: null },
        { id: 3, subject: null },
      ]);
    } finally {
      await world.driver.disconnect();
      world.database.close();
    }
  });

  it("agrees with the shipped engine on a full variant projection", async () => {
    const world = createWorld();
    try {
      const candidate = await world.engine.execute("remark", "findMany", {
        orderBy: { id: "asc" },
        select: { id: true, subject: true },
      });
      const shipped = await world.client.remark.findMany({
        orderBy: { id: "asc" },
        select: { id: true, subject: true },
      });
      assert.deepEqual(candidate, shipped);
    } finally {
      await world.driver.disconnect();
      world.database.close();
    }
  });
});
