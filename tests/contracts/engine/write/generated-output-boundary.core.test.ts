import { UnsupportedOperationError } from "@errors";
import {
  crossedReferenceContinuationGuards,
  firstGeneratedOutputDependency,
  generatedOutputSegments,
  statementStepsById,
} from "@src/query-engine/write-engine/generated-output-boundary";
import {
  ref,
  type GuardStep,
  type OperationFragment,
  type WriteStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { sql } from "@sql";
import { describe, expect, test } from "vitest";

const continuation: GuardStep = {
  id: "parent.still-exists",
  kind: "guard",
  premise: { kind: "exists", statement: sql`SELECT 1` },
  failure: { kind: "query", message: "parent changed", raceable: false },
};

const write = (
  id: string,
  outputs: WriteStep["outputs"],
  statement = sql`INSERT INTO records DEFAULT VALUES`,
  progressiveContinuation?: GuardStep
): WriteStep => ({
  id,
  kind: "write",
  statement,
  outputs,
  ...(progressiveContinuation ? { progressiveContinuation } : {}),
});

describe("generated provider-output segmentation", () => {
  test("insert-id scratch keeps a dependent write in one atomic batch", () => {
    const producer = write("parent.insert", {
      id: { kind: "insertId" },
    });
    const consumer = write(
      "child.insert",
      {},
      sql`INSERT INTO child (parent_id) VALUES (${ref("parent.insert", "id")})`
    );
    const fragment: OperationFragment = {
      steps: [producer, consumer],
      outputs: {},
    };

    expect(
      firstGeneratedOutputDependency(
        fragment,
        statementStepsById(fragment),
        true
      )
    ).toBeUndefined();
    expect(generatedOutputSegments(fragment, true)).toBeUndefined();
  });

  test("without insert-id scratch it splits at the dependency and carries the producer premise", () => {
    const producer = write(
      "parent.insert",
      { id: { kind: "insertId" } },
      sql`INSERT INTO parent DEFAULT VALUES`,
      continuation
    );
    const consumer = write(
      "child.insert",
      {},
      sql`INSERT INTO child (parent_id) VALUES (${ref("parent.insert", "id")})`
    );
    const fragment: OperationFragment = {
      steps: [producer, consumer],
      outputs: {},
    };

    expect(generatedOutputSegments(fragment, false)).toEqual([
      { steps: [producer], continuationGuards: [] },
      { steps: [consumer], continuationGuards: [continuation] },
    ]);
  });

  test("literal forwarded output never creates a provider boundary", () => {
    const producer = write("parent.insert", {
      suppliedId: {
        kind: "consumedValue",
        source: { kind: "literal", value: "p1" },
      },
    });
    const consumer = write(
      "child.insert",
      {},
      sql`INSERT INTO child (parent_id) VALUES (${ref(
        "parent.insert",
        "suppliedId"
      )})`
    );
    const fragment: OperationFragment = {
      steps: [producer, consumer],
      outputs: {},
    };

    expect(generatedOutputSegments(fragment, false)).toBeUndefined();
  });

  test("a forwarded provider output follows its source to the original premise", () => {
    const producer = write(
      "parent.insert",
      { id: { kind: "firstRowField", field: "id" } },
      sql`INSERT INTO parent DEFAULT VALUES RETURNING id`,
      continuation
    );
    const forwarder = write(
      "forward",
      {
        id: {
          kind: "consumedValue",
          source: {
            kind: "reference",
            reference: ref("parent.insert", "id"),
          },
        },
      },
      sql`UPDATE forwarding SET id = ${ref("parent.insert", "id")}`,
      continuation
    );
    const consumer = write(
      "child.insert",
      {},
      sql`INSERT INTO child (parent_id) VALUES (${ref("forward", "id")})`
    );
    const stepsById = statementStepsById({
      steps: [producer, forwarder, consumer],
      outputs: {},
    });

    expect(
      crossedReferenceContinuationGuards(
        [consumer],
        new Set(["parent.insert", "forward"]),
        stepsById
      )
    ).toEqual([continuation]);
  });

  test("a provider dependency without an exact continuation premise refuses before dispatch", () => {
    const producer = write("parent.insert", {
      id: { kind: "firstRowField", field: "id" },
    });
    const consumer = write(
      "child.insert",
      {},
      sql`INSERT INTO child (parent_id) VALUES (${ref("parent.insert", "id")})`
    );
    const stepsById = statementStepsById({
      steps: [producer, consumer],
      outputs: {},
    });

    expect(() =>
      crossedReferenceContinuationGuards(
        [consumer],
        new Set(["parent.insert"]),
        stepsById
      )
    ).toThrowError(UnsupportedOperationError);
  });

  test("a cyclic forwarding declaration fails closed as provider-dependent", () => {
    const left = write("left", {
      id: {
        kind: "consumedValue",
        source: { kind: "reference", reference: ref("right", "id") },
      },
    });
    const right = write("right", {
      id: {
        kind: "consumedValue",
        source: { kind: "reference", reference: ref("left", "id") },
      },
    });
    const consumer = write(
      "consumer",
      {},
      sql`SELECT ${ref("left", "id")}`
    );
    const fragment: OperationFragment = {
      steps: [left, right, consumer],
      outputs: {},
    };

    expect(
      firstGeneratedOutputDependency(
        fragment,
        statementStepsById(fragment),
        false
      )
    ).toEqual(ref("left", "id"));
  });
});
