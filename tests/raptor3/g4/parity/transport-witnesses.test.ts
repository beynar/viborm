/**
 * D-53 — session lifetime, failure attribution and commit certainty are
 * TRANSPORT facts with their own witnesses per driver.
 *
 * PGlite establishes PostgreSQL SQL behaviour; it does not establish what a
 * batch-only HTTP transport does between two dispatched units. These cells are
 * the credential-free half of that evidence, measured on the two batch-only
 * SQLite fixtures whose only difference is the transport fact: one keeps its
 * session (better-sqlite3's single connection), the Neon-shaped one pins none
 * and discards its temporaries between batches
 * (`batch-only-drivers.ts`, `SessionlessBatchOnlyDriver`).
 *
 * The three facts and what each cell measures:
 *
 *  - SESSION LIFETIME. The D-50 batch reference scratch is a TEMP table, so it
 *    belongs to a session. A unit that touches it in a LATER dispatched
 *    segment — to store a second member's generated key, to read one back, or
 *    merely to clean the rows up — assumes the session outlived the segment
 *    that made it. A driver that pins no session (`_canPinSession()` false:
 *    Neon HTTP, D1) breaks that assumption, and the engine states NOTHING
 *    about it today: the provider's own failure escapes, after a committed
 *    segment. That is the UNQUALIFIED state D-53 records, and the ruling
 *    requested in `g4/release/d53/note.md` §5 is what would replace the first
 *    cell's last assertion with a refusal.
 *  - FAILURE ATTRIBUTION. The shared driver seam
 *    (`drivers/driver-transaction-base.ts`, `executeBatch`) names the failing
 *    statement of a batch it ran statement by statement — measured here on the
 *    REAL sqlite3 driver and, in the sibling file, on live PGlite, because
 *    what the fixtures assume of it is otherwise only assumed. The index-free
 *    half — a transport that rejects the whole request names none, so
 *    `findUniqueExecutionContextIndex` answers by cardinality alone — already
 *    has its owner in
 *    `tests/contracts/engine/write/neon-committed-segments-capability.test.ts`
 *    and N3's ladder pins, and is not restated here.
 *  - COMMIT CERTAINTY. The fixtures' batch is ATOMIC — the property D1's
 *    `batch()` and Neon's `transaction()` have — so an aborted batch leaves no
 *    writes. Whether the transport identifies the durable commit BEFORE result
 *    decoding is the separate `supportsOrderedCommittedSegments` capability,
 *    which Neon HTTP deliberately leaves false for want of hosted evidence
 *    (`drivers/neon-http/index.ts`); no credential-free fixture can move it,
 *    and the gated live witness is `tests/providers/hosted/neon-http-transport.test.ts`.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { NeonHTTPDriver } from "@drivers/neon-http";
import { SQLite3Driver } from "@drivers/sqlite3";
import { QueryError, UniqueConstraintError } from "@errors";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, it } from "vitest";
import {
  BatchOnlyDriver,
  SessionlessBatchOnlyDriver,
} from "./batch-only-drivers";

/** The two words a sentence naming the transport fact would have to carry. */
const NAMES_THE_TRANSPORT_FACT = /session|scratch/i;

const writer = s
  .model({
    id: s.int().id().increment(),
    handle: s.string().unique(),
    notes: s.toMany(() => note),
  })
  .map("d53_writers");
const holder = s
  .model({
    id: s.string().id(),
    label: s.string().nullable(),
    notes: s.toMany(() => note),
  })
  .map("d53_holders");
const note = s
  .model({
    id: s.string().id(),
    title: s.string(),
    holderId: s.string().nullable(),
    holder: s
      .toOne(() => holder)
      .fields("holderId")
      .references("id"),
    writerId: s.int().nullable(),
    writer: s
      .toOne(() => writer)
      .fields("writerId")
      .references("id"),
  })
  .map("d53_notes");
const schema = { holder, note, writer };

/**
 * A series whose second member PROBES: the probe is answered outside the queue,
 * so the queue is dispatched first (N5's member boundary) and the member's own
 * write lands in a later segment. The first member's `create` publishes a
 * generated key through the scratch, so the scratch is made in segment one and
 * touched again after it.
 */
const seriesCreatingTwoWriters = [
  { id: "n1", title: "first", writer: { create: { handle: "alpha" } } },
  {
    id: "n2",
    title: "second",
    writer: {
      connectOrCreate: {
        where: { handle: "beta" },
        create: { handle: "beta" },
      },
    },
  },
];

/** The same series, whose probe FINDS the first member's row: nothing but the scratch cleanup follows. */
const seriesSharingOneWriter = [
  { id: "n1", title: "first", writer: { create: { handle: "shared" } } },
  {
    id: "n2",
    title: "second",
    writer: {
      connectOrCreate: {
        where: { handle: "shared" },
        create: { handle: "shared" },
      },
    },
  },
];

describe("D-53: the transport witnesses", () => {
  let driver: BatchOnlyDriver | undefined;
  afterEach(async () => {
    await driver?.disconnect();
    driver = undefined;
  });

  async function world<T extends BatchOnlyDriver>(made: T) {
    driver = made;
    const client = createClient({ schema, driver: made });
    await syncLiveSchema(client);
    return client;
  }
  const failure = async (run: PromiseLike<unknown>) =>
    await run.then(
      () => undefined,
      (error: unknown) => error
    );

  it("session lifetime: a second segment's scratch is gone on a transport that pins none", async () => {
    const client = await world(new SessionlessBatchOnlyDriver());
    await client.holder.create({ data: { id: "h1" } });
    const error = await failure(
      client.holder.update({
        where: { id: "h1" },
        data: { notes: { createMany: { data: seriesCreatingTwoWriters } } },
      })
    );

    assert.ok(
      error instanceof QueryError,
      `provider failure: ${String(error)}`
    );
    // Commit certainty, read from the same failure: this transport declares no
    // `supportsOrderedCommittedSegments`, so the segment that failed is
    // reported as one that MAY have committed, beside the one that did.
    const progress = (
      error.meta as {
        recordSeriesProgress?: Record<string, unknown>;
      }
    ).recordSeriesProgress;
    assert.equal(progress?.committedSegments, 1);
    assert.equal(progress?.mayHaveCommittedSegment, true);
    // The first segment is durable: the succession D-51 admits, reported as
    // progress, and the reason the refusal this transport owes is worth having.
    assert.deepEqual(
      (await client.writer.findMany({ select: { handle: true } })).map(
        (row) => row.handle
      ),
      ["alpha"]
    );
    assert.deepEqual(
      (await client.note.findMany({ select: { id: true } })).map(
        (row) => row.id
      ),
      ["n1"]
    );
    // UNQUALIFIED: no sentence of this engine names the transport fact. When
    // D-53's ruling lands, this assertion is the one that must be re-expressed.
    assert.ok(
      !NAMES_THE_TRANSPORT_FACT.test(error.message),
      `the engine states nothing about the session today: ${error.message}`
    );
  });

  it("session lifetime: even the scratch CLEANUP is a carry — every write commits and the operation still fails", async () => {
    const client = await world(new SessionlessBatchOnlyDriver());
    await client.holder.create({ data: { id: "h1" } });
    const error = await failure(
      client.holder.update({
        where: { id: "h1" },
        data: { notes: { createMany: { data: seriesSharingOneWriter } } },
      })
    );

    assert.ok(
      error instanceof QueryError,
      `provider failure: ${String(error)}`
    );
    assert.deepEqual(
      (await client.writer.findMany({ select: { handle: true } })).map(
        (row) => row.handle
      ),
      ["shared"]
    );
    assert.deepEqual(
      (await client.note.findMany({ select: { id: true } })).map(
        (row) => row.id
      ),
      ["n1", "n2"]
    );
  });

  it("session lifetime: the same series completes on a transport that keeps its session", async () => {
    const client = await world(new BatchOnlyDriver());
    await client.holder.create({ data: { id: "h1" } });
    await client.holder.update({
      where: { id: "h1" },
      data: { notes: { createMany: { data: seriesCreatingTwoWriters } } },
    });

    assert.deepEqual(
      (await client.writer.findMany({ select: { handle: true } })).map(
        (row) => row.handle
      ),
      ["alpha", "beta"]
    );
    assert.deepEqual(
      (await client.note.findMany({ select: { id: true } })).map(
        (row) => row.id
      ),
      ["n1", "n2"]
    );
  });

  it("session lifetime: a ONE-segment nested write is within what one batch proves (D-50's first pin)", async () => {
    const client = await world(new SessionlessBatchOnlyDriver());
    await client.writer.create({
      data: { handle: "solo", notes: { create: { id: "n9", title: "t" } } },
    });

    assert.deepEqual(
      await client.note.findMany({ select: { id: true, writerId: true } }),
      [{ id: "n9", writerId: 1 }]
    );
  });

  it("failure attribution and commit certainty: the real sqlite3 seam names the failing statement and leaves nothing behind", async () => {
    const real = new SQLite3Driver();
    try {
      await real._executeRaw('CREATE TABLE "d53_seam" ("id" TEXT PRIMARY KEY)');
      const error = await failure(
        real._executeBatch([
          { sql: 'INSERT INTO "d53_seam" ("id") VALUES (\'kept\')' },
          { sql: 'INSERT INTO "d53_seam" ("id") VALUES (\'dup\')' },
          { sql: 'INSERT INTO "d53_seam" ("id") VALUES (\'dup\')' },
        ])
      );

      assert.ok(
        error instanceof UniqueConstraintError,
        `the duplicate key: ${String(error)}`
      );
      assert.equal(error.meta.statementIndex, 2);
      const remaining = await real._executeRaw<{ id: string }>(
        'SELECT "id" FROM "d53_seam"'
      );
      assert.deepEqual(remaining.rows, []);
    } finally {
      await real._disconnect();
    }
  });

  it("session lifetime: Neon HTTP declares no session to pin", () => {
    // The three capability declarations beside it — the batch, the absent
    // interactive transaction, the unproven committed-segment notification —
    // have an owner already
    // (`tests/contracts/engine/write/neon-committed-segments-capability.test.ts`,
    // "the capability is false, beside the two that are true"). The SESSION is
    // the one D-53 adds, and the bind capacity is the fourth fact of the table.
    const neon = new NeonHTTPDriver();
    assert.equal(neon._canPinSession(), false);
    assert.equal(neon.maxBindParametersPerStatement, 65_535);
  });
});
