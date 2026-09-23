import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { DbNull, JsonNull } from "@schema/json-null";
import { s } from "@schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

/**
 * Repair-2 review. `common.md` makes refusals contracts. This is the JSON
 * sentinel-with-path refusal, asked of both engines over the same data.
 */
const doc = s
  .model({
    id: s.int().id(),
    profile: s.json().nullable(),
  })
  .map("fu2_docs");

const schema = { doc };

function build(): { db: Database.Database; driver: SQLite3Driver } {
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE fu2_docs(id INTEGER PRIMARY KEY, profile TEXT);
     INSERT INTO fu2_docs VALUES (1,'{"a":null}'),(2,NULL),(3,'null');`
  );
  return { db, driver: new SQLite3Driver({ client: db }) };
}

async function bothOutcomes(
  args: Record<string, unknown>
): Promise<{ shipped: unknown; candidate: unknown }> {
  const left = build();
  const right = build();
  const capture = async (run: () => unknown): Promise<unknown> => {
    try {
      return { ok: await run() };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
  try {
    const client = createClient({ schema, driver: left.driver }) as unknown as {
      doc: { findMany: (input: unknown) => unknown };
    };
    const engine = createCommandEngine({ schema, driver: right.driver });
    return {
      shipped: await capture(() => client.doc.findMany(args)),
      candidate: await capture(() => engine.execute("doc", "findMany", args)),
    };
  } finally {
    await left.driver.disconnect();
    left.db.close();
    await right.driver.disconnect();
    right.db.close();
  }
}

describe("G4-01 repair 2 review — the JSON sentinel-with-path refusal", () => {
  for (const [label, sentinel] of [
    ["DbNull", DbNull],
    ["JsonNull", JsonNull],
  ] as [string, unknown][])
    it(`words the path + ${label} refusal the way the shipped engine words it`, async () => {
      const seen = await bothOutcomes({
        where: { profile: { path: ["a"], equals: sentinel } },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      assert.deepEqual(
        seen.candidate,
        seen.shipped,
        `${label}\n  candidate ${JSON.stringify(seen.candidate)}\n  shipped   ${JSON.stringify(seen.shipped)}`
      );
    });

  it("agrees on a path with a plain equals: null", async () => {
    const seen = await bothOutcomes({
      where: { profile: { path: ["a"], equals: null } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    assert.deepEqual(
      seen.candidate,
      seen.shipped,
      `candidate ${JSON.stringify(seen.candidate)}\nshipped ${JSON.stringify(seen.shipped)}`
    );
  });
});
