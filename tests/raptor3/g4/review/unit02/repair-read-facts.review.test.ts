/**
 * G4-02 independent review, repair round — adversarial probes against the NEW
 * `publishedFacts` (review finding 5's repair).
 *
 * The repair deleted `publishesSingleRow` and now derives `{shape, single,
 * empty}` by calling `read.result([])` at PREPARE time. That makes the published
 * facts depend on a decoder invocation the round-1 code never made, on the
 * admission-first path the route will call before anything executes. These cells
 * attack it over a wider matrix than the author's own agreement check: relation
 * includes, nested selects, aggregates with every accumulator, `groupBy` with
 * `having`, `count` with a select, distinct and cursor forms, and the `…OrThrow`
 * verbs whose missing-row closure lives beside `result`.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";

const author = s
  .model({
    id: s.int().id(),
    name: s.string(),
    age: s.int(),
    posts: s.toMany(() => post),
  })
  .map("rv2f_authors");

const post = s
  .model({
    id: s.int().id(),
    title: s.string(),
    authorId: s.int().nullable(),
    author: s.toOne(() => author).fields("authorId").references("id"),
  })
  .map("rv2f_posts");

const schema = { author, post };

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function world() {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("schema did not apply");
  await client.author.createMany({
    data: [
      { id: 1, name: "Ada", age: 36 },
      { id: 2, name: "Bo", age: 41 },
    ],
  });
  await client.post.createMany({
    data: [
      { id: 10, title: "a", authorId: 1 },
      { id: 11, title: "b", authorId: 1 },
      { id: 12, title: "c", authorId: 2 },
    ],
  });
  const engine = createCommandEngine({ schema, driver });
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  return { database, driver, client, engine };
}

const matrix = [
  ["findUnique", { where: { id: 1 } }],
  ["findUnique", { where: { id: 999 } }],
  ["findUnique", { where: { id: 1 }, include: { posts: true } }],
  ["findUnique", { where: { id: 1 }, select: { posts: { select: { id: true } } } }],
  ["findUnique", { where: { id: 1 }, select: { _count: { select: { posts: true } } } }],
  ["findFirst", { orderBy: { age: "desc" } }],
  ["findFirst", { where: { age: { gt: 1000 } } }],
  ["findMany", {}],
  ["findMany", { take: 1, skip: 1, orderBy: { id: "asc" } }],
  ["findMany", { distinct: ["age"] }],
  ["findMany", { cursor: { id: 1 }, orderBy: { id: "asc" }, take: 1 }],
  ["findMany", { include: { posts: { take: 1, orderBy: { id: "asc" } } } }],
  ["count", {}],
  ["count", { where: { age: { gt: 1000 } } }],
  ["count", { select: { _all: true, age: true } }],
  ["exist", {}],
  ["exist", { where: { age: { gt: 1000 } } }],
  ["aggregate", { _count: true }],
  ["aggregate", { _avg: { age: true }, _sum: { age: true }, _min: { age: true }, _max: { age: true } }],
  ["groupBy", { by: ["age"], _count: true }],
  ["groupBy", { by: ["age"], _count: true, having: { age: { _min: { gt: 1000 } } } }],
] as const;

describe("G4-02 review (repair) — published read facts over a wide matrix", () => {
  it("prepare().read never throws and `single` agrees with the published value", async () => {
    const w = await world();
    const rows: Record<string, unknown>[] = [];
    const disagreements: string[] = [];
    for (const [operation, args] of matrix) {
      const label = `${operation} ${JSON.stringify(args)}`;
      let facts: { single: boolean; empty: unknown } | undefined;
      let factsError: string | undefined;
      try {
        const prepared = w.engine.prepare("author", operation, args);
        const read = prepared.read;
        assert.ok(read, `${label}: a read verb must publish facts`);
        assert.equal(
          prepared.read,
          read,
          `${label}: the facts object must be memoized`
        );
        facts = { single: read.single, empty: read.empty };
      } catch (error) {
        factsError = String(error);
      }
      let value: unknown;
      let valueError: string | undefined;
      try {
        value = await w.engine.execute("author", operation, args);
      } catch (error) {
        valueError = String(error);
      }
      const rowLike =
        value !== null && typeof value === "object" && !Array.isArray(value);
      rows.push({
        label,
        single: facts?.single,
        empty: facts?.empty,
        factsError,
        published: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
        valueError,
      });
      if (factsError) {
        disagreements.push(`${label}: prepare().read THREW ${factsError}`);
        continue;
      }
      if (valueError) continue;
      // `null` is what a missing single row publishes; the facts call it single.
      const publishedSingle = value === null ? true : rowLike;
      if (facts!.single !== publishedSingle)
        disagreements.push(
          `${label}: read.single=${facts!.single} but the published value is ${
            Array.isArray(value) ? "an array" : typeof value
          }`
        );
      // `empty` is what the read publishes for ZERO rows, so its KIND can only be
      // compared against a published value that IS the empty case.
      const isEmptyCase =
        value === null ||
        (Array.isArray(value) && value.length === 0) ||
        value === 0 ||
        value === false;
      if (!isEmptyCase) continue;
      const emptyKind = Array.isArray(facts!.empty)
        ? "array"
        : facts!.empty === null
          ? "null"
          : typeof facts!.empty;
      const valueKind = Array.isArray(value)
        ? "array"
        : value === null
          ? "null"
          : typeof value;
      if (emptyKind !== valueKind)
        disagreements.push(
          `${label}: read.empty is a ${emptyKind} but the published value is a ${valueKind}`
        );
    }
    // eslint-disable-next-line no-console
    console.log("WIDEREADFACTS", JSON.stringify(rows, undefined, 1));
    assert.deepEqual(disagreements, []);
  });

  it("the OrThrow verbs publish facts without raising the missing-row failure at prepare time", async () => {
    const w = await world();
    for (const [operation, args] of [
      ["findUniqueOrThrow", { where: { id: 999 } }],
      ["findFirstOrThrow", { where: { age: { gt: 1000 } } }],
    ] as const) {
      const prepared = w.engine.prepare("author", operation, args);
      const read = prepared.read;
      assert.ok(read, `${operation}: a read verb must publish facts`);
      assert.equal(read.single, true, `${operation}: single`);
      assert.equal(read.empty, null, `${operation}: empty`);
      await assert.rejects(
        () => w.engine.execute("author", operation, args),
        /NotFoundError|No author record found/,
        `${operation}: execution still raises the missing-row failure`
      );
    }
  });
});
