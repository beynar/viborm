/**
 * G4-02 author check — an UNCERTAIN outcome is not a record series, and the
 * cache still hears about it.
 *
 * The regression `g2-generated` seed 2122 measured
 * (`docs/architecture/raptor3-evidence/g4/briefs/g2-generated-regression.md`,
 * repair note `g4/regression/note.md`): a root `create` whose atomic batch is
 * rejected BEFORE dispatch answered with `recordSeriesProgress { …,
 * mayHaveCommittedSegment: true }` where the shipped engine answers the
 * driver's own error. The shipped rule
 * (`write-engine/OperationExecutor.ts:1031-1072`) keeps the unknown-outcome
 * fact INTERNAL for a single operation — it drives cache invalidation and then
 * rethrows the raw error; `attachProgress` (:2308) reaches only record-series
 * member failures and the invalidation aggregates.
 *
 *  1. differential: the folded root `create`, rejected before dispatch on a
 *     batch-only transport, publishes NO record-series progress on either
 *     engine and agrees with the shipped failure on EVERY field. Nothing is
 *     excluded any more: the driver seam's `statementIndex: 0` was the second,
 *     independent divergence recorded as blocker D-7, and Arnaud's decision
 *     removed it at the transport (a lone statement leaves the batch). The
 *     shapes that decision covers are pinned in the sibling
 *     `lone-statement-transport.test.ts`, which this file's red reproducer
 *     became;
 *  2. control: a real record series (a `createMany` segment) rejected exactly
 *     the same way KEEPS its progress, `mayHaveCommittedSegment` included;
 *  3. seam: the same uncertain root `create`, under `cache.autoInvalidate`,
 *     invalidates on BOTH routes. The candidate no longer reads that fact off
 *     published error meta — the transport states it through
 *     `ExecutionBinding.writeOutcome` at the point it learns it, which is where
 *     the shipped executor states it (`OperationExecutor.ts:1050-1058`). This
 *     is the reviewer's probe P7 (`g4/regression-review.md` finding 1) as an
 *     author cell: it is the falsifier for the seam, and it goes red (candidate
 *     0 against shipped 1) the moment the notification is disabled;
 *  4. the committed half of the same seam: exactly one invalidation, so no
 *     second publication site exists;
 *  5. the committed half when the operation STILL fails — the write commits and
 *     its result will not decode. After D-7 that write is a plain statement, so
 *     the plain path is what must say the segment committed
 *     (`runBorrowedStatementAtomic`, `OperationExecutor.ts:1630-1645`);
 *  6-7. the followup review's S6/S7: a cache listener that throws never
 *     replaces the operation's own failure (and, with no failure of its own to
 *     keep, both engines answer the listener's error);
 *  8. the D-7 review's D9 (finding 1): the two halves TOGETHER — a malformed
 *     result and a throwing listener — keep the registered malformed-scalar
 *     refusal primary, not the internal `InvalidScalarResult` the plain path
 *     used to compose;
 *  9. the D-7 review's D12 (finding 2): the same pair on the BATCH transport,
 *     which acknowledges before it decodes, so the listener's failure is held
 *     and composed after the operation has answered;
 *  10. the D-7 review's D11 (note 3): the falsifier for the plain path's
 *     `owned` gate — a write inside the operation's OWN region that rolls back
 *     tells the cache nothing, on either engine.
 */
import assert from "node:assert/strict";
import { VibORM, type VibORMClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { VibORMError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { createCandidateRoute } from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/exports";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { isRecord } from "@validation/value-guards";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

/**
 * The harness fault of `tests/raptor3/harness/sqlite-world.ts:84-91` on the
 * `sqlite-atomic-batch` transport model: the driver rejects the request before
 * anything reaches the provider, so it cannot prove whether the segment
 * committed.
 */
class BeforeDispatchDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  failuresBeforeDispatch = 0;
  /** The other half of the seam: the write COMMITS and its result is unusable. */
  corruptResults = false;

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    if (this.failuresBeforeDispatch > 0) {
      this.failuresBeforeDispatch--;
      throw new Error("Controlled failure before dispatch");
    }
    const response = await super.execute<T>(client, statement, parameters);
    if (this.corruptResults)
      for (const row of response.rows)
        if (isRecord(row)) Reflect.set(row, "id", "not-an-integer");
    return response;
  }
}

/**
 * The same faults on a transport whose BIND BUDGET splits one set of two rows
 * into two statements, so the set really is a batch and `submit()` — not the
 * plain path — is what acknowledges its committed segment.
 */
class SplittingBatchDriver extends BeforeDispatchDriver {
  override readonly maxBindParametersPerStatement: number | undefined = 2;
  batches = 0;

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

/**
 * The same split budget on a TRANSACTION-capable transport: two statements make
 * the operation open its own region, and a malformed result rolls that region
 * back. Nothing may tell the cache that such a write became durable.
 */
class SplittingTransactionalDriver extends SQLite3Driver {
  override readonly maxBindParametersPerStatement: number | undefined = 2;
  corruptResults = false;

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    const response = await super.execute<T>(client, statement, parameters);
    if (this.corruptResults)
      for (const row of response.rows)
        if (isRecord(row)) Reflect.set(row, "id", "not-an-integer");
    return response;
  }
}

/** Counts what the official cache driver was actually asked to drop. */
class RecordingCache extends MemoryCache {
  readonly invalidations: string[] = [];
  failing = false;

  protected override async clear(prefix: string): Promise<void> {
    this.invalidations.push(`clear:${prefix}`);
    if (this.failing) throw new Error("cache driver refused to clear");
    return super.clear(prefix);
  }
}

const owner = s
  .model({
    id: s.int().id(),
    label: s.string().map("owner_label"),
    notes: s.toMany(() => note),
  })
  .map("g4_unit02_uncertain_owners");
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
  .map("g4_unit02_uncertain_notes");
const schema = { owner, note };

interface Observation {
  readonly failure: unknown;
  readonly value: unknown;
}

async function observe(run: () => PromiseLike<unknown>): Promise<Observation> {
  try {
    return { value: await run(), failure: undefined };
  } catch (failure) {
    return { value: undefined, failure };
  }
}

/**
 * What a failure IS, at the depth at which an AggregateError composition is
 * visible: the reviewer's `shape` (`g4/d7-review.md`), adopted so cells 8-10
 * measure the IDENTITY of the primary and not only its class name.
 */
function shape(failure: unknown): unknown {
  if (failure instanceof AggregateError)
    return {
      cause: shape(failure.cause),
      errors: failure.errors.map((entry) => shape(entry)),
      kind: "AggregateError",
      message: failure.message,
    };
  if (failure instanceof VibORMError) {
    const { code, meta, name } = identity(failure);
    return { code, kind: name, meta };
  }
  if (failure instanceof Error)
    return { kind: failure.name, message: failure.message };
  return failure === undefined
    ? undefined
    : { kind: "raw", value: String(failure) };
}

/**
 * A SHAPED failure with the one accepted divergence removed, and only it: a
 * committed set window publishes `recordSeriesProgress` on this engine where the
 * shipped engine publishes none (`g4/regression-review.md` finding 3, probe P8).
 */
function withoutProgress(shaped: unknown): unknown {
  if (!isRecord(shaped)) return shaped;
  const copy: Record<string, unknown> = { ...shaped };
  if (isRecord(copy.meta)) {
    const { recordSeriesProgress: _progress, ...rest } = copy.meta;
    copy.meta = rest;
  }
  if (Array.isArray(copy.errors))
    copy.errors = copy.errors.map((entry) => withoutProgress(entry));
  if (copy.cause !== undefined) copy.cause = withoutProgress(copy.cause);
  return copy;
}

/**
 * The published failure, with the one field two engines cannot share removed:
 * `correlationId` is a per-execution identity.
 */
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

async function withWorld<T>(
  drive: (world: {
    driver: BeforeDispatchDriver;
    database: Database.Database;
    publicClient: Record<string, { create(args: unknown): Promise<unknown> }>;
  }) => Promise<T>
): Promise<T> {
  const database = new Database(":memory:");
  const driver = new BeforeDispatchDriver({ client: database });
  const client = createClient({ schema, driver });
  assert.equal((await syncLiveSchema(client)).applied, true);
  try {
    return await drive({
      driver,
      database,
      publicClient: client as unknown as Record<
        string,
        { create(args: unknown): Promise<unknown> }
      >,
    });
  } finally {
    await client.$disconnect();
    database.close();
  }
}

/**
 * One cached world per ROUTE. The candidate route is reached the way a client
 * reaches it — `VibORM.create(config, createCandidateRoute)` — because the
 * fact under test is published by the client's own cache rail.
 *
 * `fault` selects the three shapes the seam distinguishes: the write rejected
 * before dispatch (an outcome no one can prove rolled back), the write that
 * commits (an acknowledged segment), and the write that commits and then
 * answers a row nothing can decode (an acknowledged segment whose operation
 * still fails). `failingListener` makes the client's own cache driver throw, so
 * the composition of the two failures is measured rather than assumed.
 */
async function observeInvalidation(
  route: "candidate" | "shipped",
  fault: "rejected" | "committed" | "malformed-result",
  failingListener = false
): Promise<{
  failure: unknown;
  invalidations: number;
  outcome: string;
  primary?: string;
  rows: unknown[];
}> {
  const database = new Database(":memory:");
  const driver = new BeforeDispatchDriver({ client: database });
  const config = { driver, schema };
  const base = (
    route === "shipped"
      ? createClient(config)
      : VibORM.create(config, createCandidateRoute)
  ) as VibORMClient<typeof config>;
  assert.equal((await syncLiveSchema(base)).applied, true);
  const cacheDriver = new RecordingCache();
  const background: Promise<unknown>[] = [];
  const client = base.$extends(
    cache({
      driver: cacheDriver,
      waitUntil(promise) {
        background.push(promise);
      },
    })
  );
  if (fault === "rejected") driver.failuresBeforeDispatch = 1;
  if (fault === "malformed-result") driver.corruptResults = true;
  cacheDriver.failing = failingListener;
  const seen = await observe(() =>
    client.owner.create({
      cache: { autoInvalidate: true },
      data: { id: 21, label: "uncertain" },
    })
  );
  driver.failuresBeforeDispatch = 0;
  driver.corruptResults = false;
  cacheDriver.failing = false;
  await Promise.allSettled(background.splice(0));
  const observed = {
    failure: shape(seen.failure),
    invalidations: cacheDriver.invalidations.length,
    rows: database
      .prepare(
        "SELECT id, owner_label FROM g4_unit02_uncertain_owners ORDER BY id"
      )
      .all(),
  };
  try {
    if (!seen.failure) return { ...observed, outcome: "published" };
    if (seen.failure instanceof VibORMError)
      return { ...observed, outcome: identity(seen.failure).name };
    const composed = seen.failure as Error & { cause?: unknown };
    return {
      ...observed,
      outcome: `raw:${composed.message}`,
      primary:
        composed.cause instanceof VibORMError
          ? identity(composed.cause).name
          : String(composed.cause),
    };
  } finally {
    await base.$disconnect();
    database.close();
  }
}

/**
 * A set of TWO rows whose bind budget splits it into two statements, with its
 * result malformed — the shape whose window really is a batch, on whichever
 * transport is asked for. `failingListener` makes the client's own cache driver
 * refuse, so the composition of the two failures is measured.
 */
async function observeSplitWrite(
  route: "candidate" | "shipped",
  transport: "batch-only" | "transactional",
  failingListener = false
): Promise<{
  batches: number;
  failure: unknown;
  invalidations: number;
  rows: unknown[];
}> {
  const database = new Database(":memory:");
  const driver =
    transport === "batch-only"
      ? new SplittingBatchDriver({ client: database })
      : new SplittingTransactionalDriver({ client: database });
  const config = { driver, schema };
  const base = (
    route === "shipped"
      ? createClient(config)
      : VibORM.create(config, createCandidateRoute)
  ) as VibORMClient<typeof config>;
  assert.equal((await syncLiveSchema(base)).applied, true);
  const cacheDriver = new RecordingCache();
  const background: Promise<unknown>[] = [];
  const client = base.$extends(
    cache({
      driver: cacheDriver,
      waitUntil(promise) {
        background.push(promise);
      },
    })
  );
  driver.corruptResults = true;
  cacheDriver.failing = failingListener;
  const seen = await observe(() =>
    client.owner.createMany({
      cache: { autoInvalidate: true },
      data: [
        { id: 21, label: "a" },
        { id: 22, label: "b" },
      ],
      select: { id: true, label: true },
    })
  );
  driver.corruptResults = false;
  cacheDriver.failing = false;
  await Promise.allSettled(background.splice(0));
  try {
    return {
      batches: driver instanceof SplittingBatchDriver ? driver.batches : 0,
      failure: shape(seen.failure),
      invalidations: cacheDriver.invalidations.length,
      rows: database
        .prepare(
          "SELECT id, owner_label FROM g4_unit02_uncertain_owners ORDER BY id"
        )
        .all(),
    };
  } finally {
    await base.$disconnect();
    database.close();
  }
}

describe("G4-02 — an uncertain outcome is not a record series", () => {
  it("1. a root create rejected before dispatch publishes no record-series progress", async () => {
    const run = (engine: "candidate" | "shipped") =>
      withWorld(async ({ driver, database, publicClient }) => {
        driver.failuresBeforeDispatch = 1;
        const seen = await observe(() =>
          engine === "shipped"
            ? publicClient.owner!.create({ data: { id: 1, label: "o" } })
            : createCommandEngine({ schema, driver }).execute(
                "owner",
                "create",
                { data: { id: 1, label: "o" } }
              )
        );
        driver.failuresBeforeDispatch = 0;
        return {
          value: seen.value,
          rows: database
            .prepare("SELECT id FROM g4_unit02_uncertain_owners")
            .all(),
          failure: identity(seen.failure),
        };
      });
    const shipped = await run("shipped");
    const candidate = await run("candidate");
    assert.equal(
      shipped.failure.meta.recordSeriesProgress,
      undefined,
      "a root single-record write has no series to report on"
    );
    assert.equal(
      candidate.failure.meta.recordSeriesProgress,
      undefined,
      `the candidate must report no series either: ${JSON.stringify(candidate, undefined, 2)}`
    );
    // Nothing is excluded any more. `statementIndex` was the second,
    // independent divergence recorded as blocker D-7, and Arnaud's decision
    // (a lone statement leaves the batch) removed it at the transport; the
    // shapes it reached are pinned in `lone-statement-transport.test.ts`.
    assert.deepEqual(
      candidate,
      shipped,
      `the rejected root create must answer what the shipped engine answers: ${JSON.stringify({ shipped, candidate }, undefined, 2)}`
    );
  });

  it("2. a real record series rejected the same way keeps its progress", async () => {
    const seen = await withWorld(async ({ driver }) => {
      driver.failuresBeforeDispatch = 1;
      const observed = await observe(() =>
        createCommandEngine({ schema, driver }).execute("owner", "createMany", {
          data: [
            { id: 1, label: "a", notes: { create: [{ body: "a" }] } },
            { id: 2, label: "b", notes: { create: [{ body: "b" }] } },
          ],
        })
      );
      driver.failuresBeforeDispatch = 0;
      return observed;
    });
    assert.equal(seen.value, undefined, "nothing is published");
    const meta = identity(seen.failure).meta;
    assert.deepEqual(
      meta.recordSeriesProgress,
      {
        atomicity: "segment",
        phase: "member",
        committedSegments: 0,
        committedWriteMembers: 0,
        completedMembers: 0,
        mayHaveCommittedSegment: true,
      },
      `a series reports its uncertain outcome: ${JSON.stringify(meta, undefined, 2)}`
    );
  });

  it("3. an uncertain root create invalidates the cache on both routes", async () => {
    const shipped = await observeInvalidation("shipped", "rejected");
    const candidate = await observeInvalidation("candidate", "rejected");
    assert.equal(candidate.outcome, shipped.outcome);
    assert.equal(
      shipped.invalidations,
      1,
      `the shipped engine invalidates for an outcome it cannot prove rolled back: ${JSON.stringify(shipped)}`
    );
    assert.equal(
      candidate.invalidations,
      1,
      `the candidate must too, from the transport that learned it: ${JSON.stringify({ candidate, shipped })}`
    );
  });

  it("4. a committed root create on the same transport invalidates exactly once", async () => {
    // The other half of the seam, and the one a second publication site would
    // break: on this transport the candidate's `acknowledged()` states the
    // committed segment, so the route must NOT state the operation's success
    // as a second durable fact.
    const shipped = await observeInvalidation("shipped", "committed");
    const candidate = await observeInvalidation("candidate", "committed");
    assert.equal(shipped.outcome, "published");
    assert.equal(candidate.outcome, "published");
    assert.equal(shipped.invalidations, 1, JSON.stringify({ shipped }));
    assert.equal(
      candidate.invalidations,
      1,
      `one durable fact, one invalidation: ${JSON.stringify({ candidate, shipped })}`
    );
  });

  it("5. a committed root create whose result is malformed still invalidates once", async () => {
    // D-7 sends this write outside the batch, so `submit()` no longer learns
    // that its segment committed — the plain statement does, and it says so
    // before the decoding failure is published, exactly as the shipped
    // `runBorrowedStatementAtomic` does (`OperationExecutor.ts:1630-1645`).
    // Without that call the candidate would answer 0 where the shipped engine
    // answers 1, which is the regression the seam round was opened to repair.
    const shipped = await observeInvalidation("shipped", "malformed-result");
    const candidate = await observeInvalidation(
      "candidate",
      "malformed-result"
    );
    assert.equal(shipped.outcome, "QueryEngineError", JSON.stringify(shipped));
    assert.equal(
      candidate.outcome,
      shipped.outcome,
      JSON.stringify({ candidate, shipped })
    );
    assert.equal(shipped.invalidations, 1, JSON.stringify({ shipped }));
    assert.equal(
      candidate.invalidations,
      1,
      `a committed write is durable whether or not its result decodes: ${JSON.stringify({ candidate, shipped })}`
    );
  });

  it("6. a throwing invalidation listener never replaces the operation's own failure", async () => {
    // The followup review's S6 (`g4/regression-review-followup.md` finding 2),
    // as an author cell. The shipped engine keeps the query failure primary and
    // retains the listener's beside it (`retainWriteOutcomeFailure`,
    // `extensions/query.ts:859-871`); `OperationContext.stateWriteOutcome`
    // states the same composition at every seam call site.
    const shipped = await observeInvalidation("shipped", "rejected", true);
    const candidate = await observeInvalidation("candidate", "rejected", true);
    assert.equal(shipped.invalidations, 1, JSON.stringify({ shipped }));
    assert.equal(
      candidate.invalidations,
      1,
      JSON.stringify({ candidate, shipped })
    );
    assert.equal(
      shipped.outcome,
      "raw:Query execution and write-outcome publication both failed.",
      JSON.stringify({ shipped })
    );
    assert.deepEqual(
      { outcome: candidate.outcome, primary: candidate.primary },
      { outcome: shipped.outcome, primary: shipped.primary },
      `the operation's own failure stays primary: ${JSON.stringify({ candidate, shipped }, undefined, 2)}`
    );
  });

  it("7. a throwing invalidation listener on a SUCCESSFUL write answers the same on both routes", async () => {
    // The control for cell 6 (the reviewer's S7): with no failure of its own to
    // keep, the operation answers the listener's error on both engines — so
    // cell 6 measures the composition and not a blanket difference.
    const shipped = await observeInvalidation("shipped", "committed", true);
    const candidate = await observeInvalidation("candidate", "committed", true);
    assert.equal(
      candidate.invalidations,
      shipped.invalidations,
      JSON.stringify({ candidate, shipped })
    );
    assert.deepEqual(
      { outcome: candidate.outcome, primary: candidate.primary },
      { outcome: shipped.outcome, primary: shipped.primary },
      `a listener that fails alone answers the same on both routes: ${JSON.stringify({ candidate, shipped }, undefined, 2)}`
    );
  });

  it("8. a malformed result AND a throwing listener: the refusal stays primary", async () => {
    // The reviewer's D9 (`g4/d7-review.md` finding 1), as an author cell — the
    // pair cells 5 and 6 each measure one half of. On the plain path the decode
    // failure is now translated where `decoded` is built, so the value the
    // wrapper keeps primary is the PUBLIC malformed-scalar refusal and not the
    // internal `InvalidScalarResult` the composition would otherwise carry past
    // `OperationContext.run`'s catch, which no longer recognises it.
    const shipped = await observeInvalidation(
      "shipped",
      "malformed-result",
      true
    );
    const candidate = await observeInvalidation(
      "candidate",
      "malformed-result",
      true
    );
    const diagnostic = JSON.stringify({ candidate, shipped }, undefined, 2);
    assert.equal(
      shipped.outcome,
      "raw:Query execution and write-outcome publication both failed.",
      diagnostic
    );
    assert.equal(shipped.primary, "QueryEngineError", diagnostic);
    assert.deepEqual(candidate.failure, shipped.failure, diagnostic);
    assert.deepEqual(candidate.rows, shipped.rows, diagnostic);
    assert.equal(candidate.invalidations, shipped.invalidations, diagnostic);
  });

  it("9. the same pair on the BATCH transport keeps the refusal primary too", async () => {
    // The reviewer's D12 (`g4/d7-review.md` finding 2), as an author cell: the
    // two-statement form of cell 8, whose window really is a batch. That
    // transport acknowledges its committed segment BEFORE it decodes anything,
    // so the listener's failure is HELD and composed once the operation has
    // answered — the shipped `runAtomicBatch` order
    // (`OperationExecutor.ts:1277-1289`, `:1332-1343`). Before the hold the
    // candidate published the listener's `CacheConfigurationError` ALONE.
    //
    // `recordSeriesProgress` is excluded from the comparison, and only it: a
    // committed set window publishes its progress on this engine where the
    // shipped engine publishes none, which is the accepted divergence of
    // `g4/regression-review.md` finding 3 (probe P8), pinned as measured by
    // `lone-statement-transport.test.ts` row 6 and by the registered
    // `malformed-result-cuts.test.ts` cell 1b. The second assertion pins it
    // here too, so the exclusion cannot hide a change.
    const shipped = await observeSplitWrite("shipped", "batch-only", true);
    const candidate = await observeSplitWrite("candidate", "batch-only", true);
    const diagnostic = JSON.stringify({ candidate, shipped }, undefined, 2);
    assert.equal(candidate.batches, 1, diagnostic);
    assert.deepEqual(
      withoutProgress(candidate.failure),
      withoutProgress(shipped.failure),
      diagnostic
    );
    assert.deepEqual(
      (candidate.failure as { cause?: { meta?: Record<string, unknown> } })
        .cause?.meta?.recordSeriesProgress,
      {
        atomicity: "segment",
        phase: "result",
        committedSegments: 1,
        committedWriteMembers: 1,
        completedMembers: 0,
      },
      `the excluded divergence, pinned in place: ${diagnostic}`
    );
    assert.equal(
      (shipped.failure as { cause?: { meta?: Record<string, unknown> } })
        .cause?.meta?.recordSeriesProgress,
      undefined,
      `the shipped side publishes no progress here: ${diagnostic}`
    );
    assert.deepEqual(candidate.rows, shipped.rows, diagnostic);
    assert.equal(candidate.invalidations, shipped.invalidations, diagnostic);
  });

  it("10. a split write inside the operation's OWN region tells the cache nothing", async () => {
    // The reviewer's D11 (`g4/d7-review.md` note 3), as an author cell: the
    // falsifier for the plain path's `owned` gate (`ownership === "standalone"
    // && !ownRegionOpen`), which no other registered cell reaches. Two
    // statements on a TRANSACTION-capable driver open the operation's own
    // region; the malformed result rolls it back, and a `committedSegment`
    // announced from inside that region would tell the cache a write became
    // durable that the provider then discarded. Dropping the gate makes the
    // candidate answer 1 where the shipped engine answers 0.
    const shipped = await observeSplitWrite("shipped", "transactional");
    const candidate = await observeSplitWrite("candidate", "transactional");
    const diagnostic = JSON.stringify({ candidate, shipped }, undefined, 2);
    assert.equal(
      shipped.invalidations,
      0,
      `the shipped engine publishes no durable write for a rolled-back region: ${diagnostic}`
    );
    assert.equal(candidate.invalidations, shipped.invalidations, diagnostic);
    assert.deepEqual(candidate.rows, shipped.rows, diagnostic);
    assert.deepEqual(candidate.rows, [], diagnostic);
  });
});
