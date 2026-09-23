/**
 * Independent review probe — G4 performance pass, items 1 (lazy control-flow
 * sentinels) and 4 (`EngineSchema.scalars` trim).
 *
 * Item 1 turned two `readonly` fields into first-use getters. The failure mode
 * the change introduces is not "the sentinel is slow" but "the sentinel is not
 * the same object twice": `isIncompletePreparation(error)` reads the getter
 * INSIDE the `catch`, so a getter that forgot to memoise, or one that
 * materialised a second sentinel on a second read, would make `prepareBatch`
 * either swallow a real error or refuse to recognise its own. Both are silent.
 * These cells pin the two halves: the sentinel path answers `undefined`, and a
 * real refusal raised on the same path still ESCAPES `prepareBatch`.
 *
 * Item 4 replaced `Object.fromEntries(names.filter(…).map(…))` with a loop.
 * The cells below compare the live implementation against that exact reference
 * expression on the same inputs — keys, order, values and prototype — and pin
 * the one input class where a loop and `Object.fromEntries` genuinely differ
 * (`CreateDataPropertyOrThrow` versus an assignment that can hit a setter).
 */

import assert from "node:assert/strict";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { afterEach, describe, it } from "vitest";
import { cost, createWorld, worldSchema, type World } from "../../unit02/world";

describe("G4 perf review — the lazy sentinels keep their identity", () => {
  let world: World | undefined;

  afterEach(async () => {
    await world?.close();
    world = undefined;
  });

  it("answers undefined for an operation that cannot be packaged, every time", async () => {
    const open = await createWorld();
    world = open;
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: open.driver,
    });
    // A nested write whose plan needs a row it has not read yet cannot be
    // packaged statically: the sentinel is raised and recognised by identity.
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
    // …while a statically packageable one still packages, on the same engine,
    // interleaved with the sentinel path so one cannot mask the other.
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

  it("lets a REAL refusal escape prepareBatch instead of answering undefined", async () => {
    const open = await createWorld();
    world = open;
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: open.driver,
    });
    let raised: unknown;
    let escaped = "";
    try {
      await engine.prepareBatch("author", "findMany", {
        // A registered refusal, raised on the same preparation path the
        // sentinel travels.
        orderBy: { posts: { rank: "asc" } },
        cursor: { id: 1 },
      });
    } catch (error) {
      raised = error;
    }
    assert.ok(
      raised instanceof Error,
      "prepareBatch swallowed a real refusal as an incomplete preparation"
    );
    assert.notEqual(
      (raised as Error).message,
      "Raptor 3 operation requires dynamic execution",
      "prepareBatch leaked its own control-flow sentinel to the caller"
    );
    escaped = `${(raised as Error).name}: ${(raised as Error).message}`;
    assert.match(escaped, /Error: .+/);
  });

  it("keeps the envelope sentinel's deferred re-entry, with the frozen physical cost", async () => {
    const open = await createWorld();
    world = open;
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: open.driver,
    });
    open.driver.reset();
    await engine.execute("author", "create", {
      data: {
        id: 40,
        name: "Zed",
        age: 20,
        posts: { create: [{ id: 40, title: "z", rank: 1 }] },
      },
    });
    const observed = cost(open.driver);
    // The envelope sentinel is raised once, caught by identity in `run`, and
    // the operation is replayed inside its physical envelope: one transaction.
    assert.equal(observed.transactions, 1);
    assert.ok(observed.statements >= 2);
    const rows = open.database
      .prepare("SELECT id, authorId FROM g4u2_posts WHERE id = 40")
      .all();
    assert.deepEqual(rows, [{ id: 40, authorId: 40 }]);
  });
});

/** The expression `EngineSchema.scalars` replaced, verbatim. */
function referenceScalars(
  names: readonly string[],
  admitted: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    names
      .filter((field) => admitted[field] !== undefined)
      .map((field) => [field, admitted[field]])
  );
}

describe("G4 perf review — the scalars trim is a pure reuse", () => {
  it("answers the same keys, order, values and prototype as the expression it replaced", () => {
    const schema = new EngineSchema(worldSchema);
    const names = worldSchema.author["~"].scalarFieldNames;
    assert.ok(names.length > 2, "the world lost its scalars");
    const payloads: Record<string, unknown>[] = [
      {},
      { id: 1 },
      { name: "a", id: 2, age: 3 },
      { age: 0, name: "", avatar: null },
      { id: undefined, name: "kept" },
      { id: 1, name: "n", age: 2, avatar: null, posts: [{ id: 1 }] },
      { notAField: 9, id: 5 },
    ];
    for (const payload of payloads) {
      const live = schema.scalars(worldSchema.author, payload);
      const reference = referenceScalars(names, payload);
      assert.deepEqual(live, reference, JSON.stringify(payload));
      assert.deepEqual(Object.keys(live), Object.keys(reference));
      assert.equal(Object.getPrototypeOf(live), Object.getPrototypeOf(reference));
      for (const key of Object.keys(reference))
        assert.equal(
          Object.is(live[key], reference[key]),
          true,
          `${key} lost value identity`
        );
    }
  });

  it("never lets a payload key reach the result's prototype", () => {
    const schema = new EngineSchema(worldSchema);
    // `values[field] = value` differs from `Object.fromEntries` for exactly one
    // key: `__proto__` invokes the inherited setter instead of creating an own
    // property. The trim is only safe while no model can declare that field —
    // this cell states the precondition, so a schema change that allows it
    // fails here rather than silently mutating a prototype.
    assert.equal(
      worldSchema.author["~"].scalarFieldNames.includes("__proto__"),
      false
    );
    const result = schema.scalars(worldSchema.author, {
      id: 1,
      __proto__: { poisoned: true },
    } as Record<string, unknown>);
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal("poisoned" in result, false);
  });
});
