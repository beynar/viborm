import {
  assertNormalizedBatchResults,
  assertNormalizedQueryResult,
  createNormalizedResultMeta,
  isNormalizedResultRow,
  normalizeProviderInsertId,
  normalizeProviderRowCount,
} from "@drivers/normalized-result";
import { observePromiseRejection } from "@drivers/rejection-observed-promise";
import {
  normalizeTransactionLifecycleError,
  toTransactionOperationError,
} from "@drivers/transaction-lifecycle-error";
import { QueryError, TransactionError } from "@errors";
import { describe, expect, test, vi } from "vitest";

const normalizedContext = {
  provider: "fixture",
  operation: "executeBatch",
  model: "entry",
  correlationId: "correlation",
};

describe("normalized provider result boundary", () => {
  test("builds metadata only from present execution facts", () => {
    expect(createNormalizedResultMeta(normalizedContext)).toEqual({
      driver: "fixture",
      operation: "executeBatch",
      model: "entry",
      correlationId: "correlation",
    });
    expect(
      createNormalizedResultMeta({ provider: "fixture", operation: "execute" })
    ).toEqual({ driver: "fixture", operation: "execute" });
  });

  test.each([
    [0, undefined, 0],
    [null, { nullValue: 4 }, 4],
    ["12", { allowDecimalString: true }, 12],
  ] as const)("normalizes row count %s", (value, options, expected) => {
    expect(normalizeProviderRowCount(value, normalizedContext, options)).toBe(
      expected
    );
  });

  test.each([
    null,
    "01",
    "-1",
    "1.5",
    Number.NaN,
    -1,
    1.5,
  ])("refuses malformed row count %s", (value) => {
    expect(() =>
      normalizeProviderRowCount(value, normalizedContext, {
        allowDecimalString: true,
      })
    ).toThrow(QueryError);
  });

  test.each([
    ["0", undefined],
    ["9007199254740993", 9_007_199_254_740_993n],
    [0, undefined],
    [4, 4],
  ] as const)("normalizes insert id %s", (value, expected) => {
    expect(
      normalizeProviderInsertId(value, normalizedContext, {
        allowNumber: true,
      })
    ).toBe(expected);
  });

  test.each([
    undefined,
    null,
    "01",
    "-1",
    1.5,
    -1,
    Number.NaN,
  ])("refuses malformed insert id %s", (value) => {
    expect(() =>
      normalizeProviderInsertId(value, normalizedContext, {
        allowNumber: true,
      })
    ).toThrow(QueryError);
  });

  test("accepts plain and null-prototype rows but rejects non-record carriers", () => {
    const nullPrototype = Object.create(null);
    Object.defineProperty(nullPrototype, "id", {
      enumerable: true,
      value: 1,
    });

    expect(isNormalizedResultRow({ id: 1 })).toBe(true);
    expect(isNormalizedResultRow(nullPrototype)).toBe(true);
    expect(isNormalizedResultRow([])).toBe(false);
    expect(isNormalizedResultRow(null)).toBe(false);
  });

  test("attributes malformed batch entries by exact index", () => {
    expect(() =>
      assertNormalizedBatchResults(
        [{ rows: [], rowCount: 0 }],
        2,
        normalizedContext
      )
    ).toThrowError("returned 1 results");
    expect(() =>
      assertNormalizedBatchResults(
        [
          { rows: [], rowCount: 0 },
          { rows: [], rowCount: -1 },
        ],
        2,
        normalizedContext
      )
    ).toThrowError("batch result index 1");
  });

  test.each([
    { rows: [], rowCount: 0, insertId: 0 },
    { rows: [], rowCount: 0, insertId: 1n },
  ])("accepts normalized optional insert ids", (result) => {
    expect(() =>
      assertNormalizedQueryResult(result, normalizedContext)
    ).not.toThrow();
  });

  test.each([
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    -1,
    1.5,
  ])("refuses malformed normalized insert id %s", (insertId) => {
    expect(() =>
      assertNormalizedQueryResult(
        { rows: [], rowCount: 0, insertId },
        normalizedContext
      )
    ).toThrow(QueryError);
  });
});

describe("transaction lifecycle error boundary", () => {
  test("retains Error identity and wraps primitive operation failures", () => {
    const error = new Error("failure");

    expect(toTransactionOperationError(error)).toBe(error);
    expect(toTransactionOperationError("failure")).toMatchObject({
      name: "TransactionError",
      message: "Transaction operation failed",
    });
  });

  test("normalizes a primary and its ordered cleanup failures", () => {
    const primary = new Error("primary");
    const cleanupOne = new Error("cleanup one");
    const cleanupTwo = new Error("cleanup two");
    const aggregate = new AggregateError(
      [primary, cleanupOne, cleanupTwo],
      primary.message,
      { cause: primary }
    );
    const normalized = normalizeTransactionLifecycleError(
      aggregate,
      toTransactionOperationError
    );

    expect(normalized).toBeInstanceOf(AggregateError);
    if (!(normalized instanceof AggregateError)) return;
    expect(normalized.cause).toBe(primary);
    expect(normalized.errors).toEqual([primary, cleanupOne, cleanupTwo]);
  });

  test("treats an unproven aggregate as one provider failure", () => {
    const primary = new Error("primary");
    const aggregate = new AggregateError([new Error("other")], "aggregate", {
      cause: primary,
    });
    const normalized = new TransactionError("normalized aggregate");
    const normalizeFailure = vi.fn(() => normalized);

    expect(
      normalizeTransactionLifecycleError(aggregate, normalizeFailure)
    ).toBe(normalized);
    expect(normalizeFailure).toHaveBeenCalledOnce();
    expect(normalizeFailure).toHaveBeenCalledWith(aggregate);
  });

  test("falls back to whole-failure normalization when aggregate inspection fails", () => {
    const aggregate = new AggregateError([], "hostile");
    Object.defineProperty(aggregate, "cause", {
      get: () => {
        throw new Error("unreadable cause");
      },
    });
    const normalized = new TransactionError("normalized aggregate");
    const normalizeFailure = vi.fn(() => normalized);

    expect(
      normalizeTransactionLifecycleError(aggregate, normalizeFailure)
    ).toBe(normalized);
    expect(normalizeFailure).toHaveBeenCalledOnce();
    expect(normalizeFailure).toHaveBeenCalledWith(aggregate);
  });
});

describe("transaction rejection observation", () => {
  test("finally preserves rejection-observation tracking", async () => {
    const observed = vi.fn();
    const finalized = vi.fn();
    const wrapped = observePromiseRejection(Promise.resolve("done"), observed);

    await expect(wrapped.finally(finalized)).resolves.toBe("done");
    expect(finalized).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenCalled();
  });
});
