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
 *    belongs to a session. A unit that touched it in a LATER dispatched
 *    segment — to store a second member's generated key, to read one back, or
 *    merely to clean the rows up — assumed the session outlived the segment
 *    that made it, and on a driver that pins none (`_canPinSession()` false:
 *    Neon HTTP, D1) the provider's own failure escaped after a committed
 *    segment. That was the UNQUALIFIED state D-53 recorded. **D-58** answers
 *    it by EXECUTING rather than refusing: every dispatched unit makes its own
 *    scratch, reads back at its boundary what it stored, and the next unit
 *    binds the VALUE as a literal — so the three cells below measure the same
 *    end state on both transports, and no sentence of this engine names a
 *    session. The `g4/release/d53/note.md` §5 refusal is the arm NOT taken.
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
import { UniqueConstraintError } from "@errors";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, it } from "vitest";
import {
  BatchOnlyDriver,
  SessionlessBatchOnlyDriver,
} from "./batch-only-drivers";

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
    // A unique that is NOT the key: a `connectOrCreate` on it is answered by a
    // lookup outside the queue, which is what gives a member its boundary.
    code: s.string().unique(),
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

/**
 * A series under a parent whose OWN key the provider generates, each of whose
 * members probes: the parent's key is produced in the first segment and bound
 * by the second, the third and the fourth (D-58).
 */
const seriesUnderAGeneratedParent = [
  {
    id: "m1",
    title: "a",
    holder: {
      connectOrCreate: {
        where: { code: "c1" },
        create: { id: "h1", code: "c1" },
      },
    },
  },
  {
    id: "m2",
    title: "b",
    holder: {
      connectOrCreate: {
        where: { code: "c2" },
        create: { id: "h2", code: "c2" },
      },
    },
  },
  {
    id: "m3",
    title: "c",
    holder: {
      connectOrCreate: {
        where: { code: "c3" },
        create: { id: "h3", code: "c3" },
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

  it("session lifetime (D-58): a second segment STORES its own member's key, because the scratch is its own", async () => {
    const client = await world(new SessionlessBatchOnlyDriver());
    await client.holder.create({ data: { id: "h1", code: "k1" } });
    await client.holder.update({
      where: { id: "h1" },
      data: { notes: { createMany: { data: seriesCreatingTwoWriters } } },
    });

    // Both members wrote, each child bound to the key its own segment's
    // provider generated: the second segment made the scratch it stores into
    // instead of naming the one the first segment's session took with it.
    assert.deepEqual(await client.writer.findMany({ orderBy: { id: "asc" } }), [
      { id: 1, handle: "alpha" },
      { id: 2, handle: "beta" },
    ]);
    assert.deepEqual(
      await client.note.findMany({
        select: { id: true, writerId: true },
        orderBy: { id: "asc" },
      }),
      [
        { id: "n1", writerId: 1 },
        { id: "n2", writerId: 2 },
      ]
    );
  });

  it("session lifetime (D-58): the scratch CLEANUP rides the segment that made it, so the terminal segment carries none", async () => {
    const client = await world(new SessionlessBatchOnlyDriver());
    await client.holder.create({ data: { id: "h1", code: "k1" } });
    await client.holder.update({
      where: { id: "h1" },
      data: { notes: { createMany: { data: seriesSharingOneWriter } } },
    });

    assert.deepEqual(await client.writer.findMany({ orderBy: { id: "asc" } }), [
      { id: 1, handle: "shared" },
    ]);
    assert.deepEqual(
      await client.note.findMany({
        select: { id: true, writerId: true },
        orderBy: { id: "asc" },
      }),
      [
        { id: "n1", writerId: 1 },
        { id: "n2", writerId: 1 },
      ]
    );
  });

  it("session lifetime (D-58): a value produced in the first segment is a literal in the second and the third", async () => {
    const dispatched = new SessionlessBatchOnlyDriver();
    const client = await world(dispatched);
    dispatched.reset();
    const created = await client.writer.create({
      data: {
        handle: "root",
        notes: { createMany: { data: seriesUnderAGeneratedParent } },
      },
    });

    // Four dispatched units: the one that PRODUCED the parent's key, and one
    // per member whose probe took the boundary N5 gives it.
    assert.equal(dispatched.batchCalls, 4, `units: ${dispatched.batchCalls}`);
    assert.deepEqual(created, { id: 1, handle: "root" });
    assert.deepEqual(
      await client.note.findMany({
        select: { id: true, writerId: true, holderId: true },
        orderBy: { id: "asc" },
      }),
      [
        { id: "m1", writerId: 1, holderId: "h1" },
        { id: "m2", writerId: 1, holderId: "h2" },
        { id: "m3", writerId: 1, holderId: "h3" },
      ]
    );
    // The value crossed as a LITERAL: the scratch's whole life — created,
    // stored into, read back and dropped — is over before the first member's
    // own write, so no later segment names the table at all.
    const statements = dispatched.statements.map((statement) => statement.sql);
    const lastScratch = statements.reduce(
      (last, sql, index) =>
        sql.includes("__viborm_batch_refs") ? index : last,
      -1
    );
    const firstMember = statements.findIndex((sql) =>
      sql.includes('INSERT INTO "d53_notes"')
    );
    assert.ok(lastScratch >= 0 && firstMember >= 0, statements.join("\n"));
    assert.ok(lastScratch < firstMember, statements.join("\n"));
  });

  it("session lifetime: the same series completes on a transport that keeps its session", async () => {
    const client = await world(new BatchOnlyDriver());
    await client.holder.create({ data: { id: "h1", code: "k1" } });
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
