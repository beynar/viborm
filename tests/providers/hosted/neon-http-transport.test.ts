/**
 * D-53 — the Neon HTTP transport witness (credential-gated).
 *
 * PGlite establishes PostgreSQL SQL behaviour, not this transport's. Neon HTTP
 * dispatches each batch as its own NON-INTERACTIVE transaction and reserves no
 * session, so three facts the engine depends on are its own to prove: a failed
 * batch leaves no writes, a committed batch is durable before the next request
 * reads it, and a session-scoped temporary — the D-50 batch reference scratch —
 * does NOT survive to the next batch.
 *
 * Until these run, Neon HTTP is UNQUALIFIED for every behaviour that needs a
 * scratch reference to cross a segment, and
 * `supportsOrderedCommittedSegments` stays the inherited `false`
 * (`src/drivers/neon-http/index.ts`): this file is deliberately NOT evidence
 * for that stronger capability, which needs proof that the commit is
 * identified BEFORE result decoding, and nothing here can see that boundary.
 *
 * Gated exactly like its sibling `neon-http.test.ts`: with
 * `NEON_TEST_DATABASE_URL` unset every cell skips by name and fails nothing.
 * The driver's DECLARATIONS are not restated here — the capability trio has an
 * owner in `tests/contracts/engine/write/neon-committed-segments-capability.test.ts`
 * and the session and bind-capacity facts one in
 * `tests/raptor3/g4/parity/transport-witnesses.test.ts`.
 * Unlike that file it does mutate the endpoint — it creates and drops ONE
 * table of its own, named for this unit — because commit certainty cannot be
 * witnessed by a read.
 */

import { NeonHTTPDriver } from "@src/drivers/neon-http";

const databaseUrl = process.env.NEON_TEST_DATABASE_URL;
const TABLE = '"d53_neon_transport"';
const SCRATCH = '"d53_neon_scratch"';

describe.skipIf(!databaseUrl)("Neon HTTP transport facts (D-53)", () => {
  let driver: NeonHTTPDriver;

  beforeAll(async () => {
    driver = new NeonHTTPDriver({ databaseUrl });
    await driver._executeRaw(`DROP TABLE IF EXISTS ${TABLE}`);
    await driver._executeRaw(
      `CREATE TABLE ${TABLE} ("id" TEXT PRIMARY KEY, "label" TEXT)`
    );
  });

  afterAll(async () => {
    try {
      await driver._executeRaw(`DROP TABLE IF EXISTS ${TABLE}`);
    } finally {
      await driver._disconnect();
    }
  });

  it("commit certainty: a failed batch leaves no writes", async () => {
    await expect(
      driver._executeBatch([
        { sql: `INSERT INTO ${TABLE} ("id", "label") VALUES ('dup', 'a')` },
        { sql: `INSERT INTO ${TABLE} ("id", "label") VALUES ('dup', 'b')` },
      ])
    ).rejects.toThrow();

    const remaining = await driver._executeRaw<{ id: string }>(
      `SELECT "id" FROM ${TABLE} WHERE "id" = 'dup'`
    );
    expect(remaining.rows).toEqual([]);
  });

  it("commit certainty: a committed batch is durable for the next request", async () => {
    const results = await driver._executeBatch<{ id: string }>([
      { sql: `INSERT INTO ${TABLE} ("id", "label") VALUES ('kept', 'a')` },
      { sql: `SELECT "id" FROM ${TABLE} WHERE "id" = 'kept'` },
    ]);
    expect(results).toHaveLength(2);
    expect(results[1]?.rows).toEqual([{ id: "kept" }]);

    const seen = await driver._executeRaw<{ id: string }>(
      `SELECT "id" FROM ${TABLE} WHERE "id" = 'kept'`
    );
    expect(seen.rows).toEqual([{ id: "kept" }]);
  });

  it("session lifetime: a temporary does not survive to the next batch", async () => {
    await driver._executeBatch([
      {
        sql: `CREATE TEMP TABLE IF NOT EXISTS ${SCRATCH} ("ref_key" TEXT PRIMARY KEY, "ref_value" TEXT)`,
      },
      {
        sql: `INSERT INTO ${SCRATCH} ("ref_key", "ref_value") VALUES ('k', '1')`,
      },
    ]);

    // The scratch a segment made is not there for the next one: this is the
    // fact that leaves Neon HTTP unqualified for a cross-segment scratch
    // reference, and D-50's one-segment nested write within what it proves.
    await expect(
      driver._executeBatch([
        { sql: `SELECT "ref_value" FROM ${SCRATCH} WHERE "ref_key" = 'k'` },
      ])
    ).rejects.toThrow();
  });
});
