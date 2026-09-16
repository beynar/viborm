import assert from "node:assert/strict";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { Queries } from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import Database from "better-sqlite3";
import Decimal from "decimal.js";
import { describe, it } from "vitest";
import {
  differential,
  seedAuthor,
  seedPost,
  type World,
} from "./world";

/**
 * Repair witnesses for the G4-01 review findings. Every observable choice is
 * pinned DIFFERENTIALLY against the shipped engine over the same data and the
 * same provider wherever the shipped engine can answer at all: the candidate
 * may not answer an admitted input differently.
 */

function seedRatings(world: World): void {
  for (const [id, rating] of [
    [1, 3],
    [2, null],
    [3, 1],
    [4, null],
    [5, 2],
  ] as [number, number | null][])
    seedAuthor(world, { id, author_name: `a${id}`, rating });
}

function seedAbsentRelation(world: World): void {
  seedAuthor(world, { id: 1, author_name: "bravo" });
  seedAuthor(world, { id: 2, author_name: "alpha" });
  seedPost(world, { id: 1, author_id: 1, rank: 1 });
  seedPost(world, { id: 2, author_id: 2, rank: 2 });
  seedPost(world, { id: 3, author_id: null, rank: 3 });
}

describe("G4-01 repair — default null placement (Q-O01, Q-P01)", () => {
  it("leaves an unqualified order at the provider's own placement", async () => {
    for (const direction of ["asc", "desc"] as const) {
      const { shipped, candidate } = await differential(
        seedRatings,
        "author",
        "findMany",
        { orderBy: { rating: direction }, select: { id: true } }
      );
      assert.deepEqual(candidate, shipped, `orderBy rating ${direction}`);
    }
  });

  it("states the placement only where a cursor predicate must read it", async () => {
    for (const direction of ["asc", "desc"] as const) {
      const { shipped, candidate } = await differential(
        seedRatings,
        "author",
        "findMany",
        { orderBy: { rating: direction }, take: 5, select: { id: true } }
      );
      assert.deepEqual(candidate, shipped, `windowed rating ${direction}`);
    }
    // The windowed placement is the established default, and the cursor
    // predicate reads the same total order the statement emits.
    const { shipped, candidate } = await differential(
      seedRatings,
      "author",
      "findMany",
      {
        orderBy: { rating: "asc" },
        cursor: { id: 1 },
        take: 3,
        select: { id: true },
      }
    );
    assert.deepEqual(candidate, shipped);
    assert.deepEqual(candidate, [{ id: 1 }, { id: 2 }, { id: 4 }]);
  });

  it("keeps a spelled placement and a to-one relation path at parity", async () => {
    for (const nulls of ["first", "last"] as const) {
      const { shipped, candidate } = await differential(
        seedRatings,
        "author",
        "findMany",
        {
          orderBy: { rating: { sort: "asc", nulls } },
          select: { id: true },
        }
      );
      assert.deepEqual(candidate, shipped, `nulls ${nulls}`);
    }
    for (const direction of ["asc", "desc"] as const) {
      const { shipped, candidate } = await differential(
        seedAbsentRelation,
        "post",
        "findMany",
        {
          orderBy: [{ author: { name: direction } }, { id: "asc" }],
          select: { id: true },
        }
      );
      assert.deepEqual(candidate, shipped, `relation path ${direction}`);
      // The same key with no tie-break, which is the shape the review's
      // `order-cursor.test.ts` pins to the pre-repair (normalized) answer.
      const bare = await differential(seedAbsentRelation, "post", "findMany", {
        orderBy: { author: { name: direction } },
        select: { id: true },
      });
      assert.deepEqual(bare.candidate, bare.shipped, `bare relation path ${direction}`);
      assert.deepEqual(
        bare.candidate,
        direction === "asc" ? [{ id: 3 }, { id: 2 }, { id: 1 }] : [{ id: 1 }, { id: 2 }, { id: 3 }],
        `bare relation path ${direction}`
      );
    }
  });

  it("orders a grouped read identically on the client route seam and the command engine", async () => {
    const { shipped, candidate } = await differential(
      seedRatings,
      "author",
      "groupBy",
      { by: ["rating"], orderBy: { rating: "asc" }, _count: { _all: true } }
    );
    assert.deepEqual(candidate, shipped);
  });
});

describe("G4-01 repair — nested signed take (Q-P03)", () => {
  function seedWindows(world: World): void {
    seedAuthor(world, { id: 1, author_name: "one" });
    seedAuthor(world, { id: 2, author_name: "two" });
    for (const [id, authorId] of [
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 2],
      [5, 2],
    ] as [number, number][])
      seedPost(world, { id, author_id: authorId, rank: id });
  }

  it("restores the logical order of a negative nested window", async () => {
    const { shipped, candidate } = await differential(
      seedWindows,
      "author",
      "findMany",
      {
        orderBy: { id: "asc" },
        select: {
          id: true,
          posts: { orderBy: { rank: "asc" }, take: -2, select: { id: true } },
        },
      }
    );
    assert.deepEqual(candidate, [
      { id: 1, posts: [{ id: 2 }, { id: 3 }] },
      { id: 2, posts: [{ id: 4 }, { id: 5 }] },
    ]);
    assert.deepEqual(candidate, shipped);
  });

  it("leaves a positive nested window in the order it was read", async () => {
    const { shipped, candidate } = await differential(
      seedWindows,
      "author",
      "findMany",
      {
        orderBy: { id: "asc" },
        select: {
          id: true,
          posts: { orderBy: { rank: "desc" }, take: 2, select: { id: true } },
        },
      }
    );
    assert.deepEqual(candidate, [
      { id: 1, posts: [{ id: 3 }, { id: 2 }] },
      { id: 2, posts: [{ id: 5 }, { id: 4 }] },
    ]);
    assert.deepEqual(candidate, shipped);
  });
});

describe("G4-01 repair — whole-value operands (Q-W02, SC-06)", () => {
  function seedValues(world: World): void {
    seedAuthor(world, {
      id: 1,
      author_name: "one",
      avatar: Buffer.from([1, 2, 250]),
      balance: 1250n,
      birthday: "2024-03-04",
      joined_at: "2024-01-01T00:00:00.000Z",
    });
    seedAuthor(world, {
      id: 2,
      author_name: "two",
      avatar: Buffer.from([9]),
      balance: 99n,
      birthday: "2020-01-01",
      joined_at: "2020-01-01T00:00:00.000Z",
    });
  }

  it("reads an object-valued operand as one value, not as operator keys", async () => {
    const operands: [string, unknown][] = [
      ["avatar", new Uint8Array([1, 2, 250])],
      ["balance", new Decimal("12.50")],
      ["birthday", new Date("2024-03-04T00:00:00.000Z")],
      ["joinedAt", new Date("2024-01-01T00:00:00.000Z")],
    ];
    for (const [field, value] of operands) {
      const { shipped, candidate } = await differential(
        seedValues,
        "author",
        "findMany",
        { where: { [field]: value }, select: { id: true } }
      );
      assert.deepEqual(candidate, [{ id: 1 }], `${field} shorthand`);
      assert.deepEqual(candidate, shipped, `${field} shorthand`);

      const equals = await differential(seedValues, "author", "findMany", {
        where: { [field]: { equals: value } },
        select: { id: true },
      });
      assert.deepEqual(equals.candidate, [{ id: 1 }], `${field} equals`);
      assert.deepEqual(equals.candidate, equals.shipped, `${field} equals`);

      const negated = await differential(seedValues, "author", "findMany", {
        where: { [field]: { not: value } },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      assert.deepEqual(negated.candidate, [{ id: 2 }], `${field} not`);
      assert.deepEqual(negated.candidate, negated.shipped, `${field} not`);
    }
  });
});

describe("G4-01 repair — logical combinators (Q-W01)", () => {
  function seedCategories(world: World): void {
    for (const [id, category, published] of [
      [1, "alpha", 1],
      [2, "beta", 0],
      [3, "gamma", 1],
    ] as [number, string, number][])
      seedPost(world, { id, category, published, rank: id });
  }

  it("negates each arm of an array NOT and conjoins the negations", async () => {
    const { shipped, candidate } = await differential(
      seedCategories,
      "post",
      "findMany",
      {
        where: { NOT: [{ category: "alpha" }, { published: false }] },
        orderBy: { id: "asc" },
        select: { id: true },
      }
    );
    assert.deepEqual(candidate, [{ id: 3 }]);
    assert.deepEqual(candidate, shipped);
  });

  it("keeps the object NOT, the empty array NOT and nesting at parity", async () => {
    for (const where of [
      { NOT: { category: "alpha" } },
      { NOT: [] },
      { NOT: [{ NOT: [{ category: "alpha" }] }] },
      { AND: [{ NOT: [{ category: "alpha" }, { category: "beta" }] }] },
      { OR: [{ NOT: [{ category: "alpha" }] }, { id: 1 }] },
    ]) {
      const { shipped, candidate } = await differential(
        seedCategories,
        "post",
        "findMany",
        { where, orderBy: { id: "asc" }, select: { id: true } }
      );
      assert.deepEqual(candidate, shipped, JSON.stringify(where));
    }
  });

  it("reads NOT the same way in where and in having", async () => {
    const { shipped, candidate } = await differential(
      seedCategories,
      "post",
      "groupBy",
      {
        by: ["category"],
        having: { NOT: [{ category: { equals: "alpha" } }] },
        orderBy: { category: "asc" },
        _count: { _all: true },
      }
    );
    assert.deepEqual(candidate, shipped);
  });
});

/** A point world whose provider has no distance tier, like the SQLite one. */
const place = s
  .model({
    id: s.int().id(),
    name: s.string(),
    at: s.point().nullable(),
    via: s.point().nullable(),
  })
  .map("g4_rp_places");
const placeSchema = { place };

function createPlaceWorld() {
  const database = new Database(":memory:");
  database.exec(
    "CREATE TABLE g4_rp_places(id INTEGER PRIMARY KEY, name TEXT NOT NULL, at TEXT, via TEXT)"
  );
  database
    .prepare("INSERT INTO g4_rp_places(id, name, at, via) VALUES (?, ?, ?, ?)")
    .run(
      1,
      "paris",
      JSON.stringify({ longitude: 2.3522, latitude: 48.8566 }),
      null
    );
  const driver = new SQLite3Driver({ client: database });
  return {
    database,
    driver,
    engine: createCommandEngine({ schema: placeSchema, driver }),
    client: createClient({ schema: placeSchema, driver }) as unknown as {
      place: { findMany: (args: unknown) => Promise<unknown> };
    },
  };
}

describe("G4-01 repair — distance projection (Q-O02, SC-14)", () => {
  it("refuses a distance projection with the provider's own refusal", async () => {
    const world = createPlaceWorld();
    const args = {
      where: { id: 1 },
      select: {
        id: true,
        at: { _distance: { to: { longitude: 0, latitude: 0 } } },
      },
    };
    try {
      await assert.rejects(
        () => world.client.place.findMany(args),
        /point\.distance select is not supported\. GeoPoint distance is not supported by this provider\./
      );
      await assert.rejects(
        () => world.engine.execute("place", "findMany", args),
        /point\.distance select is not supported\. GeoPoint distance is not supported by this provider\./
      );
    } finally {
      await world.driver.disconnect();
      world.database.close();
    }
  });

  it("refuses two distance projections in one selection", async () => {
    const world = createPlaceWorld();
    try {
      await assert.rejects(
        () =>
          world.engine.execute("place", "findMany", {
            select: {
              at: { _distance: { to: { longitude: 0, latitude: 0 } } },
              via: { _distance: { to: { longitude: 1, latitude: 1 } } },
            },
          }),
        /Distance select supports only one _distance field per select\./
      );
    } finally {
      await world.driver.disconnect();
      world.database.close();
    }
  });

  it("projects the distance under one name on a distance-capable provider", () => {
    // PostgreSQL cannot be executed here (the preserved G4 environment
    // blocker), so the distance-tier evidence is the lowered statement and the
    // decode of a provider row, not a live answer.
    const queries = new Queries(
      new EngineSchema(placeSchema),
      new PostgresAdapter("public", true)
    );
    const query = queries.select(place, {
      select: {
        id: true,
        at: { _distance: { to: { longitude: 0, latitude: 0 } } },
      },
    } as never);
    const statement = query.sql.toStatement("$n");
    assert.match(statement, /ST_X/);
    assert.match(statement, /AS "_distance"/);
    // The selected point column is referenced by the distance expression and
    // projected under no name of its own.
    const shape = query.shape as { fields: Record<string, unknown> };
    assert.deepEqual(Object.keys(shape.fields), ["id", "_distance"]);
    assert.doesNotMatch(statement, /AS "at"/);
    assert.deepEqual(
      queries.decodeQuery(query, [{ id: 1, _distance: 4_852_312.5 }]),
      [{ id: 1, _distance: 4_852_312.5 }]
    );
    assert.deepEqual(queries.decodeQuery(query, [{ id: 1, _distance: null }]), [
      { id: 1, _distance: null },
    ]);
  });
});
