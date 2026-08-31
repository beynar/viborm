import { prepareAtomicBatch } from "@drivers/driver-batch-preparation";
import {
  isVerbatimBatchQuery,
  markVerbatimBatchQuery,
} from "@drivers/driver-batch-query-kind";
import {
  BATCH_DIAGNOSTIC_PARAMS,
  EMPTY_DIAGNOSTIC_PARAMS,
  findUniqueErrorLogDetails,
  findUniqueExecutionContextIndex,
  getErrorExecutionContext,
  readTrustedErrorExecutionContext,
  snapshotDiagnosticParameters,
} from "@drivers/driver-diagnostics";
import {
  appendExecutionTransactionPhases,
  bindExecutionTransactionPhases,
  createExecutionContext,
  deriveStatementExecutionContext,
  getExecutionExtensionChain,
  getExecutionInstrumentation,
  getExecutionTransactionPhases,
  snapshotExecutionContext,
} from "@drivers/execution-context";
import {
  readPreparedStatement,
  registerPreparedStatement,
  snapshotPreparedStatement,
  transferPreparedStatement,
} from "@drivers/prepared-statement-provenance";
import type { BatchQuery } from "@drivers/types";
import { QueryError } from "@errors";
import { sql } from "@sql";
import { describe, expect, test, vi } from "vitest";

describe("prepared driver batch state", () => {
  test("keeps execution kind and typed statement provenance private", () => {
    const query = { sql: "SELECT ?", params: [1] };
    const unregistered = {};
    const marked = markVerbatimBatchQuery(query);
    const statement = sql`SELECT ${1}`;
    registerPreparedStatement(query, statement);

    const transferred = transferPreparedStatement(query, {});
    const untouched = transferPreparedStatement(unregistered, {});
    const snapped = snapshotPreparedStatement(query, {}, [2]);

    expect(marked).toBe(query);
    expect(isVerbatimBatchQuery(marked)).toBe(true);
    expect(isVerbatimBatchQuery({})).toBe(false);
    expect(Object.keys(marked)).toEqual(["sql", "params"]);
    expect(readPreparedStatement(transferred)).toBe(statement);
    expect(readPreparedStatement(untouched)).toBeUndefined();
    expect(readPreparedStatement(snapped)?.strings).toEqual(statement.strings);
    expect(readPreparedStatement(snapped)?.values).toEqual([2]);
  });

  test.each([
    true,
    false,
  ])("detaches an atomic batch before provider dispatch (disclose=%s)", (discloseBatchParameters) => {
    const firstContext = { model: "$raw", operation: "executeRaw" };
    const boundContext = createExecutionContext({
      correlationId: "batch-correlation",
      operation: "executeBatch",
    });
    const date = new Date("2026-08-30T10:00:00.000Z");
    const rawQuery: BatchQuery = markVerbatimBatchQuery({
      sql: "SELECT ?",
      params: [date],
      context: firstContext,
    });
    const typedQuery: BatchQuery = { sql: "SELECT ?", params: [2] };
    const typedStatement = sql`SELECT ${2}`;
    registerPreparedStatement(typedQuery, typedStatement);
    const diagnosticSnapshots: unknown[][] = [];

    const prepared = prepareAtomicBatch(
      [rawQuery, typedQuery],
      boundContext,
      (params) => {
        const snapshot = [...params];
        Object.freeze(snapshot);
        diagnosticSnapshots.push(snapshot);
        return snapshot;
      },
      discloseBatchParameters
    );

    date.setUTCFullYear(2000);
    rawQuery.params?.push("later");
    firstContext.operation = "changed";

    expect(prepared.queries).toHaveLength(2);
    expect(prepared.queries.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(prepared.queries[0]?.params)).toBe(true);
    expect(prepared.errorLogDetails).toEqual([
      {
        context: prepared.queries[0]?.context,
        params: diagnosticSnapshots[0],
        sql: "SELECT ?",
      },
      {
        context: prepared.queries[1]?.context,
        params: diagnosticSnapshots[1],
        sql: "SELECT ?",
      },
    ]);
    if (discloseBatchParameters) {
      expect(prepared.diagnosticParams).toStrictEqual(diagnosticSnapshots);
      expect(prepared.diagnosticParams).not.toBe(diagnosticSnapshots);
      expect(Object.isFrozen(prepared.diagnosticParams)).toBe(true);
    } else {
      expect(prepared.diagnosticParams).toBe(EMPTY_DIAGNOSTIC_PARAMS);
    }
    expect(isVerbatimBatchQuery(prepared.queries[0] ?? {})).toBe(true);
    expect(isVerbatimBatchQuery(prepared.queries[1] ?? {})).toBe(false);
    expect(prepared.queries[0]?.params?.[0]).toEqual(
      new Date("2026-08-30T10:00:00.000Z")
    );
    expect(prepared.queries[0]?.context).toEqual({
      correlationId: "batch-correlation",
      model: "$raw",
      operation: "executeRaw",
    });
    expect(readPreparedStatement(prepared.queries[1] ?? {})?.values).toEqual([
      2,
    ]);
    expect(
      Reflect.get(prepared.queries[0] ?? {}, BATCH_DIAGNOSTIC_PARAMS)
    ).toBe(diagnosticSnapshots[0]);
  });
});

describe("trusted driver diagnostics", () => {
  test("freezes a detached diagnostic parameter graph", () => {
    const source = ["visible", { nested: true }];
    const snapshot = snapshotDiagnosticParameters(source);

    source[1] = "changed";
    expect(snapshot).toEqual(["visible", { nested: true }]);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  test("attributes only a unique trusted statement context", () => {
    const error = new QueryError("failed", {
      meta: {
        correlationId: "correlation",
        model: "entry",
        operation: "create",
      },
    });
    const unique = {
      context: {
        correlationId: "correlation",
        model: "entry",
        operation: "create",
      },
      params: [],
      sql: "INSERT",
    };
    const other = {
      context: {
        correlationId: "other",
        model: "entry",
        operation: "create",
      },
      params: [],
      sql: "OTHER",
    };

    expect(findUniqueExecutionContextIndex(new Error("raw"), [unique])).toBe(0);
    expect(
      findUniqueExecutionContextIndex(new Error("raw"), [unique, other])
    ).toBeUndefined();
    expect(findUniqueExecutionContextIndex(error, [other, unique])).toBe(1);
    expect(
      findUniqueExecutionContextIndex(error, [unique, unique])
    ).toBeUndefined();
    expect(findUniqueErrorLogDetails(error, [other, unique])).toBe(unique);
    expect(findUniqueErrorLogDetails(error, undefined)).toBeUndefined();
  });

  test("reads only the durable VibORM error snapshot and fills absent context", () => {
    const error = new QueryError("failed", {
      meta: { correlationId: "trusted", model: "entry" },
    });
    Object.defineProperty(error, "toJSON", {
      value: () => ({ meta: { correlationId: "spoofed" } }),
    });
    const fallback = {
      correlationId: "fallback",
      model: "fallback-model",
      operation: "execute",
    };

    expect(readTrustedErrorExecutionContext(error)).toEqual({
      correlationId: "trusted",
      model: "entry",
      operation: undefined,
    });
    expect(getErrorExecutionContext(error, fallback)).toEqual({
      correlationId: "trusted",
      model: "entry",
      operation: "execute",
    });
    expect(getErrorExecutionContext(new Error("raw"), fallback)).toBe(fallback);
  });
});

describe("trusted execution context composition", () => {
  test("keeps correlation lazy and preserves trusted identity", () => {
    const correlationIdFactory = vi.fn(() => "correlation");
    const context = createExecutionContext(
      { model: "entry", operation: "findMany" },
      undefined,
      correlationIdFactory
    );

    expect(snapshotExecutionContext(context, undefined, "execute")).toBe(
      context
    );
    expect(snapshotExecutionContext(undefined, context, "execute")).toBe(
      context
    );
    expect(correlationIdFactory).not.toHaveBeenCalled();
    expect(context.correlationId).toBe("correlation");
    expect(context.correlationId).toBe("correlation");
    expect(correlationIdFactory).toHaveBeenCalledTimes(1);
  });

  test("ignores hostile external members and retains the usable fallback", () => {
    const hostile = Object.defineProperties(
      {},
      {
        correlationId: {
          get: () => {
            throw new Error("no correlation");
          },
        },
        model: { get: () => 42 },
        operation: {
          get: () => {
            throw new Error("no operation");
          },
        },
      }
    );
    const bound = createExecutionContext({
      correlationId: "bound-correlation",
      model: "entry",
      operation: "findMany",
    });

    expect(snapshotExecutionContext(hostile, bound)).toBe(bound);
    expect(getExecutionInstrumentation(undefined)).toBeUndefined();
    expect(getExecutionInstrumentation(hostile)).toBeUndefined();
    expect(getExecutionExtensionChain(undefined)).toBeUndefined();
    expect(getExecutionExtensionChain(hostile)).toBeUndefined();
    expect(getExecutionTransactionPhases(undefined)).toBeUndefined();
    expect(getExecutionTransactionPhases(hostile)).toBeUndefined();
  });

  test("re-attributes a statement while preserving and composing private phases", () => {
    const events: string[] = [];
    const base = createExecutionContext({ operation: "create" });
    const bound = bindExecutionTransactionPhases(base, {
      readyToCommit: () => events.push("existing ready"),
      committed: () => events.push("existing committed"),
    });
    const appended = appendExecutionTransactionPhases(bound, {
      readyToCommit: () => events.push("appended ready"),
      committed: () => events.push("appended committed"),
    });
    const derived = deriveStatementExecutionContext(appended, "entry");
    const phases = getExecutionTransactionPhases(derived);

    phases?.readyToCommit();
    phases?.committed();
    expect(derived).toEqual({ model: "entry", operation: "create" });
    expect(events).toEqual([
      "appended ready",
      "existing ready",
      "appended committed",
      "existing committed",
    ]);
  });

  test("appends the first private phase reader without an empty intermediary", () => {
    const readyToCommit = vi.fn();
    const committed = vi.fn();
    const context = appendExecutionTransactionPhases(
      { operation: "executeBatch" },
      { readyToCommit, committed }
    );
    const phases = getExecutionTransactionPhases(context);

    phases?.readyToCommit();
    phases?.committed();
    expect(readyToCommit).toHaveBeenCalledOnce();
    expect(committed).toHaveBeenCalledOnce();
  });
});
