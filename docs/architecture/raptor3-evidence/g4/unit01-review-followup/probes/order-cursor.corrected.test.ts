import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { closeWorld, createWorld, seedNote, seedPerson, type World } from "./world";

/** Q-O01..Q-O04 / Q-P01..Q-P02 probes at the boundaries the author did not take. */
function world(): World {
  const created = createWorld();
  for (const [id, weight, category] of [
    [1, 3, "x"],
    [2, null, "y"],
    [3, 1, "x"],
    [4, null, "z"],
    [5, 2, "y"],
  ] as [number, number | null, string][])
    seedNote(created, {
      id,
      rank: id,
      weight,
      category,
      title: `n${id}`,
    });
  return created;
}

async function ids(
  created: World,
  args: Record<string, unknown>
): Promise<number[]> {
  const rows = (await created.engine.execute("note", "findMany", {
    ...args,
    select: { id: true },
  })) as Record<string, unknown>[];
  return rows.map((row) => row.id as number);
}

describe("G4-01 review — ordering and cursor boundaries", () => {
  it("pages a nullable sort key through the null-aware cursor predicate", async () => {
    const created = world();
    try {
      // weight ascending, nulls last by default: 3(1), 5(2), 1(3), 2(null), 4(null)
      assert.deepEqual(await ids(created, { orderBy: { weight: "asc" }, take: 5 }), [
        3, 5, 1, 2, 4,
      ]);
      assert.deepEqual(
        await ids(created, { orderBy: { weight: "asc" }, cursor: { id: 1 }, take: 3 }),
        [1, 2, 4]
      );
      assert.deepEqual(
        await ids(created, { orderBy: { weight: "asc" }, cursor: { id: 2 }, take: 3 }),
        [2, 4]
      );
      assert.deepEqual(
        await ids(created, {
          orderBy: { weight: { sort: "asc", nulls: "first" } },
          cursor: { id: 2 },
          take: 3,
        }),
        [2, 4, 3]
      );
    } finally {
      await closeWorld(created);
    }
  });

  it("keeps the cursor inclusive at the first and last rows of the order", async () => {
    const created = world();
    try {
      assert.deepEqual(
        await ids(created, { orderBy: { rank: "asc" }, cursor: { id: 1 }, take: 2 }),
        [1, 2]
      );
      assert.deepEqual(
        await ids(created, { orderBy: { rank: "asc" }, cursor: { id: 5 }, take: 2 }),
        [5]
      );
      assert.deepEqual(
        await ids(created, { orderBy: { rank: "asc" }, cursor: { id: 5 }, take: -2 }),
        [4, 5]
      );
      assert.deepEqual(
        await ids(created, { orderBy: { rank: "asc" }, cursor: { id: 1 }, take: -2 }),
        [1]
      );
    } finally {
      await closeWorld(created);
    }
  });

  it("returns an empty window for a cursor that matches no row", async () => {
    const created = world();
    try {
      assert.deepEqual(
        await ids(created, { orderBy: { rank: "asc" }, cursor: { id: 99 }, take: 3 }),
        []
      );
    } finally {
      await closeWorld(created);
    }
  });

  it("orders by a to-one relation path when the relation is absent", async () => {
    const created = createWorld();
    try {
      seedPerson(created, { id: 1, person_name: "bravo" });
      seedPerson(created, { id: 2, person_name: "alpha" });
      seedNote(created, { id: 1, person_id: 1, rank: 1 });
      seedNote(created, { id: 2, person_id: 2, rank: 2 });
      seedNote(created, { id: 3, person_id: null, rank: 3 });
      // CORRECTED after the repair pass. This expectation originally pinned
      // NULLS LAST, which was the pre-repair candidate's own answer and
      // contradicted this review's `shipped-parity.test.ts`. The shipped engine
      // emits the BARE direction for an unwindowed order, so on SQLite an
      // absent to-one relation sorts first ascending and last descending; the
      // oracle was re-asked differentially in
      // `tests/raptor3/g4/review/unit01-followup/order-oracle.test.ts`.
      assert.deepEqual(
        await ids(created, { orderBy: { person: { name: "asc" } } }),
        [3, 2, 1]
      );
      assert.deepEqual(
        await ids(created, { orderBy: { person: { name: "desc" } } }),
        [1, 2, 3]
      );
    } finally {
      await closeWorld(created);
    }
  });

  it("keeps distinct before the window with a mapped distinct column", async () => {
    const created = createWorld();
    try {
      seedPerson(created, { id: 1, person_name: "a" });
      seedPerson(created, { id: 2, person_name: "a" });
      seedPerson(created, { id: 3, person_name: "b" });
      seedPerson(created, { id: 4, person_name: "c" });
      const rows = (await created.engine.execute("person", "findMany", {
        distinct: ["name"],
        orderBy: { id: "asc" },
        take: 2,
        select: { id: true, name: true },
      })) as Record<string, unknown>[];
      assert.deepEqual(rows, [
        { id: 1, name: "a" },
        { id: 3, name: "b" },
      ]);
    } finally {
      await closeWorld(created);
    }
  });

  it("refuses a cursor over a non-scalar order with a named refusal", async () => {
    const created = createWorld();
    try {
      seedPerson(created, { id: 1 });
      seedNote(created, { id: 1, person_id: 1, rank: 1 });
      await assert.rejects(
        () =>
          created.engine.execute("note", "findMany", {
            orderBy: { person: { name: "asc" } },
            cursor: { id: 1 },
            take: 1,
          }),
        /Cursor pagination supports direct scalar sort directions only/
      );
    } finally {
      await closeWorld(created);
    }
  });
});
