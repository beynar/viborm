import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { Driver } from "@drivers/driver";
import {
  hasCommittedRecordSeriesProgress,
  QueryEngineError,
  UniqueConstraintError,
  VibORMError,
} from "@errors";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { sql } from "@sql";
import type { CommittedBatchNotification } from "@src/drivers/types";
import {
  type ExecutableOperation,
  OperationExecutor,
} from "@src/query-engine/write-engine/OperationExecutor";
import type {
  GuardStep,
  OperationFragment,
  PlanningFragment,
  StatementStep,
  TargetConstraintPin,
} from "@src/query-engine/write-engine/OperationFragment";
import { ref } from "@src/query-engine/write-engine/OperationFragment";
import type { RecordSeriesOperation } from "@src/query-engine/write-engine/record-series";
import { executeRoutedOperation } from "@src/query-engine/write-engine/routing";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const segmentSchema = {
  probe: s.model({ id: s.int().id() }).map("generated_segment_probe"),
};

hydrateSchemaNames(segmentSchema);

type BatchResponder = (
  queries: readonly BatchQuery[],
  call: number,
  committed: CommittedBatchNotification | undefined
) => Promise<QueryResult<unknown>[]>;

class GeneratedSegmentDriver extends Driver<null, null> {
  readonly adapter = new PostgresAdapter();
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  readonly batches: BatchQuery[][] = [];
  private readonly respond: BatchResponder;

  constructor(respond: BatchResponder) {
    super("postgresql", "generated-segment-probe");
    this.respond = respond;
  }

  protected initClient(): Promise<null> {
    return Promise.resolve(null);
  }

  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }

  protected execute<T>(): Promise<QueryResult<T>> {
    return Promise.resolve({ rows: [], rowCount: 1 });
  }

  protected executeRaw<T>(): Promise<QueryResult<T>> {
    return this.execute<T>();
  }

  protected transaction<T>(
    _client: null,
    execute: (transaction: null) => Promise<T>
  ): Promise<T> {
    return execute(null);
  }

  protected override executeBatch<T>(
    _client: null,
    queries: BatchQuery[],
    _context?: QueryExecutionContext,
    committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    this.batches.push(queries.map((query) => ({ ...query })));
    return this.respond(queries, this.batches.length, committed) as Promise<
      QueryResult<T>[]
    >;
  }
}

class OrderedGeneratedSegmentDriver extends GeneratedSegmentDriver {
  override readonly supportsOrderedCommittedSegments = true;

  protected override async executeBatch<T>(
    client: null,
    queries: BatchQuery[],
    context?: QueryExecutionContext,
    committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    const results = await super.executeBatch<T>(client, queries, context);
    await committed?.();
    return results;
  }
}

class GeneratedSegmentReachedParse extends Error {}

const RACE_PIN: TargetConstraintPin = {
  fields: ["slug"],
  table: "generated_segment_probe",
  columns: ["slug"],
  constraints: ["generated_segment_probe_slug_key"],
};

function continuation(
  publisher: string,
  output = "id",
  marker = `${publisher}-guard`
): GuardStep {
  return {
    id: `${publisher}.continuation`,
    kind: "guard",
    premise: {
      kind: "exists",
      statement: sql`SELECT ${marker} WHERE ${ref(publisher, output)} IS NOT NULL`,
    },
    failure: {
      kind: "query",
      message: `${publisher} changed`,
      raceable: false,
    },
  };
}

function providerWrite(
  id: string,
  statement: StatementStep["statement"],
  racePin?: TargetConstraintPin
): StatementStep {
  return {
    id,
    kind: "write",
    statement,
    outputs: { id: { kind: "firstRowField", field: "id" } },
    progressiveContinuation: continuation(id),
    ...(racePin ? { racePin } : {}),
  };
}

function operation(
  fragment: OperationFragment,
  onParse?: (outputs: Readonly<Record<string, unknown>>) => void
): ExecutableOperation {
  return {
    mode: "batch",
    planning: (): PlanningFragment => ({ steps: [] }),
    compile: () => fragment,
    parse: <T>(outputs: Readonly<Record<string, unknown>>): T => {
      onParse?.(outputs);
      throw new GeneratedSegmentReachedParse(String(outputs.result));
    },
  };
}

function executorFor(driver: GeneratedSegmentDriver): OperationExecutor {
  const registry = createSchemaRegistry(segmentSchema);
  return new OperationExecutor(
    new QueryEngine(driver, createModelRegistry(segmentSchema, registry))
  );
}

function twoSegmentOperation(options?: {
  readonly producerRacePin?: TargetConstraintPin;
  readonly consumerRacePin?: TargetConstraintPin;
  readonly onParse?: (outputs: Readonly<Record<string, unknown>>) => void;
}): ExecutableOperation {
  const producer = providerWrite(
    "producer",
    sql`INSERT INTO generated_segment_probe DEFAULT VALUES RETURNING id`,
    options?.producerRacePin
  );
  const consumer = {
    id: "consumer",
    kind: "write" as const,
    statement: sql`INSERT INTO generated_segment_child (parent_id) VALUES (${ref("producer", "id")})`,
    outputs: { count: { kind: "rowCount" as const } },
    ...(options?.consumerRacePin ? { racePin: options.consumerRacePin } : {}),
  };
  return operation(
    {
      steps: [producer, consumer],
      outputs: { result: ref("consumer", "count") },
    },
    options?.onParse
  );
}

function threeSegmentOperation(): ExecutableOperation {
  const producer = providerWrite(
    "producer",
    sql`INSERT INTO generated_segment_probe DEFAULT VALUES RETURNING id`
  );
  const forwarder = providerWrite(
    "forwarder",
    sql`INSERT INTO generated_segment_child (parent_id) VALUES (${ref("producer", "id")}) RETURNING id`
  );
  const consumer = {
    id: "consumer",
    kind: "write" as const,
    statement: sql`INSERT INTO generated_segment_leaf (parent_id) VALUES (${ref("forwarder", "id")})`,
    outputs: { count: { kind: "rowCount" as const } },
  };
  return operation({
    steps: [producer, forwarder, consumer],
    outputs: { result: ref("consumer", "count") },
  });
}

const EMPTY_SERIES: RecordSeriesOperation = {
  executionKind: "recordSeries",
  capture: () => ({ steps: [] }),
  compileMembers: () => [],
  compileResultReads: () => [],
  parseSeries: () => [],
};

function crossSeriesOperation(
  withPostcondition = false,
  onParse?: (outputs: Readonly<Record<string, unknown>>) => void
): ExecutableOperation {
  const producer = providerWrite(
    "producer",
    sql`INSERT INTO generated_segment_probe DEFAULT VALUES RETURNING id`
  );
  const consumer: StatementStep = {
    id: "consumer",
    kind: "write",
    statement: sql`INSERT INTO generated_segment_child (parent_id) VALUES (${ref("producer", "id")})`,
    outputs: { count: { kind: "rowCount" } },
    ...(withPostcondition
      ? {
          expects: {
            kind: "affectedRows" as const,
            expected: 1,
            failure: {
              kind: "query" as const,
              message: "consumer missed",
              raceable: false,
            },
          },
        }
      : {}),
  };
  return operation(
    {
      steps: [
        producer,
        {
          id: "series",
          kind: "recordSeries",
          series: EMPTY_SERIES,
          progressive: {
            kind: "guarded",
            guard: {
              id: "series.parent",
              kind: "guard",
              premise: {
                kind: "exists",
                statement: sql`SELECT ${"series-guard"}`,
              },
              failure: {
                kind: "query",
                message: "series parent changed",
                raceable: false,
              },
            },
          },
        },
        consumer,
      ],
      outputs: { result: ref("consumer", "count") },
    },
    onParse
  );
}

function successfulResult(
  queries: readonly BatchQuery[],
  id: number
): QueryResult<unknown>[] {
  return queries.map((query, index) => ({
    rows:
      index === queries.length - 1 && query.sql.includes("RETURNING")
        ? [{ id }]
        : [],
    rowCount: 1,
  }));
}

describe("generated-output segment execution", () => {
  test("a weak malformed result marks the dispatched segment ambiguous and stops before the next segment", async () => {
    const driver = new GeneratedSegmentDriver((queries, call) => {
      if (call === 1) return Promise.resolve(successfulResult(queries, 11));
      return Promise.resolve([]);
    });
    let committed = 0;
    let mayBeVisible = 0;

    const failure = await executorFor(driver)
      .execute(
        threeSegmentOperation(),
        createOperationExecutionContext("probe", "create"),
        undefined,
        async () => {
          committed += 1;
        },
        async () => {
          mayBeVisible += 1;
        }
      )
      .catch((error) => error);

    expect(driver.batches).toHaveLength(2);
    expect(committed).toBe(1);
    expect(mayBeVisible).toBe(1);
    expect(hasCommittedRecordSeriesProgress(failure)).toBe(true);
    expect(failure).toMatchObject({
      meta: {
        recordSeriesProgress: {
          phase: "member",
          committedSegments: 1,
          mayHaveCommittedSegment: true,
        },
      },
    });
  });

  test("an ambiguous-result invalidation failure keeps the may-commit fact and its own phase", async () => {
    const driver = new GeneratedSegmentDriver((queries, call) => {
      if (call === 1) return Promise.resolve(successfulResult(queries, 12));
      return Promise.resolve([]);
    });
    let invalidations = 0;

    const failure = await executorFor(driver)
      .execute(
        threeSegmentOperation(),
        createOperationExecutionContext("probe", "create"),
        undefined,
        undefined,
        async () => {
          invalidations += 1;
          throw new Error("ambiguous invalidation failed");
        }
      )
      .catch((error) => error);

    expect(driver.batches).toHaveLength(2);
    expect(invalidations).toBe(1);
    expect(failure).toMatchObject({
      meta: {
        recordSeriesProgress: {
          phase: "invalidation",
          committedSegments: 1,
          mayHaveCommittedSegment: true,
        },
      },
    });
  });

  test("a normalized success followed by invalidation failure is definite and invalidates once", async () => {
    const driver = new GeneratedSegmentDriver((queries) =>
      Promise.resolve(successfulResult(queries, 21))
    );
    let invalidations = 0;
    let mayBeVisible = 0;

    const failure = await executorFor(driver)
      .execute(
        twoSegmentOperation(),
        createOperationExecutionContext("probe", "create"),
        undefined,
        async () => {
          invalidations += 1;
          throw new Error("invalidation failed");
        },
        async () => {
          mayBeVisible += 1;
        }
      )
      .catch((error) => error);

    expect(driver.batches).toHaveLength(1);
    expect(invalidations).toBe(1);
    expect(mayBeVisible).toBe(0);
    expect(failure).toMatchObject({
      meta: {
        recordSeriesProgress: {
          phase: "invalidation",
          committedSegments: 1,
        },
      },
    });
    if (!(failure instanceof VibORMError)) throw failure;
    expect(failure.meta.recordSeriesProgress).not.toHaveProperty(
      "mayHaveCommittedSegment"
    );
  });

  test("a race pin in the first effectful segment retries the whole operation once", async () => {
    const driver = new GeneratedSegmentDriver((queries, call) => {
      if (call === 1) {
        return Promise.reject(
          new UniqueConstraintError("lost create race", {
            meta: {
              table: RACE_PIN.table,
              columns: [...RACE_PIN.columns],
              constraint: RACE_PIN.constraints[0],
            },
          })
        );
      }
      return Promise.resolve(successfulResult(queries, 31));
    });

    let parsedResult: unknown;
    const failure = await executeRoutedOperation(
      executorFor(driver),
      twoSegmentOperation({
        producerRacePin: RACE_PIN,
        onParse: (outputs) => {
          parsedResult = outputs.result;
        },
      }),
      createOperationExecutionContext("probe", "create")
    ).catch((error) => error);

    expect(parsedResult).toBe(1);
    expect(failure).toMatchObject({
      meta: { recordSeriesProgress: { phase: "result", committedSegments: 2 } },
    });
    expect(driver.batches).toHaveLength(3);
  });

  test("a race loser after a committed producer is not retried", async () => {
    let mayBeVisible = 0;
    const driver = new GeneratedSegmentDriver((queries, call) => {
      if (call === 1) return Promise.resolve(successfulResult(queries, 41));
      return Promise.reject(
        new UniqueConstraintError("lost create race", {
          meta: {
            table: RACE_PIN.table,
            columns: [...RACE_PIN.columns],
            constraint: RACE_PIN.constraints[0],
          },
        })
      );
    });

    const failure = await executeRoutedOperation(
      executorFor(driver),
      twoSegmentOperation({ consumerRacePin: RACE_PIN }),
      createOperationExecutionContext("probe", "create"),
      undefined,
      undefined,
      async () => {
        mayBeVisible += 1;
      }
    ).catch((error) => error);

    expect(failure).toBeInstanceOf(UniqueConstraintError);
    expect(failure).toMatchObject({
      meta: {
        recordSeriesProgress: {
          phase: "member",
          committedSegments: 1,
          committedWriteMembers: 1,
        },
      },
    });
    if (!(failure instanceof VibORMError)) throw failure;
    expect(failure.meta.recordSeriesProgress).not.toHaveProperty(
      "mayHaveCommittedSegment"
    );
    expect(mayBeVisible).toBe(0);
    expect(driver.batches).toHaveLength(2);
  });

  test("an uncontended later race-pinned arm executes", async () => {
    const driver = new GeneratedSegmentDriver((queries) =>
      Promise.resolve(successfulResult(queries, 42))
    );
    let parsedResult: unknown;

    const failure = await executeRoutedOperation(
      executorFor(driver),
      twoSegmentOperation({
        consumerRacePin: RACE_PIN,
        onParse: (outputs) => {
          parsedResult = outputs.result;
        },
      }),
      createOperationExecutionContext("probe", "create")
    ).catch((error) => error);

    expect(parsedResult).toBe(1);
    expect(driver.maxBindParametersPerStatement).toBeUndefined();
    expect(failure).toMatchObject({
      meta: {
        recordSeriesProgress: {
          phase: "result",
          committedSegments: 2,
        },
      },
    });
    expect(driver.batches).toHaveLength(2);
  });

  test("a forwarded publisher hands continuation ownership to its direct consumer", async () => {
    let changedProducer = false;
    const driver = new GeneratedSegmentDriver((queries, call) => {
      const markers = queries.flatMap((query) => query.params ?? []);
      if (call === 3 && markers.includes("producer-guard")) {
        return Promise.reject(new Error("stale producer guard replayed"));
      }
      if (call === 3) expect(markers).toContain("forwarder-guard");
      const result = successfulResult(queries, call * 10);
      if (call === 2) changedProducer = true;
      return Promise.resolve(result);
    });
    const producer = providerWrite(
      "producer",
      sql`INSERT INTO generated_segment_probe DEFAULT VALUES RETURNING id`
    );
    const forwarder: StatementStep = {
      id: "forwarder",
      kind: "write",
      statement: sql`INSERT INTO generated_segment_child (parent_id) VALUES (${ref("producer", "id")})`,
      outputs: {
        forwarded: {
          kind: "consumedValue",
          source: { kind: "reference", reference: ref("producer", "id") },
        },
      },
      progressiveContinuation: continuation("forwarder", "forwarded"),
    };
    const consumer: StatementStep = {
      id: "consumer",
      kind: "write",
      statement: sql`INSERT INTO generated_segment_leaf (parent_id) VALUES (${ref("forwarder", "forwarded")})`,
      outputs: { count: { kind: "rowCount" } },
    };

    let parsedResult: unknown;
    const failure = await executorFor(driver)
      .execute(
        operation(
          {
            steps: [producer, forwarder, consumer],
            outputs: { result: ref("consumer", "count") },
          },
          (outputs) => {
            parsedResult = outputs.result;
          }
        ),
        createOperationExecutionContext("probe", "create")
      )
      .catch((error) => error);

    expect(changedProducer).toBe(true);
    expect(parsedResult).toBe(1);
    expect(failure).toMatchObject({
      meta: { recordSeriesProgress: { phase: "result", committedSegments: 3 } },
    });
    expect(driver.batches).toHaveLength(3);
  });

  test("a provider output keeps its continuation across a nested record series", async () => {
    const driver = new OrderedGeneratedSegmentDriver((queries, call) =>
      Promise.resolve(successfulResult(queries, call * 10))
    );
    let parsedResult: unknown;

    const failure = await executorFor(driver)
      .execute(
        crossSeriesOperation(false, (outputs) => {
          parsedResult = outputs.result;
        }),
        createOperationExecutionContext("probe", "create")
      )
      .catch((error) => error);

    expect(parsedResult).toBe(1);
    expect(failure).toMatchObject({
      meta: { recordSeriesProgress: { phase: "result", committedSegments: 2 } },
    });
    expect(driver.batches).toHaveLength(2);
    expect(driver.batches[1]?.flatMap((query) => query.params ?? [])).toEqual(
      expect.arrayContaining(["series-guard", "producer-guard", 10])
    );
  });

  test("a cross-series consumer postcondition refuses before the producer commits", async () => {
    const driver = new OrderedGeneratedSegmentDriver((queries, call) =>
      Promise.resolve(successfulResult(queries, call * 10))
    );

    const failure = await executorFor(driver)
      .execute(
        crossSeriesOperation(true),
        createOperationExecutionContext("probe", "create")
      )
      .catch((error) => error);

    if (!(failure instanceof QueryEngineError)) throw failure;
    expect(failure.message).toBe(
      "Step 'consumer' carries a postcondition that cannot be checked after a committed generated-output segment."
    );
    expect(driver.batches).toEqual([]);
  });
});
