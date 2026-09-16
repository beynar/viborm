/**
 * G4-02 author check — the malformed-result property at the cuts that SURROUND
 * the folded root `create` (raptor3 plan §5.4).
 *
 * `tests/raptor3/post-prep/g29-result-progress.test.ts` pins the property on
 * the statement-atomic form: one `INSERT … RETURNING`, the established
 * identity, no progress record, the row durable. That form ELIMINATES the cut
 * "fail between the INSERT and the stored-row read, inside the operation's
 * transaction", because there is no second statement to fail between. §5.4
 * requires the same property to be checked at that cut's legal neighbours, with
 * the atomic strategy recorded rather than assumed — statement count alone
 * proves nothing about isolation. Those neighbours are here:
 *
 *  1. the SAME request on a provider WITHOUT RETURNING — the split trace still
 *     exists (INSERT, then the stored-row read), the cut is reached, the
 *     progress record is truthful, and the operation's own transaction rolls
 *     the write back;
 *  2. a relation-bearing root `create` — the record route, several statements,
 *     the cut reached at a read that is not the first statement;
 *  3. the folded form itself, compared against the SHIPPED engine on the same
 *     corrupting driver: same class, code, message, meta, and same committed
 *     state. That comparison is what makes (and keeps) the fold parity rather
 *     than a choice.
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { QueryEngineError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { isRecord } from "@validation/value-guards";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

/** The one fault: the provider answers a row whose `id` is not an integer. */
function corruptReturnedId<T>(response: QueryResult<T>): boolean {
  if (response.rows.length === 0) return false;
  let corrupted = false;
  for (const row of response.rows) {
    if (!isRecord(row)) continue;
    Reflect.set(row, "id", "not-an-integer");
    corrupted = true;
  }
  return corrupted;
}

class CorruptingDriver extends SQLite3Driver {
  readonly statements: string[] = [];
  armed = false;
  corrupted = false;

  reset(): void {
    this.statements.length = 0;
    this.corrupted = false;
    this.armed = true;
  }

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    const response = await super.execute<T>(client, statement, parameters);
    if (this.armed && corruptReturnedId(response)) this.corrupted = true;
    return response;
  }

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>[]> {
    for (const query of queries) this.statements.push(query.sql);
    const responses = await super.executeBatch<T>(client, queries, context);
    if (this.armed)
      for (const response of responses)
        if (corruptReturnedId(response)) this.corrupted = true;
    return responses;
  }
}

class NonReturningCorruptingDriver extends CorruptingDriver {
  constructor(options: { client: Database.Database }) {
    super(options);
    this.adapter.capabilities.supportsReturning = false;
  }
}

/** The same split trace on a SEGMENT-atomic transport: nothing rolls back. */
class BatchOnlyNonReturningCorruptingDriver extends NonReturningCorruptingDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

const entity = s
  .model({ id: s.int().id(), label: s.string() })
  .map("g4_unit02_cuts");
const owner = s
  .model({
    id: s.int().id(),
    label: s.string().map("owner_label"),
    notes: s.toMany(() => note),
  })
  .map("g4_unit02_cut_owners");
const note = s
  .model({
    id: s.int().id(),
    body: s.string(),
    ownerId: s.int().nullable().map("owner_id"),
    owner: s.toOne(() => owner).fields("ownerId").references("id"),
  })
  .map("g4_unit02_cut_notes");

const flatSchema = { entity };
const relationSchema = { owner, note };

interface Observation {
  readonly failure: unknown;
  readonly value: unknown;
}

async function observe(run: () => Promise<unknown>): Promise<Observation> {
  try {
    return { value: await run(), failure: undefined };
  } catch (failure) {
    return { value: undefined, failure };
  }
}

function identity(failure: unknown): object {
  assert.ok(failure instanceof QueryEngineError, `not a QueryEngineError: ${String(failure)}`);
  return {
    name: failure.name,
    code: failure.code,
    message: failure.message,
    meta: { ...failure.meta },
  };
}

describe("G4-02 §5.4 — the malformed-result cut around the folded root create", () => {
  it("1. the split trace on a provider without RETURNING still reaches the cut", async () => {
    const database = new Database(":memory:");
    const driver = new NonReturningCorruptingDriver({ client: database });
    const client = createClient({ schema: flatSchema, driver });
    assert.equal((await syncLiveSchema(client)).applied, true);
    driver.reset();
    const engine = createCommandEngine({ schema: flatSchema, driver });
    const seen = await observe(() =>
      engine.execute("entity", "create", { data: { id: 1, label: "written" } })
    );
    const statements = [...driver.statements];
    assert.equal(seen.value, undefined, "nothing is published");
    assert.equal(driver.corrupted, true, "the cut was reached");
    assert.ok(
      statements.length > 1,
      `the split trace needs more than one statement: ${JSON.stringify(statements)}`
    );
    assert.ok(
      statements.some((statement) => /^SELECT\b/.test(statement)),
      `the stored row is read back: ${JSON.stringify(statements)}`
    );
    const observed = identity(seen.failure);
    assert.deepEqual(
      { ...observed, meta: undefined },
      {
        name: "QueryEngineError",
        code: (seen.failure as QueryEngineError).code,
        message:
          'Driver "sqlite3" returned a malformed int scalar for operation "create": the value is not a canonical integer.',
        meta: undefined,
      }
    );
    assert.deepEqual(
      (observed as { meta: Record<string, unknown> }).meta,
      { driver: "sqlite3", operation: "create", scalarType: "int" },
      "a TRANSACTION rolls back, so there is no committed segment to report"
    );
    assert.deepEqual(
      database.prepare("SELECT id FROM g4_unit02_cuts").all(),
      [],
      "the operation's own envelope rolled the write back"
    );
    await client.$disconnect();
    database.close();
  });

  it("1b. the same split trace on a segment-atomic transport reports truthful progress", async () => {
    const database = new Database(":memory:");
    const driver = new BatchOnlyNonReturningCorruptingDriver({
      client: database,
    });
    const client = createClient({ schema: flatSchema, driver });
    assert.equal((await syncLiveSchema(client)).applied, true);
    driver.reset();
    const engine = createCommandEngine({ schema: flatSchema, driver });
    const seen = await observe(() =>
      engine.execute("entity", "create", { data: { id: 1, label: "written" } })
    );
    assert.equal(seen.value, undefined, "nothing is published");
    assert.equal(driver.corrupted, true, "the cut was reached");
    assert.ok(
      driver.statements.length > 1,
      `the split trace needs more than one statement: ${JSON.stringify(driver.statements)}`
    );
    const observed = identity(seen.failure) as {
      message: string;
      meta: Record<string, unknown>;
    };
    assert.equal(
      observed.message,
      'Driver "sqlite3" returned a malformed int scalar for operation "create": the value is not a canonical integer.'
    );
    assert.deepEqual(
      observed.meta.recordSeriesProgress,
      {
        atomicity: "segment",
        phase: "result",
        committedSegments: 1,
        committedWriteMembers: 1,
        completedMembers: 0,
      },
      `a real series reports its progress: ${JSON.stringify(observed)}`
    );
    assert.deepEqual(
      database.prepare("SELECT id,label FROM g4_unit02_cuts").all(),
      [{ id: 1, label: "written" }],
      "a committed segment is durable, and the progress record says so"
    );
    await client.$disconnect();
    database.close();
  });

  it("2. a relation-bearing create reaches the cut on a later statement", async () => {
    const database = new Database(":memory:");
    const driver = new CorruptingDriver({ client: database });
    const client = createClient({ schema: relationSchema, driver });
    assert.equal((await syncLiveSchema(client)).applied, true);
    driver.reset();
    const engine = createCommandEngine({ schema: relationSchema, driver });
    const seen = await observe(() =>
      engine.execute("owner", "create", {
        data: { id: 1, label: "o", notes: { create: [{ id: 2, body: "n" }] } },
      })
    );
    assert.equal(seen.value, undefined, "nothing is published");
    assert.equal(driver.corrupted, true, "the cut was reached");
    assert.ok(
      driver.statements.length > 1,
      `a relation-bearing create is a series: ${JSON.stringify(driver.statements)}`
    );
    assert.ok(seen.failure instanceof Error);
    assert.deepEqual(
      database.prepare("SELECT id FROM g4_unit02_cut_owners").all(),
      [],
      "the series rolled back"
    );
    await client.$disconnect();
    database.close();
  });

  it("3. the folded form answers exactly the same on the client route seam and the command engine", async () => {
    const run = async (engine: "shipped" | "candidate") => {
      const database = new Database(":memory:");
      const driver = new CorruptingDriver({ client: database });
      const client = createClient({ schema: flatSchema, driver });
      assert.equal((await syncLiveSchema(client)).applied, true);
      driver.reset();
      const seen = await observe(() =>
        engine === "shipped"
          ? Promise.resolve(
              (
                client as unknown as Record<
                  string,
                  { create(args: unknown): Promise<unknown> }
                >
              ).entity!.create({ data: { id: 1, label: "written" } })
            )
          : createCommandEngine({ schema: flatSchema, driver }).execute(
              "entity",
              "create",
              { data: { id: 1, label: "written" } }
            )
      );
      const outcome = {
        statements: driver.statements.length,
        corrupted: driver.corrupted,
        value: seen.value,
        rows: database.prepare("SELECT id,label FROM g4_unit02_cuts").all(),
        failure: identity(seen.failure),
      };
      await client.$disconnect();
      database.close();
      return outcome;
    };
    const shipped = await run("shipped");
    const candidate = await run("candidate");
    assert.deepEqual(candidate, shipped, "the folded create is shipped parity");
    assert.equal(shipped.statements, 1, "one statement, no re-read");
    assert.deepEqual(
      shipped.rows,
      [{ id: 1, label: "written" }],
      "a statement-atomic write commits with its own statement"
    );
    assert.deepEqual(
      (shipped.failure as { meta: Record<string, unknown> }).meta,
      { driver: "sqlite3", operation: "create", scalarType: "int" },
      "no series, no progress record"
    );
  });
});
