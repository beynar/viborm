/**
 * G4 C01 fixed witnesses — inventory family B aggregates and results,
 * Q-A01, Q-A02 and Q-R01.
 *
 * Contract sources: `request-result-shape-contracts.core.test.ts` and
 * `query-builder-coverage-boundaries.core.test.ts` (Q-A01),
 * `decimal-having-operand-sql.core.test.ts` and
 * `operation-program-read-contracts.core.test.ts` (Q-A02),
 * `result-parser-contracts.core.test.ts` / `consumable-result-rows.core.test.ts`
 * (Q-R01).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  POST_TABLE,
  relationWorldSchema,
  seedJunctions,
  seedRelationWorld,
} from "./read-schema";
import {
  createWitnessWorld,
  expectRead,
  expectRefusal,
  observeFailure,
  rowsOf,
  type WitnessWorld,
} from "./witness-world";

describe("G4 C01 aggregate shapes and result policy (Q-A01, Q-A02, Q-R01)", () => {
  let world: WitnessWorld;

  beforeEach(async () => {
    world = await createWitnessWorld(relationWorldSchema(), {
      foreignKeys: false,
      seed(database) {
        seedRelationWorld(database);
        seedJunctions(database);
      },
    });
  });

  afterEach(async () => {
    await world?.close();
  });

  it("Q-A01 restricts _avg and _sum to numeric values", async () => {
    await expectRead(
      world,
      "post",
      "groupBy",
      {
        by: ["authorTenant"],
        // The window is chosen so every average is exact in binary floating
        // point: a provider-rounded mean would pin a driver artifact, not a
        // contract.
        where: { views: { in: [10, 20, 30] } },
        _sum: { views: true },
        _avg: { views: true },
        _min: { title: true },
        _max: { slug: true },
        orderBy: { authorTenant: "asc" },
      },
      [
        {
          authorTenant: "acme",
          _sum: { views: 30 },
          _avg: { views: 15 },
          _min: { title: "One" },
          _max: { slug: "p-two" },
        },
        {
          authorTenant: "beta",
          _sum: { views: 30 },
          _avg: { views: 30 },
          _min: { title: "Four" },
          _max: { slug: "p-four" },
        },
      ]
    );
    await expectRefusal(
      world,
      "post",
      "groupBy",
      { by: ["authorTenant"], _sum: { title: true } },
      { name: "ValidationError", message: /./ }
    );
    await expectRefusal(
      world,
      "post",
      "groupBy",
      { by: ["authorTenant"], _avg: { slug: true } },
      { name: "ValidationError", message: /./ }
    );
  });

  it("Q-A02 requires a valid by and answers scalar plus aggregate having", async () => {
    await expectRefusal(
      world,
      "post",
      "groupBy",
      { by: ["absent"], _count: { _all: true } },
      { name: "ValidationError", message: /./ }
    );
    await expectRead(
      world,
      "post",
      "groupBy",
      {
        by: ["authorTenant"],
        having: {
          AND: [
            { views: { _sum: { gt: 25 } } },
            { NOT: { authorTenant: { equals: "beta" } } },
          ],
        },
        _sum: { views: true },
        orderBy: { authorTenant: "asc" },
      },
      [{ authorTenant: "acme", _sum: { views: 35 } }]
    );
    await expectRead(
      world,
      "post",
      "groupBy",
      {
        by: ["authorTenant"],
        having: {
          OR: [
            { views: { _sum: { lt: 5 } } },
            { views: { _max: { gte: 30 } } },
          ],
        },
        _max: { views: true },
        orderBy: { authorTenant: "asc" },
      },
      [
        { authorTenant: null, _max: { views: 0 } },
        { authorTenant: "beta", _max: { views: 30 } },
      ]
    );
  });

  it("Q-A02 orders groups by a grouped field and by an aggregate", async () => {
    await expectRead(
      world,
      "post",
      "groupBy",
      {
        by: ["authorTenant"],
        where: { authorTenant: { not: null } },
        _count: { _all: true },
        orderBy: { authorTenant: "desc" },
      },
      [
        { authorTenant: "beta", _count: { _all: 1 } },
        { authorTenant: "acme", _count: { _all: 3 } },
      ]
    );
    await expectRead(
      world,
      "post",
      "groupBy",
      {
        by: ["authorTenant"],
        where: { authorTenant: { not: null } },
        _sum: { views: true },
        orderBy: { _sum: { views: "asc" } },
      },
      [
        { authorTenant: "beta", _sum: { views: 30 } },
        { authorTenant: "acme", _sum: { views: 35 } },
      ]
    );
  });

  it("Q-R01 publishes fresh relation and aggregate carriers", async () => {
    const request = {
      where: { tenant: "acme", handle: "ada" },
      select: {
        handle: true,
        posts: { orderBy: { id: "asc" }, select: { id: true } },
        _count: { select: { posts: true } },
      },
    };
    const first = rowsOf(await world.candidate.execute("author", "findMany", request));
    const second = rowsOf(await world.candidate.execute("author", "findMany", request));
    assert.deepStrictEqual(first, second);
    assert.notEqual(first[0], second[0], "row containers must be fresh");
    assert.notEqual(first[0]?.posts, second[0]?.posts, "relation carriers must be fresh");
    assert.notEqual(first[0]?._count, second[0]?._count, "aggregate carriers must be fresh");
  });

  it("Q-R01 refuses a structurally invalid provider row", async () => {
    world.database
      .prepare(`UPDATE ${POST_TABLE} SET view_count = 'not-an-int' WHERE id = 1`)
      .run();
    const request = {
      where: { tenant_handle: { tenant: "acme", handle: "ada" } },
      select: {
        handle: true,
        posts: { orderBy: { id: "asc" }, select: { views: true } },
      },
    };
    const shipped = await observeFailure(() =>
      Promise.resolve(world.shipped.author?.findUnique?.(request))
    );
    const candidate = await observeFailure(() =>
      world.candidate.execute("author", "findUnique", request)
    );
    assert.notEqual(
      shipped.constructorName,
      "TypeError",
      "a malformed relation carrier must carry a public error identity"
    );
    assert.equal(
      candidate.constructorName,
      shipped.constructorName,
      `the candidate raised ${candidate.constructorName} (${candidate.message}) where the shipped engine raises ${shipped.constructorName}`
    );
  });
});
