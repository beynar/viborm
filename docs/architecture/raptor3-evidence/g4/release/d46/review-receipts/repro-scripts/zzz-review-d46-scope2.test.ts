/**
 * REVIEWER SCRATCH #2 — not part of the delivered suite. Checks whether the
 * D-46 read-narrowing can produce a SILENT DATA bug (not just a wrong error)
 * via `connectOrCreate`: if the planning read at array-route preparation
 * cannot see an earlier array member's not-yet-executed write, a
 * `connectOrCreate` might wrongly decide "missing" and CREATE a duplicate
 * instead of connecting.
 *
 * Result on the delivered tree: still ends up TransactionError (unbatchable),
 * NOT a silent duplicate write -- see review.md finding 1 for the caveat.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";

const shelf = s
  .model({
    id: s.string().id(),
    label: s.string().unique(),
    books: s.toMany(() => book),
  })
  .map("zzz2_shelves");

const book = s
  .model({
    id: s.string().id(),
    title: s.string(),
    shelfId: s.string().nullable(),
    shelf: s
      .toOne(() => shelf)
      .fields("shelfId")
      .references("id"),
  })
  .map("zzz2_books");

const schema = { shelf, book };

class BatchOnlyDriver extends RecordingSQLiteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  readonly direct: string[] = [];
  readonly batches: string[][] = [];
  private inBatch = false;

  override reset(): void {
    super.reset();
    this.direct.length = 0;
    this.batches.length = 0;
  }

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (!this.inBatch) this.direct.push(statement);
    return super.execute<T>(client, statement, parameters, context);
  }

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>[]> {
    this.batches.push(queries.map((q) => q.sql));
    this.inBatch = true;
    try {
      return await super.executeBatch<T>(client, queries, context);
    } finally {
      this.inBatch = false;
    }
  }
}

let db: Database.Database | undefined;
let driver: BatchOnlyDriver | undefined;
// biome-ignore lint/suspicious/noExplicitAny: reviewer scratch, not delivered code
let client: any;

afterEach(async () => {
  await client?.$disconnect();
  db?.close();
  db = undefined;
  driver = undefined;
  client = undefined;
});

async function world() {
  db = new Database(":memory:");
  driver = new BatchOnlyDriver({ client: db });
  client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("scratch world schema did not apply");
  driver.reset();
}

describe("REVIEW SCRATCH 2: D-46 connectOrCreate duplicate risk", () => {
  it("array member: update with nested connectOrCreate against a shelf created by an EARLIER array member", async () => {
    await world();
    const c = client;
    const d = driver!;
    await c.book.create({ data: { id: "b1", title: "t1" } });
    d.reset();
    let outcome: { ok: boolean; error?: unknown; result?: unknown } = {
      ok: false,
    };
    try {
      const result = await c.$transaction([
        c.shelf.create({ data: { id: "s1", label: "fiction" } }),
        c.book.update({
          where: { id: "b1" },
          data: {
            shelf: {
              connectOrCreate: {
                where: { label: "fiction" },
                create: { id: "s-duplicate", label: "fiction" },
              },
            },
          },
        }),
      ]);
      outcome = { ok: true, result };
    } catch (error) {
      outcome = { ok: false, error };
    }
    console.log("DIRECT (pre-batch) statements:", d.direct);
    console.log("BATCHES:", d.batches);
    console.log(
      "OUTCOME:",
      JSON.stringify(outcome, (_, v) =>
        v instanceof Error
          ? { name: v.constructor.name, message: v.message }
          : v
      )
    );
    const shelves = db!.prepare("SELECT id, label FROM zzz2_shelves").all();
    console.log("stored shelves:", shelves);
    const books = db!.prepare("SELECT id, title, shelfId FROM zzz2_books").all();
    console.log("stored books:", books);
    assert.ok(true);
  });
});
