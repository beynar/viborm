import type { AnyDriver } from "@drivers";
import {
  type BatchPreparationContext,
  type Operation,
  type QueryContext,
  QueryEngineError,
} from "../../types";
import { LiveMode } from "./live-mode";
import type { Mode } from "./mode";
import { PlannedMode } from "./planned-mode";

/**
 * The only capability fork (§8.1). Capability precedence preserved exactly: a
 * driver supporting both transactions and batch takes LiveMode (map-oracle §A);
 * a batch-only driver takes PlannedMode; a driver with neither (d1-http) falls
 * to the throw — the same "cannot execute atomically" rejection the old
 * `runNestedMutationAtomically` raised, with `meta.strategy: "unsupported"`
 * (capability honesty, map-batch-refs §6.2).
 */
export function selectMode(
  driver: AnyDriver,
  shared?: BatchPreparationContext
): Mode {
  if (driver.supportsTransactions) {
    return new LiveMode(driver);
  }
  if (driver.supportsBatch) {
    return new PlannedMode(driver, shared);
  }
  throw new QueryEngineError(
    `Driver '${driver.driverName}' cannot execute nested writes atomically because it supports neither callback transactions nor atomic batch execution.`,
    {
      meta: {
        driver: driver.driverName,
        strategy: "unsupported",
      },
    }
  );
}

/**
 * The interpreter entry (§2, §8.6). Owns every semantic decision once and
 * consults a `Mode` for substrate mechanics.
 *
 * M1 scaffolding: the interpreter body lands across milestones M3-M9. Until a
 * tree is eligible (`isTreeEligible`, empty `MIGRATED` at M1) the dispatch never
 * reaches here — every tree delegates to the legacy engines (§11 M1). Reaching
 * this function before those milestones is an internal invariant breach.
 */
export function runInterpreter<T>(
  _ctx: QueryContext,
  operation: Operation,
  _args: Record<string, unknown>,
  _mode: Mode
): Promise<T> {
  throw new QueryEngineError(
    `The nested-write interpreter is not wired for operation '${operation}' yet; eligible trees begin routing here at milestone M3.`
  );
}
