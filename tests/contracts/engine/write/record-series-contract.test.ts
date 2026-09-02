import type {
  AnyDriver,
  BatchQuery,
  QueryExecutionContext,
  QueryResult,
} from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import {
  attachRecordSeriesProgress,
  hasCommittedRecordSeriesProgress,
  QueryEngineError,
  UniqueConstraintError,
  UnsupportedOperationError,
  VibORMError,
} from "@errors";
import { readProtectedLifecycleFacts } from "@extensions/observation";
import type { InstrumentationContext } from "@instrumentation/context";
import { getOfficialInstrumentationChainCapability } from "@instrumentation/extension";
import {
  ATTR_VIBORM_WRITE_ATOMICITY,
  ATTR_VIBORM_WRITE_COMMIT_OUTCOME,
  ATTR_VIBORM_WRITE_COMMITTED_SEGMENTS,
  ATTR_VIBORM_WRITE_COMMITTED_WRITE_MEMBERS,
  ATTR_VIBORM_WRITE_COMPLETED_MEMBERS,
  ATTR_VIBORM_WRITE_MEMBER_PATH,
  ATTR_VIBORM_WRITE_STATEMENT_COUNT,
  SPAN_OPERATION,
  SPAN_RECORD_SERIES_SEGMENT,
} from "@instrumentation/spans";

import { trace } from "@opentelemetry/api";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { sql } from "@sql";
import { createTransactionCleanupError } from "@src/drivers/shared/transactions";
import type { CommittedBatchNotification } from "@src/drivers/types";
import {
  appendResolvedExtension,
  type ResolvedExtensionChain,
} from "@src/extensions/chain";
import { defineExtension } from "@src/index";
import { instrumentation } from "@src/instrumentation/exports";
import {
  type ExecutableOperation,
  OperationExecutor,
} from "@src/query-engine/write-engine/OperationExecutor";
import type {
  GuardStep,
  OperationFragment,
  PlanningFragment,
  ReadStep,
  WriteStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { ref } from "@src/query-engine/write-engine/OperationFragment";
import type { RecordSeriesOperation } from "@src/query-engine/write-engine/record-series";
import { isRecordSeries } from "@src/query-engine/write-engine/record-series";
import { executeRoutedOperation } from "@src/query-engine/write-engine/routing";
import {
  BatchOnlyPGliteDriver,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { withOtelRecorder } from "@tests/unit/instrumentation/_capture";
import { createSchemaRegistry } from "@validation";
import { beforeEach, describe, expect, test } from "vitest";

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
  protected readonly events: string[];
  batchCalls = 0;

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

  protected override executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batchCalls += 1;
    return super.executeBatch<T>(client, queries);
  }
}

/** The batch-only stand-in with the exact progressive capability D1 declares. */
class TracingProgressivePGliteDriver extends TracingBatchOnlyPGliteDriver {
  override readonly supportsOrderedCommittedSegments = true;
  override readonly maxBindParametersPerStatement: number;

  constructor(events: string[], maxBindParametersPerStatement = 65_535) {
    super(events, { client: database, namespace });
    this.maxBindParametersPerStatement = maxBindParametersPerStatement;
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[],
    _context?: QueryExecutionContext,
    committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    const results = await super.executeBatch<T>(client, queries);
    await committed?.();
    return results;
  }
}

class MalformedSecondBatchPGliteDriver extends TracingBatchOnlyPGliteDriver {
  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const results = await super.executeBatch<T>(client, queries);
    return this.batchCalls === 2 ? [] : results;
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
  /** Carry `seriesRootConflict`, so the executor wraps this member in a savepoint
   *  and a zero-row root write suppresses the member instead of failing the series
   *  (the disposition a `skipDuplicates` create member and a residual-Package-F
   *  unnameable junction member both hand it). */
  readonly skippable?: boolean;
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
    statement: sql`SELECT "id" FROM ${ledger()} ORDER BY "id" ASC`,
    outputs: { rows: { kind: "rows" } },
  };
  return {
    mode: "transaction",
    ...(spec.skippable
      ? {
          seriesRootConflict: {
            kind: "skipDuplicate" as const,
            rootWriteId: `${spec.id}.write`,
          },
        }
      : {}),
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
        statement: spec.skippable
          ? sql`INSERT INTO ${ledger()} ("id", "label") VALUES (${spec.rowId}, ${spec.label}) ON CONFLICT DO NOTHING RETURNING "id"`
          : sql`INSERT INTO ${ledger()} ("id", "label") VALUES (${spec.rowId}, ${spec.label}) RETURNING "id"`,
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
        statement: sql`SELECT "id", "label" FROM ${ledger()} ORDER BY "id" ASC`,
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
): RecordSeriesOperation & { readonly validatedArgs: Record<string, unknown> } {
  let attempt = 0;
  return {
    executionKind: "recordSeries",
    validatedArgs: {},
    capture(): PlanningFragment {
      attempt += 1;
      events.push(`capture:${attempt}`);
      const step: ReadStep = {
        id: "series.capture",
        kind: "read",
        statement: sql`SELECT "id" FROM ${ledger()} ORDER BY "id" ASC`,
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

function staticSeries(
  members: readonly ExecutableOperation[],
  parseSeries: RecordSeriesOperation["parseSeries"] = (input) =>
    input.memberResults
): RecordSeriesOperation & { readonly validatedArgs: Record<string, unknown> } {
  return {
    executionKind: "recordSeries",
    validatedArgs: {},
    capture: () => ({ steps: [] }),
    compileMembers: () => members,
    compileResultReads: () => [],
    parseSeries,
  };
}

function staticMember(
  fragment: OperationFragment,
  skippableRootWriteId?: string
): ExecutableOperation {
  return {
    mode: "batch",
    ...(skippableRootWriteId
      ? {
          seriesRootConflict: {
            kind: "skipDuplicate" as const,
            rootWriteId: skippableRootWriteId,
          },
        }
      : {}),
    planning: () => ({ steps: [] }),
    compile: () => fragment,
    parse<T>(outputs): T {
      return outputs as T;
    },
  };
}

/** One outer member whose durable prefix feeds a nested series and its suffix. */
function nestedProgressiveSeries(
  nestedLabel = "nested"
): RecordSeriesOperation {
  const prefixContinuation: GuardStep = {
    id: "outer.prefix.continuation",
    kind: "guard",
    premise: {
      kind: "exists",
      statement: sql`SELECT 1 FROM ${ledger()} WHERE "id" = ${ref("outer.prefix", "id")}`,
    },
    failure: {
      kind: "query",
      message: "the generated prefix vanished before its direct consumer",
      raceable: false,
    },
  };
  const prefix: WriteStep = {
    id: "outer.prefix",
    kind: "write",
    statement: sql`INSERT INTO ${ledger()} ("id", "label") VALUES (${1}, ${"prefix"}) RETURNING "id"`,
    outputs: {
      id: { kind: "firstRowField", field: "id" },
    },
    progressiveContinuation: prefixContinuation,
  };
  const nestedWrite: WriteStep = {
    id: "nested.write",
    kind: "write",
    statement: sql`UPDATE ${ledger()} SET "label" = ${nestedLabel} WHERE "id" = ${ref(prefix.id, "id")} RETURNING "id"`,
    outputs: { rows: { kind: "rows" } },
  };
  const nested = staticSeries([
    staticMember({
      steps: [nestedWrite],
      outputs: { result: ref(nestedWrite.id, "rows") },
    }),
  ]);
  const parentBoundaryGuard: GuardStep = {
    id: "outer.parent",
    kind: "guard",
    premise: {
      kind: "exists",
      statement: sql`SELECT 1 FROM ${ledger()} WHERE "id" = ${ref(prefix.id, "id")}`,
    },
    failure: {
      kind: "query",
      message: "the outer parent vanished across its committed boundary",
      raceable: false,
    },
  };
  const exactPrefixGuard: GuardStep = {
    id: "outer.guard",
    kind: "guard",
    premise: {
      kind: "exists",
      statement: sql`SELECT 1 FROM ${ledger()} WHERE "id" = ${ref(prefix.id, "id")} AND "label" = ${nestedLabel}`,
    },
    failure: {
      kind: "query",
      message: "the nested series did not preserve the captured prefix",
      raceable: false,
    },
  };
  const suffix: WriteStep = {
    id: "outer.suffix",
    kind: "write",
    statement: sql`INSERT INTO ${ledger()} ("id", "label") SELECT ${2}, ${"suffix"} WHERE ${ref(prefix.id, "id")} = ${1} RETURNING "id"`,
    outputs: { rows: { kind: "rows" } },
  };
  return staticSeries([
    staticMember({
      steps: [
        prefix,
        {
          id: "outer.series",
          kind: "recordSeries",
          progressive: { kind: "guarded", guard: parentBoundaryGuard },
          series: nested,
        },
        exactPrefixGuard,
        suffix,
      ],
      outputs: { result: ref(suffix.id, "rows") },
    }),
  ]);
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

// A private schema on the worker's shared database. The family syncs the table
// and empties it between tests, which is what the TRUNCATE below it did.
const getFamily = usePGliteSchemaFamily(recordSeriesSchema);

let database: PGlite;
/**
 * The suite's schema. Every driver this file builds is an EXTRA driver over a
 * database it does not own, so each one carries this: without it the driver
 * addresses `public`, where this suite has no table at all. Verbatim SQL is not
 * rewritten by the driver either, so {@link ledger} names the schema too.
 */
let namespace: string;
let stateClient: ReturnType<typeof getFamily>["client"];

/** `rs_ledger`, qualified, for the statements this file hand-builds. */
function ledger() {
  return sql.raw(`"${namespace}"."rs_ledger"`);
}

/** A row another writer committed before the series began. */
function seedRow(id: number, label: string): Promise<unknown> {
  return stateClient.$executeRawUnsafe(
    `INSERT INTO "${namespace}"."rs_ledger" ("id", "label") VALUES (${id}, '${label}')`
  );
}

beforeEach(() => {
  const family = getFamily();
  database = family.database;
  namespace = family.namespace;
  stateClient = family.client;
});

function executorFor(
  driver: PGliteDriver,
  extensionChain?: ResolvedExtensionChain
): OperationExecutor {
  const engine = new QueryEngine(
    driver,
    createModelRegistry(
      recordSeriesSchema,
      createSchemaRegistry(recordSeriesSchema)
    ),
    undefined,
    undefined,
    extensionChain
  );
  return new OperationExecutor(
    extensionChain === undefined ? engine : engine.bind(driver, extensionChain)
  );
}

function seriesContext(
  instrumentation?: InstrumentationContext,
  extensionChain?: ResolvedExtensionChain
): QueryExecutionContext {
  return createOperationExecutionContext(
    "ledger",
    "createMany",
    instrumentation,
    extensionChain
  );
}

interface SegmentObservation {
  readonly unit: Readonly<{
    kind: string;
    model?: string;
    operation?: string;
  }>;
  readonly completion: Promise<
    Readonly<{
      status: "success" | "failure";
      commitCertainty?: "committed" | "may-have-committed";
    }>
  >;
  summary?: Readonly<{
    status: "success" | "failure";
    commitCertainty?: "committed" | "may-have-committed";
  }>;
}

function observedSegmentChain(): {
  readonly chain: ResolvedExtensionChain;
  readonly observations: SegmentObservation[];
} {
  const observations: SegmentObservation[] = [];
  const extension = defineExtension<typeof recordSeriesSchema>()({
    name: "record-series-segment-observer",
    observe(unit, proceed) {
      if (unit.kind !== "segment") return;
      const completion = proceed();
      const observation: SegmentObservation = { unit, completion };
      observations.push(observation);
      completion.then((summary) => {
        observation.summary = summary;
      });
    },
  });
  return {
    chain: appendResolvedExtension(undefined, extension, recordSeriesSchema),
    observations,
  };
}

async function settleSegmentObservations(
  observations: readonly SegmentObservation[]
): Promise<void> {
  await Promise.all(observations.map(({ completion }) => completion));
  await Promise.resolve();
}

function officialSegmentExecution(): {
  readonly chain: ResolvedExtensionChain;
  readonly instrumentation: InstrumentationContext;
} {
  const chain = appendResolvedExtension(
    undefined,
    instrumentation({ tracing: true }),
    recordSeriesSchema
  );
  const capability = getOfficialInstrumentationChainCapability(chain);
  if (capability === undefined) {
    throw new Error("expected official instrumentation capability");
  }
  return { chain, instrumentation: capability.context };
}

function activeSpanName(): string | undefined {
  const active = trace.getActiveSpan();
  if (active === undefined) return undefined;
  const name = Reflect.get(active, "name");
  return typeof name === "string" ? name : undefined;
}

async function settleOfficialSegmentSpans(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

function ledgerRows(): Promise<Array<{ id: number; label: string }>> {
  return stateClient.$queryRawUnsafe<{ id: number; label: string }>(
    `SELECT "id", "label" FROM "${namespace}"."rs_ledger" ORDER BY "id" ASC`
  );
}

describe("I3 — the transactional record series through the real executor", () => {
  test("captures once, builds every member before member zero writes, then runs them in order", async () => {
    const events: string[] = [];
    const driver = new TracingPGliteDriver(events, {
      client: database,
      namespace,
    });
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
    const driver = new TracingPGliteDriver(events, {
      client: database,
      namespace,
    });
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
    const driver = new TracingPGliteDriver(events, {
      client: database,
      namespace,
    });
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
    const driver = new TracingPGliteDriver(events, {
      client: database,
      namespace,
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

  test("a batch-only substrate executes members as awaited atomic segments", async () => {
    const events: string[] = [];
    const driver = new TracingBatchOnlyPGliteDriver(events, {
      client: database,
      namespace,
    });
    const series = seriesOperation(
      events,
      twoMemberShape(() => ({ id: "m1", rowId: 2, label: "one" }))
    );

    let invalidations = 0;
    const result = await executorFor(driver).execute<unknown>(
      series,
      seriesContext(),
      undefined,
      async () => {
        invalidations += 1;
        events.push(`invalidate:${invalidations}`);
      }
    );

    expect(result).toEqual({
      captured: [],
      members: [[1], [2]],
      resultReads: [],
    });
    expect(invalidations).toBe(2);
    expect(events.indexOf("invalidate:1")).toBeLessThan(
      events.lastIndexOf("sql:SELECT")
    );
    await expect(ledgerRows()).resolves.toEqual([
      { id: 1, label: "zero" },
      { id: 2, label: "one" },
    ]);
  }, 60_000);

  test("every prepared-statement and prepared-batch seam declines, touching no phase", async () => {
    const events: string[] = [];
    const driver = new TracingPGliteDriver(events, {
      client: database,
      namespace,
    });
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
      executor.prepareSharedBatch(series, driver, seriesContext(), "createMany")
    ).resolves.toBeUndefined();
    // `PendingOperation.prepare()` is this same decline: it asks the executor for
    // `singleStatementPlan` and returns what it answers, which is what lets the
    // `$transaction([...])` merge break to its typed refusal with no new client
    // code. No capture, no member, no statement was reached by any of the three.
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

describe("I13 — progressive nested record series", () => {
  test("runs the same guarded prefix, nested member, and suffix after normalized batch success", async () => {
    const events: string[] = [];
    const driver = new TracingBatchOnlyPGliteDriver(events, {
      client: database,
      namespace,
    });

    await expect(
      executorFor(driver).execute<unknown>(
        nestedProgressiveSeries(),
        seriesContext()
      )
    ).resolves.toEqual([{ result: [{ id: 2 }] }]);

    expect(driver.supportsOrderedCommittedSegments).toBe(false);
    expect(driver.batchCalls).toBeGreaterThan(1);
    await expect(ledgerRows()).resolves.toEqual([
      { id: 1, label: "nested" },
      { id: 2, label: "suffix" },
    ]);
  }, 60_000);

  test("retries only the current rolled-back member after an earlier member committed", async () => {
    await seedRow(9, "clash");
    const events: string[] = [];
    const driver = new TracingBatchOnlyPGliteDriver(events, {
      client: database,
      namespace,
    });
    let secondCompiles = 0;
    const secondProbe: ReadStep = {
      id: "retry.probe",
      kind: "read",
      statement: sql`SELECT "id" FROM ${ledger()} ORDER BY "id" ASC`,
      outputs: { rows: { kind: "rows" } },
    };
    const second: ExecutableOperation = {
      mode: "batch",
      planning: () => ({ steps: [secondProbe] }),
      compile: () => {
        secondCompiles += 1;
        const write: WriteStep = {
          id: "retry.write",
          kind: "write",
          statement: sql`INSERT INTO ${ledger()} ("id", "label") VALUES (${2}, ${secondCompiles === 1 ? "clash" : "free"}) RETURNING "id"`,
          outputs: { rows: { kind: "rows" } },
          racePin: LABEL_PIN,
        };
        return { steps: [write], outputs: { rows: ref(write.id, "rows") } };
      },
      parse: <T>(outputs: Readonly<Record<string, unknown>>): T =>
        outputs.rows as T,
    };

    const result = await executeRoutedOperation<unknown>(
      executorFor(driver),
      staticSeries([
        memberOperation(events, {
          id: "first",
          rowId: 1,
          label: "first",
        }),
        second,
      ]),
      seriesContext()
    );

    expect(result).toEqual([[{ id: 1 }], [{ id: 2 }]]);
    expect(secondCompiles).toBe(2);
    expect(
      events.filter((event) => event === "sql:INSERT(1,first)")
    ).toHaveLength(1);
    await expect(ledgerRows()).resolves.toEqual([
      { id: 1, label: "first" },
      { id: 2, label: "free" },
      { id: 9, label: "clash" },
    ]);
  }, 60_000);

  test("keeps official segment retry spans in exact attempt order", async () => {
    const recorder = withOtelRecorder();
    try {
      await seedRow(9, "clash");
      const events: string[] = [];
      const driver = new TracingBatchOnlyPGliteDriver(events, {
        client: database,
        namespace,
      });
      let secondCompiles = 0;
      const secondProbe: ReadStep = {
        id: "official-retry.probe",
        kind: "read",
        statement: sql`SELECT "id" FROM ${ledger()} ORDER BY "id" ASC`,
        outputs: { rows: { kind: "rows" } },
      };
      const second: ExecutableOperation = {
        mode: "batch",
        planning: () => ({ steps: [secondProbe] }),
        compile: () => {
          secondCompiles += 1;
          const write: WriteStep = {
            id: "official-retry.write",
            kind: "write",
            statement: sql`INSERT INTO ${ledger()} ("id", "label") VALUES (${2}, ${secondCompiles === 1 ? "clash" : "free"}) RETURNING "id"`,
            outputs: { rows: { kind: "rows" } },
            racePin: LABEL_PIN,
          };
          return { steps: [write], outputs: { rows: ref(write.id, "rows") } };
        },
        parse: <T>(outputs: Readonly<Record<string, unknown>>): T =>
          outputs.rows as T,
      };
      const official = officialSegmentExecution();

      const result = await executeRoutedOperation<unknown>(
        executorFor(driver, official.chain),
        staticSeries([
          memberOperation(events, {
            id: "official-first",
            rowId: 1,
            label: "first",
          }),
          second,
        ]),
        seriesContext(official.instrumentation, official.chain)
      );
      await settleOfficialSegmentSpans();

      expect(result).toEqual([[{ id: 1 }], [{ id: 2 }]]);
      expect(secondCompiles).toBe(2);
      expect(
        recorder
          .spans()
          .filter(({ name }) => name === SPAN_RECORD_SERIES_SEGMENT)
          .map(({ attributes, status }) => ({
            path: attributes[ATTR_VIBORM_WRITE_MEMBER_PATH],
            outcome: attributes[ATTR_VIBORM_WRITE_COMMIT_OUTCOME],
            status: status.code,
          }))
      ).toEqual([
        { path: "0", outcome: "committed", status: 1 },
        { path: "1", outcome: "rolled_back", status: 2 },
        { path: "1", outcome: "committed", status: 1 },
      ]);
    } finally {
      await recorder.dispose();
    }
  }, 60_000);

  test("marks a dispatched malformed weak segment as possibly committed and stops the series", async () => {
    const events: string[] = [];
    const driver = new MalformedSecondBatchPGliteDriver(events, {
      client: database,
      namespace,
    });
    const writeMember = (id: number): ExecutableOperation => {
      const write: WriteStep = {
        id: `malformed.${id}`,
        kind: "write",
        statement: sql`INSERT INTO ${ledger()} ("id", "label") VALUES (${id}, ${`row-${id}`})`,
        outputs: { count: { kind: "rowCount" } },
      };
      return staticMember({
        steps: [write],
        outputs: { count: ref(write.id, "count") },
      });
    };
    let acknowledged = 0;
    let mayBeVisible = 0;

    const failure = await executorFor(driver)
      .execute(
        staticSeries([writeMember(1), writeMember(2), writeMember(3)]),
        seriesContext(),
        undefined,
        async () => {
          acknowledged += 1;
        },
        async () => {
          mayBeVisible += 1;
        }
      )
      .catch((error) => error);

    expect(failure).toMatchObject({
      meta: {
        recordSeriesProgress: {
          committedSegments: 1,
          completedMembers: 1,
          mayHaveCommittedSegment: true,
        },
      },
    });
    expect(acknowledged).toBe(1);
    expect(mayBeVisible).toBe(1);
    expect(driver.batchCalls).toBe(2);
    await expect(ledgerRows()).resolves.toEqual([
      { id: 1, label: "row-1" },
      { id: 2, label: "row-2" },
    ]);
  }, 60_000);

  test("runs prefix, recursive series, and suffix with exact cross-boundary values", async () => {
    const events: string[] = [];
    const driver = new TracingProgressivePGliteDriver(events);

    await expect(
      executorFor(driver).execute<unknown>(
        nestedProgressiveSeries(),
        seriesContext()
      )
    ).resolves.toEqual([{ result: [{ id: 2 }] }]);

    expect(events).toEqual([
      "sql:INSERT(1,prefix)",
      "sql:SELECT(1)",
      "sql:UPDATE(nested,1)",
      "sql:SELECT(1)",
      "sql:SELECT(1)",
      "sql:SELECT(1,nested)",
      "sql:INSERT(2,suffix,1,1)",
    ]);
    await expect(ledgerRows()).resolves.toEqual([
      { id: 1, label: "nested" },
      { id: 2, label: "suffix" },
    ]);
  }, 60_000);

  test("routes a guarded nested series from a direct atomic-batch fragment", async () => {
    const events: string[] = [];
    const driver = new TracingProgressivePGliteDriver(events);
    const direct = nestedProgressiveSeries().compileMembers({})[0];
    if (!direct) throw new Error("expected one direct progressive member");

    await expect(
      executorFor(driver).execute<unknown>(direct, seriesContext())
    ).resolves.toEqual({ result: [{ id: 2 }] });

    expect(events).toEqual([
      "sql:INSERT(1,prefix)",
      "sql:SELECT(1)",
      "sql:UPDATE(nested,1)",
      "sql:SELECT(1)",
      "sql:SELECT(1)",
      "sql:SELECT(1,nested)",
      "sql:INSERT(2,suffix,1,1)",
    ]);
  }, 60_000);

  test("declines an indivisible shared batch before a nested series prefix runs", async () => {
    const events: string[] = [];
    const driver = new TracingBatchOnlyPGliteDriver(events, {
      client: database,
      namespace,
    });
    const direct = nestedProgressiveSeries().compileMembers({})[0];
    if (!direct) throw new Error("expected one direct progressive member");
    const routedDirect = { ...direct, validatedArgs: {} };

    await expect(
      executorFor(driver).prepareSharedBatch(
        routedDirect,
        driver,
        seriesContext(),
        "create"
      )
    ).resolves.toBeUndefined();
    expect(driver.batchCalls).toBe(0);
    expect(events).toEqual([]);
    await expect(ledgerRows()).resolves.toEqual([]);
  });

  test("emits one child span per segment and final parent progress", async () => {
    const recorder = withOtelRecorder();
    try {
      const events: string[] = [];
      const driver = new TracingProgressivePGliteDriver(events);
      const official = officialSegmentExecution();

      await official.instrumentation.tracer.startActiveSpan(
        { name: SPAN_OPERATION },
        () =>
          executorFor(driver, official.chain).execute(
            nestedProgressiveSeries(),
            seriesContext(official.instrumentation, official.chain)
          )
      );
      await settleOfficialSegmentSpans();

      const spans = recorder.spans();
      const parent = spans.find((span) => span.name === SPAN_OPERATION);
      expect(parent?.attributes).toMatchObject({
        [ATTR_VIBORM_WRITE_ATOMICITY]: "segment",
        [ATTR_VIBORM_WRITE_COMMITTED_SEGMENTS]: 3,
        [ATTR_VIBORM_WRITE_COMPLETED_MEMBERS]: 2,
        [ATTR_VIBORM_WRITE_COMMITTED_WRITE_MEMBERS]: 2,
      });
      expect(
        spans
          .filter((span) => span.name === SPAN_RECORD_SERIES_SEGMENT)
          .map((span) => ({
            parent:
              parent !== undefined &&
              span.parentSpanContext?.spanId === parent.spanContext().spanId
                ? parent.name
                : undefined,
            path: span.attributes[ATTR_VIBORM_WRITE_MEMBER_PATH],
            statements: span.attributes[ATTR_VIBORM_WRITE_STATEMENT_COUNT],
            outcome: span.attributes[ATTR_VIBORM_WRITE_COMMIT_OUTCOME],
          }))
      ).toEqual([
        {
          parent: SPAN_OPERATION,
          path: "0",
          statements: 1,
          outcome: "committed",
        },
        {
          parent: SPAN_OPERATION,
          path: "0.0",
          statements: 2,
          outcome: "committed",
        },
        {
          parent: SPAN_OPERATION,
          path: "0",
          statements: 4,
          outcome: "committed",
        },
      ]);
    } finally {
      await recorder.dispose();
    }
  }, 60_000);

  test("presents official segments in onion order and keeps final progress on the parent", async () => {
    const recorder = withOtelRecorder();
    try {
      const timeline: string[] = [];
      const summaries: SegmentObservation["summary"][] = [];
      let chain = appendResolvedExtension(
        undefined,
        defineExtension<typeof recordSeriesSchema>()({
          name: "official-segment-before",
          observe(unit, proceed) {
            if (unit.kind !== "segment") return;
            timeline.push(`A.in:${activeSpanName()}`);
            return proceed().then((summary) => {
              timeline.push(`A.out:${summary.status}`);
            });
          },
        }),
        recordSeriesSchema
      );
      chain = appendResolvedExtension(
        chain,
        instrumentation({ tracing: true }),
        recordSeriesSchema
      );
      chain = appendResolvedExtension(
        chain,
        defineExtension<typeof recordSeriesSchema>()({
          name: "official-segment-after",
          observe(unit, proceed) {
            if (unit.kind !== "segment") return;
            timeline.push(`B.in:${activeSpanName()}`);
            const completion = proceed();
            completion.then((summary) => {
              summaries.push(summary);
              timeline.push(`B.out:${summary.status}`);
            });
            throw new Error("hostile segment observer");
          },
        }),
        recordSeriesSchema
      );
      const capability = getOfficialInstrumentationChainCapability(chain);
      if (capability === undefined) {
        throw new Error("expected official instrumentation capability");
      }
      const events: string[] = [];
      const driver = new TracingProgressivePGliteDriver(events);

      const result = await capability.context.tracer.startActiveSpan(
        { name: SPAN_OPERATION },
        () =>
          executorFor(driver, chain).execute(
            nestedProgressiveSeries(),
            seriesContext(capability.context, chain)
          )
      );
      await settleOfficialSegmentSpans();

      expect(result).toEqual([{ result: [{ id: 2 }] }]);
      expect(timeline).toEqual(
        Array.from({ length: 3 }, () => [
          `A.in:${SPAN_OPERATION}`,
          `B.in:${SPAN_RECORD_SERIES_SEGMENT}`,
          "B.out:success",
          "A.out:success",
        ]).flat()
      );
      expect(summaries).toHaveLength(3);
      expect(
        summaries.every(
          (summary) =>
            summary?.status === "success" &&
            summary.commitCertainty === "committed"
        )
      ).toBe(true);

      const spans = recorder.spans();
      const parent = spans.find(({ name }) => name === SPAN_OPERATION);
      const segments = spans.filter(
        ({ name }) => name === SPAN_RECORD_SERIES_SEGMENT
      );
      expect(parent?.attributes).toMatchObject({
        [ATTR_VIBORM_WRITE_ATOMICITY]: "segment",
        [ATTR_VIBORM_WRITE_COMMITTED_SEGMENTS]: 3,
        [ATTR_VIBORM_WRITE_COMPLETED_MEMBERS]: 2,
        [ATTR_VIBORM_WRITE_COMMITTED_WRITE_MEMBERS]: 2,
      });
      expect(
        segments.map(({ attributes, parentSpanContext }) => ({
          parent: parentSpanContext?.spanId,
          path: attributes[ATTR_VIBORM_WRITE_MEMBER_PATH],
          statements: attributes[ATTR_VIBORM_WRITE_STATEMENT_COUNT],
          outcome: attributes[ATTR_VIBORM_WRITE_COMMIT_OUTCOME],
          parentProgress: attributes[ATTR_VIBORM_WRITE_COMMITTED_SEGMENTS],
        }))
      ).toEqual([
        {
          parent: parent?.spanContext().spanId,
          path: "0",
          statements: 1,
          outcome: "committed",
          parentProgress: undefined,
        },
        {
          parent: parent?.spanContext().spanId,
          path: "0.0",
          statements: 2,
          outcome: "committed",
          parentProgress: undefined,
        },
        {
          parent: parent?.spanContext().spanId,
          path: "0",
          statements: 4,
          outcome: "committed",
          parentProgress: undefined,
        },
      ]);
    } finally {
      await recorder.dispose();
    }
  }, 60_000);

  test("keeps segment facts exact to active official tracing on a shared driver", async () => {
    const recorder = withOtelRecorder();
    try {
      const events: string[] = [];
      const driver = new TracingProgressivePGliteDriver(events);
      const read: ReadStep = {
        id: "official-isolation.read",
        kind: "read",
        statement: sql`SELECT "id" FROM ${ledger()} ORDER BY "id" ASC`,
        outputs: { rows: { kind: "rows" } },
      };
      const series = () =>
        staticSeries([
          staticMember({
            steps: [read],
            outputs: { rows: ref(read.id, "rows") },
          }),
        ]);
      const activeFacts: Array<string | undefined> = [];
      let activeChain = appendResolvedExtension(
        undefined,
        instrumentation({ tracing: true }),
        recordSeriesSchema
      );
      activeChain = appendResolvedExtension(
        activeChain,
        defineExtension<typeof recordSeriesSchema>()({
          name: "official-segment-active-facts",
          observe(unit, proceed) {
            if (unit.kind !== "segment") return;
            activeFacts.push(readProtectedLifecycleFacts(unit)?.kind);
            return proceed();
          },
        }),
        recordSeriesSchema
      );
      const activeCapability =
        getOfficialInstrumentationChainCapability(activeChain);
      if (activeCapability === undefined) {
        throw new Error("expected active official instrumentation capability");
      }

      await executorFor(driver, activeChain).execute(
        series(),
        seriesContext(activeCapability.context, activeChain)
      );

      const ordinaryFacts: Array<string | undefined> = [];
      const ordinaryChain = appendResolvedExtension(
        undefined,
        defineExtension<typeof recordSeriesSchema>()({
          name: "ordinary-segment-facts",
          observe(unit, proceed) {
            if (unit.kind !== "segment") return;
            ordinaryFacts.push(readProtectedLifecycleFacts(unit)?.kind);
            return proceed();
          },
        }),
        recordSeriesSchema
      );
      await executorFor(driver, ordinaryChain).execute(
        series(),
        seriesContext(undefined, ordinaryChain)
      );

      const ignoredFacts: Array<string | undefined> = [];
      let ignoredChain = appendResolvedExtension(
        undefined,
        instrumentation({
          tracing: { ignoreSpanTypes: [SPAN_RECORD_SERIES_SEGMENT] },
        }),
        recordSeriesSchema
      );
      ignoredChain = appendResolvedExtension(
        ignoredChain,
        defineExtension<typeof recordSeriesSchema>()({
          name: "official-segment-ignored-facts",
          observe(unit, proceed) {
            if (unit.kind !== "segment") return;
            ignoredFacts.push(readProtectedLifecycleFacts(unit)?.kind);
            return proceed();
          },
        }),
        recordSeriesSchema
      );
      const ignoredCapability =
        getOfficialInstrumentationChainCapability(ignoredChain);
      if (ignoredCapability === undefined) {
        throw new Error("expected ignored official instrumentation capability");
      }
      await executorFor(driver, ignoredChain).execute(
        series(),
        seriesContext(ignoredCapability.context, ignoredChain)
      );
      await settleOfficialSegmentSpans();

      expect(activeFacts).toEqual(["segment"]);
      expect(ordinaryFacts).toEqual([undefined]);
      expect(ignoredFacts).toEqual([undefined]);
      expect(
        recorder
          .spans()
          .filter(({ name }) => name === SPAN_RECORD_SERIES_SEGMENT)
      ).toHaveLength(1);
    } finally {
      await recorder.dispose();
    }
  }, 60_000);

  test("emits one protected unit beside each existing progressive span", async () => {
    const recorder = withOtelRecorder();
    try {
      const events: string[] = [];
      const driver = new TracingProgressivePGliteDriver(events);
      const observed = observedSegmentChain();
      const chain = appendResolvedExtension(
        observed.chain,
        instrumentation({ tracing: true }),
        recordSeriesSchema
      );
      const capability = getOfficialInstrumentationChainCapability(chain);
      if (capability === undefined) {
        throw new Error("expected official instrumentation capability");
      }

      await executorFor(driver, chain).execute(
        nestedProgressiveSeries(),
        seriesContext(capability.context, chain)
      );
      await settleSegmentObservations(observed.observations);
      await settleOfficialSegmentSpans();

      expect(observed.observations).toHaveLength(3);
      expect(
        observed.observations.map(({ unit, summary }) => ({ unit, summary }))
      ).toEqual([
        {
          unit: {
            kind: "segment",
            model: "ledger",
            operation: "createMany",
          },
          summary: {
            status: "success",
            commitCertainty: "committed",
            durationMs: expect.any(Number),
          },
        },
        {
          unit: {
            kind: "segment",
            model: "ledger",
            operation: "createMany",
          },
          summary: {
            status: "success",
            commitCertainty: "committed",
            durationMs: expect.any(Number),
          },
        },
        {
          unit: {
            kind: "segment",
            model: "ledger",
            operation: "createMany",
          },
          summary: {
            status: "success",
            commitCertainty: "committed",
            durationMs: expect.any(Number),
          },
        },
      ]);
      expect(
        recorder
          .spans()
          .filter(({ name }) => name === SPAN_RECORD_SERIES_SEGMENT)
      ).toHaveLength(3);
    } finally {
      await recorder.dispose();
    }
  }, 60_000);

  test("reads committed certainty after acknowledged segment post-work fails", async () => {
    const events: string[] = [];
    const driver = new TracingProgressivePGliteDriver(events);
    const { chain, observations } = observedSegmentChain();

    await executorFor(driver, chain)
      .execute(
        nestedProgressiveSeries(),
        seriesContext(undefined, chain),
        undefined,
        async () => {
          throw new Error("committed invalidation failed");
        }
      )
      .catch(() => undefined);
    await settleSegmentObservations(observations);

    expect(observations).toHaveLength(1);
    expect(observations[0]?.summary).toMatchObject({
      status: "failure",
      commitCertainty: "committed",
    });
  }, 60_000);

  test("reports only a dispatched unacknowledged write as possibly committed", async () => {
    const events: string[] = [];
    const driver = new MalformedSecondBatchPGliteDriver(events, {
      client: database,
      namespace,
    });
    const writeMember = (id: number): ExecutableOperation => {
      const write: WriteStep = {
        id: `observed-malformed.${id}`,
        kind: "write",
        statement: sql`INSERT INTO ${ledger()} ("id", "label") VALUES (${id}, ${`observed-${id}`})`,
        outputs: { count: { kind: "rowCount" } },
      };
      return staticMember({
        steps: [write],
        outputs: { count: ref(write.id, "count") },
      });
    };
    const { chain, observations } = observedSegmentChain();

    await executorFor(driver, chain)
      .execute(
        staticSeries([writeMember(1), writeMember(2), writeMember(3)]),
        seriesContext(undefined, chain)
      )
      .catch(() => undefined);
    await settleSegmentObservations(observations);

    expect(observations).toHaveLength(2);
    expect(observations.map(({ summary }) => summary)).toMatchObject([
      { status: "success", commitCertainty: "committed" },
      { status: "failure", commitCertainty: "may-have-committed" },
    ]);
  }, 60_000);

  test("does not claim durable certainty for read-only or rolled-back segments", async () => {
    await seedRow(1, "occupied");
    const events: string[] = [];
    const driver = new TracingProgressivePGliteDriver(events);
    const read: ReadStep = {
      id: "observed.read",
      kind: "read",
      statement: sql`SELECT "id" FROM ${ledger()} ORDER BY "id" ASC`,
      outputs: { rows: { kind: "rows" } },
    };
    const duplicate: WriteStep = {
      id: "observed.duplicate",
      kind: "write",
      statement: sql`INSERT INTO ${ledger()} ("id", "label") VALUES (${1}, ${"duplicate"})`,
      outputs: { count: { kind: "rowCount" } },
    };
    const { chain, observations } = observedSegmentChain();

    await executorFor(driver, chain).execute(
      staticSeries([
        staticMember({
          steps: [read],
          outputs: { rows: ref(read.id, "rows") },
        }),
      ]),
      seriesContext(undefined, chain)
    );
    await executorFor(driver, chain)
      .execute(
        staticSeries([
          staticMember({
            steps: [duplicate],
            outputs: { count: ref(duplicate.id, "count") },
          }),
        ]),
        seriesContext(undefined, chain)
      )
      .catch(() => undefined);
    await settleSegmentObservations(observations);

    expect(observations.map(({ summary }) => summary)).toMatchObject([
      { status: "success" },
      { status: "failure" },
    ]);
    expect(
      observations.every(
        ({ summary }) => summary?.commitCertainty === undefined
      )
    ).toBe(true);
  }, 60_000);

  test("publishes exact official read-only, rolled-back, and unacknowledged outcomes", async () => {
    const recorder = withOtelRecorder();
    try {
      const official = officialSegmentExecution();
      const events: string[] = [];
      const acknowledgedDriver = new TracingProgressivePGliteDriver(events);
      const read: ReadStep = {
        id: "official-outcome.read",
        kind: "read",
        statement: sql`SELECT "id" FROM ${ledger()} ORDER BY "id" ASC`,
        outputs: { rows: { kind: "rows" } },
      };
      await executorFor(acknowledgedDriver, official.chain).execute(
        staticSeries([
          staticMember({
            steps: [read],
            outputs: { rows: ref(read.id, "rows") },
          }),
        ]),
        seriesContext(official.instrumentation, official.chain)
      );

      await seedRow(1, "occupied");
      const duplicate: WriteStep = {
        id: "official-outcome.duplicate",
        kind: "write",
        statement: sql`INSERT INTO ${ledger()} ("id", "label") VALUES (${1}, ${"duplicate"})`,
        outputs: { count: { kind: "rowCount" } },
      };
      await executorFor(acknowledgedDriver, official.chain)
        .execute(
          staticSeries([
            staticMember({
              steps: [duplicate],
              outputs: { count: ref(duplicate.id, "count") },
            }),
          ]),
          seriesContext(official.instrumentation, official.chain)
        )
        .catch(() => undefined);

      const committedFailure: WriteStep = {
        id: "official-outcome.committed-failure",
        kind: "write",
        statement: sql`INSERT INTO ${ledger()} ("id", "label") VALUES (${20}, ${"committed-failure"})`,
        outputs: { count: { kind: "rowCount" } },
      };
      await executorFor(acknowledgedDriver, official.chain)
        .execute(
          staticSeries([
            staticMember({
              steps: [committedFailure],
              outputs: {
                count: ref(committedFailure.id, "count"),
              },
            }),
          ]),
          seriesContext(official.instrumentation, official.chain),
          undefined,
          async () => {
            throw new Error("committed outcome listener failed");
          }
        )
        .catch(() => undefined);

      const weakDriver = new MalformedSecondBatchPGliteDriver(events, {
        client: database,
        namespace,
      });
      const weakMember = (id: number): ExecutableOperation => {
        const write: WriteStep = {
          id: `official-outcome.weak.${id}`,
          kind: "write",
          statement: sql`INSERT INTO ${ledger()} ("id", "label") VALUES (${id}, ${`weak-${id}`})`,
          outputs: { count: { kind: "rowCount" } },
        };
        return staticMember({
          steps: [write],
          outputs: { count: ref(write.id, "count") },
        });
      };
      await executorFor(weakDriver, official.chain)
        .execute(
          staticSeries([weakMember(10), weakMember(11), weakMember(12)]),
          seriesContext(official.instrumentation, official.chain)
        )
        .catch(() => undefined);
      await settleOfficialSegmentSpans();

      expect(
        recorder
          .spans()
          .filter(({ name }) => name === SPAN_RECORD_SERIES_SEGMENT)
          .map(({ attributes, status }) => ({
            outcome: attributes[ATTR_VIBORM_WRITE_COMMIT_OUTCOME],
            status: status.code,
          }))
      ).toEqual([
        { outcome: "read_only", status: 1 },
        { outcome: "rolled_back", status: 2 },
        { outcome: "committed", status: 2 },
        { outcome: "committed", status: 1 },
        { outcome: "unacknowledged", status: 2 },
      ]);
    } finally {
      await recorder.dispose();
    }
  }, 60_000);

  test("marks a segment committed when post-commit invalidation fails", async () => {
    const recorder = withOtelRecorder();
    try {
      const events: string[] = [];
      const driver = new TracingProgressivePGliteDriver(events);
      const official = officialSegmentExecution();

      const failure = await official.instrumentation.tracer
        .startActiveSpan({ name: SPAN_OPERATION }, () =>
          executorFor(driver, official.chain).execute(
            nestedProgressiveSeries(),
            seriesContext(official.instrumentation, official.chain),
            undefined,
            async () => {
              throw new Error("invalidation failed");
            }
          )
        )
        .catch((error) => error);
      await settleOfficialSegmentSpans();

      expect(failure).toMatchObject({
        meta: {
          recordSeriesProgress: {
            phase: "invalidation",
            committedSegments: 1,
            committedWriteMembers: 1,
          },
        },
      });
      const spans = recorder.spans();
      const segment = spans.find(
        (span) => span.name === SPAN_RECORD_SERIES_SEGMENT
      );
      expect(segment?.attributes[ATTR_VIBORM_WRITE_COMMIT_OUTCOME]).toBe(
        "committed"
      );
      const parent = spans.find((span) => span.name === SPAN_OPERATION);
      expect(parent?.attributes).toMatchObject({
        [ATTR_VIBORM_WRITE_ATOMICITY]: "segment",
        [ATTR_VIBORM_WRITE_COMMITTED_SEGMENTS]: 1,
        [ATTR_VIBORM_WRITE_COMPLETED_MEMBERS]: 0,
        [ATTR_VIBORM_WRITE_COMMITTED_WRITE_MEMBERS]: 1,
      });
    } finally {
      await recorder.dispose();
    }
  }, 60_000);

  test.each([
    {
      name: "prefix",
      seed: { id: 1, label: "occupied-prefix" },
      series: () => nestedProgressiveSeries(),
      phase: "prefix",
      memberPath: [0],
      committedSegments: 0,
    },
    {
      name: "nested member",
      seed: { id: 9, label: "occupied-nested" },
      series: () => nestedProgressiveSeries("occupied-nested"),
      phase: "member",
      memberPath: [0, 0],
      committedSegments: 1,
    },
    {
      name: "suffix",
      seed: { id: 2, label: "occupied-suffix" },
      series: () => nestedProgressiveSeries(),
      phase: "suffix",
      memberPath: [0],
      committedSegments: 2,
    },
  ])("attributes a $name failure to its exact progressive phase", async ({
    seed,
    series,
    phase,
    memberPath,
    committedSegments,
  }) => {
    const events: string[] = [];
    const driver = new TracingProgressivePGliteDriver(events);
    await seedRow(seed.id, seed.label);

    const failure = await executorFor(driver)
      .execute(series(), seriesContext())
      .catch((error) => error);

    expect(failure).toMatchObject({
      meta: {
        recordSeriesProgress: {
          atomicity: "segment",
          phase,
          committedSegments,
          memberPath,
        },
      },
    });
    if (!(failure instanceof VibORMError)) {
      throw new Error("expected a VibORM progress failure");
    }
    expect(failure.toJSON()).toMatchObject({
      meta: {
        recordSeriesProgress: {
          phase,
          committedSegments,
          memberPath,
        },
      },
    });
  }, 60_000);

  test("refuses a statically oversized later member before the first commit", async () => {
    const events: string[] = [];
    const driver = new TracingProgressivePGliteDriver(events, 2);
    const first: WriteStep = {
      id: "capacity.first",
      kind: "write",
      statement: sql`INSERT INTO ${ledger()} ("id", "label") VALUES (${1}, ${"first"})`,
      outputs: { count: { kind: "rowCount" } },
    };
    const oversized: WriteStep = {
      id: "capacity.oversized",
      kind: "write",
      statement: sql`INSERT INTO ${ledger()} ("id", "label") SELECT ${2}, ${"oversized"} WHERE ${true}`,
      outputs: { count: { kind: "rowCount" } },
    };
    const series = staticSeries([
      staticMember({
        steps: [first],
        outputs: { count: ref(first.id, "count") },
      }),
      staticMember({
        steps: [oversized],
        outputs: { count: ref(oversized.id, "count") },
      }),
    ]);

    await expect(
      executorFor(driver).execute(series, seriesContext())
    ).rejects.toThrow(
      "one statically compiled statement needs 3 bound values, above the verified limit of 2"
    );
    expect(events).toEqual([]);
    await expect(ledgerRows()).resolves.toEqual([]);
  }, 60_000);

  test("refuses an unguarded nested boundary before its enclosing prefix commits", async () => {
    const events: string[] = [];
    const driver = new TracingProgressivePGliteDriver(events);
    const prefix: WriteStep = {
      id: "unguarded.prefix",
      kind: "write",
      statement: sql`INSERT INTO ${ledger()} ("id", "label") VALUES (${1}, ${"unsafe"})`,
      outputs: { count: { kind: "rowCount" } },
    };
    const unsafe = staticSeries([
      staticMember({
        steps: [
          prefix,
          {
            id: "unguarded.series",
            kind: "recordSeries",
            progressive: {
              kind: "unsupported",
              reason: "the complete parent cannot be re-pinned",
            },
            series: staticSeries([]),
          },
        ],
        outputs: { count: ref(prefix.id, "count") },
      }),
    ]);

    await expect(
      executorFor(driver).execute(unsafe, seriesContext())
    ).rejects.toThrow("the complete parent cannot be re-pinned");
    expect(events).toEqual([]);
    await expect(ledgerRows()).resolves.toEqual([]);
  }, 60_000);
});

describe("batch-only root-conflict attribution", () => {
  const rootFirstMember = (
    rootId: number,
    rootLabel: string,
    childId: number,
    childLabel: string
  ): ExecutableOperation => {
    const root: WriteStep = {
      id: `skip.${rootId}.root`,
      kind: "write",
      statement: sql`INSERT INTO ${ledger()} ("id", "label") VALUES (${rootId}, ${rootLabel}) ON CONFLICT DO NOTHING`,
      outputs: { count: { kind: "rowCount" } },
    };
    const child: WriteStep = {
      id: `skip.${rootId}.child`,
      kind: "write",
      statement: sql`INSERT INTO ${ledger()} ("id", "label") VALUES (${childId}, ${childLabel})`,
      outputs: { count: { kind: "rowCount" } },
    };
    return staticMember(
      {
        steps: [root, child],
        outputs: { count: ref(child.id, "count") },
      },
      root.id
    );
  };

  test("a skipped root dispatches no descendant on a capability-false batch driver", async () => {
    await seedRow(1, "resident");
    const events: string[] = [];
    const driver = new TracingBatchOnlyPGliteDriver(events, {
      client: database,
      namespace,
    });

    await expect(
      executorFor(driver).execute(
        staticSeries([rootFirstMember(1, "duplicate", 2, "descendant")]),
        seriesContext()
      )
    ).resolves.toEqual([{ kind: "skipped" }]);

    expect(driver.batchCalls).toBe(1);
    await expect(ledgerRows()).resolves.toEqual([{ id: 1, label: "resident" }]);
  }, 60_000);

  test("a strong commit acknowledgement invalidates a skipped root without counting a write member", async () => {
    await seedRow(1, "resident");
    const events: string[] = [];
    const driver = new TracingProgressivePGliteDriver(events);
    let committedWrites = 0;

    const failure = await executorFor(driver)
      .execute(
        staticSeries([rootFirstMember(1, "duplicate", 2, "descendant")]),
        seriesContext(),
        undefined,
        async () => {
          committedWrites += 1;
          throw new Error("skipped-root invalidation failed");
        }
      )
      .catch((error) => error);

    expect(failure).toBeInstanceOf(QueryEngineError);
    expect(failure).toMatchObject({
      meta: {
        recordSeriesProgress: {
          phase: "invalidation",
          committedSegments: 1,
          completedMembers: 0,
          committedWriteMembers: 0,
        },
      },
    });
    expect(committedWrites).toBe(1);
    expect(driver.batchCalls).toBe(1);
    await expect(ledgerRows()).resolves.toEqual([{ id: 1, label: "resident" }]);
  }, 60_000);

  test("a skipped root is not counted as a committed write member", async () => {
    await seedRow(1, "resident");
    await seedRow(9, "occupied");
    const events: string[] = [];
    const driver = new TracingBatchOnlyPGliteDriver(events, {
      client: database,
      namespace,
    });
    const failingWrite: WriteStep = {
      id: "skip.later-failure",
      kind: "write",
      statement: sql`INSERT INTO ${ledger()} ("id", "label") VALUES (${9}, ${"conflict"})`,
      outputs: { count: { kind: "rowCount" } },
    };

    const failure = await executorFor(driver)
      .execute(
        staticSeries([
          rootFirstMember(1, "duplicate", 2, "descendant"),
          staticMember({
            steps: [failingWrite],
            outputs: { count: ref(failingWrite.id, "count") },
          }),
        ]),
        seriesContext()
      )
      .catch((error) => error);

    expect(failure).toBeInstanceOf(UniqueConstraintError);
    expect(failure).toMatchObject({
      meta: {
        recordSeriesProgress: {
          committedSegments: 1,
          completedMembers: 1,
          committedWriteMembers: 0,
        },
      },
    });
    await expect(ledgerRows()).resolves.toEqual([
      { id: 1, label: "resident" },
      { id: 9, label: "occupied" },
    ]);
  }, 60_000);

  test("a fresh root continues to its descendant", async () => {
    const events: string[] = [];
    const driver = new TracingBatchOnlyPGliteDriver(events, {
      client: database,
      namespace,
    });

    await expect(
      executorFor(driver).execute(
        staticSeries([rootFirstMember(1, "fresh", 2, "descendant")]),
        seriesContext()
      )
    ).resolves.toEqual([{ count: 1 }]);

    expect(driver.batchCalls).toBe(2);
    await expect(ledgerRows()).resolves.toEqual([
      { id: 1, label: "fresh" },
      { id: 2, label: "descendant" },
    ]);
  }, 60_000);

  test("a descendant failure preserves only the acknowledged root prefix", async () => {
    await seedRow(2, "resident");
    const events: string[] = [];
    const driver = new TracingBatchOnlyPGliteDriver(events, {
      client: database,
      namespace,
    });

    const failure = await executorFor(driver)
      .execute(
        staticSeries([rootFirstMember(1, "fresh", 2, "conflict")]),
        seriesContext()
      )
      .catch((error) => error);

    expect(failure).toBeInstanceOf(UniqueConstraintError);
    expect(failure).toMatchObject({
      meta: {
        recordSeriesProgress: {
          committedSegments: 1,
          committedWriteMembers: 1,
        },
      },
    });
    if (!(failure instanceof VibORMError)) throw failure;
    expect(failure.meta.recordSeriesProgress).not.toHaveProperty(
      "mayHaveCommittedSegment"
    );
    await expect(ledgerRows()).resolves.toEqual([
      { id: 1, label: "fresh" },
      { id: 2, label: "resident" },
    ]);
  }, 60_000);

  test("a statically known write before the skippable root refuses before any member effect", async () => {
    const before: WriteStep = {
      id: "skip.before",
      kind: "write",
      statement: sql`INSERT INTO ${ledger()} ("id", "label") VALUES (${9}, ${"orphan"})`,
      outputs: { count: { kind: "rowCount" } },
    };
    const root: WriteStep = {
      id: "skip.root",
      kind: "write",
      statement: sql`INSERT INTO ${ledger()} ("id", "label") VALUES (${1}, ${"root"}) ON CONFLICT DO NOTHING`,
      outputs: { count: { kind: "rowCount" } },
    };
    const member = staticMember(
      { steps: [before, root], outputs: {} },
      root.id
    );
    const driver = new TracingBatchOnlyPGliteDriver([], {
      client: database,
      namespace,
    });

    const refusal = await executorFor(driver)
      .execute(staticSeries([member]), seriesContext())
      .catch((error) => error);

    expect(refusal).toBeInstanceOf(UnsupportedOperationError);
    expect(refusal).toHaveProperty(
      "message",
      "Driver 'pglite' cannot execute this record series as committed segments because skipping root 'skip.root' would leave prior effect 'skip.before' committed."
    );
    expect(driver.batchCalls).toBe(0);
    await expect(ledgerRows()).resolves.toEqual([]);
  }, 60_000);
});

describe("residual F — a suppressed member does not poison its enclosing scope", () => {
  test("a later member still writes, and a later race still retries the WHOLE series", async () => {
    const events: string[] = [];
    const driver = new TracingPGliteDriver(events, {
      client: database,
      namespace,
    });
    // Two committed rows: `blocked` is what the skippable member's root INSERT
    // conflicts on (so that member is SUPPRESSED, savepoint and all), and `clash`
    // is what the pinned member loses to on attempt one (a genuine retryable race).
    await seedRow(8, "blocked");
    await seedRow(9, "clash");

    const series = seriesOperation(events, {
      members: (attempt) => [
        { id: "m0", rowId: 1, label: "zero" },
        // Suppressed: its `ON CONFLICT DO NOTHING` root write returns no row, so the
        // executor rolls this member's savepoint back and the series continues.
        { id: "mSkip", rowId: 3, label: "blocked", skippable: true },
        // The member after the suppressed one. If the savepoint rollback had
        // poisoned the enclosing scope, this INSERT could not run at all.
        {
          id: "m1",
          rowId: 2,
          label: attempt === 1 ? "clash" : "free",
          pinned: true,
        },
      ],
    });

    const result = await executeRoutedOperation<unknown>(
      executorFor(driver),
      series,
      seriesContext()
    );

    // THE CLAIM: the mark on the pinned member's unique violation reached the routed
    // boundary intact even though a member had already been suppressed inside the
    // same scope, so the complete series ran again — capture included.
    expect(events.filter((event) => event.startsWith("capture:"))).toEqual([
      "capture:1",
      "capture:2",
    ]);
    // Every attempt ran all three members in order, and the suppressed one was
    // attempted both times rather than being remembered as "already skipped".
    expect(events.filter((event) => event.startsWith("plan:"))).toEqual([
      "plan:m0",
      "plan:mSkip",
      "plan:m1",
      "plan:m0",
      "plan:mSkip",
      "plan:m1",
    ]);
    expect(events.filter((event) => event.startsWith("sql:INSERT"))).toEqual([
      "sql:INSERT(1,zero)",
      "sql:INSERT(3,blocked)",
      "sql:INSERT(2,clash)",
      "sql:INSERT(1,zero)",
      "sql:INSERT(3,blocked)",
      "sql:INSERT(2,free)",
    ]);
    // The suppressed member contributed nothing to the public result; the members
    // around it did.
    expect(result).toEqual({
      captured: [8, 9],
      members: [[1], [], [2]],
      resultReads: [],
    });
    // Row 3 never landed on either attempt, and the row it conflicted with was
    // neither rewritten nor adopted.
    await expect(ledgerRows()).resolves.toEqual([
      { id: 1, label: "zero" },
      { id: 2, label: "free" },
      { id: 8, label: "blocked" },
      { id: 9, label: "clash" },
    ]);
  }, 60_000);
});

describe("I3 — pre-existing hazard: the retry mark does not survive error wrapping", () => {
  test("a differing scope failure defeats the outer retry (current behaviour, pinned)", async () => {
    const events: string[] = [];
    const driver = new DivergentScopeFailurePGliteDriver(events, {
      client: database,
      namespace,
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

describe("I3 — committed progress is trusted execution state", () => {
  test("mutable public metadata cannot suppress a whole-operation retry", () => {
    const forged = new QueryEngineError("forged", {
      meta: {
        recordSeriesProgress: {
          atomicity: "segment",
          phase: "member",
          committedSegments: 1,
          completedMembers: 1,
          committedWriteMembers: 1,
        },
      },
    });
    expect(hasCommittedRecordSeriesProgress(forged)).toBe(false);

    const trusted = attachRecordSeriesProgress(forged, {
      atomicity: "segment",
      phase: "member",
      committedSegments: 1,
      completedMembers: 1,
      committedWriteMembers: 1,
    });
    expect(hasCommittedRecordSeriesProgress(trusted)).toBe(true);
  });

  test("re-attachment cannot make public and trusted progress disagree", () => {
    const failure = attachRecordSeriesProgress(
      new QueryEngineError("stopped"),
      {
        atomicity: "segment",
        phase: "member",
        committedSegments: 1,
        completedMembers: 1,
        committedWriteMembers: 1,
      }
    );
    const reattached = attachRecordSeriesProgress(failure, {
      atomicity: "segment",
      phase: "result",
      committedSegments: 2,
      completedMembers: 2,
      committedWriteMembers: 2,
    });

    expect(reattached.meta.recordSeriesProgress).toMatchObject({
      phase: "member",
      committedSegments: 1,
    });
    expect(reattached.toJSON()).toMatchObject({
      meta: {
        recordSeriesProgress: {
          phase: "member",
          committedSegments: 1,
        },
      },
    });
  });
});
