/**
 * G4-02 author check — **D-7: a lone statement leaves the batch.**
 *
 * Arnaud's decision (2026-09-15, 22:40) applied: a set-oriented statement that
 * is the operation's ONLY statement needs no batch envelope and runs on the
 * plain execute path, which is the shipped transport rule
 * (`write-engine/OperationExecutor.ts` `canExecuteDirectly` at `:241` and its
 * `:346-357` call site — `runStatementAtomic` sends exactly this shape through
 * `_execute`). This file was the blocker's red reproducer
 * (`statement-index-blocker.red.test.ts`); it is now the positive contract.
 *
 * What it pins, and what falsifies it: restore the batch envelope for the lone
 * statement (drop the `lone` condition in `OperationContext.setMutations`) and
 * rows 1-4 go red with `+ statementIndex: 0`, because
 * `drivers/driver-diagnostics.ts:35-36` attributes index `0` to ANY
 * one-statement batch whose error carries no VibORM context and
 * `driver-transaction-base.ts:854-872` normalizes the failure with it. The
 * family is every one-statement batch the candidate used to submit — the folded
 * root write AND every relation-free bulk verb (`g4/regression-review.md`
 * finding 2, probes P4-P6) — so all four are rows here.
 *
 * Rows 5 and 6 are the NEIGHBOURS the rule must not disturb: a multi-statement
 * batch still is a batch, keeps the driver seam's index and agrees with the
 * shipped engine; and a set window that DID commit is still a committed segment
 * and still publishes its record-series progress, which is the G2.9 pin
 * (`tests/raptor3/post-prep/g29-result-progress.test.ts`) for the shape that
 * still has a series after D-7.
 *
 * Row 7 is the one shape D-7 moves the OTHER way, pinned as measured because it
 * is a decision for Arnaud (D-7.1, `g4/regression/note.md` "D-7 round" §D.6):
 * the shipped root `update`/`delete` fold is two statements — `[presence guard,
 * mutation … RETURNING]` — so it is a batch and keeps `statementIndex: 0`,
 * while the candidate's fold is one statement with a JavaScript postcondition
 * and now has no batch to attribute an index on. The one-statement batch was
 * what made those two agree.
 */
import assert from "node:assert/strict";
import type { BatchQuery, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { QueryEngineError, VibORMError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { isRecord } from "@validation/value-guards";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const INSERT_STATEMENT = /^INSERT\b/;

/**
 * The `sqlite-atomic-batch` transport model with the harness fault of
 * `tests/raptor3/harness/sqlite-world.ts:84-91`: the driver rejects one
 * statement before anything reaches the provider, so nothing can prove whether
 * the segment committed. `failAt` selects WHICH statement of the attempt fails,
 * which is what separates a one-statement batch from a longer one.
 */
class BeforeDispatchDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  failAt: number | undefined;
  dispatched = 0;

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    const index = this.dispatched++;
    if (this.failAt === index) {
      throw new Error("Controlled failure before dispatch");
    }
    return super.execute<T>(client, statement, parameters);
  }
}

/** The same transport, with a bind budget that splits one set into two. */
class ChunkingBeforeDispatchDriver extends BeforeDispatchDriver {
  override readonly maxBindParametersPerStatement: number | undefined = 2;
  batches = 0;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batches++;
    return super.executeBatch<T>(client, queries);
  }
}

/** The same chunking transport, faulting the RESULT instead of the dispatch. */
class ChunkingCorruptingDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  override readonly maxBindParametersPerStatement: number | undefined = 2;
  inserts = 0;
  batches = 0;
  corrupted = false;
  armed = false;

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    const response = await super.execute<T>(client, statement, parameters);
    if (INSERT_STATEMENT.test(statement)) this.inserts++;
    if (!this.armed) return response;
    for (const row of response.rows) {
      if (!isRecord(row)) continue;
      Reflect.set(row, "id", "not-an-integer");
      this.corrupted = true;
    }
    return response;
  }

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batches++;
    return this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
  }
}

const owner = s
  .model({
    id: s.int().id(),
    label: s.string().map("owner_label"),
    notes: s.toMany(() => note),
  })
  .map("g4_unit02_lone_owners");
const note = s
  .model({
    id: s.int().id().increment(),
    body: s.string(),
    ownerId: s.int().nullable().map("owner_id"),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id"),
  })
  .map("g4_unit02_lone_notes");
const schema = { owner, note };

type Engine = "candidate" | "shipped";
type Verb = "create" | "createMany" | "updateMany" | "deleteMany";

/** The published failure, less the one field two executions cannot share. */
function identity(failure: unknown): {
  code: string;
  meta: Record<string, unknown>;
  name: string;
} {
  assert.ok(
    failure instanceof VibORMError,
    `not a VibORMError: ${String(failure)}`
  );
  const { correlationId: _correlationId, ...meta } = failure.meta as Record<
    string,
    unknown
  >;
  return { code: failure.code, meta, name: failure.name };
}

const requests: Readonly<Record<Verb, Record<string, unknown>>> = {
  create: { data: { id: 2, label: "written" } },
  createMany: { data: [{ id: 2, label: "written" }] },
  updateMany: { where: { id: 1 }, data: { label: "changed" } },
  deleteMany: { where: { id: 1 } },
};

/**
 * Run ONE relation-free verb whose plan is a single statement on a batch-only
 * driver, with that statement rejected before dispatch, and return what each
 * engine published. A seed row exists so `updateMany`/`deleteMany` address a
 * real row: the rejection, not an empty selection, is the measured fault.
 */
async function rejectedLoneStatement(
  engine: Engine,
  verb: Verb
): Promise<ReturnType<typeof identity> & { dispatched: number }> {
  const database = new Database(":memory:");
  const driver = new BeforeDispatchDriver({ client: database });
  const client = createClient({ schema, driver });
  assert.equal((await syncLiveSchema(client)).applied, true);
  const publicClient = client as unknown as Record<
    string,
    Record<string, (args: unknown) => Promise<unknown>>
  >;
  await publicClient.owner!.create!({ data: { id: 1, label: "seed" } });
  driver.dispatched = 0;
  driver.failAt = 0;
  let failure: unknown;
  try {
    await (engine === "shipped"
      ? publicClient.owner![verb]!(requests[verb])
      : createCommandEngine({ schema, driver }).execute(
          "owner",
          verb,
          requests[verb]
        ));
  } catch (error) {
    failure = error;
  }
  driver.failAt = undefined;
  try {
    return { ...identity(failure), dispatched: driver.dispatched };
  } finally {
    await client.$disconnect();
    database.close();
  }
}

/**
 * The same measurement for a ROOT single-row fold, which reaches the provider
 * through a different physical shape on each engine (cell 7).
 */
async function rejectedRootFold(
  engine: Engine,
  verb: "update" | "delete",
  args: unknown
): Promise<{ meta: Record<string, unknown>; statements: number }> {
  const database = new Database(":memory:");
  const driver = new BeforeDispatchDriver({ client: database });
  const client = createClient({ schema, driver });
  assert.equal((await syncLiveSchema(client)).applied, true);
  const publicClient = client as unknown as Record<
    string,
    Record<string, (request: unknown) => Promise<unknown>>
  >;
  await publicClient.owner!.create!({ data: { id: 1, label: "seed" } });
  driver.dispatched = 0;
  driver.failAt = 0;
  let failure: unknown;
  try {
    await (engine === "shipped"
      ? publicClient.owner![verb]!(args)
      : createCommandEngine({ schema, driver }).execute("owner", verb, args));
  } catch (error) {
    failure = error;
  }
  driver.failAt = undefined;
  try {
    return { meta: identity(failure).meta, statements: driver.dispatched };
  } finally {
    await client.$disconnect();
    database.close();
  }
}

describe("G4-02 D-7 — a lone statement leaves the batch", () => {
  for (const verb of [
    "create",
    "createMany",
    "updateMany",
    "deleteMany",
  ] as const) {
    it(`${verb}: one statement rejected before dispatch answers the shipped failure exactly`, async () => {
      const shipped = await rejectedLoneStatement("shipped", verb);
      const candidate = await rejectedLoneStatement("candidate", verb);
      assert.equal(
        candidate.dispatched,
        1,
        `the verb must be ONE statement to measure this: ${JSON.stringify(candidate)}`
      );
      assert.equal(
        candidate.meta.statementIndex,
        undefined,
        `a statement outside a batch has no index to attribute: ${JSON.stringify({ shipped, candidate }, undefined, 2)}`
      );
      assert.equal(
        candidate.meta.recordSeriesProgress,
        undefined,
        `a root single-record write has no series to report: ${JSON.stringify(candidate, undefined, 2)}`
      );
      assert.deepEqual(
        candidate,
        shipped,
        `the rejected lone statement must answer what the shipped engine answers: ${JSON.stringify({ shipped, candidate }, undefined, 2)}`
      );
    });
  }

  it("5. a multi-statement batch is still a batch, and still agrees with the shipped engine", async () => {
    // The neighbour the rule must not disturb. Two rows whose bind budget
    // splits them into two statements stay in ONE batch, so the driver seam
    // still attributes its index — the change is confined to the one-statement
    // family, and this row goes red if the condition ever widens.
    const run = async (engine: Engine) => {
      const database = new Database(":memory:");
      const driver = new ChunkingBeforeDispatchDriver({ client: database });
      const client = createClient({ schema, driver });
      assert.equal((await syncLiveSchema(client)).applied, true);
      const publicClient = client as unknown as Record<
        string,
        Record<string, (args: unknown) => Promise<unknown>>
      >;
      driver.dispatched = 0;
      driver.batches = 0;
      driver.failAt = 1;
      let failure: unknown;
      try {
        await (engine === "shipped"
          ? publicClient.owner!.createMany!({
              data: [
                { id: 1, label: "a" },
                { id: 2, label: "b" },
              ],
            })
          : createCommandEngine({ schema, driver }).execute(
              "owner",
              "createMany",
              {
                data: [
                  { id: 1, label: "a" },
                  { id: 2, label: "b" },
                ],
              }
            ));
      } catch (error) {
        failure = error;
      }
      driver.failAt = undefined;
      const observed = {
        ...identity(failure),
        statements: driver.dispatched,
        batches: driver.batches,
      };
      await client.$disconnect();
      database.close();
      return observed;
    };
    const shipped = await run("shipped");
    const candidate = await run("candidate");
    assert.equal(
      candidate.statements,
      2,
      `the bind budget must split this set: ${JSON.stringify(candidate)}`
    );
    assert.equal(
      candidate.batches,
      1,
      `two statements are one batch: ${JSON.stringify(candidate)}`
    );
    assert.equal(
      candidate.meta.statementIndex,
      1,
      `a real batch keeps the driver seam's attribution: ${JSON.stringify(candidate, undefined, 2)}`
    );
    assert.deepEqual(
      candidate,
      shipped,
      `a multi-statement batch must still answer what the shipped engine answers: ${JSON.stringify({ shipped, candidate }, undefined, 2)}`
    );
  });

  it("7. root update/delete: the shipped two-statement fold keeps an index the candidate's one-statement fold has none of", async () => {
    // RECORDED DIVERGENCE (D-7.1, a decision for Arnaud — `g4/regression/note.md`
    // "D-7 round" §D.6). The shipped root `update`/`delete` fold is TWO
    // statements on a batch-only driver — `[presence guard, mutation …
    // RETURNING]` (`UpdateOperation`/`DeleteOperation` `foldGuard` /
    // `buildRootPresenceGuard`) — so it is a batch, and the driver seam
    // attributes `statementIndex: 0` to a rejection before dispatch. The
    // candidate's fold is ONE statement with a JavaScript postcondition
    // (`OperationContext.published`), which is the G3-accepted difference, so
    // after D-7 it is no batch and has no index to attribute. Before D-7 the
    // candidate's one-statement BATCH agreed with shipped by coincidence.
    // Pinned as measured so any change in either engine shows up here.
    for (const verb of ["update", "delete"] as const) {
      const args =
        verb === "update"
          ? { where: { id: 1 }, data: { label: "changed" } }
          : { where: { id: 1 } };
      const shipped = await rejectedRootFold("shipped", verb, args);
      const candidate = await rejectedRootFold("candidate", verb, args);
      assert.deepEqual(
        { statements: shipped.statements, index: shipped.meta.statementIndex },
        { statements: 1, index: 0 },
        `the shipped fold batches a presence guard with its mutation: ${JSON.stringify(shipped, undefined, 2)}`
      );
      assert.deepEqual(
        {
          statements: candidate.statements,
          index: candidate.meta.statementIndex,
        },
        { statements: 1, index: undefined },
        `the candidate fold is one statement outside any batch: ${JSON.stringify(candidate, undefined, 2)}`
      );
      assert.deepEqual(
        { ...candidate.meta, statementIndex: undefined },
        { ...shipped.meta, statementIndex: undefined },
        `nothing else diverges: ${JSON.stringify({ shipped, candidate }, undefined, 2)}`
      );
    }
  });

  it("6. a set window that committed still publishes its record-series progress", async () => {
    // The G2.9 progress half, on the shape that still HAS a record series after
    // D-7: the window of a two-statement set mutation is acknowledged, and a
    // window that DID commit is a committed segment like any other
    // (`g4/regression-review.md` finding 3, enforced by
    // `OperationContext.failure`). The one-statement form of the same cut is
    // `tests/raptor3/post-prep/g29-result-progress.test.ts`.
    const database = new Database(":memory:");
    const driver = new ChunkingCorruptingDriver({ client: database });
    const client = createClient({ schema, driver });
    assert.equal((await syncLiveSchema(client)).applied, true);
    driver.armed = true;
    let value: unknown;
    let failure: unknown;
    try {
      value = await createCommandEngine({ schema, driver }).execute(
        "owner",
        "createMany",
        {
          data: [
            { id: 1, label: "a" },
            { id: 2, label: "b" },
          ],
          select: { id: true, label: true },
        }
      );
    } catch (error) {
      failure = error;
    }
    const rows = database
      .prepare("SELECT id FROM g4_unit02_lone_owners ORDER BY id")
      .all();
    const diagnostic = JSON.stringify(
      {
        inserts: driver.inserts,
        batches: driver.batches,
        corrupted: driver.corrupted,
        rows,
        value,
        failure: failure instanceof VibORMError ? identity(failure) : failure,
      },
      undefined,
      2
    );
    try {
      assert.equal(value, undefined, diagnostic);
      assert.equal(driver.inserts, 2, diagnostic);
      assert.equal(driver.batches, 1, diagnostic);
      assert.equal(driver.corrupted, true, diagnostic);
      assert.ok(failure instanceof QueryEngineError, diagnostic);
      assert.equal(
        failure.message,
        'Driver "sqlite3" returned a malformed int scalar for operation "createMany": the value is not a canonical integer.',
        diagnostic
      );
      assert.deepEqual(
        identity(failure).meta.recordSeriesProgress,
        {
          atomicity: "segment",
          phase: "result",
          committedSegments: 1,
          committedWriteMembers: 1,
          completedMembers: 0,
        },
        diagnostic
      );
      assert.deepEqual(rows, [{ id: 1 }, { id: 2 }], diagnostic);
    } finally {
      await client.$disconnect();
      database.close();
    }
  });
});
