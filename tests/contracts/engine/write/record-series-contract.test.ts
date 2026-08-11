import { createClient } from "@client/client";
import type { AnyDriver, QueryExecutionContext } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { TransactionError } from "@errors";
import { push } from "@migrations";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { sql } from "@sql";
import { createTransactionCleanupError } from "@src/drivers/shared/transactions";
import {
  type ExecutableOperation,
  OperationExecutor,
} from "@src/query-engine/write-engine/OperationExecutor";
import type {
  OperationFragment,
  PlanningFragment,
  ReadStep,
  WriteStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { ref } from "@src/query-engine/write-engine/OperationFragment";
import type { RecordSeriesOperation } from "@src/query-engine/write-engine/record-series";
import { isRecordSeries } from "@src/query-engine/write-engine/record-series";
import { executeRoutedOperation } from "@src/query-engine/write-engine/routing";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

/**
 * PACKAGE I3 — the transactional record series, proven on a FAKE operation.
 *
 * The series is an execution form, not a payload shape: what it promises is
 * about ORDER, SCOPE and RETRY, and none of that is visible through a public
 * write whose members happen to be creates. So the members here are hand-built
 * {@link ExecutableOperation} values — the same synthetic-operation seam
 * `optional-absent-bind.test.ts` uses — driven by the REAL
 * {@link OperationExecutor} on a real PGlite database. Every event the executor
 * causes is appended to one ordered trace: the fake records its own phases, and a
 * tracing driver records every statement the provider was actually asked to run,
 * so "before the first write" and "after every member" are read off one list
 * rather than inferred.
 *
 * What is deliberately NOT proven here: anything about which records a public
 * bulk payload turns into. That is Package J/K's, and it arrives after this.
 */

const recordSeriesSchema = (() => {
  const ledger = s
    .model({
      id: s.int().id(),
      // A second unique so a member can collide on something that is NOT the
      // primary key — the pin has to name one constraint unambiguously.
      label: s.string().unique(),
    })
    .map("rs_ledger");
  return { ledger };
})();

hydrateSchemaNames(recordSeriesSchema);

/** The pin the raceable member carries: the label unique, exactly. */
const LABEL_PIN = {
  fields: ["label"],
  table: "rs_ledger",
  columns: ["label"],
  constraints: ["rs_ledger_label_key"],
};

// ---------------------------------------------------------------------------
// Tracing drivers: one ordered list, shared with the fake's own phase records.
// ---------------------------------------------------------------------------

const LEADING_WORD = /\s+/;

function traceStatement(
  events: string[],
  statement: string,
  params: unknown[]
): void {
  const verb = statement.trim().split(LEADING_WORD)[0]?.toUpperCase() ?? "?";
  events.push(params.length === 0 ? `sql:${verb}` : `sql:${verb}(${params})`);
}

class TracingPGliteDriver extends PGliteDriver {
  private readonly events: string[];

  constructor(
    events: string[],
    options?: ConstructorParameters<typeof PGliteDriver>[0]
  ) {
    super(options);
    this.events = events;
  }

  protected override execute<T>(
    client: PGlite | Transaction,
    statement: string,
    params: unknown[],
    context?: QueryExecutionContext
  ) {
    traceStatement(this.events, statement, params);
    return super.execute<T>(client, statement, params, context);
  }
}

/** A substrate with an atomic batch and NO interactive scope. */
class TracingBatchOnlyPGliteDriver extends BatchOnlyPGliteDriver {
  private readonly events: string[];

  constructor(
    events: string[],
    options?: ConstructorParameters<typeof PGliteDriver>[0]
  ) {
    super(options);
    this.events = events;
  }

  protected override execute<T>(
    client: PGlite | Transaction,
    statement: string,
    params: unknown[],
    context?: QueryExecutionContext
  ) {
    traceStatement(this.events, statement, params);
    return super.execute<T>(client, statement, params, context);
  }
}

/**
 * Reproduces the scope-failure arm of `withTransaction`
 * (`src/drivers/driver-transaction-base.ts`): when the transaction scope recorded
 * a failure that is NOT the error escaping the callback, the base driver throws
 * BOTH through the production wrapper instead of the original error. Used by the
 * finding-8 witness below, with the real wrapper so the pin tracks production.
 */
class DivergentScopeFailurePGliteDriver extends TracingPGliteDriver {
  override async withTransaction<T>(
    fn: Parameters<PGliteDriver["withTransaction"]>[0],
    options?: Parameters<PGliteDriver["withTransaction"]>[1],
    context?: QueryExecutionContext
  ): Promise<T> {
    try {
      return (await super.withTransaction(fn, options, context)) as T;
    } catch (error) {
      throw createTransactionCleanupError(error, [
        new Error("the scope recorded a different failure"),
      ]);
    }
  }
}

// ---------------------------------------------------------------------------
// The fake series and its members.
// ---------------------------------------------------------------------------

interface MemberSpec {
  readonly id: string;
  readonly rowId: number;
  readonly label: string;
  /** Attach the label pin, making a unique violation on it a retryable race. */
  readonly pinned?: boolean;
}

interface SeriesShape {
  /** The members this attempt builds, given what the capture read. */
  members(
    attempt: number,
    captured: Readonly<Record<string, unknown>>
  ): readonly MemberSpec[];
  readonly resultRead?: boolean;
}

function rowIds(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((row) =>
    row !== null && typeof row === "object" && "id" in row ? row.id : row
  );
}

/**
 * One member: a probe that reads the table as this scope currently sees it, then
 * one INSERT. The probe is what makes "member N observes member N-1's effect"
 * observable — its rows arrive as the member's own `known` at compile time.
 */
function memberOperation(
  events: string[],
  spec: MemberSpec
): ExecutableOperation {
  const probe: ReadStep = {
    id: `${spec.id}.probe`,
    kind: "read",
    statement: sql`SELECT "id" FROM "rs_ledger" ORDER BY "id" ASC`,
    outputs: { rows: { kind: "rows" } },
  };
  return {
    mode: "transaction",
    planning(): PlanningFragment {
      events.push(`plan:${spec.id}`);
      return { steps: [probe] };
    },
    compile(known): OperationFragment {
      events.push(
        `compile:${spec.id}:[${rowIds(known[`${spec.id}.probe.rows`])}]`
      );
      const write: WriteStep = {
        id: `${spec.id}.write`,
        kind: "write",
        statement: sql`INSERT INTO "rs_ledger" ("id", "label") VALUES (${spec.rowId}, ${spec.label}) RETURNING "id"`,
        outputs: { rows: { kind: "rows" } },
        ...(spec.pinned ? { racePin: LABEL_PIN } : {}),
      };
      return { steps: [write], outputs: { result: ref(write.id, "rows") } };
    },
    parse<T>(outputs: Readonly<Record<string, unknown>>): T {
      return outputs.result as T;
    },
  };
}

/** The series' result read: one ordinary read operation, no planning. */
function resultReadOperation(events: string[]): ExecutableOperation {
  return {
    mode: "transaction",
    planning: (): PlanningFragment => ({ steps: [] }),
    compile(): OperationFragment {
      events.push("compile:resultRead");
      const read: ReadStep = {
        id: "series.read",
        kind: "read",
        statement: sql`SELECT "id", "label" FROM "rs_ledger" ORDER BY "id" ASC`,
        outputs: { rows: { kind: "rows" } },
      };
      return { steps: [read], outputs: { result: ref(read.id, "rows") } };
    },
    parse<T>(outputs: Readonly<Record<string, unknown>>): T {
      return outputs.result as T;
    },
  };
}

function seriesOperation(
  events: string[],
  shape: SeriesShape
): RecordSeriesOperation {
  let attempt = 0;
  return {
    executionKind: "recordSeries",
    capture(): PlanningFragment {
      attempt += 1;
      events.push(`capture:${attempt}`);
      const step: ReadStep = {
        id: "series.capture",
        kind: "read",
        statement: sql`SELECT "id" FROM "rs_ledger" ORDER BY "id" ASC`,
        outputs: { rows: { kind: "rows" } },
      };
      return { steps: [step] };
    },
    compileMembers(captured): readonly ExecutableOperation[] {
      const specs = shape.members(attempt, captured);
      // The captured record's KEY SHAPE is part of the contract: one
      // `planningKey(step, output)` per declared output.
      events.push(`captured:${Object.keys(captured)}`);
      events.push(`build:${specs.map((spec) => spec.id)}`);
      return specs.map((spec) => memberOperation(events, spec));
    },
    compileResultReads(_captured, memberResults) {
      events.push(`reads:${memberResults.length}`);
      return shape.resultRead ? [resultReadOperation(events)] : [];
    },
    parseSeries(input) {
      events.push("parse");
      return {
        captured: rowIds(input.captured["series.capture.rows"]),
        members: input.memberResults.map(rowIds),
        resultReads: input.resultReadResults.map(rowIds),
      };
    },
  };
}

/** Two members: the second's label and pin are the only per-case variables. */
function twoMemberShape(
  second: (attempt: number) => MemberSpec,
  resultRead?: boolean
): SeriesShape {
  return {
    members: (attempt) => [
      { id: "m0", rowId: 1, label: "zero" },
      second(attempt),
    ],
    ...(resultRead === undefined ? {} : { resultRead }),
  };
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

let database: PGlite;

function makeStateClient() {
  return createClient({
    schema: recordSeriesSchema,
    driver: new PGliteDriver({ client: database }),
  });
}

let stateClient: ReturnType<typeof makeStateClient>;

/** A row another writer committed before the series began. */
function seedRow(id: number, label: string): Promise<unknown> {
  return stateClient.$executeRawUnsafe(
    `INSERT INTO "rs_ledger" ("id", "label") VALUES (${id}, '${label}')`
  );
}

beforeAll(async () => {
  database = new PGlite();
  stateClient = makeStateClient();
  await push(stateClient, { force: true });
}, 60_000);

afterAll(async () => {
  await stateClient.$disconnect();
});

beforeEach(async () => {
  await stateClient.$executeRawUnsafe('TRUNCATE TABLE "rs_ledger"');
});

function executorFor(driver: PGliteDriver): OperationExecutor {
  return new OperationExecutor(
    new QueryEngine(
      driver,
      createModelRegistry(
        recordSeriesSchema,
        createSchemaRegistry(recordSeriesSchema)
      )
    )
  );
}

function seriesContext(): QueryExecutionContext {
  return createOperationExecutionContext("ledger", "createMany");
}

function ledgerRows(): Promise<Array<{ id: number; label: string }>> {
  return stateClient.$queryRawUnsafe<{ id: number; label: string }>(
    'SELECT "id", "label" FROM "rs_ledger" ORDER BY "id" ASC'
  );
}

describe("I3 — the transactional record series through the real executor", () => {
  test("captures once, builds every member before member zero writes, then runs them in order", async () => {
    const events: string[] = [];
    const driver = new TracingPGliteDriver(events, { client: database });
    const series = seriesOperation(
      events,
      twoMemberShape(() => ({ id: "m1", rowId: 2, label: "one" }), true)
    );

    const result = await executorFor(driver).execute<unknown>(
      series,
      seriesContext()
    );

    // The complete, ordered story of one attempt. Read top to bottom:
    //  · ONE capture, and its outputs are addressed `<step>.<output>`;
    //  · `build:m0,m1` — every member exists BEFORE the first INSERT below it;
    //  · each member plans, then compiles, then writes, one after another;
    //  · member one's compile SAW `[1]` — the row member zero inserted inside
    //    this scope, which no separate transaction could have seen;
    //  · the result read runs after BOTH members, and after `reads:2` is handed
    //    both member results.
    expect(events).toEqual([
      "capture:1",
      "sql:SELECT",
      "captured:series.capture.rows",
      "build:m0,m1",
      "plan:m0",
      "sql:SELECT",
      "compile:m0:[]",
      "sql:INSERT(1,zero)",
      "plan:m1",
      "sql:SELECT",
      "compile:m1:[1]",
      "sql:INSERT(2,one)",
      "reads:2",
      "compile:resultRead",
      "sql:SELECT",
      "parse",
    ]);
    expect(result).toEqual({
      captured: [],
      members: [[1], [2]],
      resultReads: [[1, 2]],
    });
    await expect(ledgerRows()).resolves.toEqual([
      { id: 1, label: "zero" },
      { id: 2, label: "one" },
    ]);
  }, 60_000);

  test("a member failure rolls member zero back with it", async () => {
    const events: string[] = [];
    const driver = new TracingPGliteDriver(events, { client: database });
    // Row 9 is committed before the series runs; member one collides with it on
    // the PRIMARY KEY, which carries no pin — so this is a plain failure, not a
    // race, and nothing retries.
    await seedRow(9, "resident");

    await expect(
      executorFor(driver).execute<unknown>(
        seriesOperation(
          events,
          twoMemberShape(() => ({ id: "m1", rowId: 9, label: "clash" }))
        ),
        seriesContext()
      )
    ).rejects.toThrow();

    // Member zero's INSERT ran and committed nothing: the enclosing transaction
    // took it back with the member that failed.
    expect(events).toContain("sql:INSERT(1,zero)");
    await expect(ledgerRows()).resolves.toEqual([{ id: 9, label: "resident" }]);
  }, 60_000);

  test("a RACEABLE member failure retries the capture and every member exactly once", async () => {
    const events: string[] = [];
    const driver = new TracingPGliteDriver(events, { client: database });
    // The row the first attempt's member one collides with, on the pinned label
    // unique — committed by another writer before this series began.
    await seedRow(9, "clash");

    // The second attempt takes a label that is free. The claim under test is that
    // the EXECUTOR ran the whole series again — capture included — not that this
    // fake adapts; the fake only has to stop colliding so the retry can converge.
    const series = seriesOperation(
      events,
      twoMemberShape((attempt) => ({
        id: "m1",
        rowId: 2,
        label: attempt === 1 ? "clash" : "free",
        pinned: true,
      }))
    );

    // Through the ROUTED boundary, which owns the one retry. Members never reach
    // it: they run under `execute` on the scope's own driver.
    const result = await executeRoutedOperation<unknown>(
      executorFor(driver),
      series,
      seriesContext()
    );

    expect(events.filter((event) => event.startsWith("capture:"))).toEqual([
      "capture:1",
      "capture:2",
    ]);
    // Each member ran ONCE per attempt and the series ran twice: four member
    // plans, four compiles, four INSERTs — never a third attempt, and never a
    // member retried on its own inside an attempt.
    expect(events.filter((event) => event.startsWith("plan:"))).toEqual([
      "plan:m0",
      "plan:m1",
      "plan:m0",
      "plan:m1",
    ]);
    expect(events.filter((event) => event.startsWith("sql:INSERT"))).toEqual([
      "sql:INSERT(1,zero)",
      "sql:INSERT(2,clash)",
      "sql:INSERT(1,zero)",
      "sql:INSERT(2,free)",
    ]);
    expect(result).toEqual({
      captured: [9],
      members: [[1], [2]],
      resultReads: [],
    });
    // The first attempt left nothing behind: one row 1, not two.
    await expect(ledgerRows()).resolves.toEqual([
      { id: 1, label: "zero" },
      { id: 2, label: "free" },
      { id: 9, label: "clash" },
    ]);
  }, 60_000);

  test("inside a caller's OPEN scope it still rolls back and retries whole", async () => {
    const events: string[] = [];
    const driver = new TracingPGliteDriver(events, { client: database });
    await seedRow(9, "clash");

    const series = seriesOperation(
      events,
      twoMemberShape((attempt) => ({
        id: "m1",
        rowId: 2,
        label: attempt === 1 ? "clash" : "free",
        pinned: true,
      }))
    );
    const executor = executorFor(driver);

    // The array form of `$transaction` hands each operation the caller's ALREADY
    // OPEN scope (`client.ts` → `executeWith(txDriver)`), so the series arrives
    // with a driver override. It must still open a scope of its own on that driver
    // — a SAVEPOINT — because the retry above it re-runs the COMPLETE series:
    // borrowing the caller's scope would leave the first attempt's member zero
    // standing, and its poisoned scope would refuse the second attempt's very
    // first statement instead of converging.
    const result = await driver.withTransaction((txDriver) =>
      executeRoutedOperation<unknown>(
        executor,
        series,
        seriesContext(),
        txDriver as AnyDriver
      )
    );

    expect(events.filter((event) => event.startsWith("capture:"))).toEqual([
      "capture:1",
      "capture:2",
    ]);
    expect(result).toEqual({
      captured: [9],
      members: [[1], [2]],
      resultReads: [],
    });
    // The caller's transaction committed, carrying the SECOND attempt only: the
    // abandoned first attempt left no second row 1 behind.
    await expect(ledgerRows()).resolves.toEqual([
      { id: 1, label: "zero" },
      { id: 2, label: "free" },
      { id: 9, label: "clash" },
    ]);
  }, 60_000);

  test("a batch-only substrate refuses before the provider is touched", async () => {
    const events: string[] = [];
    const driver = new TracingBatchOnlyPGliteDriver(events, {
      client: database,
    });
    const series = seriesOperation(
      events,
      twoMemberShape(() => ({ id: "m1", rowId: 2, label: "one" }))
    );

    // The refusal is the driver's own: a series needs an interactive scope, and
    // `withTransaction` rejects a substrate that has none BEFORE it invokes the
    // body. Its wording names the driver method, not the series — inherited
    // deliberately, since presenting it under a series-specific name would need
    // error machinery this package does not add. PINNED so the day that changes
    // is a decision, not a drift.
    const refusal = await executorFor(driver)
      .execute<unknown>(series, seriesContext())
      .then(
        () => new Error("the series ran on a batch-only substrate"),
        (error: unknown) => error
      );
    if (!(refusal instanceof TransactionError)) throw refusal;
    expect(refusal.message).toContain("does not support callback transactions");
    expect(refusal.meta).toMatchObject({ method: "$transaction(callback)" });
    // Nothing was captured, nothing was built, and no statement was sent.
    expect(events).toEqual([]);
  }, 60_000);

  test("every prepared-statement and prepared-batch seam declines, touching no phase", async () => {
    const events: string[] = [];
    const driver = new TracingPGliteDriver(events, { client: database });
    const executor = executorFor(driver);
    const series = seriesOperation(
      events,
      twoMemberShape(() => ({ id: "m1", rowId: 2, label: "one" }))
    );

    expect(isRecordSeries(series)).toBe(true);
    // Each seam returns `undefined` rather than reaching for a planning phase the
    // series does not have — the difference between a decline and a `TypeError`.
    expect(executor.singleStatementPlan(series)).toBeUndefined();
    expect(executor.buildStatement(series)).toBeUndefined();
    await expect(
      executor.prepareBatch(series, driver, seriesContext())
    ).resolves.toBeUndefined();
    await expect(
      executor.prepareSharedBatch(series, driver, seriesContext(), "createMany")
    ).resolves.toBeUndefined();
    // `PendingOperation.prepare()` is this same decline: it asks the executor for
    // `singleStatementPlan` and returns what it answers, which is what lets the
    // `$transaction([...])` merge break to its typed refusal with no new client
    // code. No capture, no member, no statement was reached by any of the four.
    expect(events).toEqual([]);
  }, 60_000);

  test("the series adds no operation step kind", async () => {
    const kinds = new Set<string>();
    const events: string[] = [];
    const series = seriesOperation(
      events,
      twoMemberShape(() => ({ id: "m1", rowId: 2, label: "one" }))
    );
    for (const step of series.capture().steps) kinds.add(step.kind);
    for (const member of series.compileMembers({})) {
      for (const step of member.planning().steps) kinds.add(step.kind);
      for (const step of member.compile({}).steps) kinds.add(step.kind);
    }
    // The fragment module's vocabulary is owned by architecture gate (d); this
    // says the new execution form did not need a word outside it.
    expect([...kinds].sort()).toEqual(["read", "write"]);
  });
});

describe("I3 — pre-existing hazard: the retry mark does not survive error wrapping", () => {
  test("a differing scope failure defeats the outer retry (current behaviour, pinned)", async () => {
    const events: string[] = [];
    const driver = new DivergentScopeFailurePGliteDriver(events, {
      client: database,
    });
    await seedRow(9, "clash");

    const series = seriesOperation(
      events,
      twoMemberShape((attempt) => ({
        id: "m1",
        rowId: 2,
        label: attempt === 1 ? "clash" : "free",
        pinned: true,
      }))
    );

    // Identical to the converging witness above, except that the transaction
    // scope recorded a failure differing from the one escaping the body — the
    // arm at `driver-transaction-base.ts` that throws
    // `createTransactionCleanupError(error, [scopeFailure])`.
    //
    // The retry classification is an IDENTITY mark on the error object
    // (`race-retry.ts` keeps a WeakSet), so it does not survive being wrapped:
    // `isRetryableRace` sees an AggregateError it never marked, and the routed
    // boundary rethrows instead of retrying. This is PRE-EXISTING and belongs to
    // every transaction-mode retry, not to the series — the series is simply the
    // first form whose retry is always a transaction. Recorded honestly rather
    // than papered over; lifting it means classifying through the wrapper's
    // `cause`, which is not this package's change.
    await expect(
      executeRoutedOperation<unknown>(
        executorFor(driver),
        series,
        seriesContext()
      )
    ).rejects.toBeInstanceOf(AggregateError);
    // ONE attempt: the capture never ran a second time.
    expect(events.filter((event) => event.startsWith("capture:"))).toEqual([
      "capture:1",
    ]);
    await expect(ledgerRows()).resolves.toEqual([{ id: 9, label: "clash" }]);
  }, 60_000);
});
