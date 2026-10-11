/**
 * One execution owner for authenticated SQL slices and typed parameters.
 * Apply, down, reset, and push consume this. There is no second executor.
 */

import type { AnyDriver } from "../drivers/driver";
import {
  ConnectionError,
  isVibORMError,
  MigrationError,
  type MigrationErrorMeta,
  VibORMErrorCode,
} from "../errors";
import { decodeParameter } from "./compile";
import { sliceDispatch } from "./sql-blob";
import type {
  LedgerEffectStateV1,
  MigrationBooleanCheckV1,
  MigrationDispatchV1,
  MigrationOperationV1,
  MigrationStepV1,
} from "./v1-types";

export async function executeExactSql(
  producer: AnyDriver,
  sql: string,
  parameters: readonly unknown[] = []
): Promise<void> {
  await producer._executeRaw(sql, [...parameters]);
}

export async function executeDispatch(
  producer: AnyDriver,
  blob: Uint8Array,
  dispatch: MigrationDispatchV1,
  targetNamespace?: string
): Promise<void> {
  await executeExactSql(
    producer,
    sliceDispatch(blob, dispatch),
    dispatch.parameters.map((parameter) =>
      decodeParameter(parameter, targetNamespace)
    )
  );
}

export async function evaluateCheck(
  producer: AnyDriver,
  blob: Uint8Array,
  check: MigrationBooleanCheckV1,
  targetNamespace?: string
): Promise<boolean> {
  const sql = sliceDispatch(blob, check.query);
  const params = check.query.parameters.map((parameter) =>
    decodeParameter(parameter, targetNamespace)
  );
  const result = await producer._executeRaw<Record<string, unknown>>(
    sql,
    params
  );
  if (result.rows.length !== 1) {
    throw new MigrationError(
      `Check ${check.id} must return exactly one row`,
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
  const values = Object.values(result.rows[0]!);
  if (values.length !== 1) {
    throw new MigrationError(
      `Check ${check.id} must return exactly one column`,
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
  return coerceBoolean(values[0], check.id) === check.equals;
}

function coerceBoolean(value: unknown, id: string): boolean {
  if (
    value === true ||
    value === 1 ||
    value === 1n ||
    value === "1" ||
    value === "t" ||
    value === "true"
  ) {
    return true;
  }
  if (
    value === false ||
    value === 0 ||
    value === 0n ||
    value === "0" ||
    value === "f" ||
    value === "false"
  ) {
    return false;
  }
  throw new MigrationError(
    `Check ${id} did not return a boolean`,
    VibORMErrorCode.MIGRATION_INVALID_STATE
  );
}

export interface StepProgress {
  readonly operationId: string;
  readonly dispatchId: string;
  readonly skipped: boolean;
}

/** The edge a program runs: every dispatch failure names it. */
export interface DispatchEdge {
  readonly fromState: string | null;
  readonly toState: string | null;
}

/** Where one dispatch sits: its edge, operation and statement position. */
interface DispatchSite {
  readonly edge: DispatchEdge | undefined;
  readonly operationId: string;
  readonly statementIndex: number;
}

export async function executeOperations(
  producer: AnyDriver,
  blob: Uint8Array,
  operations: readonly MigrationOperationV1[],
  boundary: "transactional" | "stepwise",
  onProgress?: (
    progress: StepProgress,
    effect: LedgerEffectStateV1
  ) => Promise<void>,
  targetNamespace?: string,
  edge?: DispatchEdge
): Promise<void> {
  let statementIndex = 0;
  for (const operation of operations) {
    for (const step of operation.steps) {
      await executeStep(
        producer,
        blob,
        { edge, operationId: operation.id, statementIndex },
        step,
        boundary,
        onProgress,
        targetNamespace
      );
      statementIndex += 1;
    }
  }
}

function siteMeta(site: DispatchSite, dispatchId: string): MigrationErrorMeta {
  return {
    ...(site.edge?.fromState ? { fromState: site.edge.fromState } : {}),
    ...(site.edge?.toState ? { toState: site.edge.toState } : {}),
    operationId: site.operationId,
    dispatchId,
    statementIndex: site.statementIndex,
  };
}

/**
 * Runs one dispatch. A statement the provider refused — its answer carries a
 * provider code — becomes a MigrationError naming its edge, operation,
 * dispatch and statement, with that code; SQL and parameters stay on the
 * cause, behind diagnostics. A transport failure is not a refusal: it stays
 * what it is, and the pinned session reports a lost connection as the
 * retryable failure it is (plan S2).
 */
async function runDispatch(
  producer: AnyDriver,
  blob: Uint8Array,
  site: DispatchSite,
  dispatch: MigrationDispatchV1,
  targetNamespace: string | undefined
): Promise<void> {
  try {
    await executeDispatch(producer, blob, dispatch, targetNamespace);
  } catch (error) {
    const refused =
      isVibORMError(error) &&
      !(error instanceof ConnectionError) &&
      (error.meta.providerCode !== undefined ||
        error.meta.providerSqlState !== undefined);
    if (!refused) throw error;
    throw new MigrationError(
      `Migration statement ${site.statementIndex} of operation ${site.operationId} failed`,
      VibORMErrorCode.MIGRATION_FAILED,
      {
        cause: error,
        meta: {
          ...siteMeta(site, dispatch.dispatchId),
          providerCode: error.meta.providerCode,
          providerSqlState: error.meta.providerSqlState,
        },
      }
    );
  }
}

async function executeStep(
  producer: AnyDriver,
  blob: Uint8Array,
  site: DispatchSite,
  step: MigrationStepV1,
  boundary: "transactional" | "stepwise",
  onProgress?: (
    progress: StepProgress,
    effect: LedgerEffectStateV1
  ) => Promise<void>,
  targetNamespace?: string
): Promise<void> {
  const { operationId } = site;
  if (step.retry === "proven") {
    if (await evaluateCheck(producer, blob, step.postcheck, targetNamespace)) {
      await onProgress?.(
        { operationId, dispatchId: step.execute.dispatchId, skipped: true },
        "none"
      );
      return;
    }
    if (
      !(await evaluateCheck(producer, blob, step.precheck, targetNamespace))
    ) {
      throw new MigrationError(
        `Proven step ${operationId} is neither at origin nor destination`,
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        { meta: { lastConfirmedStep: step.execute.dispatchId } }
      );
    }
    await runDispatch(producer, blob, site, step.execute, targetNamespace);
    if (
      !(await evaluateCheck(producer, blob, step.postcheck, targetNamespace))
    ) {
      throw new MigrationError(
        `Proven step ${operationId} failed its postcheck`,
        VibORMErrorCode.MIGRATION_PARTIAL_EFFECT,
        {
          meta: {
            lastConfirmedStep: step.execute.dispatchId,
            effectState: "partial",
            partial: true,
          },
        }
      );
    }
    await onProgress?.(
      { operationId, dispatchId: step.execute.dispatchId, skipped: false },
      "committed"
    );
    return;
  }

  if (boundary === "stepwise") {
    await onProgress?.(
      { operationId, dispatchId: step.execute.dispatchId, skipped: false },
      "none"
    );
    try {
      await executeDispatch(producer, blob, step.execute, targetNamespace);
    } catch (error) {
      throw new MigrationError(
        `Opaque stepwise dispatch ${step.execute.dispatchId} failed with an ambiguous outcome`,
        VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
        {
          cause: error instanceof Error ? error : undefined,
          meta: {
            ...siteMeta(site, step.execute.dispatchId),
            lastConfirmedStep: step.execute.dispatchId,
            effectState: "may-have-committed",
            partial: true,
          },
        }
      );
    }
    await onProgress?.(
      { operationId, dispatchId: step.execute.dispatchId, skipped: false },
      "committed"
    );
    return;
  }

  await runDispatch(producer, blob, site, step.execute, targetNamespace);
  await onProgress?.(
    { operationId, dispatchId: step.execute.dispatchId, skipped: false },
    "committed"
  );
}

export async function evaluateAllChecks(
  producer: AnyDriver,
  blob: Uint8Array,
  checks: readonly MigrationBooleanCheckV1[],
  targetNamespace?: string
): Promise<boolean> {
  for (const check of checks) {
    if (!(await evaluateCheck(producer, blob, check, targetNamespace))) {
      return false;
    }
  }
  return true;
}
