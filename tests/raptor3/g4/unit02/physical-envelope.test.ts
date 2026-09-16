/**
 * G4-02 — the one physical-envelope rule, and the frozen fast paths.
 *
 * The rule (`OperationContext.run`): an operation's envelope opens at the first
 * statement that is not the operation's only statement. This file pins the
 * consequence for the frozen scalar/bulk workloads of
 * `benchmarks/operation-pipeline-catalog.mjs` and, in the same table, the
 * SHIPPED engine's cost for the same public request — so the candidate's
 * single-statement classification and the shipped `canExecuteDirectly`
 * classification are pinned side by side and either column moving fails.
 */

import assert from "node:assert/strict";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { OperationContext } from "@query-engine/raptor3/shared/operation-context";
import { afterEach, describe, it } from "vitest";
import { cost, createWorld, worldSchema, type World } from "./world";

let world: World | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

interface Cost {
  readonly statements: number;
  readonly transactions: number;
}

async function measure(run: () => PromiseLike<unknown>): Promise<{
  readonly value: unknown;
  readonly cost: Cost;
}> {
  const driver = world!.driver;
  driver.reset();
  const value = await run();
  const observed = cost(driver);
  return {
    value,
    cost: { statements: observed.statements, transactions: observed.transactions },
  };
}

describe("G4-02 physical envelope", () => {
  it("scalar-find-unique: one statement, no envelope, on both engines", async () => {
    world = await createWorld();
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    const shipped = await measure(() =>
      world!.client.author.findUnique({ where: { id: 1 } })
    );
    const candidate = await measure(() =>
      engine.execute("author", "findUnique", { where: { id: 1 } })
    );
    assert.deepEqual(shipped.cost, { statements: 1, transactions: 0 });
    assert.deepEqual(candidate.cost, { statements: 1, transactions: 0 });
    assert.deepEqual(candidate.value, shipped.value);
  });

  it("fixed-collection-rowref-20: one statement, no envelope", async () => {
    world = await createWorld();
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    const candidate = await measure(() =>
      engine.execute("author", "findMany", {
        orderBy: { id: "asc" },
        include: { posts: { orderBy: { id: "asc" } } },
      })
    );
    assert.deepEqual(candidate.cost, { statements: 1, transactions: 0 });
    assert.equal((candidate.value as unknown[]).length, 2);
  });

  it("flat-scalar-update: one statement, no envelope, same row as shipped", async () => {
    world = await createWorld();
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    const shipped = await measure(() =>
      world!.client.author.update({
        where: { id: 1 },
        data: { age: { increment: 1 } },
      })
    );
    const candidate = await measure(() =>
      engine.execute("author", "update", {
        where: { id: 2 },
        data: { age: { increment: 1 } },
      })
    );
    assert.deepEqual(shipped.cost, { statements: 1, transactions: 0 });
    assert.deepEqual(candidate.cost, { statements: 1, transactions: 0 });
    assert.deepEqual(shipped.value, {
      id: 1,
      name: "Ada",
      age: 37,
      avatar: null,
    });
    assert.deepEqual(candidate.value, {
      id: 2,
      name: "Bo",
      age: 42,
      avatar: null,
    });
  });

  it("bulk-update-returning: one statement, no envelope", async () => {
    world = await createWorld();
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    const candidate = await measure(() =>
      engine.execute("post", "updateMany", {
        where: { rank: { gte: 1 } },
        data: { rank: { increment: 10 } },
        select: { id: true, rank: true },
      })
    );
    assert.deepEqual(candidate.cost, { statements: 1, transactions: 0 });
    assert.deepEqual(candidate.value, [
      { id: 10, rank: 11 },
      { id: 11, rank: 12 },
      { id: 12, rank: 13 },
    ]);
  });

  it("a counting read opens no transaction and runs one statement", async () => {
    world = await createWorld();
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    const candidate = await measure(() => engine.execute("post", "count", {}));
    assert.deepEqual(candidate.cost, { statements: 1, transactions: 0 });
    assert.equal(candidate.value, 3);
  });

  it("a multi-statement write keeps its envelope and is constructed once", async () => {
    world = await createWorld();
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    const candidate = await measure(() =>
      engine.execute("author", "update", {
        where: { id: 1 },
        data: { name: "Ada II", posts: { update: { where: { id: 10 }, data: { title: "renamed" } } } },
      })
    );
    assert.equal(candidate.cost.transactions, 1);
    assert.ok(
      candidate.cost.statements > 1,
      `a relation-bearing update is multi-statement, saw ${candidate.cost.statements}`
    );
    assert.equal(
      world.database
        .prepare("SELECT title FROM g4u2_posts WHERE id = 10")
        .pluck()
        .get(),
      "renamed"
    );
  });

  it("an update that names a relation projection keeps its qualified route", async () => {
    world = await createWorld();
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    const candidate = await measure(() =>
      engine.execute("author", "update", {
        where: { id: 1 },
        data: { age: { increment: 1 } },
        select: { id: true, posts: { select: { id: true } } },
      })
    );
    assert.equal(candidate.cost.transactions, 1);
    assert.ok(candidate.cost.statements > 1);
    assert.deepEqual(candidate.value, {
      id: 1,
      posts: [{ id: 10 }, { id: 11 }],
    });
  });

  // The two cells below share ONE plan admissibility (`createMany` with no
  // projection on a RETURNING adapter answers `single: true` for both), so the
  // difference between them can only come from the envelope rule itself: the
  // construction's own statement count, enforced at `OperationContext.dispatch`.
  it("two rows sharing a column set are one statement with no envelope, as shipped", async () => {
    world = await createWorld();
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    const shipped = await measure(() =>
      world!.client.author.createMany({
        data: [
          { id: 20, name: "F", age: 1 },
          { id: 21, name: "G", age: 2 },
        ],
      })
    );
    const candidate = await measure(() =>
      engine.execute("author", "createMany", {
        data: [
          { id: 30, name: "H", age: 1 },
          { id: 31, name: "I", age: 2 },
        ],
      })
    );
    assert.deepEqual(shipped.cost, { statements: 1, transactions: 0 });
    assert.deepEqual(candidate.cost, shipped.cost);
    assert.deepEqual(candidate.value, { count: 2 });
  });

  it("rows that exceed the bind budget raise the envelope sentinel and are constructed once", async () => {
    // A LOW bind cap (brief item 3's "including low bind caps") splits the one
    // grouped INSERT the plan admitted into two chunks inside the existing
    // `compileBindBudgetChunks` owner. Nothing about the plan changed — the
    // construction's own statement count did, and the sentinel is what turns
    // that into the envelope.
    world = await createWorld({ maxBindParameters: 8 });
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    // biome-ignore lint/suspicious/noExplicitAny: observing the private sentinel is the point.
    const prototype = OperationContext.prototype as any;
    const original = prototype.restart;
    let restarts = 0;
    prototype.restart = function counted(this: unknown, ...rest: unknown[]) {
      restarts++;
      return original.apply(this, rest);
    };
    let candidate: Awaited<ReturnType<typeof measure>>;
    try {
      candidate = await measure(() =>
        engine.execute("author", "createMany", {
          data: [
            { id: 40, name: "J", age: 1 },
            { id: 41, name: "K", age: 2 },
            { id: 42, name: "L", age: 3 },
          ],
        })
      );
    } finally {
      prototype.restart = original;
    }
    assert.equal(restarts, 1, "the envelope sentinel recovered exactly once");
    assert.deepEqual(candidate.cost, { statements: 2, transactions: 1 });
    assert.deepEqual(candidate.value, { count: 3 });
    // Each row written exactly once: the re-run repeated construction only.
    assert.equal(
      world.database
        .prepare("SELECT COUNT(*) FROM g4u2_authors WHERE id IN (40, 41, 42)")
        .pluck()
        .get(),
      3
    );
  });

  it("a bulk verb with no rows reaches the provider not at all", async () => {
    world = await createWorld();
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    const candidate = await measure(() =>
      engine.execute("post", "updateMany", {
        where: { rank: { gte: 1 } },
        data: { rank: { increment: 1 } },
        limit: 0,
      })
    );
    assert.deepEqual(candidate.cost, { statements: 0, transactions: 0 });
    assert.deepEqual(candidate.value, { count: 0 });
  });
});
