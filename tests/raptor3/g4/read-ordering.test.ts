/**
 * G4 C01 fixed witnesses — inventory family B ordering, Q-O01…Q-O04 and RF-07.
 *
 * Contract sources: `sql-generation.core.test.ts` and
 * `query-builder-coverage-boundaries.core.test.ts` (Q-O01),
 * `geopoint-behavior.ts` / `vector-orderby.core.test.ts` (Q-O02),
 * `orderby-relation-depth.core.test.ts` and `nested-orderby-behavior.ts`
 * (Q-O03, RF-07), `polymorphic-relation-behavior.ts` (Q-O04).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { PLACES, spatialWorldSchema } from "./codec-schema";
import {
  relationWorldSchema,
  seedJunctions,
  seedRelationWorld,
} from "./read-schema";
import {
  createWitnessWorld,
  expectRead,
  expectRefusal,
  rowsOf,
  type WitnessWorld,
} from "./witness-world";

/** `{ mentor: { mentor: { … rank: "asc" } } }` with `hops` relation steps. */
function mentorChain(hops: number): Record<string, unknown> {
  let term: Record<string, unknown> = { rank: "asc" };
  for (let step = 0; step < hops; step++) term = { mentor: term };
  return term;
}

describe("G4 C01 ordering vocabulary (Q-O01…Q-O04)", () => {
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

  it("Q-O01 orders a scalar domain ascending and descending", async () => {
    await expectRead(
      world,
      "post",
      "findMany",
      { orderBy: { views: "desc" }, select: { id: true } },
      [{ id: 4 }, { id: 2 }, { id: 1 }, { id: 3 }, { id: 5 }]
    );
    await expectRead(
      world,
      "post",
      "findMany",
      { orderBy: [{ views: "asc" }, { id: "desc" }], select: { id: true } },
      [{ id: 5 }, { id: 3 }, { id: 1 }, { id: 2 }, { id: 4 }]
    );
  });

  it("Q-O01 places nulls exactly where { sort, nulls } asks", async () => {
    const handles = (nulls: "first" | "last") => ({
      orderBy: { score: { sort: "asc", nulls } },
      select: { tenant: true, handle: true },
    });
    await expectRead(world, "author", "findMany", handles("first"), [
      { tenant: "acme", handle: "bob" },
      { tenant: "beta", handle: "dee" },
      { tenant: "acme", handle: "cy" },
      { tenant: "acme", handle: "ada" },
      { tenant: "beta", handle: "ada" },
    ]);
    await expectRead(world, "author", "findMany", handles("last"), [
      { tenant: "beta", handle: "dee" },
      { tenant: "acme", handle: "cy" },
      { tenant: "acme", handle: "ada" },
      { tenant: "beta", handle: "ada" },
      { tenant: "acme", handle: "bob" },
    ]);
  });

  it("Q-O03 descends to-one relations and stops after eight hops (RF-07)", async () => {
    await expectRead(
      world,
      "post",
      "findMany",
      {
        where: { author: { isNot: null } },
        orderBy: [{ author: { rank: "asc" } }, { id: "asc" }],
        select: { id: true },
      },
      [{ id: 1 }, { id: 2 }, { id: 4 }, { id: 3 }]
    );
    const eight = rowsOf(
      await world.candidate.execute("author", "findMany", {
        orderBy: mentorChain(8),
        select: { handle: true },
      })
    );
    assert.equal(eight.length, 5, "eight to-one hops remain admitted");
    await expectRefusal(
      world,
      "author",
      "findMany",
      { orderBy: mentorChain(9), select: { handle: true } },
      { name: "ValidationError", message: /./ }
    );
    await expectRefusal(
      world,
      "author",
      "findMany",
      { orderBy: { posts: { views: "asc" } }, select: { handle: true } },
      { name: "ValidationError", message: /./ }
    );
  });

  it("Q-O04 orders collections only by _count", async () => {
    await expectRead(
      world,
      "author",
      "findMany",
      {
        orderBy: [
          { posts: { _count: "desc" } },
          { tenant: "asc" },
          { handle: "asc" },
        ],
        select: { tenant: true, handle: true },
      },
      [
        { tenant: "acme", handle: "ada" },
        { tenant: "acme", handle: "bob" },
        { tenant: "beta", handle: "ada" },
        { tenant: "acme", handle: "cy" },
        { tenant: "beta", handle: "dee" },
      ]
    );
    await expectRead(
      world,
      "board",
      "findMany",
      {
        orderBy: [{ items: { _count: "desc" } }, { id: "asc" }],
        select: { id: true },
      },
      [{ id: 1 }, { id: 2 }]
    );
    await expectRefusal(
      world,
      "author",
      "findMany",
      { orderBy: { tags: { label: "asc" } }, select: { handle: true } },
      { name: "ValidationError", message: /./ }
    );
  });
});

describe("G4 C01 distance ordering (Q-O02)", () => {
  let world: WitnessWorld;

  beforeEach(async () => {
    world = await createWitnessWorld(spatialWorldSchema());
    for (const place of PLACES) {
      await world.shipped.place?.create?.({ data: { ...place } });
    }
    world.reset();
  });

  afterEach(async () => {
    await world?.close();
  });

  /**
   * The SQLite adapter spells the `within` tier but not the metre-distance
   * tier, so here the contract is one refusal with one identity. The positive
   * distance ordering is witnessed on a capable provider in
   * `tests/raptor3/g4/native/`.
   */
  it("Q-O02 refuses distance ordering identically on a provider without the tier", async () => {
    await expectRefusal(
      world,
      "place",
      "findMany",
      {
        orderBy: {
          location: { _distance: { to: PLACES[1]?.location, sort: "asc" } },
        },
        select: { id: true, name: true },
      },
      {
        name: "FeatureNotSupportedError",
        message: /GeoPoint distance is not supported by this provider/,
      }
    );
  });
});
