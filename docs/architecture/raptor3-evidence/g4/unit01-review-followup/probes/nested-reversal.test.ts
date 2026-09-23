import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";
import { both } from "./world";

/** Finding 2 follow-up: every placement of a negative to-many window. */
const WINDOWS = `
  INSERT INTO fu_teams VALUES (1,'one'),(2,'two');
  INSERT INTO fu_members(id, team_id, member_name, rank, weight, bucket, active) VALUES
    (1,1,'a',1,1,'x',1),
    (2,1,'b',2,2,'x',1),
    (3,1,'c',3,3,'y',1),
    (4,2,'d',4,4,'x',1),
    (5,2,'e',5,5,'y',1),
    (6,2,'f',6,6,'y',1);
`;

async function parity(
  args: Record<string, unknown>,
  label: string
): Promise<unknown> {
  const { shipped, candidate } = await both(WINDOWS, "team", "findMany", args);
  assert.deepEqual(
    candidate,
    shipped,
    `${label}\n  candidate ${JSON.stringify(candidate)}\n  shipped   ${JSON.stringify(shipped)}`
  );
  return candidate;
}

describe("G4-01 follow-up — negative nested windows", () => {
  it("restores a negative nested window under include as well as select", async () => {
    const selected = await parity(
      {
        orderBy: { id: "asc" },
        select: {
          id: true,
          members: { orderBy: { rank: "asc" }, take: -2, select: { id: true } },
        },
      },
      "select take -2"
    );
    assert.deepEqual(selected, [
      { id: 1, members: [{ id: 2 }, { id: 3 }] },
      { id: 2, members: [{ id: 5 }, { id: 6 }] },
    ]);
    await parity(
      {
        orderBy: { id: "asc" },
        include: { members: { orderBy: { rank: "asc" }, take: -2 } },
      },
      "include take -2"
    );
  });

  it("restores a negative nested window combined with skip, distinct and a cursor", async () => {
    await parity(
      {
        orderBy: { id: "asc" },
        select: {
          id: true,
          members: {
            orderBy: { rank: "asc" },
            take: -2,
            skip: 1,
            select: { id: true },
          },
        },
      },
      "take -2 skip 1"
    );
    await parity(
      {
        orderBy: { id: "asc" },
        select: {
          id: true,
          members: {
            orderBy: { rank: "asc" },
            take: -2,
            distinct: ["bucket"],
            select: { id: true },
          },
        },
      },
      "take -2 distinct"
    );
    await parity(
      {
        orderBy: { id: "asc" },
        select: {
          id: true,
          members: {
            orderBy: { rank: "asc" },
            cursor: { id: 3 },
            take: -2,
            select: { id: true },
          },
        },
      },
      "take -2 cursor"
    );
  });

  it("restores a negative window at take -1 and at a window larger than the rows", async () => {
    await parity(
      {
        orderBy: { id: "asc" },
        select: {
          id: true,
          members: { orderBy: { rank: "asc" }, take: -1, select: { id: true } },
        },
      },
      "take -1"
    );
    await parity(
      {
        orderBy: { id: "asc" },
        select: {
          id: true,
          members: { orderBy: { rank: "asc" }, take: -9, select: { id: true } },
        },
      },
      "take -9"
    );
  });

  it("does not reverse a to-one relation that carries no window", async () => {
    const { shipped, candidate } = await both(
      WINDOWS,
      "member",
      "findMany",
      {
        orderBy: { id: "asc" },
        take: -2,
        select: { id: true, team: { select: { id: true } } },
      }
    );
    assert.deepEqual(candidate, shipped);
    assert.deepEqual(candidate, [
      { id: 5, team: { id: 2 } },
      { id: 6, team: { id: 2 } },
    ]);
  });
});

/** The variant-arm site shares the same shape owner; prove it on a junction. */
const shelfBook = s
  .model({ id: s.int().id(), title: s.string() })
  .map("fu_books");
const shelfClip = s
  .model({ id: s.int().id(), title: s.string() })
  .map("fu_clips");
const shelf = s
  .model({
    id: s.int().id(),
    label: s.string(),
    items: s
      .toMany(
        { book: () => shelfBook, clip: () => shelfClip },
        { values: { book: "fu.book.v1", clip: "fu.clip.v1" } }
      )
      .through({
        book: { table: "fu_shelf_books", source: "holder", target: "entry" },
        clip: { table: "fu_shelf_clips", source: "holder", target: "entry" },
      }),
  })
  .map("fu_shelves");
const variantSchema = { shelf, shelfBook, shelfClip };

function variantWorld() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE fu_books(id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE fu_clips(id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE fu_shelves(id INTEGER PRIMARY KEY, label TEXT NOT NULL);
    CREATE TABLE fu_shelf_books(holder INTEGER NOT NULL, entry INTEGER NOT NULL);
    CREATE TABLE fu_shelf_clips(holder INTEGER NOT NULL, entry INTEGER NOT NULL);
    INSERT INTO fu_books VALUES (1,'b1'),(2,'b2'),(3,'b3');
    INSERT INTO fu_clips VALUES (1,'c1');
    INSERT INTO fu_shelves VALUES (1,'shelf');
    INSERT INTO fu_shelf_books VALUES (1,1),(1,2),(1,3);
    INSERT INTO fu_shelf_clips VALUES (1,1);
  `);
  const driver = new SQLite3Driver({ client: database });
  return {
    database,
    driver,
    engine: createCommandEngine({ schema: variantSchema, driver }),
    client: createClient({ schema: variantSchema, driver }) as unknown as {
      shelf: { findMany: (args: unknown) => Promise<unknown> };
    },
  };
}

describe("G4-01 follow-up — a variant arm is the same shape owner", () => {
  it("restores a negative window inside a to-many variant arm", async () => {
    const shippedWorld = variantWorld();
    const candidateWorld = variantWorld();
    const args = {
      select: {
        id: true,
        items: {
          only: ["book"],
          variants: {
            book: { orderBy: { id: "asc" }, take: -2, select: { id: true } },
          },
        },
      },
    };
    try {
      const shipped = await shippedWorld.client.shelf.findMany(args);
      const candidate = await candidateWorld.engine.execute(
        "shelf",
        "findMany",
        args
      );
      assert.deepEqual(
        candidate,
        shipped,
        `variant arm take -2\n  candidate ${JSON.stringify(candidate)}\n  shipped   ${JSON.stringify(shipped)}`
      );
      // A to-many variant carrier answers a tagged list; the window is the
      // last two book rows, restored to ascending order.
      assert.deepEqual(candidate, [
        {
          id: 1,
          items: [
            { type: "book", data: { id: 2 } },
            { type: "book", data: { id: 3 } },
          ],
        },
      ]);
    } finally {
      await shippedWorld.driver.disconnect();
      shippedWorld.database.close();
      await candidateWorld.driver.disconnect();
      candidateWorld.database.close();
    }
  });
});
