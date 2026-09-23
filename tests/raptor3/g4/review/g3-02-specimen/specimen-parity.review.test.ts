/**
 * G3-02 specimen INDEPENDENT REVIEW probes — "re-express the malformed-batch
 * specimen under D-7".
 *
 * The unit rewrote `tests/raptor3/g3/author-execution-regressions.test.ts`
 * cell 1 into two halves inside one `it`: half A (the specimen's own two-row
 * relation-free `record.createMany({select})`, now a LONE statement after D-7)
 * asserting the shipped malformed-scalar refusal with meta exactly
 * `{driver, operation, scalarType}` and NO `recordSeriesProgress`; half B (a
 * `parent.createMany` whose one member carries a nested `leftChildren.createMany`)
 * keeping the "acknowledged atomic batch -> truthful progress" property with
 * `recordSeriesProgress { committedSegments: 1, committedWriteMembers: 2,
 * completedMembers: 2 }`.
 *
 * These probes are the measurements the author did NOT make:
 *
 *  - R1 — half A's EXACT request through the public client on the SHIPPED
 *    engine, same cut, same driver: is the sentence the cell now pins really
 *    the shipped answer (identity, meta and committed rows)?
 *  - R2 — half B's EXACT request on the SHIPPED engine: the author records the
 *    member counts as measured-on-the-candidate-only and explicitly does NOT
 *    claim shipped parity. Measure it.
 *  - R3 — half A's request on a TRANSACTION-CAPABLE driver (the cut's "any
 *    transport" claim), candidate vs shipped.
 *  - R4 — WHERE half B's cut fires: the write window must be acknowledged
 *    (committed) and the malformed row must arrive in a LATER window, or
 *    `committedSegments: 1` is not the acknowledged-batch property at all.
 *    Also measures whether `arm()` leaves stale `batches` entries behind.
 *  - R5 — the neighbour: the same relation-free `createMany` WITHOUT `select`
 *    under the same cut. Nothing row-bearing is answered, so the cut must not
 *    fire and the write must succeed — the cut is stated over rows, not verbs.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { VibORMError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { isRecord } from "@validation/value-guards";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const PARENT_INSERT = /^INSERT INTO "g3_author_execution_parents"/;

/** The specimen's schema, copied verbatim from the unit's file. */
function executionSchema() {
  const record = s
    .model({ id: s.int().id(), code: s.string().unique() })
    .map("g3_author_execution_records");
  const parent = s
    .model({
      id: s.int().id().increment(),
      label: s.string(),
      leftChildren: s.toMany(() => leftChild),
      rightChildren: s.toMany(() => rightChild),
    })
    .map("g3_author_execution_parents");
  const leftChild = s
    .model({
      id: s.int().id(),
      label: s.string(),
      parentId: s.int(),
      parent: s.toOne(() => parent).fields("parentId").references("id"),
    })
    .map("g3_author_execution_left_children");
  const rightChild = s
    .model({
      id: s.int().id(),
      label: s.string(),
      parentId: s.int(),
      parent: s.toOne(() => parent).fields("parentId").references("id"),
    })
    .map("g3_author_execution_right_children");
  return { leftChild, parent, record, rightChild };
}

/** The unit's own observed driver, reproduced so both engines meet one cut. */
class ObservedDriver extends SQLite3Driver {
  readonly statements: string[] = [];
  /** The index in `statements` of each response the cut corrupted. */
  readonly corruptedAt: number[] = [];
  corrupted = false;
  private armed = false;

  arm(): void {
    this.statements.length = 0;
    this.corruptedAt.length = 0;
    this.corrupted = false;
    this.armed = true;
  }

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const index = this.statements.push(statement) - 1;
    const response = await super.execute<T>(client, statement, parameters);
    if (!this.armed) return response;
    for (const row of response.rows) {
      if (isRecord(row) && Object.hasOwn(row, "id")) {
        Reflect.set(row, "id", "malformed");
        this.corrupted = true;
        if (!this.corruptedAt.includes(index)) this.corruptedAt.push(index);
      }
    }
    return response;
  }
}

class BatchOnlyDriver extends ObservedDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  override maxBindParametersPerStatement: number | undefined = undefined;
  batchCalls = 0;
  readonly batches: BatchQuery[][] = [];
  /** Batch windows the provider ACKNOWLEDGED (returned results for). */
  readonly acknowledged: string[][] = [];
  /** How many windows were already recorded when the cut was armed. */
  batchesBeforeArm = 0;

  override arm(): void {
    super.arm();
    this.batchesBeforeArm = this.batches.length;
    this.batchCalls = 0;
  }

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batchCalls++;
    this.batches.push(queries);
    const results = await this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
    this.acknowledged.push(queries.map(({ sql }) => sql));
    return results;
  }
}

/** The published failure, less the one field two executions cannot share. */
function identity(failure: unknown): {
  code: string;
  meta: Record<string, unknown>;
  message: string;
  name: string;
} {
  if (!(failure instanceof VibORMError))
    return {
      code: "(not a VibORMError)",
      meta: {},
      message: String(failure),
      name: failure instanceof Error ? failure.name : typeof failure,
    };
  const { correlationId: _ignored, ...meta } = failure.meta as Record<
    string,
    unknown
  >;
  return { code: failure.code, meta, message: failure.message, name: failure.name };
}

type Engine = "candidate" | "shipped";
type Transport = "batch-only" | "interactive";

interface Observation {
  readonly batchCalls: number | undefined;
  readonly batchesBeforeArm: number | undefined;
  readonly childRows: unknown[];
  readonly corrupted: boolean;
  readonly corruptedStatements: string[];
  readonly failure: ReturnType<typeof identity> | undefined;
  readonly parentRows: unknown[];
  readonly recordRows: unknown[];
  readonly statements: string[];
  readonly value: unknown;
  readonly windows: string[][];
}

async function observe(
  engine: Engine,
  transport: Transport,
  model: "record" | "parent",
  request: Record<string, unknown>
): Promise<Observation> {
  const schema = executionSchema();
  const database = new Database(":memory:");
  const driver =
    transport === "batch-only"
      ? new BatchOnlyDriver({ client: database })
      : new ObservedDriver({ client: database });
  const client = createClient({ schema, driver });
  assert.equal((await syncLiveSchema(client)).applied, true);
  const publicClient = client as unknown as Record<
    string,
    Record<string, (args: unknown) => Promise<unknown>>
  >;
  driver.arm();
  let value: unknown;
  let failure: unknown;
  try {
    value = await (engine === "shipped"
      ? publicClient[model]!.createMany!(request)
      : createCommandEngine({ schema, driver }).execute(
          model,
          "createMany",
          request
        ));
  } catch (error) {
    failure = error;
  }
  const read = (sql: string) => database.prepare(sql).all();
  const observation: Observation = {
    batchCalls:
      driver instanceof BatchOnlyDriver ? driver.batchCalls : undefined,
    batchesBeforeArm:
      driver instanceof BatchOnlyDriver ? driver.batchesBeforeArm : undefined,
    childRows: read(
      "SELECT id,label,parentId FROM g3_author_execution_left_children ORDER BY id"
    ),
    corrupted: driver.corrupted,
    corruptedStatements: driver.corruptedAt.map(
      (index) => driver.statements[index]!
    ),
    failure: failure === undefined ? undefined : identity(failure),
    parentRows: read(
      "SELECT id,label FROM g3_author_execution_parents ORDER BY id"
    ),
    recordRows: read(
      "SELECT id,code FROM g3_author_execution_records ORDER BY id"
    ),
    statements: driver.statements,
    value,
    windows:
      driver instanceof BatchOnlyDriver
        ? driver.acknowledged.slice(-(driver.batchCalls || 0))
        : [],
  };
  try {
    return observation;
  } finally {
    await client.$disconnect();
    database.close();
  }
}

const LONE_REQUEST = {
  data: [
    { id: 1, code: "one" },
    { id: 2, code: "two" },
  ],
  select: { id: true },
};

const BATCH_REQUEST = {
  data: [
    {
      label: "batched",
      leftChildren: { createMany: { data: [{ id: 1, label: "left-1" }] } },
    },
  ],
  select: { id: true, label: true },
};

const show = (observation: unknown) => JSON.stringify(observation, undefined, 2);

describe("G3-02 specimen review probes", () => {
  it("R1. half A's sentence is the SHIPPED engine's own answer for the same request", async () => {
    const candidate = await observe(
      "candidate",
      "batch-only",
      "record",
      LONE_REQUEST
    );
    const shipped = await observe(
      "shipped",
      "batch-only",
      "record",
      LONE_REQUEST
    );
    const diagnostic = show({ candidate, shipped });
    // The cell's own assertions, re-measured here.
    assert.equal(candidate.value, undefined, diagnostic);
    assert.equal(candidate.corrupted, true, diagnostic);
    assert.equal(candidate.statements.length, 1, diagnostic);
    assert.equal(candidate.batchCalls, 0, diagnostic);
    assert.deepEqual(
      candidate.failure?.meta,
      { driver: "sqlite3", operation: "createMany", scalarType: "int" },
      diagnostic
    );
    assert.deepEqual(
      candidate.recordRows,
      [
        { id: 1, code: "one" },
        { id: 2, code: "two" },
      ],
      diagnostic
    );
    // The differential the cell claims but never ran.
    assert.deepEqual(candidate.failure, shipped.failure, diagnostic);
    assert.deepEqual(candidate.recordRows, shipped.recordRows, diagnostic);
    assert.equal(candidate.batchCalls, shipped.batchCalls, diagnostic);
  });

  it("R2. half B's progress is measured against the SHIPPED engine for the same request", async () => {
    const candidate = await observe(
      "candidate",
      "batch-only",
      "parent",
      BATCH_REQUEST
    );
    const shipped = await observe(
      "shipped",
      "batch-only",
      "parent",
      BATCH_REQUEST
    );
    const diagnostic = show({ candidate, shipped });
    assert.equal(candidate.value, undefined, diagnostic);
    assert.equal(candidate.batchCalls, 2, diagnostic);
    assert.deepEqual(
      candidate.failure?.meta.recordSeriesProgress,
      {
        atomicity: "segment",
        phase: "result",
        committedSegments: 1,
        committedWriteMembers: 2,
        completedMembers: 2,
      },
      diagnostic
    );
    assert.deepEqual(
      candidate.parentRows,
      [{ id: 1, label: "batched" }],
      diagnostic
    );
    assert.deepEqual(
      candidate.childRows,
      [{ id: 1, label: "left-1", parentId: 1 }],
      diagnostic
    );
    // MEASURED DIVERGENCE (recorded, not asserted as parity — the unit claims
    // none for this shape, and the OLD cell was candidate-only too). For the
    // SAME request under the SAME cut the shipped engine answers a different
    // failure entirely: it batches all seven statements into ONE window, its
    // terminal read is a `LIMIT 1` fragment probe, and the malformed `id` makes
    // its generated-key FRAGMENT fail before any decode — with
    // `committedSegments: 0, mayHaveCommittedSegment: true` at `phase: member`,
    // although the rows ARE durable. So half B pins CANDIDATE behavior, not a
    // shipped sentence; only half A is a parity pin (R1). Pinned here so the
    // day either engine changes, this divergence is visible.
    assert.equal(shipped.batchCalls, 1, diagnostic);
    assert.equal(
      shipped.failure?.message,
      "Fragment output 'parent.create.id' did not resolve to a runtime value.",
      diagnostic
    );
    assert.deepEqual(
      shipped.failure?.meta.recordSeriesProgress,
      {
        atomicity: "segment",
        phase: "member",
        committedSegments: 0,
        committedWriteMembers: 0,
        completedMembers: 0,
        mayHaveCommittedSegment: true,
        memberPath: [0],
        totalMembers: 1,
      },
      diagnostic
    );
    // Both engines leave the same durable state, so the divergence is in what
    // each SAYS about it, not in what each DID.
    assert.deepEqual(candidate.parentRows, shipped.parentRows, diagnostic);
    assert.deepEqual(candidate.childRows, shipped.childRows, diagnostic);
  });

  it("R3. half A's sentence holds on a transaction-capable transport too", async () => {
    const candidate = await observe(
      "candidate",
      "interactive",
      "record",
      LONE_REQUEST
    );
    const shipped = await observe(
      "shipped",
      "interactive",
      "record",
      LONE_REQUEST
    );
    const diagnostic = show({ candidate, shipped });
    assert.equal(candidate.corrupted, true, diagnostic);
    assert.deepEqual(
      candidate.failure?.meta,
      { driver: "sqlite3", operation: "createMany", scalarType: "int" },
      diagnostic
    );
    assert.deepEqual(candidate.failure, shipped.failure, diagnostic);
    assert.deepEqual(candidate.recordRows, shipped.recordRows, diagnostic);
  });

  it("R4. half B's acknowledged write window commits BEFORE the malformed row arrives", async () => {
    const candidate = await observe(
      "candidate",
      "batch-only",
      "parent",
      BATCH_REQUEST
    );
    const diagnostic = show(candidate);
    // The unit's `arm()` clears `batchCalls` but NOT `batches`, so the cell's
    // `batches.find(...)` searches pre-arm traffic too. Measure whether the
    // migration leaves any window behind on this driver.
    assert.equal(candidate.batchesBeforeArm, 0, diagnostic);
    assert.equal(candidate.windows.length, 2, diagnostic);
    const writeWindow = candidate.windows.findIndex((window) =>
      window.some((sql) => PARENT_INSERT.test(sql))
    );
    assert.equal(writeWindow, 0, diagnostic);
    assert(candidate.windows[0]!.length > 1, diagnostic);
    // The property: the window carrying the write was ACKNOWLEDGED and its rows
    // are durable, and the malformed row arrives in a LATER window.
    assert.deepEqual(
      candidate.parentRows,
      [{ id: 1, label: "batched" }],
      diagnostic
    );
    assert.equal(candidate.corruptedStatements.length, 1, diagnostic);
    const corruptedIndex = candidate.statements.indexOf(
      candidate.corruptedStatements[0]!
    );
    const parentInsertIndex = candidate.statements.findIndex((sql) =>
      PARENT_INSERT.test(sql)
    );
    assert(parentInsertIndex >= 0, diagnostic);
    assert(
      corruptedIndex > parentInsertIndex,
      `the cut must fire after the write, not inside it: ${diagnostic}`
    );
    assert(
      /^SELECT\b/.test(candidate.corruptedStatements[0]!),
      `the malformed row arrives on the terminal read: ${diagnostic}`
    );
  });

  it("R6. an `executeBatch`-only cut is ELIMINATED for half A's request (the attempt-2 red, reproduced independently)", async () => {
    // The unit's repair is only necessary if the OLD cut placement really is
    // unreachable now. Reproduce it without touching the unit's file: state the
    // same corruption inside `executeBatch` alone and make half A's request.
    class BatchEntryOnlyCutDriver extends BatchOnlyDriver {
      batchCorrupted = false;

      protected override async executeBatch<T>(
        client: Database.Database,
        queries: BatchQuery[]
      ): Promise<QueryResult<T>[]> {
        const results = await super.executeBatch<T>(client, queries);
        for (const result of results)
          for (const row of result.rows)
            if (isRecord(row) && Object.hasOwn(row, "id")) {
              Reflect.set(row, "id", "malformed");
              this.batchCorrupted = true;
            }
        return results;
      }
    }
    const schema = executionSchema();
    const database = new Database(":memory:");
    const driver = new BatchEntryOnlyCutDriver({ client: database });
    const client = createClient({ schema, driver });
    assert.equal((await syncLiveSchema(client)).applied, true);
    driver.batchCalls = 0;
    driver.batchCorrupted = false;
    let value: unknown;
    let failure: unknown;
    try {
      value = await createCommandEngine({ schema, driver }).execute(
        "record",
        "createMany",
        LONE_REQUEST
      );
    } catch (error) {
      failure = error;
    }
    const rows = database
      .prepare("SELECT id,code FROM g3_author_execution_records ORDER BY id")
      .all();
    const diagnostic = show({
      batchCalls: driver.batchCalls,
      batchCorrupted: driver.batchCorrupted,
      failure: failure === undefined ? undefined : identity(failure),
      rows,
      value,
    });
    try {
      // Exactly the qualification attempt-2 red: no batch, no corruption, and
      // the create SUCCEEDS where the pre-D-7 cell expected a rejection.
      assert.equal(driver.batchCalls, 0, diagnostic);
      assert.equal(driver.batchCorrupted, false, diagnostic);
      assert.equal(failure, undefined, diagnostic);
      assert.deepEqual(value, [{ id: 1 }, { id: 2 }], diagnostic);
      assert.deepEqual(
        rows,
        [
          { id: 1, code: "one" },
          { id: 2, code: "two" },
        ],
        diagnostic
      );
    } finally {
      await client.$disconnect();
      database.close();
    }
  });

  it("R5. the cut is stated over ROWS: the same write without `select` is untouched", async () => {
    const candidate = await observe("candidate", "batch-only", "record", {
      data: [
        { id: 1, code: "one" },
        { id: 2, code: "two" },
      ],
    });
    const diagnostic = show(candidate);
    assert.equal(candidate.corrupted, false, diagnostic);
    assert.equal(candidate.failure, undefined, diagnostic);
    assert.deepEqual(
      candidate.recordRows,
      [
        { id: 1, code: "one" },
        { id: 2, code: "two" },
      ],
      diagnostic
    );
  });
});
