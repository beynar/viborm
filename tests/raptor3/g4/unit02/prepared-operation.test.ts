/**
 * G4-02 — the prepared operation boundary (brief item 8, g4/unit03 blocker B-1)
 * and packageable reads (item 12, divergence D-2).
 *
 * `prepare()` admits once and publishes the one prepared read shape and
 * cardinality the client lifecycle needs BEFORE the statement runs; `execute`
 * and `prepareBatch` are its callers.
 */

// The route's cache codec belongs to the cache runtime `viborm/cache` loads.
import "@cache/runtime";
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { NotFoundError, ValidationError } from "@errors";
import { createCandidateRoute } from "@query-engine/raptor3/route/client-route";
import type { ReadOperation } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createTestCommandEngine } from "@tests/raptor3/harness/command-engine";
import v from "@validation/primitives/v";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { createWorld, type World, worldSchema } from "./world";

const SELECT_STATEMENT = /^SELECT\b/;
let world: World | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

describe("G4-02 prepared operation boundary", () => {
  it("keeps prepared and routed handles bound to their own client", async () => {
    world = await createWorld();
    const firstEngine = createTestCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    const request = { where: { id: 1 }, select: { name: true } };
    const firstPrepared = firstEngine.prepare("author", "findUnique", request);
    const firstPending = world.client.author.findUnique(request);
    // Prepare before another lineage exists, then execute after it has supplied
    // the same model identities with a different transport and row value.
    assert.ok(firstPrepared.read);
    const other = await createWorld();
    try {
      await other.client.author.update({
        where: { id: 1 },
        data: { name: "Other client" },
      });
      const secondEngine = createTestCommandEngine({
        schema: worldSchema,
        driver: other.driver,
      });
      const secondPrepared = secondEngine.prepare(
        "author",
        "findUnique",
        request
      );
      assert.deepEqual(await secondPrepared.execute(), {
        name: "Other client",
      });
      assert.deepEqual(await firstPrepared.execute(), { name: "Ada" });
      assert.deepEqual(await other.client.author.findUnique(request), {
        name: "Other client",
      });
      assert.deepEqual(await firstPending, { name: "Ada" });
      assert.deepEqual(await firstPrepared.execute(), { name: "Ada" });
    } finally {
      await other.close();
    }
  });

  it("rejects invalid prepared reads asynchronously before dispatch", async () => {
    world = await createWorld();
    const engine = createTestCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    const prepared = engine.prepare("author", "findMany", { take: "invalid" });
    world.driver.reset();

    const pending = prepared.execute();
    assert.ok(pending instanceof Promise);
    await assert.rejects(pending, ValidationError);
    assert.equal(world.driver.statements.length, 0);
  });

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
      const engine = createTestCommandEngine({ schema, driver });
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

  it("isolates admission, prepared reads, and cache codecs across concurrent handles and factories", async () => {
    world = await createWorld();
    const otherWorld = await createWorld();
    try {
      await otherWorld.client.author.update({
        where: { id: 1 },
        data: { name: "Grace" },
      });
      const route = createCandidateRoute(worldSchema, world.driver);
      const otherRoute = createCandidateRoute(worldSchema, otherWorld.driver);
      const requests = [
        {
          route,
          driver: world.driver,
          operation: "findUnique",
          args: { where: { id: 1 }, select: { name: true } },
          expected: { name: "Ada" },
        },
        {
          route,
          driver: world.driver,
          operation: "findMany",
          args: { where: { id: 2 }, select: { age: true } },
          expected: [{ age: 41 }],
        },
        {
          route: otherRoute,
          driver: otherWorld.driver,
          operation: "findUnique",
          args: { where: { id: 1 }, select: { name: true } },
          expected: { name: "Grace" },
        },
      ];
      world.driver.reset();
      otherWorld.driver.reset();
      const prepared = requests.map((request) => {
        const handle = request.route.operation(
          worldSchema.author,
          request.operation,
          request.args
        );
        const admitted = handle.preparedArgs;
        const statement = handle.buildStatement();
        const codec = handle.cacheResultCodec();
        assert.ok(statement);
        assert.deepEqual(admitted.select, request.args.select);
        return { request, handle, admitted, statement, codec };
      });
      assert.equal(new Set(prepared.map(({ admitted }) => admitted)).size, 3);
      assert.equal(new Set(prepared.map(({ statement }) => statement)).size, 3);
      assert.equal(new Set(prepared.map(({ codec }) => codec)).size, 3);
      assert.equal(world.driver.statements.length, 0);
      assert.equal(otherWorld.driver.statements.length, 0);

      await Promise.all(
        prepared.map(
          async ({ request, handle, admitted, statement, codec }) => {
            const value = await handle.execute({
              context: { model: "author", operation: request.operation },
              engineDriver: request.driver,
              driverOverride: undefined,
              isWrite: false,
              committedWriteSegment: undefined,
              writeMayBeVisible: undefined,
            });
            assert.deepEqual(value, request.expected);
            assert.deepEqual(
              codec.materialize(codec.snapshot(value)),
              request.expected
            );
            assert.equal(handle.preparedArgs, admitted);
            assert.equal(handle.buildStatement(), statement);
            assert.equal(handle.cacheResultCodec(), codec);
          }
        )
      );
      assert.equal(world.driver.statements.length, 2);
      assert.equal(otherWorld.driver.statements.length, 1);
    } finally {
      await otherWorld.close();
    }
  });

  it("publishes the prepared read shape and cardinality before the statement runs", async () => {
    world = await createWorld();
    const engine = createTestCommandEngine({
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
    assert.deepEqual(Object.keys(shape.kind === "object" ? shape.fields : {}), [
      "id",
      "name",
    ]);
    // Publishing the shape reaches no provider.
    assert.equal(world.driver.statements.length, 0);
    assert.deepEqual(await prepared.execute(), { id: 1, name: "Ada" });
    assert.equal(world.driver.statements.length, 1);

    const many = engine.prepare("author", "findMany", {});
    assert.equal(many.read?.single, false);
  });

  it("the published facts describe the value every read verb actually publishes", async () => {
    world = await createWorld();
    const engine = createTestCommandEngine({
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
    const engine = createTestCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    const packaged = await engine.prepareBatch("author", "findMany", {
      where: { id: 1 },
      select: { id: true, name: true },
    });
    assert.ok(packaged, "a pure read must be packageable");
    assert.equal(packaged.queries.length, 1);
    assert.match(packaged.queries[0]?.sql ?? "", SELECT_STATEMENT);
    const rows = await world.driver._executeBatch(packaged.queries);
    assert.deepEqual(packaged.parseResult(rows), [{ id: 1, name: "Ada" }]);
  });

  it("a packaged OrThrow read keeps the not-found identity in its parser", async () => {
    world = await createWorld();
    const engine = createTestCommandEngine({
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

  it("answers undefined for an operation that cannot be packaged, every time", async () => {
    world = await createWorld();
    const engine = createTestCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    // The incomplete-preparation sentinel is control flow, and `prepareBatch`
    // recognises it by IDENTITY inside its own `catch`. The sentinel is built
    // on first use and memoised, so a sentinel that were not the same object
    // on a second read would make this boundary either swallow a real refusal
    // or leak its own control-flow sentence to the caller — both silent, and
    // neither visible to any other registered cell. A nested write whose plan
    // needs a row it has not read yet is the shape that raises it.
    for (let repeat = 0; repeat < 4; repeat++) {
      const prepared = await engine.prepareBatch("author", "update", {
        where: { id: 1 },
        data: { posts: { update: [{ where: { id: 10 }, data: { rank: 9 } }] } },
      });
      assert.equal(
        prepared,
        undefined,
        "a dynamic operation packaged statically"
      );
    }
    // …while a statically packageable operation still packages on the same
    // engine, interleaved with the sentinel path so neither masks the other.
    for (let repeat = 0; repeat < 4; repeat++) {
      const packaged = await engine.prepareBatch("author", "findUnique", {
        where: { id: 1 },
        select: { id: true },
      });
      assert.ok(packaged, "a static read did not package");
      await engine.prepareBatch("author", "update", {
        where: { id: 1 },
        data: { posts: { update: [{ where: { id: 10 }, data: { rank: 9 } }] } },
      });
    }
  });
});
