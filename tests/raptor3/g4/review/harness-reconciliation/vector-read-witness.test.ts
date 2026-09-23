/**
 * Review probe — G4 harness reconciliation, SC-13 read half.
 *
 * The unit rewrote SC-13's read half from "both engines refuse the read" to
 * "both engines answer `[]`". `[]` is the result of reading the table the
 * refused WRITE left empty, so the rewritten half can no longer fail for the
 * reason the cell exists (the C12 vector tier on a provider that declares
 * none). This probe asks the question the cell dropped, using the witness
 * world's own fixture-owned raw-SQL seed rather than either engine's write
 * path: with one row actually present, do the two engines still agree?
 *
 * Measured 2026-09-15: the vector column migrates to SQLite as `JSON NOT NULL`,
 * both engines DECODE the seeded value, and both return the same public row.
 * So a non-vacuous SC-13 read half was available for one extra `seed` hook.
 */
import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  EMBEDDINGS,
  VECTOR_TABLE,
  vectorWorldSchema,
} from "../../codec-schema";
import { createWitnessWorld, type WitnessWorld } from "../../witness-world";

type Settled =
  | { kind: "value"; value: unknown }
  | { kind: "failure"; constructorName: string; name: string; message: string };

async function settle(invoke: () => Promise<unknown>): Promise<Settled> {
  try {
    return { kind: "value", value: await invoke() };
  } catch (failure) {
    assert.ok(failure instanceof Error, "a refusal must be an Error");
    return {
      kind: "failure",
      constructorName: failure.constructor.name,
      name: failure.name,
      message: failure.message,
    };
  }
}

const seedOneVector = (database: Database.Database) => {
  const row = EMBEDDINGS[0];
  assert.ok(row);
  database
    .prepare(
      `INSERT INTO "${VECTOR_TABLE}" ("id","embedded_name","embedded_vector") VALUES (?,?,?)`
    )
    .run(row.id, row.name, JSON.stringify(row.embedding));
};

describe("review probe: SC-13 vector read over a NON-empty table", () => {
  let world: WitnessWorld;

  beforeEach(async () => {
    world = await createWitnessWorld(vectorWorldSchema(), {
      seed: seedOneVector,
    });
  });

  afterEach(async () => {
    await world?.close();
  });

  it("the tier-less provider still stores a vector column the read can decode", () => {
    const ddl = (
      world.database
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get(VECTOR_TABLE) as { sql?: unknown } | undefined
    )?.sql;
    assert.equal(typeof ddl, "string");
    assert.match(String(ddl), /"embedded_vector"\s+JSON NOT NULL/);
    const counted = world.database
      .prepare(`SELECT COUNT(*) AS n FROM "${VECTOR_TABLE}"`)
      .get() as { n: number };
    assert.equal(counted.n, 1);
  });

  it("both engines answer a seeded vector row identically", async () => {
    const shipped = await settle(() =>
      Promise.resolve(
        world.shipped.embedded?.findMany?.({ select: { embedding: true } })
      )
    );
    const candidate = await settle(() =>
      world.candidate.execute("embedded", "findMany", {
        select: { embedding: true },
      })
    );
    assert.equal(
      candidate.kind,
      shipped.kind,
      `the candidate produced ${candidate.kind} where the shipped engine produced ${shipped.kind}`
    );
    if (shipped.kind === "failure" && candidate.kind === "failure") {
      assert.equal(candidate.constructorName, shipped.constructorName);
      return;
    }
    assert.deepEqual(candidate, shipped);
    // The measured contract: the tier-less provider REFUSES the write and
    // ANSWERS the read, decoding the stored list. SC-13's rewritten read half
    // asserts `[]`, which is true of any empty table and of no capability.
    assert.deepEqual(candidate, {
      kind: "value",
      value: [{ embedding: [1, 0, 0] }],
    });
  });
});
