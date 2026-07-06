import {
  createPlanState,
  lowerBatchResolvableValue,
} from "@query-engine/operations/nested-writes/batch-references";
import { s } from "@schema";
import { Sql, sql } from "@sql";
import { describe, expect, test } from "vitest";

const generatedUser = s
  .model({
    id: s.int().id().increment(),
    name: s.string(),
  })
  .map("batch_ref_users");

const literalUser = s
  .model({
    id: s.string().id(),
    name: s.string(),
  })
  .map("batch_ref_literal_users");

function createBatchRefAdapter() {
  return {
    adapter: {
      batchRefs: {
        setup: (batchId: string) => [sql.raw([`setup:${batchId}`])],
        clear: (batchId: string) => sql.raw([`clear:${batchId}`]),
        cleanup: (batchId: string) => sql.raw([`cleanup:${batchId}`]),
        read: (batchId: string, key: string) =>
          sql.raw([`read:${batchId}:${key}`]),
        store: (batchId: string, key: string, valueSql: Sql) =>
          sql.raw([`store:${batchId}:${key}:${valueSql.toStatement()}`]),
        storeLastInsertId: (batchId: string, key: string) =>
          sql.raw([`store-last:${batchId}:${key}`]),
      },
    },
  };
}

describe("batch reference domain model", () => {
  test("allocates unique monotonically ordered ref keys", () => {
    const state = createPlanState(createBatchRefAdapter());

    const first = state.references.allocateValueRef();
    const second = state.references.allocateValueRef();
    const third = state.references.allocateValueRef();

    expect([first.key, second.key, third.key]).toEqual([
      "ref_0",
      "ref_1",
      "ref_2",
    ]);
    expect(new Set([first.key, second.key, third.key]).size).toBe(3);
  });

  test("registers primary-key refs deterministically", () => {
    const state = createPlanState(createBatchRefAdapter());

    const first = state.registerProducedPrimaryKeyRef(generatedUser, {
      name: "Ada",
    });
    const second = state.registerProducedPrimaryKeyRef(generatedUser, {
      name: "Grace",
    });

    expect(
      first.primaryKeyRefs.map((ref) => [ref.fieldName, ref.valueRef.key])
    ).toEqual([["id", "ref_0"]]);
    expect(
      second.primaryKeyRefs.map((ref) => [ref.fieldName, ref.valueRef.key])
    ).toEqual([["id", "ref_1"]]);
    expect(state.references.allocatedValueRefs.map((ref) => ref.key)).toEqual([
      "ref_0",
      "ref_1",
    ]);
  });

  test("adds setup and cleanup only when refs are allocated", () => {
    const state = createPlanState(createBatchRefAdapter());

    expect(state.setupStatements).toHaveLength(0);
    expect(state.cleanupStatements).toHaveLength(0);

    state.references.allocateValueRef();

    expect(
      state.setupStatements.map((statement) => statement.toStatement())
    ).toEqual([`setup:${state.batchId}`, `clear:${state.batchId}`]);
    expect(
      state.cleanupStatements.map((statement) => statement.toStatement())
    ).toEqual([`cleanup:${state.batchId}`]);

    state.references.allocateValueRef();

    expect(state.setupStatements).toHaveLength(2);
    expect(state.cleanupStatements).toHaveLength(1);
  });

  test("does not allocate refs for fully literal primary keys", () => {
    const state = createPlanState(createBatchRefAdapter());

    const recordRef = state.registerProducedPrimaryKeyRef(literalUser, {
      id: "user-1",
      name: "Alan",
    });

    expect(recordRef.primaryKey).toEqual({ id: "user-1" });
    expect(recordRef.primaryKeyRefs).toEqual([]);
    expect(state.references.allocatedValueRefs).toEqual([]);
    expect(state.setupStatements).toHaveLength(0);
    expect(state.cleanupStatements).toHaveLength(0);
  });

  test("lowers only batch refs through the adapter", () => {
    const ctx = createBatchRefAdapter();
    const state = createPlanState(ctx);
    const ref = state.references.allocateValueRef();
    const fragment = sql`already sql`;

    expect(lowerBatchResolvableValue(ctx.adapter, "literal")).toBe("literal");
    expect(lowerBatchResolvableValue(ctx.adapter, fragment)).toBe(fragment);
    const lowered = lowerBatchResolvableValue(ctx.adapter, ref);
    if (!(lowered instanceof Sql)) {
      throw new Error("Expected batch ref to lower to a SQL fragment.");
    }
    expect(lowered.toStatement()).toBe(`read:${state.batchId}:ref_0`);
  });
});
