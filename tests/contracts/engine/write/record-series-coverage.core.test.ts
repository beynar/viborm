import {
  QueryEngineError,
  TransactionError,
  UnsupportedOperationError,
} from "@errors";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { validateClientSchemaOrThrow } from "@schema/validation/validator";
import { sql } from "@sql";
import { createQueryScope } from "@src/query-engine/context/query-scope";
import { CreateManyRecordSeries } from "@src/query-engine/write-engine/CreateManyRecordSeries";
import {
  crossedReferenceContinuationGuards,
  generatedOutputSegments,
  statementStepsById,
} from "@src/query-engine/write-engine/generated-output-boundary";
import { routeJunctionCreateManyRow } from "@src/query-engine/write-engine/junction-create-many-routing";
import {
  type OperationFragment,
  ref,
  type WriteStep,
} from "@src/query-engine/write-engine/OperationFragment";
import {
  isRecordSeries,
  isSkippableCreateMemberResult,
} from "@src/query-engine/write-engine/record-series";
import { StepScope } from "@src/query-engine/write-engine/StepScope";
import {
  buildSeriesResultReads,
  parseSeriesResultReads,
  type SeriesResultReadInput,
} from "@src/query-engine/write-engine/series-result-read";
import { UpdateManyRecordSeries } from "@src/query-engine/write-engine/UpdateManyRecordSeries";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const schema = (() => {
  const category = s
    .model({
      id: s.int().id(),
      name: s.string().unique(),
      articles: s.toMany(() => article),
      generatedArticles: s.toMany(() => generatedArticle),
    })
    .map("series_coverage_categories");
  const article = s
    .model({
      id: s.int().id(),
      title: s.string(),
      categoryId: s.int().nullable(),
      category: s
        .toOne(() => category)
        .fields("categoryId")
        .references("id"),
    })
    .map("series_coverage_articles");
  const generatedArticle = s
    .model({
      id: s.int().id().increment(),
      slug: s.string().unique(),
      title: s.string(),
      categoryId: s.int().nullable(),
      category: s
        .toOne(() => category)
        .fields("categoryId")
        .references("id"),
    })
    .map("series_coverage_generated_articles");
  return { category, article, generatedArticle };
})();

hydrateSchemaNames(schema);
validateClientSchemaOrThrow(schema);

class SeriesPlanningDriver extends PlanningDriver {
  constructor() {
    super("postgresql", { maxBindParametersPerStatement: 100 });
  }
}

function engine(): QueryEngine {
  return new QueryEngine(
    new SeriesPlanningDriver(),
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
}

function parsedRows(
  queryEngine: QueryEngine,
  model: Model<any>,
  rows: readonly Record<string, unknown>[]
): Record<string, unknown>[] {
  const series = new CreateManyRecordSeries(queryEngine, model, { data: rows });
  const parsed = series.validatedArgs.data;
  if (!Array.isArray(parsed)) {
    throw new Error("createMany did not expose its validated record rows");
  }
  return parsed.map((row) => {
    if (!isRecord(row)) {
      throw new Error("createMany did not expose its validated record rows");
    }
    return row;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("root record-series coverage", () => {
  test("createMany constructs ordinary members in source order and counts their row keys", () => {
    const queryEngine = engine();
    const series = new CreateManyRecordSeries(queryEngine, schema.article, {
      data: [
        { id: 2, title: "second", categoryId: 9 },
        {
          id: 1,
          title: "first",
          category: { connect: { id: 9 } },
        },
      ],
    });

    expect(series.capture()).toEqual({ steps: [] });
    const members = series.compileMembers();
    expect(members).toHaveLength(2);
    expect(members.map((member) => member.mode)).toEqual([
      "transaction",
      "transaction",
    ]);
    expect(members[0]?.planning().steps).toHaveLength(0);
    expect(members[1]?.planning().steps.map((step) => step.id)).toEqual([
      "category.find",
    ]);
    expect(
      series.parseSeries({
        captured: {},
        memberResults: [{ id: 2 }, { id: 1 }],
        resultReadResults: [],
      })
    ).toEqual({ count: 2 });
  });

  test("createMany returning reads run after members and restore member order", () => {
    const series = new CreateManyRecordSeries(engine(), schema.article, {
      data: [
        { id: 2, title: "second", categoryId: 9 },
        {
          id: 1,
          title: "first",
          category: { connect: { id: 9 } },
        },
      ],
      select: { title: true },
    });
    const reads = series.compileResultReads({}, [{ id: 2 }, { id: 1 }]);

    expect(reads).toHaveLength(1);
    expect(reads[0]?.planning()).toEqual({ steps: [] });
    const readFragment = reads[0]?.compile({});
    expect(readFragment?.steps.map((step) => step.id)).toEqual([
      "article.createManySeries.read",
    ]);
    const decoded = reads[0]?.parse({
      result: [
        { id: 1, title: "first" },
        { id: 2, title: "second" },
      ],
    });
    expect(
      series.parseSeries({
        captured: {},
        memberResults: [{ id: 2 }, { id: 1 }],
        resultReadResults: [decoded],
      })
    ).toEqual([{ title: "second" }, { title: "first" }]);
  });

  test("skipDuplicates counts only exact inserted outcomes and omits skipped reads", () => {
    const series = new CreateManyRecordSeries(engine(), schema.article, {
      data: [
        { id: 1, title: "kept", categoryId: 9 },
        { id: 2, title: "duplicate", categoryId: 9 },
      ],
      skipDuplicates: true,
      select: { title: true },
    });
    const outcomes = [
      { kind: "inserted", value: { id: 1 } },
      { kind: "skipped" },
    ];

    expect(isSkippableCreateMemberResult(outcomes[0])).toBe(true);
    expect(isSkippableCreateMemberResult(outcomes[1])).toBe(true);
    expect(series.compileResultReads({}, outcomes)).toHaveLength(1);
    expect(
      series.parseSeries({
        captured: {},
        memberResults: outcomes,
        resultReadResults: [[{ title: "kept" }]],
      })
    ).toEqual([{ title: "kept" }]);
  });

  test("updateMany captures once, sorts complete row keys, and reports the captured count", () => {
    const series = new UpdateManyRecordSeries(engine(), schema.article, {
      where: { title: { contains: "draft" } },
      data: { category: { connect: { id: 9 } } },
    });
    const capture = series.capture().steps[0];
    if (!capture) throw new Error("expected updateMany capture");
    const captured = {
      [`${capture.id}.rows`]: [{ id: 3 }, { id: 1 }, { id: 2 }],
    };
    const members = series.compileMembers(captured);

    expect(capture.kind).toBe("read");
    expect(members).toHaveLength(3);
    expect(
      members.map((member) => {
        // A `PlanningFragment` is statement-only by type (`OperationFragment.ts`
        // states it, and every `planning()` producer is typed
        // `readonly StatementStep[]`), so "not a guard, not a nested series" is
        // already proven. The refusal that can still fire is the locate itself:
        // an update member publishes its row through a leading READ.
        const locate = member.planning().steps[0];
        if (!locate || locate.kind !== "read") {
          throw new Error("expected an ordinary selected-record locate");
        }
        return locate.statement.values[0];
      })
    ).toEqual([1, 2, 3]);
    expect(
      series.parseSeries({
        captured,
        memberResults: [{ id: 1 }, { id: 2 }, { id: 3 }],
        resultReadResults: [],
      })
    ).toEqual({ count: 3 });
    expect(series.compileMembers({ [`${capture.id}.rows`]: [] })).toEqual([]);
  });

  test("updateMany returning reads use member final keys, not capture order", () => {
    const series = new UpdateManyRecordSeries(engine(), schema.article, {
      data: { category: { connect: { id: 9 } } },
      select: { title: true },
    });
    const reads = series.compileResultReads({}, [{ id: 8 }, { id: 4 }]);
    const decoded = reads[0]?.parse({
      result: [
        { id: 4, title: "four" },
        { id: 8, title: "eight" },
      ],
    });

    expect(reads).toHaveLength(1);
    expect(
      series.parseSeries({
        captured: {},
        memberResults: [{ id: 8 }, { id: 4 }],
        resultReadResults: [decoded],
      })
    ).toEqual([{ title: "eight" }, { title: "four" }]);
  });
});

describe("junction createMany row routing coverage", () => {
  test("a generated key with one spelled unique adopts the existing target", () => {
    const queryEngine = engine();
    const source = { slug: "stable", title: "kept" };
    const [parsed] = parsedRows(queryEngine, schema.generatedArticle, [source]);
    if (!parsed) throw new Error("expected one validated row");

    expect(
      routeJunctionCreateManyRow(
        createQueryScope(queryEngine, schema.generatedArticle),
        ["id"],
        { parsed, source },
        true
      )
    ).toMatchObject({
      kind: "adopt",
      where: { slug: "stable" },
      relationBearing: false,
    });
  });

  test("relation work takes the series route and records whether dropping skip helps", () => {
    const queryEngine = engine();
    const source = {
      slug: "fresh",
      title: "related",
      category: { connect: { id: 9 } },
    };
    const [parsed] = parsedRows(queryEngine, schema.generatedArticle, [source]);
    if (!parsed) throw new Error("expected one validated row");

    expect(
      routeJunctionCreateManyRow(
        createQueryScope(queryEngine, schema.generatedArticle),
        ["id"],
        { parsed, source },
        false
      )
    ).toMatchObject({
      kind: "series",
      withSkip: false,
      droppingFlagHelps: false,
    });
  });

  test("a caller-supplied row key remains a leaf and retains skip probing", () => {
    const queryEngine = engine();
    const source = { id: 5, title: "leaf" };
    const [parsed] = parsedRows(queryEngine, schema.article, [source]);
    if (!parsed) throw new Error("expected one validated row");

    expect(
      routeJunctionCreateManyRow(
        createQueryScope(queryEngine, schema.article),
        ["id"],
        { parsed, source },
        true
      )
    ).toMatchObject({
      kind: "leaf",
      withSkip: true,
      joinWhenTargetExists: false,
    });
  });
});

function resultReadInput(
  expectedRowKeys: readonly Readonly<Record<string, unknown>>[]
): SeriesResultReadInput {
  return {
    engine: engine(),
    model: schema.article,
    args: { select: { title: true } },
    select: { title: true },
    expectedRowKeys,
    operation: "updateManyAndReturn",
    scope: new StepScope(),
    stepLabel: "article.coverage.read",
    missingRowMessage: "the series row disappeared",
  };
}

describe("series result failure coverage", () => {
  test("public aggregation rejects a lost group, an invalid row, and excess rows", () => {
    const input = resultReadInput([{ id: 1 }]);

    expect(() => parseSeriesResultReads(input, [undefined])).toThrow(
      "query-engine-v2 record series lost a grouped final read."
    );
    expect(() => parseSeriesResultReads(input, [[null]])).toThrow(
      "query-engine-v2 record series final read did not decode to a row."
    );
    expect(() =>
      parseSeriesResultReads(input, [[{ title: "one" }, { title: "extra" }]])
    ).toThrow(
      "query-engine-v2 record series final reads returned inconsistent row counts."
    );
  });

  test("an ordinary result-read operation rejects a missing provider row with operation metadata", () => {
    const input = resultReadInput([{ id: 1 }]);
    const [read] = buildSeriesResultReads(input);
    if (!read) throw new Error("expected one result read");

    expect(() => read.parse({ result: [] })).toThrowError(TransactionError);
    expect(() => read.parse({ result: "not rows" })).toThrowError(
      QueryEngineError
    );
  });
});

function write(
  id: string,
  outputs: WriteStep["outputs"],
  statement = sql`INSERT INTO records DEFAULT VALUES`
): WriteStep {
  return { id, kind: "write", statement, outputs };
}

describe("generated output series coverage", () => {
  test("an indirect provider value still requires the original continuation premise", () => {
    const producer = write("producer", {
      id: { kind: "firstRowField", field: "id" },
    });
    const forwarder = write(
      "forwarder",
      {
        id: {
          kind: "consumedValue",
          source: { kind: "reference", reference: ref("producer", "id") },
        },
      },
      sql`UPDATE carrier SET id = ${ref("producer", "id")}`
    );
    const consumer = write(
      "consumer",
      {},
      sql`INSERT INTO child (id) VALUES (${ref("forwarder", "id")})`
    );
    const fragment: OperationFragment = {
      steps: [producer, forwarder, consumer],
      outputs: {},
    };

    expect(() =>
      crossedReferenceContinuationGuards(
        [consumer],
        new Set(["producer", "forwarder"]),
        statementStepsById(fragment)
      )
    ).toThrowError(UnsupportedOperationError);
  });

  test("a record-series step declines generated-output segmentation", () => {
    const fragment: OperationFragment = {
      steps: [
        {
          id: "nested.series",
          kind: "recordSeries",
          progressive: { kind: "unsupported", reason: "transactional" },
          series: {
            executionKind: "recordSeries",
            capture: () => ({ steps: [] }),
            compileMembers: () => [],
            compileResultReads: () => [],
            parseSeries: () => undefined,
          },
        },
      ],
      outputs: {},
    };

    expect(generatedOutputSegments(fragment, false)).toBeUndefined();
    const [step] = fragment.steps;
    if (!step || step.kind !== "recordSeries") {
      throw new Error("expected the record-series step");
    }
    expect(isRecordSeries(step.series)).toBe(true);
  });
});

describe("coverage low value", () => {
  test("record-series discriminants reject malformed lookalikes", () => {
    expect(isSkippableCreateMemberResult(null)).toBe(false);
    expect(isSkippableCreateMemberResult({})).toBe(false);
    expect(isSkippableCreateMemberResult({ kind: "inserted" })).toBe(false);
    expect(
      isSkippableCreateMemberResult({
        kind: "inserted",
        value: { id: 1 },
        extra: true,
      })
    ).toBe(false);
    expect(
      isSkippableCreateMemberResult({ kind: "skipped", extra: true })
    ).toBe(false);
  });

  test("series shells fail closed when executor publications lose their record shape", () => {
    const createSeries = new CreateManyRecordSeries(engine(), schema.article, {
      data: [{ id: 1, title: "one", categoryId: 9 }],
    });
    expect(() =>
      createSeries.parseSeries({
        captured: {},
        memberResults: [1],
        resultReadResults: [],
      })
    ).toThrow(
      "query-engine-v2 createMany with relation data lost a row's final row key."
    );

    const updateSeries = new UpdateManyRecordSeries(engine(), schema.article, {
      data: { category: { connect: { id: 9 } } },
      select: { id: true },
    });
    expect(() => updateSeries.compileResultReads({}, [1])).toThrow(
      "query-engine-v2 updateMany with relation data lost a captured root's row key."
    );
    expect(() => updateSeries.compileMembers({})).toThrow(
      "query-engine-v2 updateMany with relation data did not expose its captured root rows."
    );
  });
});
