// biome-ignore-all lint/suspicious/noMisplacedAssertion: fixture assertion helpers run only within registered Vitest cells or their setup hooks.
/** SQLite stores JSON vector values; distance support is an independent provider tier. */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createTestCommandEngine } from "@tests/raptor3/harness/command-engine";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, it } from "vitest";

const TABLE = "g4_unit02_vectors";

const embedded = s
  .model({
    id: s.int().id(),
    name: s.string().map("embedded_name"),
    embedding: s.vector().dimension(3).map("embedded_vector"),
  })
  .map(TABLE);
const schema = { embedded };

const createVectorClient = (driver: SQLite3Driver) =>
  createClient({ schema, driver });

interface Outcome {
  readonly failed: boolean;
  readonly constructorName?: string;
  readonly message?: string;
  readonly value?: unknown;
}

async function observe(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { failed: false, value: await run() };
  } catch (error) {
    assert.ok(error instanceof Error);
    return {
      failed: true,
      constructorName: error.constructor.name,
      message: error.message,
    };
  }
}

describe("G4-02 SC-13 — the vector crossings without a provider tier", () => {
  let database: Database.Database;
  let client: ReturnType<typeof createVectorClient>;
  let driver: SQLite3Driver;

  beforeEach(async () => {
    database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    driver = new SQLite3Driver({ client: database });
    client = createVectorClient(driver);
    assert.equal((await syncLiveSchema(client)).applied, true);
  });

  afterEach(async () => {
    await client?.$disconnect();
    database?.close();
  });

  it("writes JSON vector values on both seams and decodes both stored rows", async () => {
    const write = { id: 1, name: "unit-x", embedding: [1, 0, 0] };
    const candidateWrite = { id: 2, name: "unit-y", embedding: [0, 1, 0] };
    assert.deepEqual(await client.embedded.create({ data: write }), write);
    const engine = createTestCommandEngine({ schema, driver });
    assert.deepEqual(
      await engine.execute("embedded", "create", { data: candidateWrite }),
      candidateWrite
    );
    assert.deepEqual(
      database
        .prepare(`SELECT embedded_vector FROM ${TABLE} ORDER BY id`)
        .all(),
      [{ embedded_vector: "[1,0,0]" }, { embedded_vector: "[0,1,0]" }]
    );
    const args = {
      orderBy: { id: "asc" as const },
      select: { embedding: true as const },
    };
    const shippedRead = await observe(() =>
      Promise.resolve(client.embedded.findMany(args))
    );
    const candidateRead = await observe(() =>
      engine.execute("embedded", "findMany", args)
    );
    assert.deepEqual(shippedRead, {
      failed: false,
      value: [{ embedding: [1, 0, 0] }, { embedding: [0, 1, 0] }],
    });
    assert.deepEqual(candidateRead, shippedRead);
  });

  it("invalid vector dimensions refuse before either seam stores a row", async () => {
    const args = { data: { id: 1, name: "invalid", embedding: [1, 0] } };
    const engine = createTestCommandEngine({ schema, driver });
    const shipped = await observe(() =>
      Promise.resolve(client.embedded.create(args))
    );
    const candidate = await observe(() =>
      engine.execute("embedded", "create", args)
    );
    assert.equal(shipped.failed, true);
    assert.equal(shipped.constructorName, "ValidationError");
    assert.deepEqual(candidate, shipped);
    assert.deepEqual(database.prepare(`SELECT id FROM ${TABLE}`).all(), []);
  });
});
