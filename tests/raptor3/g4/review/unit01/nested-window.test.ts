import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { closeWorld, createWorld, seedNote, seedPerson, type World } from "./world";

/**
 * Q-P03 probe. A nested to-many node runs the ordinary page operator; a
 * NEGATIVE nested `take` therefore executes a reversed window and the decoded
 * array must be restored to the logical order, exactly as the root does
 * (`src/query-engine/result/relation-result-parser.ts:68`).
 */
function world(): World {
  const created = createWorld();
  seedPerson(created, { id: 1, person_name: "one" });
  seedPerson(created, { id: 2, person_name: "two" });
  seedNote(created, { id: 1, person_id: 1, title: "a", rank: 1, category: "x" });
  seedNote(created, { id: 2, person_id: 1, title: "b", rank: 2, category: "y" });
  seedNote(created, { id: 3, person_id: 1, title: "c", rank: 3, category: "z" });
  seedNote(created, { id: 4, person_id: 2, title: "d", rank: 4, category: "x" });
  seedNote(created, { id: 5, person_id: 2, title: "e", rank: 5, category: "y" });
  return created;
}

async function rows(
  created: World,
  args: Record<string, unknown>
): Promise<Record<string, unknown>[]> {
  return (await created.engine.execute(
    "person",
    "findMany",
    args
  )) as Record<string, unknown>[];
}

describe("G4-01 review — nested paging", () => {
  it("restores the logical order of a negative nested take", async () => {
    const created = world();
    try {
      const found = await rows(created, {
        orderBy: { id: "asc" },
        select: {
          id: true,
          notes: { orderBy: { rank: "asc" }, take: -2, select: { id: true } },
        },
      });
      assert.deepEqual(found, [
        { id: 1, notes: [{ id: 2 }, { id: 3 }] },
        { id: 2, notes: [{ id: 4 }, { id: 5 }] },
      ]);
    } finally {
      await closeWorld(created);
    }
  });

  it("matches the root's own signed-take contract", async () => {
    const created = world();
    try {
      const root = (await created.engine.execute("note", "findMany", {
        where: { personId: 1 },
        orderBy: { rank: "asc" },
        take: -2,
        select: { id: true },
      })) as Record<string, unknown>[];
      assert.deepEqual(root, [{ id: 2 }, { id: 3 }]);
    } finally {
      await closeWorld(created);
    }
  });

  it("keeps a nested cursor window per parent at a boundary", async () => {
    const created = world();
    try {
      const found = await rows(created, {
        orderBy: { id: "asc" },
        select: {
          id: true,
          notes: {
            orderBy: { rank: "asc" },
            cursor: { id: 3 },
            take: 5,
            select: { id: true },
          },
        },
      });
      // Shipped parity (`builders/nested-read-window.ts:63-67`): the cursor row
      // is located once by its own unique key and compared against every
      // candidate row of THIS parent's window, so a parent that does not own
      // the cursor row still pages from the cursor's position in the order.
      assert.deepEqual(found[0]!.notes, [{ id: 3 }]);
      assert.deepEqual(found[1]!.notes, [{ id: 4 }, { id: 5 }]);
    } finally {
      await closeWorld(created);
    }
  });
});
