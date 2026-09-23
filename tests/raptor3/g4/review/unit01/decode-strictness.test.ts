import assert from "node:assert/strict";
import { QueryEngineError } from "@errors";
import { describe, it } from "vitest";
import { closeWorld, createWorld, seedNote, seedPerson, type World } from "./world";

/**
 * Q-R01 probe. Every leaf is decoded strictly, at every placement, and a
 * malformed provider value carries the established public identity rather than
 * a bare TypeError or a silent coercion.
 */
async function failure(body: () => Promise<unknown>): Promise<Error> {
  try {
    await body();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
}

describe("G4-01 review — strict decoding", () => {
  it("refuses a list member that is null with the established identity", async () => {
    const created = createWorld();
    try {
      seedPerson(created, { id: 1, tags: JSON.stringify(["a", null]) });
      const error = await failure(() =>
        created.engine.execute("person", "findUnique", {
          where: { id: 1 },
          select: { tags: true },
        })
      );
      assert.ok(
        error instanceof QueryEngineError,
        `expected a QueryEngineError, got ${error.constructor.name}: ${error.message}`
      );
      assert.match(error.message, /malformed string scalar/);
    } finally {
      await closeWorld(created);
    }
  });

  it("refuses an enum value the schema never declared", async () => {
    const created = createWorld();
    try {
      seedPerson(created, { id: 1, tier: "legend" });
      const error = await failure(() =>
        created.engine.execute("person", "findUnique", {
          where: { id: 1 },
          select: { tier: true },
        })
      );
      assert.ok(error instanceof QueryEngineError, error.message);
      assert.match(error.message, /malformed enum scalar/);
    } finally {
      await closeWorld(created);
    }
  });

  it("refuses a malformed leaf inside a to-many carrier, not only at the root", async () => {
    const created = createWorld();
    try {
      seedPerson(created, { id: 1 });
      seedNote(created, { id: 1, person_id: 1, rank: 1 });
      // A provider row whose int column answers a non-integral text.
      created.database.exec("UPDATE rv_notes SET rank = '2.5' WHERE id = 1");
      const error = await failure(() =>
        created.engine.execute("person", "findUnique", {
          where: { id: 1 },
          select: { id: true, notes: { select: { rank: true } } },
        })
      );
      assert.ok(error instanceof QueryEngineError, error.message);
      assert.match(error.message, /malformed int(eger)? scalar/);
    } finally {
      await closeWorld(created);
    }
  });

  it("refuses a malformed leaf inside an aggregate result", async () => {
    const created = createWorld();
    try {
      seedPerson(created, { id: 1, visits: 3n });
      seedNote(created, { id: 1, person_id: 1, rank: 1 });
      const aggregated = (await created.engine.execute("person", "aggregate", {
        _sum: { visits: true },
      })) as Record<string, Record<string, unknown>>;
      // Falsifier 6 of the handoff: a bigint `_sum` stays a bigint.
      assert.equal(typeof aggregated._sum!.visits, "bigint");
      assert.equal(aggregated._sum!.visits, 3n);
    } finally {
      await closeWorld(created);
    }
  });

  it("returns null aggregates over an empty window and keeps _count at zero", async () => {
    const created = createWorld();
    try {
      const aggregated = (await created.engine.execute("note", "aggregate", {
        where: { rank: { gt: 1000 } },
        _count: true,
        _avg: { rank: true },
        _sum: { rank: true },
        _min: { title: true },
      })) as Record<string, unknown>;
      assert.equal(aggregated._count, 0);
      assert.deepEqual(aggregated._avg, { rank: null });
      assert.deepEqual(aggregated._sum, { rank: null });
      assert.deepEqual(aggregated._min, { title: null });
    } finally {
      await closeWorld(created);
    }
  });

  it("counts only non-null values for a selected field and all rows for _all", async () => {
    const created = createWorld();
    try {
      seedPerson(created, { id: 1, score: 1.5 });
      seedPerson(created, { id: 2, score: null });
      seedPerson(created, { id: 3, score: 2.5 });
      const counted = await created.engine.execute("person", "count", {
        select: { _all: true, score: true },
      });
      assert.deepEqual(counted, { _all: 3, score: 2 });
      assert.equal(await created.engine.execute("person", "count", {}), 3);
      assert.equal(await created.engine.execute("person", "exist", {}), true);
      assert.equal(
        await created.engine.execute("person", "exist", {
          where: { id: { gt: 99 } },
        }),
        false
      );
    } finally {
      await closeWorld(created);
    }
  });

  it("applies the count window (take/skip) before aggregating", async () => {
    const created = createWorld();
    try {
      for (const id of [1, 2, 3, 4, 5])
        seedNote(created, { id, rank: id, title: `n${id}` });
      assert.equal(
        await created.engine.execute("note", "count", {
          orderBy: { rank: "asc" },
          take: 2,
        }),
        2
      );
      assert.equal(
        await created.engine.execute("note", "count", {
          orderBy: { rank: "asc" },
          skip: 3,
        }),
        2
      );
      const aggregated = (await created.engine.execute("note", "aggregate", {
        orderBy: { rank: "asc" },
        take: -2,
        _sum: { rank: true },
      })) as Record<string, Record<string, unknown>>;
      assert.equal(aggregated._sum!.rank, 9);
    } finally {
      await closeWorld(created);
    }
  });
});
