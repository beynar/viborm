import { PGliteDriver } from "@drivers/pglite";
import { QueryEngineError } from "@errors";
import { runNestedMutationAtomically } from "@query-engine/operations/nested-writes/atomic-runner";
import { selectMode } from "@query-engine/operations/nested-writes/interpreter";
import { LiveMode } from "@query-engine/operations/nested-writes/live-mode";
import { PlannedMode } from "@query-engine/operations/nested-writes/planned-mode";
import { describe, expect, test } from "vitest";

/**
 * M1 capability-matrix gate (§11 M1 / §8.1).
 *
 * `selectMode` is the single capability fork and must route every driver class
 * exactly the way `runNestedWriteOperation` does today:
 *   - a transaction driver (incl. one that also supports batch) → LiveMode
 *   - a batch-only driver (D1 / Neon-HTTP class) → PlannedMode
 *   - a driver with neither atomic strategy (d1-http class) → the same
 *     "supports neither" rejection.
 *
 * The neither-capability case is proven **byte-identical** to the frozen old
 * path (`atomic-runner.ts::runNestedMutationAtomically`) — same message and
 * same meta (`driver`, `operation`, `strategy`) — not merely a shared
 * substring. §11 M1 requires the d1-http rejection to survive verbatim, and
 * the old rejection interpolates the operation name into both the message and
 * `meta.operation`, so an equivalence proof must pin both.
 */

class BothCapabilitiesDriver extends PGliteDriver {
  override readonly supportsTransactions = true;
  override readonly supportsBatch = true;
}

class BatchOnlyDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

class NoAtomicDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = false;
}

const NESTED_OPERATIONS = ["create", "update", "upsert"] as const;

async function captureOldRejection(
  driver: NoAtomicDriver,
  operation: (typeof NESTED_OPERATIONS)[number]
): Promise<QueryEngineError> {
  try {
    await runNestedMutationAtomically(driver, operation, () => {
      throw new Error(
        "run should never be invoked on a neither-capability driver"
      );
    });
  } catch (error) {
    if (error instanceof QueryEngineError) {
      return error;
    }
  }
  throw new Error("expected the old path to reject with a QueryEngineError");
}

describe("selectMode capability matrix", () => {
  test("transaction driver routes to LiveMode", () => {
    const mode = selectMode(new PGliteDriver(), "create");
    expect(mode).toBeInstanceOf(LiveMode);
    expect(mode.canObserveOwnWrites).toBe(true);
  });

  test("driver supporting both transactions and batch prefers LiveMode", () => {
    const mode = selectMode(new BothCapabilitiesDriver(), "update");
    expect(mode).toBeInstanceOf(LiveMode);
    expect(mode.canObserveOwnWrites).toBe(true);
  });

  test("batch-only driver routes to PlannedMode", () => {
    const mode = selectMode(new BatchOnlyDriver(), "upsert");
    expect(mode).toBeInstanceOf(PlannedMode);
    expect(mode.canObserveOwnWrites).toBe(false);
  });

  describe("neither-capability driver rejects byte-identically to the old path", () => {
    for (const operation of NESTED_OPERATIONS) {
      test(`operation '${operation}'`, async () => {
        const driver = new NoAtomicDriver();
        const old = await captureOldRejection(driver, operation);

        let thrown: unknown;
        try {
          selectMode(driver, operation);
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(QueryEngineError);
        if (!(thrown instanceof QueryEngineError)) {
          throw new Error("expected a QueryEngineError");
        }

        // Message pinned verbatim, including the operation name the old path
        // interpolates ("nested create writes", etc.).
        expect(thrown.message).toBe(old.message);
        expect(thrown.message).toBe(
          `Driver '${driver.driverName}' cannot execute nested ${operation} writes atomically because it supports neither callback transactions nor atomic batch execution.`
        );

        // Meta pinned by shape, including meta.operation.
        expect(thrown.meta.driver).toBe(old.meta.driver);
        expect(thrown.meta.operation).toBe(old.meta.operation);
        expect(thrown.meta.strategy).toBe(old.meta.strategy);
        expect(thrown.meta.driver).toBe(driver.driverName);
        expect(thrown.meta.operation).toBe(operation);
        expect(thrown.meta.strategy).toBe("unsupported");
      });
    }
  });
});
