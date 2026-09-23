/**
 * G4-02 phase-2 review — operator-named keys inside a JSON document.
 *
 * `prepareUpdate` now interprets `push`/`unshift`/`multiply`/`divide`/
 * `decrement` as operators on any plain admitted record. A JSON column's value
 * IS a plain record, so a document whose top-level key happens to be one of the
 * new operator names is the shape that separates "one interpreter of an
 * admitted payload" from "a second reading of a whole value". The shipped
 * engine is the oracle.
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const doc = s
  .model({
    id: s.int().id(),
    payload: s.json(),
    labels: s.string().array(),
  })
  .map("r2_docs");
const schema = { doc };

async function update(
  data: unknown,
  engine: "shipped" | "candidate"
): Promise<string> {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const client = createClient({ schema, driver });
  assert.equal((await syncLiveSchema(client)).applied, true);
  const candidate = createCommandEngine({ schema, driver });
  await (
    client as unknown as Record<
      string,
      { create(args: unknown): Promise<unknown> }
    >
  ).doc!.create({ data: { id: 1, payload: { seed: true }, labels: ["a"] } });
  let answer: string;
  try {
    const value =
      engine === "shipped"
        ? await (
            client as unknown as Record<
              string,
              { update(args: unknown): Promise<unknown> }
            >
          ).doc!.update({ where: { id: 1 }, data })
        : await candidate.execute("doc", "update", { where: { id: 1 }, data });
    answer = `ok:${JSON.stringify(value)}`;
  } catch (error) {
    answer = `${(error as Error).constructor.name}: ${(error as Error).message.slice(0, 120)}`;
  }
  await client.$disconnect();
  database.close();
  return answer;
}

describe("G4-02 review — a JSON document that spells an operator name", () => {
  for (const [name, data] of [
    ["push", { payload: { push: 1 } }],
    ["multiply", { payload: { multiply: 2 } }],
    ["unshift", { payload: { unshift: "x" } }],
    ["divide", { payload: { divide: 0 } }],
    ["set inside a document", { payload: { set: { nested: 1 } } }],
    ["a real list push", { labels: { push: "b" } }],
    ["a real list set", { labels: { set: ["z"] } }],
  ] as const) {
    it(`${name}: the candidate answers what the shipped engine answers`, async () => {
      const shipped = await update(data, "shipped");
      const candidate = await update(data, "candidate");
      assert.equal(
        candidate,
        shipped,
        `candidate ${candidate}\nshipped   ${shipped}`
      );
    });
  }
});
