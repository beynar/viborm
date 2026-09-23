/**
 * C-01 cutover review probe (independent reviewer, not a registered mode).
 *
 * The replacing invariant the unit claims is: "every client lineage installs the
 * route in `VibORM`'s constructor and `bind()` forwards it — there is exactly one
 * operation owner and no routeless path". The note proves it by grep
 * (`client.ts:489` builds `createCandidateRoute(...)` unconditionally). These cells
 * prove it by observation instead, on the three lineages a client can reach:
 * the root view, a callback `$transaction`, and an array `$transaction([...])`.
 *
 * The observable is the Raptor 3 engine's own root alias spelling: it emits `q0`
 * where the deleted engine emitted `t0` (cutover proposal, integrator addendum to
 * stage 2c item 1). A lineage that reached any other owner could not answer `q0`.
 */
import assert from "node:assert/strict";
import type { BatchQuery, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";

const author = s
  .model({
    id: s.int().id().increment(),
    email: s.string().unique(),
    name: s.string(),
  })
  .map("g4rc_lineage_authors");
const schema = { author };

/** Records every statement the client submits, whatever transport carries it. */
class RecordingDriver extends SQLite3Driver {
  override readonly supportsBatch = true;
  readonly statements: string[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, parameters);
  }

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    for (const query of queries) this.statements.push(query.sql);
    return super.executeBatch<T>(client, queries);
  }
}

const opened: Database.Database[] = [];
const clients: { $disconnect(): Promise<unknown> }[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
  for (const database of opened.splice(0)) database.close();
});

async function world() {
  const database = new Database(":memory:");
  opened.push(database);
  const driver = new RecordingDriver({ client: database });
  const base = createClient({ driver, schema });
  clients.push(base as unknown as { $disconnect(): Promise<unknown> });
  assert.equal((await syncLiveSchema(base)).applied, true);
  await base.author.create({
    data: { email: "present@example.test", name: "Ada" },
  });
  driver.statements.length = 0;
  return { base, driver };
}

function selects(driver: RecordingDriver): string[] {
  return driver.statements.filter((text) => text.startsWith("SELECT"));
}

describe("C-01 review — one operation owner on every lineage", () => {
  it("the root view runs through the Raptor 3 engine", async () => {
    const { base, driver } = await world();
    const rows = await base.author.findMany({ where: { name: "Ada" } });
    assert.equal(rows.length, 1);
    const reads = selects(driver);
    assert.ok(reads.length >= 1, JSON.stringify(driver.statements));
    for (const text of reads) assert.match(text, /"q0"/);
  });

  it("a callback $transaction lineage runs through the same owner", async () => {
    const { base, driver } = await world();
    const rows = await base.$transaction(
      async (tx) => await tx.author.findMany({ where: { name: "Ada" } })
    );
    assert.equal(rows.length, 1);
    const reads = selects(driver);
    assert.ok(reads.length >= 1, JSON.stringify(driver.statements));
    for (const text of reads) assert.match(text, /"q0"/);
  });

  it("an array $transaction lineage runs through the same owner", async () => {
    const { base, driver } = await world();
    const results = await (
      base as unknown as {
        $transaction(members: readonly PromiseLike<unknown>[]): Promise<
          unknown[]
        >;
      }
    ).$transaction([
      base.author.findMany({ where: { name: "Ada" } }),
      base.author.count({}),
    ]);
    assert.equal(Array.isArray(results), true);
    const reads = selects(driver);
    assert.ok(reads.length >= 1, JSON.stringify(driver.statements));
    for (const text of reads) assert.match(text, /"q0"/);
  });
});
