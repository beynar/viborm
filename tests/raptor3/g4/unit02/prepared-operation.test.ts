/**
 * G4-02 — the prepared operation boundary (brief item 8, g4/unit03 blocker B-1)
 * and packageable reads (item 12, divergence D-2).
 *
 * `prepare()` admits once and publishes the one prepared read shape and
 * cardinality the client lifecycle needs BEFORE the statement runs; `execute`
 * and `prepareBatch` are its callers.
 */

import assert from "node:assert/strict";
import { SQLite3Driver } from "@drivers/sqlite3";
import { NotFoundError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import type { ReadOperation } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import v from "@validation/primitives/v";
import Database from "better-sqlite3";
import { createClient } from "@client/client";
import { afterEach, describe, it } from "vitest";
import { createWorld, worldSchema, type World } from "./world";

let world: World | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

describe("G4-02 prepared operation boundary", () => {
  it("admits exactly once however many times the handle is asked", async () => {
    let transforms = 0;
    const note = s
      .model({
        id: s.int().id(),
        label: s.string().schema(
          v.string({
            transform(value) {
              transforms++;
              return value;
            },
          })
        ),
      })
      .map("g4u2_prepared_notes");
    const schema = { note };
    const database = new Database(":memory:");
    const driver = new SQLite3Driver({ client: database });
    const client = createClient({ schema, driver });
    try {
      assert.equal((await syncLiveSchema(client)).applied, true);
      const engine = createCommandEngine({ schema, driver });
      const prepared = engine.prepare("note", "create", {
        data: { id: 1, label: "once" },
      });
      assert.deepEqual(prepared.args.data, { id: 1, label: "once" });
      assert.deepEqual(prepared.args.data, { id: 1, label: "once" });
      const value = await prepared.execute();
      assert.deepEqual(value, { id: 1, label: "once" });
      assert.equal(transforms, 1);
    } finally {
      await client.$disconnect();
      database.close();
    }
  });

  it("publishes the prepared read shape and cardinality before the statement runs", async () => {
    world = await createWorld();
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    const prepared = engine.prepare("author", "findUnique", {
      where: { id: 1 },
      select: { id: true, name: true },
    });
    world.driver.reset();
    assert.ok(prepared.read);
    assert.equal(prepared.read.single, true);
    const shape = prepared.read.shape;
    assert.equal(shape.kind, "object");
    assert.deepEqual(
      Object.keys(shape.kind === "object" ? shape.fields : {}),
      ["id", "name"]
    );
    // Publishing the shape reaches no provider.
    assert.equal(world.driver.statements.length, 0);
    assert.deepEqual(await prepared.execute(), { id: 1, name: "Ada" });
    assert.equal(world.driver.statements.length, 1);

    const many = engine.prepare("author", "findMany", {});
    assert.equal(many.read?.single, false);
  });

  it("the published facts describe the value every read verb actually publishes", async () => {
    world = await createWorld();
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    // EVERY admitted read verb, not a sample: the published facts are what a
    // cache codec is built from, so a verb whose public value is NOT the row
    // (`count` publishes a number, `exist` a boolean) must say so here.
    const requests: readonly (readonly [ReadOperation, unknown])[] = [
      ["findUnique", { where: { id: 1 } }],
      ["findFirst", {}],
      ["findMany", {}],
      ["count", {}],
      ["count", { select: { id: true } }],
      ["exist", {}],
      ["aggregate", { _count: true }],
      ["groupBy", { by: ["age"], _count: true }],
    ];
    for (const [operation, request] of requests) {
      const prepared = engine.prepare("author", operation, request);
      const published = await prepared.execute();
      const facts = prepared.read;
      assert.ok(facts, `${operation} published no prepared read`);
      const rowLike =
        published !== null &&
        typeof published === "object" &&
        !Array.isArray(published);
      assert.equal(
        facts.single,
        rowLike,
        `${operation}: read.single=${facts.single} but the published value is ${
          Array.isArray(published) ? "an array" : typeof published
        }`
      );
      assert.equal(
        typeof facts.empty,
        typeof published,
        `${operation}: read.empty is a ${typeof facts.empty} but the published value is a ${typeof published}`
      );
      assert.equal(
        Array.isArray(facts.empty),
        Array.isArray(published),
        `${operation}: read.empty and the published value disagree about the set`
      );
    }
  });

  it("a pure read is statically packageable", async () => {
    world = await createWorld();
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    const packaged = await engine.prepareBatch("author", "findMany", {
      where: { id: 1 },
      select: { id: true, name: true },
    });
    assert.ok(packaged, "a pure read must be packageable");
    assert.equal(packaged.queries.length, 1);
    assert.match(packaged.queries[0]?.sql ?? "", /^SELECT\b/);
    const rows = await world.driver._executeBatch(packaged.queries);
    assert.deepEqual(packaged.parseResult(rows), [{ id: 1, name: "Ada" }]);
  });

  it("a packaged OrThrow read keeps the not-found identity in its parser", async () => {
    world = await createWorld();
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    const packaged = await engine.prepareBatch("author", "findUniqueOrThrow", {
      where: { id: 99 },
      select: { id: true },
    });
    assert.ok(packaged);
    const rows = await world.driver._executeBatch(packaged.queries);
    assert.throws(() => packaged.parseResult(rows), NotFoundError);
  });
});
