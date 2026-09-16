/**
 * G4-02 author check — SC-13's property: the vector crossings of a provider
 * that declares NO vector tier answer identically on both engines.
 *
 * The witness cell `tests/raptor3/g4/read-codecs.test.ts` "SC-13 refuses a
 * vector write and read identically" also requires the READ to refuse. Neither
 * engine refuses it: the shipped result parser decodes a vector column with no
 * capability check, and with both writes refused the witness's table is empty,
 * so `observeFailure` fails on the SHIPPED read before the candidate is
 * consulted. That is a witness defect; the requested change is recorded in
 * `g4/unit02/note.md` §P.11. What SC-13 is about — one identity, not a silent
 * degradation, and the candidate identical to the shipped engine — is asserted
 * here on both crossings.
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
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
    driver = new SQLite3Driver({ client: database });
    client = createVectorClient(driver);
    assert.equal((await syncLiveSchema(client)).applied, true);
  });

  afterEach(async () => {
    await client?.$disconnect();
    database?.close();
  });

  it("refuses the write with one identity on both seams and decodes the read identically", async () => {
    const write = { id: 1, name: "unit-x", embedding: [1, 0, 0] };
    const shippedWrite = await observe(() =>
      Promise.resolve(
        (
          client as unknown as Record<
            string,
            { create(args: unknown): Promise<unknown> }
          >
        ).embedded!.create({ data: write })
      )
    );
    const engine = createCommandEngine({ schema, driver });
    const candidateWrite = await observe(() =>
      engine.execute("embedded", "create", { data: write })
    );
    assert.equal(shippedWrite.failed, true, "the shipped write must refuse");
    assert.deepEqual(
      {
        failed: candidateWrite.failed,
        constructorName: candidateWrite.constructorName,
        message: candidateWrite.message,
      },
      {
        failed: shippedWrite.failed,
        constructorName: shippedWrite.constructorName,
        message: shippedWrite.message,
      },
      `the candidate raised ${candidateWrite.constructorName} (${candidateWrite.message}) where the shipped engine raises ${shippedWrite.constructorName} (${shippedWrite.message})`
    );
    assert.deepEqual(
      database.prepare(`SELECT id FROM ${TABLE}`).all(),
      [],
      "a refused vector write stores nothing on either engine"
    );

    // The read crossing, over a row the provider already holds.
    database
      .prepare(
        `INSERT INTO ${TABLE} (id, embedded_name, embedded_vector) VALUES (9,'seeded','[1,0,0]')`
      )
      .run();
    const shippedRead = await observe(() =>
      Promise.resolve(
        (
          client as unknown as Record<
            string,
            { findMany(args: unknown): Promise<unknown> }
          >
        ).embedded!.findMany({ select: { embedding: true } })
      )
    );
    const candidateRead = await observe(() =>
      engine.execute("embedded", "findMany", { select: { embedding: true } })
    );
    assert.deepEqual(shippedRead, { failed: false, value: [{ embedding: [1, 0, 0] }] });
    assert.deepEqual(candidateRead, shippedRead);
  });
});
