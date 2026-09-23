/**
 * N5 — the three facts the `cmds` unit states about a membership whose value
 * another owner resolves.
 *
 * 1. A CORRELATED arm (a nested `update` or `upsert` under an updating parent)
 *    locates its target by the parent's FINAL membership value — "the parent's
 *    FK value is its FINAL value", the delegated fold's pinned semantics (M1,
 *    `tests/contracts/engine/write/parent-held-delegated-fk-rebind-correlation.test.ts`)
 *    — and that value is what the located row HOLDS, so the arm's own
 *    membership contribution RESTATES the parent's assignment instead of
 *    adding a second final one. An UNcorrelated producer still owns the
 *    conflict: two independent statements of one column remain the registered
 *    refusal.
 * 2. A `connect` whose located value the PARENT's own SET spends carries that
 *    row's presence into the write, proved inside the atomic unit that carries
 *    it (D-29): a target that vanishes between the plan-time read and the
 *    batch aborts the unit with the arm's own identity sentence, not with a
 *    foreign-key violation on a column the engine chose.
 * 3. A membership asks whether the producer's create SUPPLIES the referenced
 *    field, never whether its value is a construction-time literal: a sibling
 *    `connect` supplies it from the row it locates. A referenced field the
 *    create neither writes nor generates keeps the registered sentence.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { NestedWriteError, UnsupportedOperationError } from "@errors";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";
import { BatchOnlyDriver } from "./batch-only-drivers";

const author = s
  .model({
    id: s.int().id(),
    name: s.string(),
    books: s.toMany(() => book),
  })
  .map("n5c_authors");
const book = s
  .model({
    id: s.int().id(),
    title: s.string(),
    authorId: s.int().nullable(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
  })
  .map("n5c_books");
const rebindSchema = { author, book };

const provider = s
  .model({
    id: s.string().id(),
    // A to-ONE: `account.providerId` is unique, and the badge edge references
    // that same unique, so the uniqueness is the fact that must stay.
    account: s.toOne(() => account),
  })
  .map("n5c_providers");
const account = s
  .model({
    id: s.int().id().increment(),
    providerId: s.string().unique().nullable(),
    provider: s
      .toOne(() => provider)
      .fields("providerId")
      .references("id"),
    badges: s.toMany(() => badge),
  })
  .map("n5c_accounts");
const badge = s
  .model({
    id: s.string().id(),
    accountProviderId: s.string(),
    account: s
      .toOne(() => account)
      .fields("accountProviderId")
      .references("providerId"),
  })
  .map("n5c_badges");
const supplySchema = { account, badge, provider };

describe("N5: a correlated arm restates the parent's final membership value", () => {
  let driver: RecordingSQLiteDriver | undefined;
  afterEach(async () => {
    await driver?.disconnect();
    driver = undefined;
  });

  async function world() {
    driver = new RecordingSQLiteDriver({ dataDir: ":memory:" });
    const client = createClient({ schema: rebindSchema, driver });
    await syncLiveSchema(client);
    await client.author.createMany({
      data: [
        { id: 1, name: "decoy" },
        { id: 2, name: "target" },
        { id: 3, name: "bystander" },
      ],
    });
    await client.book.create({ data: { id: 1, title: "book-1", authorId: 1 } });
    return client;
  }

  it("locates and writes the row the parent's own SET ends on", async () => {
    const client = await world();
    assert.deepEqual(
      await client.book.update({
        where: { id: 1 },
        data: {
          authorId: 2,
          author: {
            upsert: {
              update: { name: "renamed" },
              create: { id: 9, name: "never" },
            },
          },
        },
      }),
      { id: 1, title: "book-1", authorId: 2 }
    );
    // The author the book moved AWAY from is untouched, and no arm created a
    // row: the upsert found the row the parent ENDS on.
    assert.deepEqual(await client.author.findMany({ orderBy: { id: "asc" } }), [
      { id: 1, name: "decoy" },
      { id: 2, name: "renamed" },
      { id: 3, name: "bystander" },
    ]);
  });

  it("keeps the conflict for a producer the parent's value did not select", async () => {
    const client = await world();
    // A `connect` is not correlated — its row is named by its own selector, not
    // by the parent's value — so the column carries two independent final
    // assignments and the registered sentence stands.
    await assert.rejects(
      async () => {
        await client.book.update({
          where: { id: 1 },
          data: { authorId: 2, author: { connect: { id: 3 } } },
        });
      },
      (error: unknown) =>
        error instanceof UnsupportedOperationError &&
        error.message ===
          "query-engine-v2 update has conflicting final assignments for column 'authorId' on relation 'author'."
    );
    assert.deepEqual(await client.book.findMany(), [
      { id: 1, title: "book-1", authorId: 1 },
    ]);
  });
});

describe("N5: a parent-held connect carries its target's presence into the write", () => {
  let driver: BatchOnlyDriver | undefined;
  afterEach(async () => {
    await driver?.disconnect();
    driver = undefined;
  });

  it("aborts the unit with the arm's own sentence when the target vanishes", async () => {
    driver = new BatchOnlyDriver({ dataDir: ":memory:" });
    const client = createClient({ schema: rebindSchema, driver });
    await syncLiveSchema(client);
    await client.author.createMany({
      data: [
        { id: 1, name: "decoy" },
        { id: 2, name: "target" },
      ],
    });
    await client.book.create({ data: { id: 1, title: "book-1" } });
    // The row the plan-time read found, gone before the batch runs. Without
    // the premise the write reaches the provider and the foreign key answers.
    driver.plant = (database) => {
      database.prepare('DELETE FROM "n5c_authors" WHERE "id" = ?').run(2);
    };
    await assert.rejects(
      async () => {
        await client.book.update({
          where: { id: 1 },
          data: { author: { connect: { id: 2 } } },
        });
      },
      (error: unknown) =>
        error instanceof NestedWriteError &&
        error.message ===
          "Cannot connect relation 'author': target record was not found."
    );
    assert.deepEqual(await client.book.findMany(), [
      { id: 1, title: "book-1", authorId: null },
    ]);
  });
});

describe("N5: a connect supplies the referenced field of a sibling edge", () => {
  let driver: RecordingSQLiteDriver | undefined;
  afterEach(async () => {
    await driver?.disconnect();
    driver = undefined;
  });

  async function world() {
    driver = new RecordingSQLiteDriver({ dataDir: ":memory:" });
    const client = createClient({ schema: supplySchema, driver });
    await syncLiveSchema(client);
    await client.provider.create({ data: { id: "provider" } });
    return client;
  }

  it("resolves a referenced column a nested connect fills", async () => {
    const client = await world();
    assert.deepEqual(
      await client.badge.create({
        data: {
          id: "badge",
          account: { create: { provider: { connect: { id: "provider" } } } },
        },
        select: { id: true, accountProviderId: true },
      }),
      { id: "badge", accountProviderId: "provider" }
    );
    assert.deepEqual(await client.account.findMany(), [
      { id: 1, providerId: "provider" },
    ]);
  });

  it("keeps the sentence for a referenced field nothing writes or generates", async () => {
    const client = await world();
    await assert.rejects(
      async () => {
        await client.badge.create({
          data: { id: "badge", account: { create: {} } },
        });
      },
      (error: unknown) =>
        error instanceof UnsupportedOperationError &&
        error.message ===
          "query-engine-v2 create cannot resolve the parent id for relation 'account': referenced field 'providerId' is neither this record's primary key nor a knowable value in its own create data."
    );
    assert.deepEqual(await client.badge.findMany(), []);
  });
});
