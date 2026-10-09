// biome-ignore-all lint/suspicious/noMisplacedAssertion: fixture assertion helpers run only within registered Vitest cells or their setup hooks.
/** SC-13 distinguishes JSON value storage, duplicate identity, and vector-domain refusal. */
import assert from "node:assert/strict";
import type Database from "better-sqlite3";
import { describe, it } from "vitest";
import {
  EMBEDDINGS,
  VECTOR_TABLE,
  vectorWorldSchema,
} from "../../codec-schema";
import { createWitnessWorld, type WitnessWorld } from "../../witness-world";

const VECTOR_INSERT = /^INSERT INTO "g4_codec_vectors"/;

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

async function write(
  world: WitnessWorld,
  index: number,
  engine: "shipped" | "candidate"
) {
  const row = EMBEDDINGS[index];
  assert.ok(row);
  return engine === "shipped"
    ? world.shipped.embedded?.create?.({ data: { ...row } })
    : world.candidate.execute("embedded", "create", { data: { ...row } });
}

describe("review probe: what SC-13's write half actually measures", () => {
  it("fresh vectors write identically in seeded and unseeded worlds", async () => {
    for (const engine of ["shipped", "candidate"] as const) {
      for (const seeded of [false, true]) {
        const world = await createWitnessWorld(
          vectorWorldSchema(),
          seeded ? { seed: seedRow(0) } : {}
        );
        try {
          assert.deepEqual(await write(world, 1, engine), EMBEDDINGS[1]);
          const stored = world.database
            .prepare(
              `SELECT embedded_vector FROM "${VECTOR_TABLE}" WHERE id = 2`
            )
            .get();
          assert.deepEqual(stored, { embedded_vector: "[0,1,0]" });
        } finally {
          await world.close();
        }
      }
    }
  });

  it("a duplicate key is a constraint refusal while the fresh vector is stored", async () => {
    for (const engine of ["shipped", "candidate"] as const) {
      const world = await createWitnessWorld(vectorWorldSchema(), {
        seed: seedRow(0),
      });
      try {
        const duplicate = await refusalOf(() =>
          Promise.resolve(write(world, 0, engine))
        );
        assert.equal(duplicate.constructorName, "UniqueConstraintError");
        assert.equal(duplicate.code, "V2003");
        assert.deepEqual(await write(world, 1, engine), EMBEDDINGS[1]);
        assert.deepEqual(
          world.database
            .prepare(
              `SELECT embedded_vector FROM "${VECTOR_TABLE}" ORDER BY id`
            )
            .all(),
          [{ embedded_vector: "[1,0,0]" }, { embedded_vector: "[0,1,0]" }]
        );
      } finally {
        await world.close();
      }
    }
  });

  it("invalid vector dimensions are refused before an INSERT on either seam", async () => {
    const world = await createWitnessWorld(vectorWorldSchema(), {
      seed: seedRow(0),
    });
    try {
      const args = { data: { id: 2, name: "invalid", embedding: [1, 0] } };
      const shipped = await refusalOf(() =>
        Promise.resolve(world.shipped.embedded?.create?.(args))
      );
      const candidate = await refusalOf(() =>
        world.candidate.execute("embedded", "create", args)
      );
      assert.deepEqual(candidate, shipped);
      assert.equal(shipped.constructorName, "ValidationError");
      assert.equal(shipped.code, "V4001");
      assert.equal(
        world.statements.filter((statement) =>
          VECTOR_INSERT.test(statement.sql)
        ).length,
        0
      );
      assert.deepEqual(
        world.database
          .prepare(`SELECT embedded_vector FROM "${VECTOR_TABLE}"`)
          .all(),
        [{ embedded_vector: "[1,0,0]" }]
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
