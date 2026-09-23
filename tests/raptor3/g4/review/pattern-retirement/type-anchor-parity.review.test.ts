/**
 * G4 pattern-retirement INDEPENDENT review — the type anchor.
 *
 * D-15 moved two facts out of the deleted `write-engine/OperationFragment.ts`:
 * the guard-failure SHAPE (now `PreparedGuardFailure` in `query-engine/types.ts`)
 * and the one `Failure -> Error` construction (`createFailureError`, now a
 * module-private function inside `query-engine/batch-error-attribution.ts`).
 *
 * A move is only a move if the result is observationally identical. The ORACLE
 * below is the base's construction verbatim (`git show
 * e8114ed9:src/query-engine/write-engine/OperationFragment.ts`, `createFailureError`).
 * Every arm of the taxonomy is driven through the one surviving entry point
 * (`attributeOperationBatchError`) and compared against it: class, message,
 * code, and every `meta` field a caller branches on.
 *
 * Arms the author's receipts do not separate: `kind: "query"` with
 * `raceable: true` (the arm whose explanatory comment was dropped in the move),
 * `kind: "notFound"` with a bogus declared message (the message must NOT reach
 * the caller), and `relation: undefined` on a nested-write failure.
 */
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { type Dialect, Driver } from "@drivers";
import {
  NESTED_WRITE_ASSERTION_FLOOR_MESSAGE,
  NestedWriteAssertionError,
  NestedWriteError,
  NotFoundError,
  TransactionError,
  VibORMErrorCode,
} from "@errors";
import { attributeOperationBatchError } from "@query-engine/batch-error-attribution";
import type {
  Operation,
  PreparedBatchGuard,
  PreparedGuardFailure,
} from "@query-engine/types";
import { sql } from "@sql";
import { describe, expect, test } from "vitest";

/** The base's `createFailureError`, verbatim. Nothing here imports the engine. */
function oracleFailureError(
  failure: PreparedGuardFailure,
  model: string,
  operation: string
): Error {
  if (failure.kind === "nestedWrite") {
    const error = new NestedWriteError(failure.message, failure.relation ?? "");
    if (failure.raceable) {
      error.meta.raceable = true;
    }
    return error;
  }
  if (failure.kind === "notFound") {
    return new NotFoundError(model, operation);
  }
  const error = new TransactionError(failure.message, {
    meta: { model, operation },
  });
  if (failure.raceable) {
    error.meta.raceable = true;
  }
  return error;
}

class ProbeDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter = new PostgresAdapter();
  /** Every guard re-probe answers "the premise still holds". */
  probeRows: unknown[] = [{ found: 1 }];

  constructor(dialect: Dialect = "postgresql") {
    super(dialect, `pattern-retirement-review-${dialect}`);
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {
    // No external client is allocated.
  }

  protected async execute<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: this.probeRows as T[], rowCount: this.probeRows.length };
  }

  protected async executeRaw<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [] as T[], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    fn: (transaction: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

const guardFor = (
  failure: PreparedGuardFailure,
  queryIndex = 0,
  model = "Doc",
  operation: Operation = "update"
): PreparedBatchGuard => ({
  queryIndex,
  premise: "exists",
  probe: sql`select 1`,
  failure,
  model,
  operation,
});

const ARMS: ReadonlyArray<{ label: string; failure: PreparedGuardFailure }> = [
  {
    label: "nestedWrite, not raceable, with a relation",
    failure: {
      kind: "nestedWrite",
      message: "connect target vanished",
      relation: "posts",
      raceable: false,
    },
  },
  {
    label: "nestedWrite, raceable, with a relation",
    failure: {
      kind: "nestedWrite",
      message: "premise changed",
      relation: "posts",
      raceable: true,
    },
  },
  {
    label: "nestedWrite, raceable, relation ABSENT",
    failure: {
      kind: "nestedWrite",
      message: "premise changed",
      raceable: true,
    },
  },
  {
    label: "notFound, not raceable, bogus declared message",
    failure: {
      kind: "notFound",
      message: "THIS SENTENCE MUST NOT REACH A CALLER",
      raceable: false,
    },
  },
  {
    label: "notFound, raceable",
    failure: { kind: "notFound", message: "ignored", raceable: true },
  },
  {
    label: "query, not raceable",
    failure: {
      kind: "query",
      message: "skip premise changed",
      raceable: false,
    },
  },
  {
    label: "query, RACEABLE (the arm whose comment was dropped in the move)",
    failure: { kind: "query", message: "skip premise changed", raceable: true },
  },
];

function shapeOf(error: unknown): Record<string, unknown> {
  const value = error as Error & {
    code?: unknown;
    meta?: Record<string, unknown>;
  };
  return {
    constructor: value.constructor.name,
    message: value.message,
    code: value.code,
    metaRaceable: value.meta?.raceable,
    metaRelation: value.meta?.relation,
    metaModel: value.meta?.model,
    metaOperation: value.meta?.operation,
  };
}

describe("D-15 type anchor: the relocated failure construction is the base's", () => {
  for (const arm of ARMS) {
    test(`statement-index attribution matches the oracle — ${arm.label}`, async () => {
      const driver = new ProbeDriver();
      const raised = new NestedWriteAssertionError("assertion failed", {
        meta: { statementIndex: 3 },
      });

      const attributed = await attributeOperationBatchError(
        raised,
        [guardFor(arm.failure, 3, "Doc", "update")],
        driver
      );

      expect(shapeOf(attributed)).toEqual(
        shapeOf(oracleFailureError(arm.failure, "Doc", "update"))
      );
    });

    test(`re-probe attribution matches the oracle — ${arm.label}`, async () => {
      const driver = new ProbeDriver();
      // An `exists` premise whose probe comes back EMPTY: the guard fired.
      driver.probeRows = [];
      const raised = new NestedWriteAssertionError("assertion failed");

      const attributed = await attributeOperationBatchError(
        raised,
        [guardFor(arm.failure, 0, "Doc", "update")],
        driver,
        [{ sql: "update docs set label = $1" }]
      );

      expect(shapeOf(attributed)).toEqual(
        shapeOf(oracleFailureError(arm.failure, "Doc", "update"))
      );
    });
  }

  test("a notFound guard never leaks its declared message", async () => {
    const driver = new ProbeDriver();
    const failure: PreparedGuardFailure = {
      kind: "notFound",
      message: "THIS SENTENCE MUST NOT REACH A CALLER",
      raceable: false,
    };
    const attributed = (await attributeOperationBatchError(
      new NestedWriteAssertionError("assertion failed", {
        meta: { statementIndex: 0 },
      }),
      [guardFor(failure, 0, "Doc", "findUnique")],
      driver
    )) as Error;

    expect(attributed).toBeInstanceOf(NotFoundError);
    expect(attributed.message).toBe("No Doc record found for findUnique");
    expect(attributed.message).not.toContain("MUST NOT REACH");
  });
});

describe("D-15 type anchor: the attribution rules the move must not have changed", () => {
  test("two guards differing ONLY in raceable stay un-attributable", async () => {
    const driver = new ProbeDriver();
    const raised = new NestedWriteAssertionError("assertion failed");
    const base: PreparedGuardFailure = {
      kind: "nestedWrite",
      message: "premise changed",
      relation: "posts",
      raceable: false,
    };

    const attributed = await attributeOperationBatchError(
      raised,
      [guardFor(base, 0), guardFor({ ...base, raceable: true }, 1)],
      driver,
      [{ sql: "select 1" }, { sql: "select 2" }]
    );

    expect(attributed).toBe(raised);
  });

  test("two guards differing ONLY in relation stay un-attributable", async () => {
    const driver = new ProbeDriver();
    const raised = new NestedWriteAssertionError("assertion failed");
    const base: PreparedGuardFailure = {
      kind: "nestedWrite",
      message: "premise changed",
      relation: "posts",
      raceable: false,
    };

    const attributed = await attributeOperationBatchError(
      raised,
      [guardFor(base, 0), guardFor({ ...base, relation: "tags" }, 1)],
      driver,
      [{ sql: "select 1" }, { sql: "select 2" }]
    );

    expect(attributed).toBe(raised);
  });

  test("two identical guards whose probes stay clean ARE attributable", async () => {
    const driver = new ProbeDriver();
    const raised = new NestedWriteAssertionError("assertion failed");
    const failure: PreparedGuardFailure = {
      kind: "nestedWrite",
      message: "premise changed",
      relation: "posts",
      raceable: true,
    };

    const attributed = await attributeOperationBatchError(
      raised,
      [guardFor(failure, 0), guardFor(failure, 1)],
      driver,
      [{ sql: "select 1" }, { sql: "select 2" }]
    );

    expect(shapeOf(attributed)).toEqual(
      shapeOf(oracleFailureError(failure, "Doc", "update"))
    );
  });

  test("a guard-free batch still reaches the shared assertion floor", async () => {
    const driver = new ProbeDriver();
    const raised = new NestedWriteAssertionError("assertion failed");

    const attributed = (await attributeOperationBatchError(
      raised,
      [],
      driver
    )) as NestedWriteError;

    expect(attributed).toBeInstanceOf(NestedWriteError);
    expect(attributed.message).toBe(NESTED_WRITE_ASSERTION_FLOOR_MESSAGE);
    expect(attributed.code).toBe(VibORMErrorCode.NESTED_WRITE_ASSERTION_FAILED);
    // `VibORMError` sanitizes a cause (diagnostic safety redacts its text), so
    // neither identity nor wording is the contract; ATTACHING one is.
    expect(attributed.originalCause).toBeInstanceOf(Error);
  });

  test("an error that is not an assertion failure passes through untouched", async () => {
    const driver = new ProbeDriver();
    const raw = new Error("connection reset");
    expect(
      await attributeOperationBatchError(
        raw,
        [
          guardFor({
            kind: "notFound",
            message: "ignored",
            raceable: false,
          }),
        ],
        driver
      )
    ).toBe(raw);
  });
});
