/**
 * M1 (D-57) — the key a provider that cannot RETURN rows must already know.
 *
 * A driver without `supportsReturning` cannot read back the row its INSERT
 * wrote, so the engine has to NAME that row from what it already holds. It
 * holds three things and no more: a key the payload spelled, a key the ORM
 * itself produced at admission (`s.string().id()`'s ULID, `.uuid()`, `.cuid()`,
 * `.nanoid()`, `.now()` — every generator except `increment` installs a
 * JavaScript closure and the create boundary evaluates it), and ONE column the
 * provider generates and then names for the statement that produced it
 * (`insertId` / `LAST_INSERT_ID`, `OperationContext.insertIdField`).
 *
 * These cells measure that, and they measure the BOUNDARY: the two sentences
 * `Raptor 3 interactive output requires RETURNING or one generated increment
 * field` (the interactive `create`) and `Driver 'X' cannot locate one selected
 * createMany row after insertion` are reached by ONE schema shape and no
 * other — a model with MORE THAN ONE generated column among the fields the
 * operation must know. A compound key of a spelled part and one generated part
 * is named; a compound key of two generated parts is not.
 *
 * The shape is measured here on a capability-forced SQLite transport because no
 * shipped non-RETURNING provider admits it: MySQL is the only adapter that
 * declares `supportsReturning: false`, and MySQL refuses a second
 * AUTO_INCREMENT column at DDL time (errno 1075 — measured on the Docker lane
 * in `tests/providers/docker/mysql2-generated-key.test.ts`). See
 * `docs/architecture/raptor3-evidence/g4/release/m1/note.md`.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { QueryResult } from "@drivers";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";

const INSERT_STATEMENT = /^\s*insert\b/i;
const RETURNING_CLAUSE = /returning/i;
const INTERACTIVE_REFUSAL =
  /Raptor 3 interactive output requires RETURNING or one generated increment field/;
const CREATE_MANY_REFUSAL =
  /cannot locate one selected createMany row after insertion/;

/**
 * MySQL's transport profile on a credential-free driver: an interactive
 * session, no RETURNING, and a provider that names the one column it generated
 * for the statement that produced it.
 */
class InteractiveNonReturningDriver extends RecordingSQLiteDriver {
  constructor() {
    super();
    this.adapter.capabilities.supportsReturning = false;
  }
  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    const result = await super.execute<T>(client, statement, parameters);
    if (!INSERT_STATEMENT.test(statement)) return result;
    const named = await super.executeRaw<{ id: number | bigint }>(
      client,
      "SELECT last_insert_rowid() AS id"
    );
    const insertId = named.rows[0]?.id;
    return insertId === undefined ? result : { ...result, insertId };
  }
}

/** Every key the ORM produces in JavaScript, and a relation to carry one. */
const author = s
  .model({
    id: s.string().id(),
    name: s.string(),
    createdAt: s.dateTime().now(),
    books: s.toMany(() => book).name("m1gkAuthor"),
  })
  .map("m1gk_authors");
const book = s
  .model({
    id: s.string().uuid().id(),
    title: s.string(),
    authorId: s.string(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id")
      .name("m1gkAuthor"),
  })
  .map("m1gk_books");

/** The one column the provider generates and names. */
const ticket = s
  .model({ id: s.int().id().increment(), label: s.string() })
  .map("m1gk_tickets");

/** A compound key: one part the payload spells, one the provider generates. */
const slot = s
  .model({
    tenant: s.string(),
    seat: s.int().increment(),
    label: s.string(),
  })
  .id(["tenant", "seat"])
  .map("m1gk_slots");
/** A compound key both of whose parts the provider generates. */
const pair = s
  .model({
    left: s.int().increment(),
    right: s.int().increment(),
    label: s.string(),
  })
  .id(["left", "right"])
  .map("m1gk_pairs");

/**
 * SQLite spells AUTOINCREMENT only on a single INTEGER PRIMARY KEY, so the two
 * compound tables are created verbatim. The DECLARATION is what the engine
 * reads when it decides whether it can name the row; the physical column is
 * only somewhere to put it.
 */
const COMPOUND_TABLES = [
  'CREATE TABLE "m1gk_slots" ("seat" INTEGER PRIMARY KEY AUTOINCREMENT, "tenant" TEXT NOT NULL, "label" TEXT NOT NULL)',
  'CREATE TABLE "m1gk_pairs" ("left" INTEGER NOT NULL, "right" INTEGER NOT NULL, "label" TEXT NOT NULL, PRIMARY KEY ("left", "right"))',
];

describe("M1: the key a non-RETURNING provider must already know", () => {
  let driver: InteractiveNonReturningDriver | undefined;
  afterEach(async () => {
    await driver?.disconnect();
    driver = undefined;
  });

  async function ownWorld() {
    driver = new InteractiveNonReturningDriver();
    const client = createClient({ schema: { author, book }, driver });
    await syncLiveSchema(client);
    driver.reset();
    return client;
  }

  async function providerWorld() {
    driver = new InteractiveNonReturningDriver();
    const client = createClient({ schema: { ticket }, driver });
    await syncLiveSchema(client);
    driver.reset();
    return client;
  }

  async function compoundWorld() {
    driver = new InteractiveNonReturningDriver();
    const client = createClient({ schema: { pair, slot }, driver });
    for (const table of COMPOUND_TABLES) await client.$executeRawUnsafe(table);
    driver.reset();
    return client;
  }

  it("a create names its row from the key the ORM produced at admission", async () => {
    const client = await ownWorld();
    const created = await client.author.create({
      data: { name: "Ada" },
      select: { id: true, name: true },
    });
    assert.equal(typeof created.id, "string");
    assert.equal(created.name, "Ada");
    // The row the engine named is the row the provider stored.
    assert.deepEqual(
      await client.author.findUnique({
        where: { id: created.id },
        select: { id: true, name: true },
      }),
      created
    );
    // No RETURNING was spelled on the way there.
    assert.equal(
      driver?.statements.some((statement) =>
        RETURNING_CLAUSE.test(statement.sql)
      ),
      false
    );
  });

  it("a nested create, an upsert's create arm and a connectOrCreate name theirs the same way", async () => {
    const client = await ownWorld();
    const nested = await client.author.create({
      data: { name: "Grace", books: { create: { title: "One" } } },
      select: { id: true, books: { select: { id: true, title: true } } },
    });
    assert.equal(nested.books.length, 1);
    assert.equal(typeof nested.books[0]?.id, "string");

    const upserted = await client.author.upsert({
      where: { id: "m1gk-absent" },
      create: { name: "Barbara" },
      update: { name: "changed" },
      select: { id: true, name: true },
    });
    assert.equal(upserted.name, "Barbara");
    assert.equal(typeof upserted.id, "string");

    const connected = await client.book.create({
      data: {
        title: "Two",
        author: {
          connectOrCreate: {
            where: { id: "m1gk-absent-2" },
            create: { name: "Katherine" },
          },
        },
      },
      select: { id: true, authorId: true },
    });
    assert.equal(typeof connected.authorId, "string");
    assert.deepEqual(
      await client.author.findUnique({
        where: { id: connected.authorId },
        select: { name: true },
      }),
      { name: "Katherine" }
    );
  });

  it("a selected createMany locates every row it wrote, with and without skipDuplicates", async () => {
    const client = await ownWorld();
    const many = await client.author.createMany({
      data: [{ name: "One" }, { name: "Two" }],
      select: { id: true, name: true },
    });
    assert.deepEqual(
      many.map((row) => row.name),
      ["One", "Two"]
    );
    for (const row of many) assert.equal(typeof row.id, "string");

    const skipped = await client.author.createMany({
      data: [{ name: "Three" }],
      skipDuplicates: true,
      select: { id: true, name: true },
    });
    assert.deepEqual(
      skipped.map((row) => row.name),
      ["Three"]
    );
  });

  it("one generated column rides the identity the provider names for its own statement", async () => {
    const client = await providerWorld();
    assert.deepEqual(
      await client.ticket.create({
        data: { label: "first" },
        select: { id: true, label: true },
      }),
      { id: 1, label: "first" }
    );
    assert.deepEqual(
      await client.ticket.createMany({
        data: [{ label: "second" }, { label: "third" }],
        select: { id: true, label: true },
      }),
      [
        { id: 2, label: "second" },
        { id: 3, label: "third" },
      ]
    );
  });

  it("a compound key of one spelled part and one generated part is named", async () => {
    const client = await compoundWorld();
    assert.deepEqual(
      await client.slot.create({
        data: { tenant: "acme", label: "desk" },
        select: { tenant: true, seat: true, label: true },
      }),
      { tenant: "acme", seat: 1, label: "desk" }
    );
    assert.deepEqual(
      await client.slot.createMany({
        data: [{ tenant: "acme", label: "chair" }],
        select: { tenant: true, seat: true, label: true },
      }),
      [{ tenant: "acme", seat: 2, label: "chair" }]
    );
  });

  it("a compound key of two generated parts is the one shape neither arm can name", async () => {
    const client = await compoundWorld();
    await assert.rejects(async () => {
      await client.pair.create({
        data: { label: "x" },
        select: { left: true, right: true, label: true },
      });
    }, INTERACTIVE_REFUSAL);
    await assert.rejects(async () => {
      await client.pair.createMany({
        data: [{ label: "y" }],
        select: { left: true, right: true },
      });
    }, CREATE_MANY_REFUSAL);
    // Neither refusal wrote anything.
    assert.deepEqual(
      await client.pair.findMany({ select: { label: true } }),
      []
    );
  });

  it("the same compound key is named as soon as the payload spells both parts", async () => {
    const client = await compoundWorld();
    assert.deepEqual(
      await client.pair.create({
        data: { left: 7, right: 9, label: "spelled" },
        select: { left: true, right: true, label: true },
      }),
      { left: 7, right: 9, label: "spelled" }
    );
    assert.deepEqual(
      await client.pair.createMany({
        data: [{ left: 8, right: 10, label: "also spelled" }],
        select: { left: true, right: true, label: true },
      }),
      [{ left: 8, right: 10, label: "also spelled" }]
    );
  });
});
