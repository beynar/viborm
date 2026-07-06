import { PGliteDriver } from "@drivers/pglite";
import { QueryEngineError } from "@errors";
import { selectMode } from "@query-engine/operations/nested-writes/interpreter";
import { LiveMode } from "@query-engine/operations/nested-writes/live-mode";
import { PlannedMode } from "@query-engine/operations/nested-writes/planned-mode";
import { describe, expect, test } from "vitest";

/**
 * M1 capability-matrix gate (§11 M1 / §8.1), still enforced after the M9 old-
 * engine deletion.
 *
 * `selectMode` is the single capability fork and must route every driver class:
 *   - a transaction driver (incl. one that also supports batch) → LiveMode
 *   - a batch-only driver (D1 / Neon-HTTP class) → PlannedMode
 *   - a driver with neither atomic strategy (d1-http class) → the same
 *     "supports neither" rejection.
 *
 * The neither-capability rejection message and meta (`driver`, `operation`,
 * `strategy`) are pinned VERBATIM as string literals — §11 M1 required the
 * d1-http rejection to survive byte-identically to the frozen `atomic-runner`
 * path, and that literal is the surviving contract now the old path is deleted.
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

  describe("neither-capability driver rejects with the pinned message", () => {
    for (const operation of NESTED_OPERATIONS) {
      test(`operation '${operation}'`, () => {
        const driver = new NoAtomicDriver();

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

        // Message pinned verbatim, including the operation name interpolated
        // ("nested create writes", etc.).
        expect(thrown.message).toBe(
          `Driver '${driver.driverName}' cannot execute nested ${operation} writes atomically because it supports neither callback transactions nor atomic batch execution.`
        );

        // Meta pinned by shape, including meta.operation.
        expect(thrown.meta.driver).toBe(driver.driverName);
        expect(thrown.meta.operation).toBe(operation);
        expect(thrown.meta.strategy).toBe("unsupported");
      });
    }
  });
});
