import { PGliteDriver } from "@drivers/pglite";
import { QueryEngineError } from "@errors";
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
 *     "supports neither" rejection with meta.strategy: "unsupported".
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

describe("selectMode capability matrix", () => {
  test("transaction driver routes to LiveMode", () => {
    const mode = selectMode(new PGliteDriver());
    expect(mode).toBeInstanceOf(LiveMode);
    expect(mode.canObserveOwnWrites).toBe(true);
  });

  test("driver supporting both transactions and batch prefers LiveMode", () => {
    const mode = selectMode(new BothCapabilitiesDriver());
    expect(mode).toBeInstanceOf(LiveMode);
    expect(mode.canObserveOwnWrites).toBe(true);
  });

  test("batch-only driver routes to PlannedMode", () => {
    const mode = selectMode(new BatchOnlyDriver());
    expect(mode).toBeInstanceOf(PlannedMode);
    expect(mode.canObserveOwnWrites).toBe(false);
  });

  test("driver lacking every atomic strategy rejects with the unsupported message", () => {
    const driver = new NoAtomicDriver();
    let thrown: unknown;
    try {
      selectMode(driver);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(QueryEngineError);
    if (!(thrown instanceof QueryEngineError)) {
      throw new Error("expected a QueryEngineError");
    }
    expect(thrown.message).toContain(
      "supports neither callback transactions nor atomic batch execution"
    );
    expect(thrown.meta.strategy).toBe("unsupported");
    expect(thrown.meta.driver).toBe(driver.driverName);
  });
});
