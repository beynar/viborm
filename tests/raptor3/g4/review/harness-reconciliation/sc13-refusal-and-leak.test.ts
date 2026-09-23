/**
 * Review probe — G4 harness reconciliation, follow-up round (after REVISE).
 *
 * The repair seeded SC-13's world with one raw-SQL row and moved the WRITE half
 * onto `EMBEDDINGS[1]`, "a row the seed did not write, so a duplicate key can
 * never stand in for the capability refusal". That sentence is an argument, so
 * these cells measure it:
 *
 *   1. the refusal a SEEDED world raises for the vector write has the same
 *      identity as the one an UNSEEDED world raises — the seed did not change
 *      which failure SC-13 reads;
 *   2. the identity is the same for the id the seed DID write, so identity
 *      alone cannot tell a duplicate key from the capability failure: the
 *      repair's choice of an unwritten row is load-bearing, not decoration;
 *   3. what that identity actually is — `QueryError` "Query execution failed"
 *      (code `V2001`), the generic provider-execution failure, raised AFTER the
 *      INSERT is emitted and its vector parameter is refused by the driver. It
 *      is NOT the `FeatureNotSupportedError` of `unsupportedVector`
 *      (`src/errors/query.ts:442`, whose members are `literal` / `l2` /
 *      `cosine`, none of which a parameterized write reaches). SC-13's doc
 *      comment says "the WRITE is where the capability is asked"; measured,
 *      the capability tier is never consulted on this path. The parity the
 *      cell asserts is real, but it is driver-level, not tier-level;
 *   4. SC-13's read expectation is sensitive to a leaked row — with two rows
 *      present the exact expectation the cell states fails, which is what makes
 *      "a refused write that leaked a row would show up as a second member"
 *      true rather than decorative.
 */
import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import { describe, it } from "vitest";
import { EMBEDDINGS, VECTOR_TABLE, vectorWorldSchema } from "../../codec-schema";
import { createWitnessWorld, type WitnessWorld } from "../../witness-world";

interface Refusal {
  readonly constructorName: string;
  readonly name: string;
  readonly message: string;
  readonly code: string;
}

async function refusalOf(invoke: () => Promise<unknown>): Promise<Refusal> {
  try {
    await invoke();
  } catch (failure) {
    assert.ok(failure instanceof Error, "a refusal must be an Error");
    return {
      constructorName: failure.constructor.name,
      name: failure.name,
      message: failure.message,
      code: String((failure as unknown as { code?: unknown }).code ?? ""),
    };
  }
  return assert.fail("the vector write was not refused");
}

const seedRow = (index: number) => (database: Database.Database) => {
  const row = EMBEDDINGS[index];
  assert.ok(row, "missing embedding fixture");
  database
    .prepare(
      `INSERT INTO "${VECTOR_TABLE}" ("id","embedded_name","embedded_vector") VALUES (?,?,?)`
    )
    .run(row.id, row.name, JSON.stringify(row.embedding));
};

async function writeRefusals(
  world: WitnessWorld,
  index: number
): Promise<{ shipped: Refusal; candidate: Refusal }> {
  const row = EMBEDDINGS[index];
  assert.ok(row);
  const shipped = await refusalOf(() =>
    Promise.resolve(world.shipped.embedded?.create?.({ data: { ...row } }))
  );
  const candidate = await refusalOf(() =>
    world.candidate.execute("embedded", "create", { data: { ...row } })
  );
  return { shipped, candidate };
}

describe("review probe: what SC-13's write half actually measures", () => {
  it("the seeded and unseeded worlds refuse the same write with the same identity", async () => {
    const unseeded = await createWitnessWorld(vectorWorldSchema());
    const seeded = await createWitnessWorld(vectorWorldSchema(), {
      seed: seedRow(0),
    });
    try {
      const withoutSeed = await writeRefusals(unseeded, 1);
      const withSeed = await writeRefusals(seeded, 1);
      assert.equal(withSeed.shipped.constructorName, withoutSeed.shipped.constructorName);
      assert.equal(withSeed.candidate.constructorName, withoutSeed.candidate.constructorName);
      assert.equal(withSeed.candidate.constructorName, withSeed.shipped.constructorName);
    } finally {
      await unseeded.close();
      await seeded.close();
    }
  });

  it("identity alone cannot tell a duplicate key from the capability failure", async () => {
    const world = await createWitnessWorld(vectorWorldSchema(), {
      seed: seedRow(0),
    });
    try {
      const onSeededId = await writeRefusals(world, 0);
      const onFreshId = await writeRefusals(world, 1);
      // Same class on both, which is precisely why SC-13 must write a row the
      // seed did not: a duplicate key would satisfy the parity assertion.
      assert.equal(onSeededId.shipped.constructorName, onFreshId.shipped.constructorName);
      assert.equal(onSeededId.candidate.constructorName, onFreshId.candidate.constructorName);
      const counted = world.database
        .prepare(`SELECT COUNT(*) AS n FROM "${VECTOR_TABLE}"`)
        .get() as { n: number };
      assert.equal(counted.n, 1, "no attempted write may have landed");
    } finally {
      await world.close();
    }
  });

  it("the asserted identity is the generic provider failure, not the vector tier's refusal", async () => {
    const world = await createWitnessWorld(vectorWorldSchema(), {
      seed: seedRow(0),
    });
    try {
      const { shipped, candidate } = await writeRefusals(world, 1);
      for (const refusal of [shipped, candidate]) {
        assert.equal(refusal.constructorName, "QueryError");
        assert.equal(refusal.message, "Query execution failed");
        assert.equal(refusal.code, "V2001");
        // `unsupportedVector` would say so, and does not fire here.
        assert.doesNotMatch(refusal.name, /FeatureNotSupported/);
        assert.doesNotMatch(refusal.message, /vector/i);
      }
      // Both engines really do emit the INSERT: the capability is not refused
      // before the statement is built.
      assert.equal(
        world.statements.filter((statement) => /^INSERT INTO "g4_codec_vectors"/.test(statement.sql))
          .length,
        2,
        "one attempted INSERT per engine"
      );
    } finally {
      await world.close();
    }
  });

  it("SC-13's read expectation is sensitive to a leaked second row", async () => {
    const world = await createWitnessWorld(vectorWorldSchema(), {
      seed: (database) => {
        seedRow(0)(database);
        seedRow(1)(database);
      },
    });
    try {
      const candidate = await world.candidate.execute("embedded", "findMany", {
        select: { embedding: true },
      });
      const shipped = await world.shipped.embedded?.findMany?.({
        select: { embedding: true },
      });
      assert.deepStrictEqual(candidate, shipped);
      // The exact expectation SC-13 asserts, against a world with one extra
      // row: it must NOT hold, or the cell could not see a leak.
      assert.throws(() =>
        assert.deepStrictEqual(candidate, [{ embedding: [1, 0, 0] }])
      );
      assert.deepStrictEqual(candidate, [
        { embedding: [1, 0, 0] },
        { embedding: [0, 1, 0] },
      ]);
    } finally {
      await world.close();
    }
  });
});
