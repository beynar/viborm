/**
 * R1 — **a concrete reference that becomes a relation must be representable**,
 * on native PostgreSQL.
 *
 * The credential-free pins
 * (`tests/raptor3/g4/parity/reference-representability.test.ts`) prove the
 * engine's answer on both routes. This file proves the three facts that only a
 * real transactional provider can witness, with no capability changed by the
 * test:
 *
 *  1. **Operation-owned rollback.** The refusal stands before the holder's own
 *     SET, so no sibling scalar of that statement survives — and where the
 *     refused connection's arm had already INSERTed its own row, the
 *     operation's own transaction takes that row back.
 *  2. **Borrowed transaction ownership.** Inside `$transaction(async tx => …)`
 *     the caller owns the transaction: the engine does not commit it, does not
 *     replay it, and does not clean it up. PostgreSQL makes this checkable —
 *     a statement that actually reached the server and failed would leave the
 *     transaction in its aborted state and every later statement would answer
 *     `current transaction is aborted`. The caller's later writes commit, so
 *     the refusal reached no statement and took no ownership.
 *  3. The caller's own abort still takes the whole callback with it.
 *
 * The suite owns two `r13_*` tables, creates them verbatim and drops only
 * those: the database is shared, so nothing here pushes a schema or drops
 * anything it did not create.
 *
 * NOTE: requires a running PostgreSQL (docker). Set PG_TEST_CONNECTION_STRING.
 */

import assert from "node:assert/strict";
import { createClient as PgCreateClient } from "@drivers/pg";
import { NestedWriteError } from "@errors";
import { s } from "@schema";
import { afterAll, beforeAll, describe, it } from "vitest";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

/** `code` is a NULLABLE unique the holder's edge references and the payload
 *  does not address. */
const badge = s
  .model({
    id: s.string().id(),
    slug: s.string().unique(),
    code: s.string().nullable().unique(),
    note: s.string().nullable(),
    holders: s.toMany(() => holder),
  })
  .map("r13_badges");
const holder = s
  .model({
    id: s.string().id(),
    name: s.string(),
    badgeCode: s.string().nullable(),
    badge: s
      .toOne(() => badge)
      .fields("badgeCode")
      .references("code"),
  })
  .map("r13_holders");
const schema = { badge, holder };

const NULL_CODE =
  "Cannot connect relation 'badge': the located target's referenced field 'code' is null.";
const NULL_CODE_HOLDERS =
  "Cannot connect relation 'holders': the located target's referenced field 'code' is null.";

/** Children first: a table is dropped before the table it references. */
const TABLES = ["r13_holders", "r13_badges"];
const DDL = [
  'CREATE TABLE "r13_badges" ("id" varchar(191) NOT NULL, "slug" varchar(191) NOT NULL, "code" varchar(191), "note" varchar(191), PRIMARY KEY ("id"), CONSTRAINT "r13_badges_slug" UNIQUE ("slug"), CONSTRAINT "r13_badges_code" UNIQUE ("code"))',
  'CREATE TABLE "r13_holders" ("id" varchar(191) NOT NULL, "name" varchar(191) NOT NULL, "badgeCode" varchar(191), PRIMARY KEY ("id"), CONSTRAINT "r13_holders_badge" FOREIGN KEY ("badgeCode") REFERENCES "r13_badges" ("code"))',
];

describeIf("R1: reference representability on native PostgreSQL", () => {
  const client = PgCreateClient({
    schema,
    databaseUrl: TEST_CONNECTION_STRING,
  });

  beforeAll(async () => {
    for (const table of TABLES)
      await client.$executeRawUnsafe(`DROP TABLE IF EXISTS "${table}"`);
    for (const statement of DDL) await client.$executeRawUnsafe(statement);
  });

  afterAll(async () => {
    for (const table of TABLES)
      await client.$executeRawUnsafe(`DROP TABLE IF EXISTS "${table}"`);
    await client.$disconnect();
  });

  async function world() {
    for (const table of TABLES)
      await client.$executeRawUnsafe(`DELETE FROM "${table}"`);
    await client.badge.create({
      data: { id: "b1", slug: "codeless", code: null, note: null },
    });
    await client.badge.create({
      data: { id: "b2", slug: "gold", code: "GOLD", note: null },
    });
    await client.holder.create({
      data: { id: "h1", name: "one", badgeCode: "GOLD" },
    });
  }

  const badgeIds = async () =>
    (await client.badge.findMany({ orderBy: { id: "asc" } })).map(
      (row) => row.id
    );

  it("1. the operation owns its own rollback: the produced row and the sibling scalar both go", async () => {
    await world();
    await assert.rejects(
      async () => {
        await client.holder.update({
          where: { id: "h1" },
          data: {
            name: "renamed",
            badge: {
              connectOrCreate: {
                where: { slug: "fresh" },
                create: { id: "b9", slug: "fresh", code: null, note: null },
              },
            },
          },
        });
      },
      (error: unknown) =>
        error instanceof NestedWriteError && error.message === NULL_CODE
    );
    assert.deepEqual(await client.holder.findMany(), [
      { id: "h1", name: "one", badgeCode: "GOLD" },
    ]);
    assert.deepEqual(await badgeIds(), ["b1", "b2"]);
  });

  it("2. the child-held direction refuses, and the parent's own write does not survive it", async () => {
    await world();
    await assert.rejects(
      async () => {
        await client.badge.update({
          where: { id: "b1" },
          data: { note: "touched", holders: { connect: { id: "h1" } } },
        });
      },
      (error: unknown) =>
        error instanceof NestedWriteError && error.message === NULL_CODE_HOLDERS
    );
    assert.deepEqual(await client.badge.findMany({ where: { id: "b1" } }), [
      { id: "b1", slug: "codeless", code: null, note: null },
    ]);
    assert.deepEqual(await client.holder.findMany(), [
      { id: "h1", name: "one", badgeCode: "GOLD" },
    ]);
  });

  it("3. a BORROWED transaction stays the caller's: not committed, not replayed, not cleaned up", async () => {
    await world();
    await client.$transaction(async (tx) => {
      await tx.badge.create({
        data: { id: "m1", slug: "before", code: "M1", note: null },
      });
      await assert.rejects(
        async () => {
          await tx.holder.update({
            where: { id: "h1" },
            data: {
              name: "renamed",
              badge: {
                connectOrCreate: {
                  where: { slug: "fresh" },
                  create: { id: "b9", slug: "fresh", code: null, note: null },
                },
              },
            },
          });
        },
        (error: unknown) =>
          error instanceof NestedWriteError && error.message === NULL_CODE
      );
      // The caller's transaction is still ITS transaction and still usable:
      // PostgreSQL would answer `current transaction is aborted` for every
      // statement after a server-side failure, and a transaction the engine had
      // taken over would have committed or rolled back the row above.
      await tx.badge.create({
        data: { id: "m2", slug: "after", code: "M2", note: null },
      });
    });
    // The caller returned normally, so the CALLER's transaction committed —
    // both markers, and nothing of the refused operation.
    assert.deepEqual(await badgeIds(), ["b1", "b2", "m1", "m2"]);
    assert.deepEqual(await client.holder.findMany(), [
      { id: "h1", name: "one", badgeCode: "GOLD" },
    ]);
  });

  it("4. the caller's own abort still takes the whole callback with it", async () => {
    await world();
    const aborted = new Error("the caller's own abort");
    await assert.rejects(
      async () => {
        await client.$transaction(async (tx) => {
          await tx.badge.create({
            data: { id: "m1", slug: "before", code: "M1", note: null },
          });
          await assert.rejects(
            async () => {
              await tx.badge.update({
                where: { id: "b1" },
                data: { holders: { connect: { id: "h1" } } },
              });
            },
            (error: unknown) =>
              error instanceof NestedWriteError &&
              error.message === NULL_CODE_HOLDERS
          );
          throw aborted;
        });
      },
      (error: unknown) => error === aborted
    );
    assert.deepEqual(await badgeIds(), ["b1", "b2"]);
  });

  it("5. a representable reference still connects natively, in both directions", async () => {
    await world();
    assert.deepEqual(
      await client.holder.update({
        where: { id: "h1" },
        data: { badge: { disconnect: true } },
      }),
      { id: "h1", name: "one", badgeCode: null }
    );
    await client.badge.update({
      where: { id: "b2" },
      data: { note: "kept", holders: { connect: { id: "h1" } } },
    });
    assert.deepEqual(await client.holder.findMany(), [
      { id: "h1", name: "one", badgeCode: "GOLD" },
    ]);
    assert.deepEqual(
      await client.holder.update({
        where: { id: "h1" },
        data: {
          name: "adopted",
          badge: {
            connectOrCreate: {
              where: { slug: "fresh" },
              create: { id: "b9", slug: "fresh", code: "NEW", note: null },
            },
          },
        },
      }),
      { id: "h1", name: "adopted", badgeCode: "NEW" }
    );
    assert.deepEqual(await badgeIds(), ["b1", "b2", "b9"]);
  });
});
