import type { AnyDriver } from "@drivers";
import { isVibORMError, UniqueConstraintError, VibORMErrorCode } from "@errors";
import { hasNestedWritesInData } from "./builders/nested-write-detector";
import { isRaceableGuardError } from "./operations/nested-writes/effects";
import {
  runInterpreter,
  selectMode,
} from "./operations/nested-writes/interpreter";
import { assertPlanExecutable } from "./operations/nested-writes/legality";
import { isTreeEligible } from "./operations/nested-writes/routing";
import { hasRecordKeys } from "./operations/nested-writes/semantic-plan";
import { type Operation, type QueryContext, QueryEngineError } from "./types";

export function hasNestedWrites(
  operation: Operation,
  args: Record<string, unknown>
): boolean {
  if (!["create", "update", "upsert"].includes(operation)) {
    return false;
  }

  if (operation === "upsert") {
    return (
      hasNestedWritesInData(args.create) || hasNestedWritesInData(args.update)
    );
  }

  return hasNestedWritesInData(args.data);
}

export function needsUpsertWhereFallback(
  ctx: QueryContext,
  operation: Operation,
  args: Record<string, unknown>
): boolean {
  if (operation !== "upsert") {
    return false;
  }

  if (ctx.adapter.capabilities.supportsUpsertWhere) {
    return false;
  }

  return hasUpsertWhereOptions(operation, args);
}

export function hasUpsertWhereOptions(
  operation: Operation,
  args: Record<string, unknown>
): boolean {
  return (
    operation === "upsert" &&
    (hasRecordKeys(args.targetWhere) || hasRecordKeys(args.setWhere))
  );
}

export async function executeWithNestedWrites<T>(
  ctx: QueryContext,
  operation: Operation,
  args: Record<string, unknown>,
  driver: AnyDriver
): Promise<T> {
  const modelName = ctx.model["~"].names.ts ?? "unknown";

  driver.setContext({ model: modelName, operation });

  try {
    return await runNestedWriteOperation<T>(ctx, operation, args, driver);
  } catch (error) {
    // The write-race retry (§7.4). This wrapper sits ABOVE selectMode, so both
    // substrates share one converge-on-rerun path — the batch (planned) drivers
    // gain the behavior they lacked (map-batch-planner D2 closed). Two race
    // classes reach here:
    //
    //  - Missing-key create-branch races (Pin Rule 2): SELECT ... FOR UPDATE
    //    cannot lock absent rows, so two concurrent upserts/connectOrCreates of
    //    a missing key can both take the create branch. The loser's atomic unit
    //    rolled back with a unique violation (Postgres/SQLite) or a gap-lock
    //    deadlock (MySQL); rerunning sees the winner's committed row and takes
    //    the update/found branch. Authorized by hasRaceableCreateBranch.
    //
    //  - Raceable staleness-pin failures (the filtered-M2M-deleteMany
    //    symmetric-difference guards): the interpreter tagged the surfaced
    //    NestedWriteError raceable; rerunning re-plans against fresh membership
    //    and converges. Self-authorizing — the flag was set by the interpreter,
    //    which had full context — so no args-walk schema knowledge is needed.
    if (isWriteRaceLoserError(error) && canRetryRace(operation, args, error)) {
      return await runNestedWriteOperation<T>(ctx, operation, args, driver);
    }
    throw error;
  } finally {
    driver.clearContext();
  }
}

/** May the caught race-loser error re-run the whole operation (§7.4)? A
 *  self-authorizing raceable error (the flag set by the interpreter) always
 *  may; otherwise the tree must statically contain a raceable create branch. */
function canRetryRace(
  operation: Operation,
  args: Record<string, unknown>,
  error: unknown
): boolean {
  return (
    isRaceableGuardError(error) || hasRaceableCreateBranch(operation, args)
  );
}

function runNestedWriteOperation<T>(
  ctx: QueryContext,
  operation: Operation,
  args: Record<string, unknown>,
  driver: AnyDriver
): Promise<T> {
  // The capability fork (§8.1) resolves the mode first: a driver with neither
  // atomic strategy (d1-http class) rejects here, byte-identically to the frozen
  // atomic-runner path. Then the uniform legality gate (§6.3, §11 M2) runs the
  // whole-tree static validation for BOTH modes before the interpreter writes a
  // row, so an invalid deep tree is rejected up front instead of failing
  // mid-execution (D5 closed).
  const mode = selectMode(driver, operation);
  assertPlanExecutable(ctx, operation, args, mode);

  // Migration routing seam (§11). At M9 every nested kind and relation class is
  // migrated, so every valid tree is eligible and runs on the interpreter; the
  // frozen legacy engines are deleted. The seam itself (routing.ts / MIGRATED)
  // is removed at M10.
  if (isTreeEligible(ctx, operation, args)) {
    return runInterpreter<T>(ctx, operation, args, mode);
  }

  // Unreachable after M9: a valid create/update/upsert tree is always eligible
  // (all kinds + both relation classes migrated), and an invalid tree has
  // already thrown at `assertPlanExecutable`. The old engines that once served
  // ineligible trees are deleted; this is a defensive internal-invariant guard.
  throw new QueryEngineError(
    `Nested ${operation} write tree is not interpreter-eligible after the M9 migration — this is an internal routing invariant breach.`
  );
}

function isWriteRaceLoserError(error: unknown): boolean {
  if (error instanceof UniqueConstraintError) {
    return true;
  }

  // A NestedWriteError the interpreter tagged raceable (the filtered-M2M-
  // deleteMany staleness pins, §7.4). Never true for the step-4 assertion
  // fallback or any non-raceable premise; blanket acceptance of the assertion
  // class is explicitly rejected (§12.14) — raceability is a per-guard fact,
  // carried in the typed error's meta, never inferred from an error class.
  if (isRaceableGuardError(error)) {
    return true;
  }

  return (
    isVibORMError(error) &&
    (error.code === VibORMErrorCode.DEADLOCK ||
      error.code === VibORMErrorCode.SERIALIZATION_FAILURE)
  );
}

function hasRaceableCreateBranch(
  operation: Operation,
  args: Record<string, unknown>
): boolean {
  if (operation === "upsert") {
    return true;
  }

  return containsRaceableNestedWrite(args.data);
}

function containsRaceableNestedWrite(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsRaceableNestedWrite);
  }

  if (value === null || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  if ("connectOrCreate" in record || "upsert" in record) {
    return true;
  }

  return Object.values(record).some(containsRaceableNestedWrite);
}

export function isNestedBatchOperation(
  operation: Operation
): operation is Extract<Operation, "create" | "update" | "upsert"> {
  return (
    operation === "create" || operation === "update" || operation === "upsert"
  );
}
