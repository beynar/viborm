import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { validateClientSchemaOrThrow } from "@schema/validation/validator";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import type { ExecutableOperation } from "@src/query-engine/write-engine/OperationExecutor";
import type {
  OperationStep,
  RecordSeriesStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const schema = (() => {
  const folder = s
    .model({
      id: s.int().id(),
      name: s.string(),
      cards: s.toMany(() => card),
    })
    .map("nested_series_coverage_folders");
  const card = s
    .model({
      id: s.int().id(),
      title: s.string(),
      folderId: s.int(),
      folder: s
        .toOne(() => folder)
        .fields("folderId")
        .references("id"),
      tags: s.toMany(() => tag).through("nested_series_coverage_card_tag"),
    })
    .map("nested_series_coverage_cards");
  const tag = s
    .model({
      id: s.int().id(),
      name: s.string(),
      cards: s.toMany(() => card),
    })
    .map("nested_series_coverage_tags");
  return { folder, card, tag };
})();

hydrateSchemaNames(schema);
validateClientSchemaOrThrow(schema);

class TransactionPlanningDriver extends PlanningDriver {
  constructor() {
    super("postgresql", { supportsTransactions: true, supportsBatch: true });
  }
}

class ProgressivePlanningDriver extends PlanningDriver {
  constructor() {
    super("postgresql", { supportsTransactions: false, supportsBatch: true });
  }
}

function engine(driver: PlanningDriver = new TransactionPlanningDriver()) {
  return new QueryEngine(
    driver,
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
}

function planningKnown(
  operation: ExecutableOperation,
  row: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return Object.fromEntries(
    operation
      .planning()
      .steps.flatMap((step) =>
        Object.keys(step.outputs).map((output) => [
          `${step.id}.${output}`,
          output === "rows" ? [row] : row[output],
        ])
      )
  );
}

function recordSeriesStep(steps: readonly OperationStep[]): RecordSeriesStep {
  const step = steps.find((candidate) => candidate.kind === "recordSeries");
  if (!step || step.kind !== "recordSeries") {
    throw new Error("expected a nested record-series placement");
  }
  return step;
}

function freshSeriesStep(queryEngine: QueryEngine): RecordSeriesStep {
  const operation = new CreateOperation(queryEngine, schema.folder, {
    data: {
      id: 10,
      name: "folder",
      cards: {
        createMany: {
          data: [
            {
              id: 2,
              title: "second",
              tags: { connect: [{ id: 9 }] },
            },
            {
              id: 1,
              title: "first",
              tags: { connect: [{ id: 9 }] },
            },
          ],
        },
      },
    },
    select: { id: true },
  });
  return recordSeriesStep(
    operation.compile(planningKnown(operation, { id: 9 })).steps
  );
}

describe("fresh nested record-series coverage", () => {
  test("relation-bearing createMany rows remain ordinary fresh-record members", () => {
    const step = freshSeriesStep(engine());
    const series = step.series;
    const members = series.compileMembers({});

    expect(step.progressive).toEqual({
      kind: "unsupported",
      reason: "this execution substrate does not use progressive commits",
    });
    expect(series.capture()).toEqual({ steps: [] });
    expect(members).toHaveLength(2);
    expect(members.map((member) => member.mode)).toEqual([
      "transaction",
      "transaction",
    ]);
    expect(
      members.every((member) => {
        const ids = member.planning().steps.map((read) => read.id);
        return ids.length === 1 && ids[0]?.startsWith("tag.find");
      })
    ).toBe(true);

    const fragments = members.map((member) =>
      member.compile(planningKnown(member, { id: 9 }))
    );
    expect(
      fragments.map((fragment) => fragment.steps.map((current) => current.kind))
    ).toEqual([
      ["write", "write"],
      ["write", "write"],
    ]);
    expect(
      fragments.every((fragment) =>
        fragment.steps[0]?.id.startsWith("card.create")
      )
    ).toBe(true);
    expect(
      fragments.map((fragment) =>
        fragment.steps.map((current) => current.id)
      )
    ).toEqual([
      ["card.create", "tag.connect"],
      ["card.create#1", "tag.connect#1"],
    ]);
    expect(members.map((member) => member.parse({}))).toEqual([
      undefined,
      undefined,
    ]);
    expect(series.compileResultReads({}, [undefined, undefined])).toEqual([]);
    expect(
      series.parseSeries({
        captured: {},
        memberResults: [undefined, undefined],
        resultReadResults: [],
      })
    ).toBeUndefined();
  });

  test("progressive placement carries an exact parent liveness guard", () => {
    const step = freshSeriesStep(engine(new ProgressivePlanningDriver()));

    expect(step.progressive.kind).toBe("guarded");
    if (step.progressive.kind !== "guarded") {
      throw new Error("expected a progressive parent guard");
    }
    expect(step.progressive.guard.id).toBe("card.createManySeries.parent");
    expect(
      step.progressive.guard.premise.statement.values.length
    ).toBeGreaterThan(0);
    expect(
      step.progressive.guard.premise.statement.values.every(
        (value) => value === 10
      )
    ).toBe(true);
    expect(step.series.compileMembers({}).map((member) => member.mode)).toEqual(
      ["batch", "batch"]
    );
  });
});

function selectedSeriesStep(queryEngine: QueryEngine): RecordSeriesStep {
  const operation = new UpdateOperation(queryEngine, schema.folder, {
    where: { id: 10 },
    data: {
      cards: {
        updateMany: {
          where: { title: { contains: "draft" } },
          data: {
            title: "published",
            tags: { connect: [{ id: 9 }] },
          },
        },
      },
    },
    select: { id: true },
  });
  return recordSeriesStep(
    operation.compile(planningKnown(operation, { id: 10 })).steps
  );
}

describe("nested selected record-series coverage", () => {
  test("captured targets sort deterministically before selected-record construction", () => {
    const step = selectedSeriesStep(engine());
    const capture = step.series.capture().steps[0];
    if (!capture) throw new Error("expected selected-record capture");
    const members = step.series.compileMembers({
      [`${capture.id}.rows`]: [{ id: 3 }, { id: 1 }, { id: 2 }],
    });

    expect(capture.id).toBe("card.find");
    expect(members).toHaveLength(3);
    expect(
      members.map((member) => {
        const locate = member.planning().steps[0];
        if (
          !locate ||
          locate.kind === "guard" ||
          locate.kind === "recordSeries"
        ) {
          throw new Error("expected a selected-record locate");
        }
        return locate.statement.values[0];
      })
    ).toEqual([1, 2, 3]);
    expect(step.series.compileResultReads({}, [])).toEqual([]);
    expect(
      step.series.parseSeries({
        captured: {},
        memberResults: [],
        resultReadResults: [],
      })
    ).toBeUndefined();
  });

  test("a selected member compiles its scalar and nested relation writes together", () => {
    const step = selectedSeriesStep(engine());
    const capture = step.series.capture().steps[0];
    if (!capture) throw new Error("expected selected-record capture");
    const [member] = step.series.compileMembers({
      [`${capture.id}.rows`]: [{ id: 4 }],
    });
    if (!member) throw new Error("expected selected-record member");

    const known = planningKnown(member, { id: 4 });
    known["tag.find.rows"] = [{ id: 9 }];
    const fragment = member.compile(known);
    expect(
      fragment.steps.map((current) => `${current.kind}:${current.id}`)
    ).toEqual(["write:card.update", "write:tag.connect"]);
    expect(member.parse({})).toBeUndefined();
  });

  test("an empty capture constructs no selected-record member", () => {
    const step = selectedSeriesStep(engine());
    const capture = step.series.capture().steps[0];
    if (!capture) throw new Error("expected selected-record capture");

    expect(step.series.compileMembers({ [`${capture.id}.rows`]: [] })).toEqual(
      []
    );
  });
});

describe("coverage low value", () => {
  test("nested selected capture publications fail closed on missing and invalid rows", () => {
    const step = selectedSeriesStep(engine());
    const capture = step.series.capture().steps[0];
    if (!capture) throw new Error("expected selected-record capture");

    expect(() => step.series.compileMembers({})).toThrow(
      "did not expose its captured target rows"
    );
    expect(() =>
      step.series.compileMembers({ [`${capture.id}.rows`]: [null] })
    ).toThrow("captured an invalid target row");
  });
});
