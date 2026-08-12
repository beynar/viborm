import type { QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { TransactionError } from "@errors";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { sql } from "@sql";
import {
  type ExecutableOperation,
  OperationExecutor,
} from "@src/query-engine/write-engine/OperationExecutor";
import {
  type OperationFragment,
  type PlanningFragment,
  ref,
} from "@src/query-engine/write-engine/OperationFragment";
import {
  optionalAbsentBindSchema,
  runOptionalAbsentBindBehavior,
} from "@tests/contracts/engine/write/optional-absent-bind-behavior";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

// The no-regression control: PostgreSQL's binder coerces `undefined` to NULL, so
// this shape already worked here before M5 and must keep working after it.
runOptionalAbsentBindBehavior({
  name: "PGlite transaction",
  pgliteMode: "transaction",
});

runOptionalAbsentBindBehavior({
  name: "PGlite atomic batch",
  pgliteMode: "atomicBatch",
});

// ---------------------------------------------------------------------------
// The executor seam itself. The behaviors above prove the public shape works;
// these two prove WHAT the seam does with an unresolved value, on the narrowest
// fragment that can carry one — and that only the OPTIONAL half is normalized.
// ---------------------------------------------------------------------------

/** Records the parameters each statement reached the provider with. */
class RecordingPGliteDriver extends PGliteDriver {
  readonly binds: unknown[][] = [];

  protected override execute<T>(
    client: PGlite | Transaction,
    statement: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.binds.push(params);
    return super.execute<T>(client, statement, params, context);
  }
}

/** The real executor on the real engine — only the fragment below is synthetic. */
function makeSeamExecutor(driver: RecordingPGliteDriver): OperationExecutor {
  const schemas = createSchemaRegistry(optionalAbsentBindSchema);
  return new OperationExecutor(
    new QueryEngine(
      driver,
      createModelRegistry(optionalAbsentBindSchema, schemas)
    )
  );
}

/**
 * A two-step planning fragment: a read that matches NO row exposing one
 * `firstRowField`, then a read that binds it. `optional` is the only difference
 * between the two witnesses below, which is the point — it is the flag that says
 * "an empty result is a legitimate branch here".
 */
function absentFieldOperation(optional: boolean): ExecutableOperation {
  const probe = {
    id: "probe",
    kind: "read",
    statement: sql`SELECT 1 AS "id" WHERE 1 = 0`,
    outputs: {
      id: {
        kind: "firstRowField",
        field: "id",
        ...(optional ? { optional } : {}),
      },
    },
  } as const;
  const consumer = {
    id: "consumer",
    kind: "read",
    statement: sql`SELECT ${ref("probe", "id")}::int AS "bound"`,
    outputs: { rows: { kind: "rows" } },
  } as const;
  return {
    mode: "transaction",
    // Planning publication is derived (Phase 9.1): every declared statement
    // output is exposed under `<step>.<name>`. This fixture's old hand-named
    // subset (`rows`) is gone with the map; the executor path under test — the
    // absent-optional bind INSIDE the consumer's own statement — is untouched.
    planning: (): PlanningFragment => ({
      steps: [probe, consumer],
    }),
    compile: (): OperationFragment => ({
      steps: [
        {
          id: "final",
          kind: "read",
          statement: sql`SELECT 1 AS "ok"`,
          outputs: { rows: { kind: "rows" } },
        },
      ],
      outputs: { rows: ref("final", "rows") },
    }),
    parse: <T>(outputs: Readonly<Record<string, unknown>>): T =>
      outputs as unknown as T,
  };
}

describe("the executor's absent-optional bind", () => {
  test("an OPTIONAL output whose read matched no row binds SQL NULL", async () => {
    const driver = new RecordingPGliteDriver();
    const executor = makeSeamExecutor(driver);
    try {
      await executor.execute(
        absentFieldOperation(true),
        createOperationExecutionContext("account", "upsert")
      );
      // The consumer is the second statement inside the transaction envelope. Its
      // one parameter is the absent output: `null`, never `undefined` — mysql2's
      // binder rejects the latter, so an engine that passed it through would be
      // driver-dependent.
      const consumerBind = driver.binds.find((params) => params.length === 1);
      expect(consumerBind).toEqual([null]);
    } finally {
      await driver.disconnect();
    }
  });

  test("a NON-optional output whose read matched no row still fails the operation closed", async () => {
    const driver = new RecordingPGliteDriver();
    const executor = makeSeamExecutor(driver);
    try {
      // No `optional`: an absent row is not a branch, it is a broken plan. The
      // typed refusal names the step and the field, and NOTHING binds — the
      // normalization must not turn an unresolved reference into a silent NULL.
      await expect(
        executor.execute(
          absentFieldOperation(false),
          createOperationExecutionContext("account", "upsert")
        )
      ).rejects.toThrow(TransactionError);
      expect(driver.binds.some((params) => params.length === 1)).toBe(false);
    } finally {
      await driver.disconnect();
    }
  });
});
