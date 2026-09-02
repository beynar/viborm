import { UnsupportedOperationError } from "@errors";
import { sql } from "@sql";
import {
  assignmentIdentityFromFieldValue,
  assignmentIdentityFromScalar,
  type FinalAssignmentIdentity,
  type FinalAssignmentOrigin,
  FinalRootAssignmentTruth,
} from "@src/query-engine/write-engine/final-root-assignment";
import { ref } from "@src/query-engine/write-engine/OperationFragment";
import { describe, expect, test } from "vitest";

const contribute = (
  truth: FinalRootAssignmentTruth,
  identity: FinalAssignmentIdentity,
  origin: FinalAssignmentOrigin = "scalar",
  preserveExistingOnEqual = false
) =>
  truth.contribute(
    "ownerId",
    identity,
    origin,
    "conflicting final ownerId",
    preserveExistingOnEqual
  );

describe("one final root assignment truth per physical column", () => {
  test("an equal contribution replaces provenance unless the caller preserves it", () => {
    const truth = new FinalRootAssignmentTruth();
    contribute(truth, { kind: "literal", value: 7 });
    contribute(truth, { kind: "literal", value: 7 }, "fold");
    expect(truth.get("ownerId")).toEqual({
      identity: { kind: "literal", value: 7 },
      origin: "fold",
    });

    contribute(truth, { kind: "literal", value: 7 }, "membership", true);
    expect(truth.get("ownerId")?.origin).toBe("fold");
  });

  test("a fork starts with the same facts and then diverges independently", () => {
    const original = new FinalRootAssignmentTruth();
    contribute(original, { kind: "literal", value: "u1" });
    const fork = original.fork();
    fork.contribute(
      "tenantId",
      { kind: "literal", value: "t1" },
      "membership",
      "conflict"
    );

    expect(fork.get("ownerId")).toEqual(original.get("ownerId"));
    expect(original.get("tenantId")).toBeUndefined();
    expect(fork.get("tenantId")?.origin).toBe("membership");
  });

  test("unresolved scalar expressions remain opaque and cannot prove agreement", () => {
    const expression = sql`counter + 1`;
    expect(assignmentIdentityFromScalar(expression)).toEqual({
      kind: "opaque",
      value: expression,
    });

    const truth = new FinalRootAssignmentTruth();
    contribute(truth, assignmentIdentityFromScalar(expression));
    expect(() =>
      contribute(truth, assignmentIdentityFromScalar(expression), "fold")
    ).toThrowError(UnsupportedOperationError);
  });

  test("operation references preserve their field-bound source identity", () => {
    expect(assignmentIdentityFromFieldValue("id", ref("insert", "id"))).toEqual(
      {
        kind: "source",
        source: { kind: "finalRef", ref: ref("insert", "id") },
        referencedField: "id",
      }
    );
    expect(assignmentIdentityFromFieldValue("id", 4)).toEqual({
      kind: "literal",
      value: 4,
    });
  });
});

describe("final reference source equality", () => {
  const sameTransition = (value: unknown) => value;

  test.each([
    {
      name: "literal",
      left: {
        kind: "source",
        source: { kind: "literal", value: 7 },
        referencedField: "id",
      },
      right: { kind: "literal", value: 7 },
    },
    {
      name: "final output reference",
      left: {
        kind: "source",
        source: { kind: "finalRef", ref: ref("insert", "id") },
        referencedField: "id",
      },
      right: {
        kind: "source",
        source: { kind: "finalRef", ref: ref("insert", "id") },
        referencedField: "id",
      },
    },
    {
      name: "planning field",
      left: {
        kind: "source",
        source: { kind: "planningField", step: "locate" },
        referencedField: "id",
      },
      right: {
        kind: "source",
        source: { kind: "planningField", step: "locate" },
        referencedField: "id",
      },
    },
    {
      name: "transitioned planning field",
      left: {
        kind: "source",
        source: {
          kind: "transitionedPlanningField",
          step: "locate",
          apply: sameTransition,
        },
        referencedField: "id",
      },
      right: {
        kind: "source",
        source: {
          kind: "transitionedPlanningField",
          step: "locate",
          apply: sameTransition,
        },
        referencedField: "id",
      },
    },
    {
      name: "selected-row continuity",
      left: {
        kind: "source",
        source: {
          kind: "selectedRowContinuity",
          step: "selected",
          apply: sameTransition,
        },
        referencedField: "id",
      },
      right: {
        kind: "source",
        source: {
          kind: "selectedRowContinuity",
          step: "selected",
          apply: sameTransition,
        },
        referencedField: "id",
      },
    },
  ] as const)("accepts the same $name", ({ left, right }) => {
    const truth = new FinalRootAssignmentTruth();
    contribute(truth, left);
    expect(() => contribute(truth, right, "membership")).not.toThrow();
  });

  test("a lookup source is equal only by statement and referenced-field identity", () => {
    const lookup = sql`SELECT id FROM owner`;
    const identity = (statement: typeof lookup): FinalAssignmentIdentity => ({
      kind: "source",
      source: { kind: "lookup", statement },
      referencedField: "id",
    });
    const truth = new FinalRootAssignmentTruth();
    contribute(truth, identity(lookup));
    expect(() => contribute(truth, identity(lookup), "fold")).not.toThrow();
    expect(() =>
      contribute(truth, identity(sql`SELECT id FROM owner`), "fold")
    ).toThrowError("conflicting final ownerId");
  });

  test("a different source kind or field cannot be treated as the same assignment", () => {
    const truth = new FinalRootAssignmentTruth();
    contribute(truth, {
      kind: "source",
      source: { kind: "planningField", step: "locate" },
      referencedField: "id",
    });
    expect(() =>
      contribute(truth, {
        kind: "source",
        source: { kind: "finalRef", ref: ref("locate", "id") },
        referencedField: "id",
      })
    ).toThrowError(UnsupportedOperationError);
  });
});
