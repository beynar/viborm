import assert from "node:assert/strict";
import { NotFoundError } from "@errors";
import { describe, it } from "vitest";
import { closeWorld, createWorld, seedNote, seedPerson, type World } from "./world";

/** OP-R09 / Q-A02 / Q-S01..Q-S02 probes: mapped by-fields, having parity, shapes. */
function world(): World {
  const created = createWorld();
  seedPerson(created, { id: 1, person_name: "one", visits: 10n });
  seedPerson(created, { id: 2, person_name: "two", visits: 20n });
  seedNote(created, { id: 1, person_id: 1, rank: 1, category: "x", published: 1 });
  seedNote(created, { id: 2, person_id: 1, rank: 2, category: "x", published: 0 });
  seedNote(created, { id: 3, person_id: 2, rank: 4, category: "y", published: 1 });
  seedNote(created, { id: 4, person_id: null, rank: 8, category: "y", published: 1 });
  return created;
}

describe("G4-01 review — groupBy, having and projection shapes", () => {
  it("groups by a MAPPED column and keeps its public name and nullability", async () => {
    const created = world();
    try {
      const grouped = (await created.engine.execute("note", "groupBy", {
        by: ["personId"],
        _count: true,
        _sum: { rank: true },
        // Explicit placement, so this probe isolates the MAPPED by-column and
        // not the default-null-placement divergence (finding 3).
        orderBy: { personId: { sort: "asc", nulls: "first" } },
      })) as Record<string, unknown>[];
      assert.deepEqual(grouped, [
        { personId: null, _count: 1, _sum: { rank: 8 } },
        { personId: 1, _count: 2, _sum: { rank: 3 } },
        { personId: 2, _count: 1, _sum: { rank: 4 } },
      ]);
    } finally {
      await closeWorld(created);
    }
  });

  it("admits in having every comparison the where ladder admits", async () => {
    const created = world();
    try {
      const byNotIn = (await created.engine.execute("note", "groupBy", {
        by: ["category"],
        _count: true,
        having: { category: { notIn: ["y"] } },
      })) as Record<string, unknown>[];
      assert.deepEqual(byNotIn, [{ category: "x", _count: 2 }]);

      const nested = (await created.engine.execute("note", "groupBy", {
        by: ["category"],
        _sum: { rank: true },
        having: {
          NOT: { rank: { _sum: { lt: 5 } } },
          OR: [{ rank: { _sum: { gte: 12 } } }, { category: { equals: "x" } }],
        },
        orderBy: { category: "asc" },
      })) as Record<string, unknown>[];
      assert.deepEqual(nested, [{ category: "y", _sum: { rank: 12 } }]);

      const counted = (await created.engine.execute("note", "groupBy", {
        by: ["category"],
        _count: true,
        having: { rank: { _count: { gte: 2 } } },
        orderBy: { category: "asc" },
      })) as Record<string, unknown>[];
      assert.deepEqual(counted, [
        { category: "x", _count: 2 },
        { category: "y", _count: 2 },
      ]);
    } finally {
      await closeWorld(created);
    }
  });

  it("projects a relation, a filtered _count and scalars in one selection", async () => {
    const created = world();
    try {
      const rows = (await created.engine.execute("person", "findMany", {
        orderBy: { id: "asc" },
        select: {
          id: true,
          name: true,
          notes: { where: { published: true }, orderBy: { rank: "asc" }, select: { id: true } },
          _count: { select: { notes: { where: { published: true } } } },
        },
      })) as Record<string, unknown>[];
      assert.deepEqual(rows, [
        { id: 1, name: "one", notes: [{ id: 1 }], _count: { notes: 1 } },
        { id: 2, name: "two", notes: [{ id: 3 }], _count: { notes: 1 } },
      ]);
    } finally {
      await closeWorld(created);
    }
  });

  it("carries the not-found identity for findFirstOrThrow", async () => {
    const created = world();
    try {
      await assert.rejects(
        () =>
          created.engine.execute("note", "findFirstOrThrow", {
            where: { rank: { gt: 1000 } },
          }),
        (error: unknown) => {
          assert.ok(error instanceof NotFoundError, String(error));
          const meta = (error as { meta?: Record<string, unknown> }).meta ?? {};
          assert.equal(meta.model, "note");
          assert.equal(meta.operation, "findFirstOrThrow");
          return true;
        }
      );
      const found = await created.engine.execute("note", "findFirstOrThrow", {
        where: { rank: 1 },
        select: { id: true },
      });
      assert.deepEqual(found, { id: 1 });
    } finally {
      await closeWorld(created);
    }
  });

  it("folds only ASCII in insensitive mode", async () => {
    const created = createWorld();
    try {
      seedPerson(created, { id: 1, person_name: "ÉCOLE" });
      seedPerson(created, { id: 2, person_name: "ecole" });
      const rows = (await created.engine.execute("person", "findMany", {
        where: { name: { contains: "école", mode: "insensitive" } },
        orderBy: { id: "asc" },
        select: { id: true },
      })) as Record<string, unknown>[];
      // Portable ASCII folding: 'É' and 'é' are NOT folded together.
      assert.deepEqual(rows, []);
      const ascii = (await created.engine.execute("person", "findMany", {
        where: { name: { contains: "COLE", mode: "insensitive" } },
        orderBy: { id: "asc" },
        select: { id: true },
      })) as Record<string, unknown>[];
      assert.deepEqual(ascii, [{ id: 1 }, { id: 2 }]);
    } finally {
      await closeWorld(created);
    }
  });
});
