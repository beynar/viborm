/**
 * G4-02 phase-2 review — the two cells the author re-diagnosed as witness
 * defects (note §P.11.1), checked independently on the candidate's own side.
 *
 * SC-13: the witness asks BOTH engines to refuse a vector READ. The author says
 * the shipped result parser decodes a vector column with no capability check
 * and the table is empty anyway. These cells ask the question the witness
 * cannot: what does each engine answer for the vector read when a row EXISTS
 * (seeded with raw SQL), and what does each answer for the write. If the
 * candidate refuses a read the shipped engine answers, the cell is not a pure
 * witness defect.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { EMBEDDINGS, vectorWorldSchema, VECTOR_TABLE } from "../../codec-schema";
import { createWitnessWorld } from "../../witness-world";

async function outcome(invoke: () => Promise<unknown>): Promise<string> {
  try {
    return `ok:${JSON.stringify(await invoke(), (_k, v) => (typeof v === "bigint" ? `${v}n` : v))}`;
  } catch (error) {
    return `${(error as Error).constructor.name}: ${(error as Error).message}`;
  }
}

describe("G4-02 review — SC-13's two crossings, both engines", () => {
  it("refuses the vector WRITE with one identity on both engines", async () => {
    const world = await createWitnessWorld(vectorWorldSchema());
    try {
      const shipped = await outcome(() =>
        Promise.resolve(
          world.shipped.embedded?.create?.({ data: { ...EMBEDDINGS[0] } })
        )
      );
      const candidate = await outcome(() =>
        world.candidate.execute("embedded", "create", {
          data: { ...EMBEDDINGS[0] },
        })
      );
      assert.equal(
        candidate.split(":")[0],
        shipped.split(":")[0],
        `candidate ${candidate}\nshipped   ${shipped}`
      );
    } finally {
      await world.close();
    }
  });

  it("answers the vector READ the same way on both engines over an EMPTY table", async () => {
    const world = await createWitnessWorld(vectorWorldSchema());
    try {
      const shipped = await outcome(() =>
        Promise.resolve(
          world.shipped.embedded?.findMany?.({ select: { embedding: true } })
        )
      );
      const candidate = await outcome(() =>
        world.candidate.execute("embedded", "findMany", {
          select: { embedding: true },
        })
      );
      assert.equal(
        candidate,
        shipped,
        `candidate ${candidate}\nshipped   ${shipped}`
      );
    } finally {
      await world.close();
    }
  });

  it("answers the vector READ the same way on both engines over a SEEDED row", async () => {
    const world = await createWitnessWorld(vectorWorldSchema(), {
      seed: (database) => {
        database
          .prepare(
            `INSERT INTO ${VECTOR_TABLE} (id, embedded_name, embedded_vector) VALUES (?,?,?)`
          )
          .run(1, "unit-x", JSON.stringify([1, 0, 0]));
      },
    });
    try {
      const shipped = await outcome(() =>
        Promise.resolve(
          world.shipped.embedded?.findMany?.({ select: { embedding: true } })
        )
      );
      const candidate = await outcome(() =>
        world.candidate.execute("embedded", "findMany", {
          select: { embedding: true },
        })
      );
      assert.equal(
        candidate,
        shipped,
        `candidate ${candidate}\nshipped   ${shipped}`
      );
    } finally {
      await world.close();
    }
  });
});
