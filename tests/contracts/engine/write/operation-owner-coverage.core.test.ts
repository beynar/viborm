import { NotFoundError, QueryEngineError, TransactionError } from "@errors";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { sql } from "@sql";
import { BulkCountOperation } from "@src/query-engine/write-engine/BulkCountOperation";
import { CreateManyOperation } from "@src/query-engine/write-engine/CreateManyOperation";
import { DeleteOperation } from "@src/query-engine/write-engine/DeleteOperation";
import {
  lookupKeyIsNull,
  m2mDisconnectRequiresSelector,
  m2mMembershipRace,
  setRequiredOrphan,
  upsertSkipPremiseChanged,
  upsertTargetNotFoundForParent,
} from "@src/query-engine/write-engine/messages";
import {
  bucketOperationSteps,
  createFailureError,
  type GuardStep,
  type OperationStep,
  ref,
  type WriteStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { ReadOperation } from "@src/query-engine/write-engine/ReadOperation";
import {
  constructRoutedOperation,
  createRoutedCacheResultCodec,
  isReadOperation,
  isWriteOperation,
} from "@src/query-engine/write-engine/routing";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { UpsertOperation } from "@src/query-engine/write-engine/UpsertOperation";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const record = s
  .model({
    id: s.int().id(),
    email: s.string().unique(),
    label: s.string(),
    score: s.int(),
  })
  .map("operation_owner_coverage_records");

const schema = { record };
hydrateSchemaNames(schema);

function engine(
  dialect: "mysql" | "postgresql" = "postgresql",
  options: {
    readonly supportsTransactions?: boolean;
    readonly supportsBatch?: boolean;
  } = {}
): QueryEngine {
  const driver = new PlanningDriver(dialect, options);
  return new QueryEngine(
    driver,
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
}

function routed(
  queryEngine: QueryEngine,
  operation: string,
  args: Record<string, unknown>
) {
  const resolved = constructRoutedOperation(
    queryEngine,
    record,
    operation,
    args
  );
  if (!resolved) throw new Error(`'${operation}' did not route`);
  return resolved;
}

describe("write operation count owners", () => {
  test("bulk limit zero is a statement-free no-op with an exact zero result", () => {
    for (const kind of ["updateMany", "deleteMany"] as const) {
      const args =
        kind === "updateMany"
          ? { data: { label: "ignored" }, limit: 0 }
          : { limit: 0 };
      const operation = new BulkCountOperation(engine(), record, kind, args);

      expect(operation.planning()).toEqual({ steps: [] });
      expect(operation.compile({})).toEqual({ steps: [], outputs: {} });
      expect(operation.parse({ count: "not consulted" })).toEqual({ count: 0 });
    }
  });

  test("bulk count accepts provider bigint counts and rejects non-numeric output", () => {
    const operation = new BulkCountOperation(engine(), record, "deleteMany", {
      where: { score: { gte: 10 } },
    });
    const compiled = operation.compile({});

    expect(compiled.steps).toHaveLength(1);
    expect(operation.parse({ count: 3n })).toEqual({ count: 3 });
    expect(() => operation.parse({ count: "3" })).toThrowError(
      "deleteMany did not resolve a numeric count"
    );
  });

  test("empty createMany keeps its direct no-op but refuses array batch preparation", () => {
    const operation = new CreateManyOperation(engine(), record, { data: [] });

    expect(operation.planning()).toEqual({ steps: [] });
    expect(operation.compile({})).toEqual({ steps: [], outputs: {} });
    expect(operation.parse({})).toEqual({ count: 0 });
    expect(() => operation.assertBatchPreparable()).toThrowError(
      "No data to insert for createMany."
    );
  });

  test("recoverable createMany skips are executor effects and publish numeric counts", () => {
    const operation = new CreateManyOperation(engine("mysql"), record, {
      data: [
        { id: 1, email: "one@example.test", label: "one", score: 1 },
        { id: 2, email: "two@example.test", label: "two", score: 2 },
      ],
      skipDuplicates: true,
    });
    const compiled = operation.compile({});

    expect(() => operation.assertBatchPreparable()).not.toThrow();
    expect(compiled.steps).not.toHaveLength(0);
    expect(
      compiled.steps.every(
        (step) => step.kind === "write" && step.onUniqueConflict === "skip"
      )
    ).toBe(true);
    expect(operation.parse({ count: 2n })).toEqual({ count: 2 });
    expect(() => operation.parse({ count: null })).toThrowError(
      "createMany did not resolve a numeric count"
    );
  });
});

describe("read operation preparation and parsing", () => {
  test("prepared row parsing is compiled once and preserves negative-take order", () => {
    const operation = new ReadOperation(engine(), record, "findMany", {
      take: -2,
      select: { id: true, label: true },
    });
    const parser = operation.createResultParser();
    const shape = operation.createExpectedResultShape();
    const compiled = operation.compileResultRows(parser, shape);
    const rows = [
      { id: 2, label: "two" },
      { id: 1, label: "one" },
    ];

    expect(operation.preparedResultRows).toBe(operation);
    expect(operation.planning()).toEqual({ steps: [] });
    expect(operation.compile({}).steps).toHaveLength(1);
    expect(
      operation.parseResultWithProgram(
        { result: rows },
        parser,
        shape,
        compiled
      )
    ).toEqual([
      { id: 1, label: "one" },
      { id: 2, label: "two" },
    ]);
  });

  test("the ordinary parser and prepared parser share the result carrier refusal", () => {
    const operation = new ReadOperation(engine(), record, "findMany", {});
    const parser = operation.createResultParser();
    const shape = operation.createExpectedResultShape();

    expect(() => operation.parse({ result: null })).toThrowError(
      "read did not expose its result rows"
    );
    expect(() =>
      operation.parseResultWithProgram(
        { result: null },
        parser,
        shape,
        operation.compileResultRows(parser, shape)
      )
    ).toThrowError("read did not expose its result rows");
  });

  test("findUniqueOrThrow materializes absence as the public not-found error", () => {
    const operation = new ReadOperation(engine(), record, "findUniqueOrThrow", {
      where: { id: 404 },
    });

    expect(() => operation.parse({ result: [] })).toThrow(NotFoundError);
    expect(() => operation.parse({ result: [] })).toThrowError(
      "No record record found for findUniqueOrThrow"
    );
  });

  test("every read family constructs one planning-free read statement", () => {
    const cases: readonly [string, Record<string, unknown>][] = [
      ["findUnique", { where: { id: 1 } }],
      ["findFirst", { take: -3 }],
      ["findMany", { take: 5 }],
      ["count", {}],
      ["aggregate", { _count: true }],
      ["groupBy", { by: "label", _count: true }],
      ["exist", { where: { id: 1 } }],
    ];

    for (const [family, args] of cases) {
      const operation = new ReadOperation(engine(), record, family, args);
      expect(operation.planning().steps).toEqual([]);
      expect(operation.compile({}).steps).toHaveLength(1);
      expect(operation.createExpectedResultShape()).toBeDefined();
    }
  });
});

describe("single-row write owners", () => {
  test("a scalar update folds to one statement and owns result publication", () => {
    const operation = new UpdateOperation(engine(), record, {
      where: { id: 1 },
      data: { label: "changed" },
      select: { id: true, label: true },
    });

    expect(operation.planning()).toEqual({ steps: [] });
    expect(operation.compile({}).steps).toHaveLength(1);
    expect(operation.parse({ result: [{ id: 1, label: "changed" }] })).toEqual({
      id: 1,
      label: "changed",
    });
    expect(() => operation.parse({})).toThrowError(
      "update did not expose its result"
    );
  });

  test("a scalar delete folds to one statement and returns the removed row", () => {
    const operation = new DeleteOperation(engine(), record, {
      where: { email: "removed@example.test" },
      select: { id: true, email: true },
    });

    expect(operation.planning()).toEqual({ steps: [] });
    expect(operation.compile({}).steps).toHaveLength(1);
    expect(
      operation.parse({
        result: [{ id: 1, email: "removed@example.test" }],
      })
    ).toEqual({ id: 1, email: "removed@example.test" });
    expect(() => operation.parse({})).toThrowError(
      "delete did not expose its result"
    );
  });

  test("a targeted scalar upsert folds to one conflict statement", () => {
    const operation = new UpsertOperation(engine(), record, {
      where: { email: "stable@example.test" },
      create: {
        id: 1,
        email: "stable@example.test",
        label: "created",
        score: 0,
      },
      update: { label: "updated" },
      select: { id: true, label: true },
    });

    expect(operation.validatedArgs).toMatchObject({
      where: { email: "stable@example.test" },
      select: { id: true, label: true },
    });
    expect(operation.planning()).toEqual({ steps: [] });
    expect(operation.compile({}).steps).toHaveLength(1);
    expect(operation.parse({ result: [{ id: 1, label: "updated" }] })).toEqual({
      id: 1,
      label: "updated",
    });
    expect(() => operation.parse({})).toThrowError(
      "upsert did not expose its result"
    );
  });
});

describe("routed owner boundaries", () => {
  test("cache codecs come only from routed reads and are memoized by the read", () => {
    const read = routed(engine(), "findMany", {
      select: { id: true, label: true },
    });
    const first = createRoutedCacheResultCodec(read);
    const second = createRoutedCacheResultCodec(read);

    expect(second).toBe(first);
    expect(() =>
      createRoutedCacheResultCodec(
        routed(engine(), "deleteMany", { where: { score: { lt: 0 } } })
      )
    ).toThrowError("cache result encoding reached a non-read operation");
  });

  test("batch-only non-returning routing refuses single-row result resolution before parsing", () => {
    const batchOnly = engine("mysql", {
      supportsTransactions: false,
      supportsBatch: true,
    });

    expect(() =>
      constructRoutedOperation(batchOnly, record, "update", {})
    ).toThrowError(
      "cannot execute 'update' because public result parsing cannot be rolled back"
    );
    expect(() =>
      constructRoutedOperation(batchOnly, record, "upsert", {})
    ).toThrowError(
      "cannot execute non-returning upsert writes atomically because public result parsing cannot be rolled back"
    );
  });

  test("route classification is total over read, write, and unknown names", () => {
    expect(isReadOperation("groupBy")).toBe(true);
    expect(isWriteOperation("createMany")).toBe(true);
    expect(isWriteOperation("findMany")).toBe(false);
    expect(isReadOperation("invented")).toBe(false);
    expect(isWriteOperation("invented")).toBe(false);
    expect(
      constructRoutedOperation(engine(), record, "invented", {})
    ).toBeUndefined();
  });
});

describe("fragment failure attribution", () => {
  test("nested, not-found, and query failures keep their public classes and race marks", () => {
    const nested = createFailureError(
      {
        kind: "nestedWrite",
        message: "nested changed",
        relation: "posts",
        raceable: true,
      },
      "record",
      "update"
    );
    const missing = createFailureError(
      { kind: "notFound", message: "missing", raceable: false },
      "record",
      "delete"
    );
    const query = createFailureError(
      { kind: "query", message: "premise changed", raceable: true },
      "record",
      "upsert"
    );
    const unrelatedNested = createFailureError(
      {
        kind: "nestedWrite",
        message: "unattributed nested change",
        raceable: false,
      },
      "record",
      "update"
    );
    const stableQuery = createFailureError(
      { kind: "query", message: "stable failure", raceable: false },
      "record",
      "upsert"
    );

    expect(nested).toMatchObject({
      message: "nested changed",
      meta: { relation: "posts", raceable: true },
    });
    expect(missing).toBeInstanceOf(NotFoundError);
    expect(missing.message).toBe("No record record found for delete");
    expect(query).toBeInstanceOf(TransactionError);
    expect(query).toMatchObject({
      message: "premise changed",
      meta: { model: "record", operation: "upsert", raceable: true },
    });
    expect(unrelatedNested).toMatchObject({
      message: "unattributed nested change",
      meta: { relation: "" },
    });
    expect(stableQuery).toMatchObject({
      message: "stable failure",
      meta: { model: "record", operation: "upsert" },
    });
  });

  test("step bucketing isolates guards while retaining statement and series order", () => {
    const guard: GuardStep = {
      id: "guard",
      kind: "guard",
      premise: {
        kind: "exists",
        statement: sql`SELECT 1`,
      },
      failure: { kind: "query", message: "missing", raceable: false },
    };
    const write: WriteStep = {
      id: "write",
      kind: "write",
      statement: sql`UPDATE records SET id = ${ref("read", "id")}`,
      outputs: {
        id: {
          kind: "consumedValue",
          source: { kind: "reference", reference: ref("read", "id") },
        },
      },
    };
    const steps: OperationStep[] = [write, guard];
    const guards: OperationStep[] = [];
    const statements: OperationStep[] = [];

    bucketOperationSteps(steps, guards, statements);

    expect(guards).toEqual([guard]);
    expect(statements).toEqual([write]);
  });
});

describe("retained write message contracts", () => {
  test("relation failures remain byte-identical at their catalog owner", () => {
    expect(setRequiredOrphan("posts", ["authorId", "tenantId"])).toBe(
      "Cannot set relation 'posts' because foreign key field(s) authorId, tenantId are required: rows removed from the set cannot be disconnected. Delete them instead."
    );
    expect(upsertTargetNotFoundForParent("profile")).toBe(
      "Cannot upsert relation 'profile': target record was not found for this parent."
    );
    expect(m2mDisconnectRequiresSelector("tags")).toBe(
      "Nested operation 'disconnect' on many-to-many relation 'tags' requires a target selector."
    );
    expect(m2mMembershipRace("tags", "deleteMany")).toBe(
      "Concurrent membership change during 'deleteMany' on many-to-many relation 'tags': retry to converge."
    );
    expect(lookupKeyIsNull("author", "code")).toBe(
      "Cannot connect relation 'author': the located target's referenced field 'code' is null."
    );
    expect(upsertSkipPremiseChanged("targetWhere")).toBe(
      "query-engine-v2 top-level upsert targetWhere skip premise changed before the atomic batch."
    );
  });
});

describe("coverage low value", () => {
  test("direct invalid read construction keeps the internal invariant diagnostic", () => {
    expect(() => new ReadOperation(engine(), record, "invented", {})).toThrow(
      QueryEngineError
    );
  });

  test("createMany's post-parse array invariant is not forgeable through its schema", () => {
    expect(
      () => new CreateManyOperation(engine(), record, { data: null })
    ).toThrow();
  });
});
