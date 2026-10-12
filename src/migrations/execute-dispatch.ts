import { errorCause } from "../errors/diagnostic-safety";
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
  type VibORMError,
  VibORMErrorCode,
} from "../errors";
import { decodeParameter } from "./compile";
import type { MigrationBatch } from "./pinned-session";
import { sliceDispatch } from "./sql-blob";
import { readExecutableStatements } from "./statement-safety";
import { readFlag } from "./v1-parse-shared";
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

/** A dispatch's exact text and its decoded parameters. */
function dispatchQuery(
  blob: Uint8Array,
  dispatch: MigrationDispatchV1,
  targetNamespace: string | undefined
): { readonly sql: string; readonly params: unknown[] } {
  return {
    sql: sliceDispatch(blob, dispatch),
    params: dispatch.parameters.map((parameter) =>
      decodeParameter(parameter, targetNamespace)
    ),
  };
}

export async function executeDispatch(
  producer: AnyDriver,
  blob: Uint8Array,
  dispatch: MigrationDispatchV1,
  targetNamespace?: string
): Promise<void> {
  const { sql, params } = dispatchQuery(blob, dispatch, targetNamespace);
  await executeExactSql(producer, sql, params);
}

export async function evaluateCheck(
  producer: AnyDriver,
  blob: Uint8Array,
  check: MigrationBooleanCheckV1,
  targetNamespace?: string
): Promise<boolean> {
  const { sql, params } = dispatchQuery(blob, check.query, targetNamespace);
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
  const flag = readFlag(values[0]);
  if (flag === undefined) {
    throw new MigrationError(
      `Check ${check.id} did not return a boolean`,
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
  return flag === check.equals;
}

const TRAILING_SEMICOLON = /;\s*$/;

/**
 * {@link evaluateCheck} as a condition one request asserts (plan D7): the
 * check's one row holds one value, `check.equals` in a spelling
 * `readFlag` reads. No row, more rows, or another value do not hold. A
 * check with another number of columns is refused, as `evaluateCheck`
 * refuses it: the `UNION ALL` with one column fails the request, which rolls
 * back. Columns are named, never read as one whole row, which PlanetScale
 * Neki refuses.
 */
export function checkCondition(
  blob: Uint8Array,
  check: MigrationBooleanCheckV1,
  targetNamespace: string | undefined
): { readonly sql: string; readonly params: unknown[] } {
  const { sql, params } = dispatchQuery(blob, check.query, targetNamespace);
  const spellings = check.equals ? "'true', 't', '1'" : "'false', 'f', '0'";
  return {
    sql: `(SELECT CASE WHEN count(*) = 1 THEN min(one.value::text) END FROM (SELECT * FROM (\n${sql.replace(TRAILING_SEMICOLON, "")}\n) AS checked UNION ALL SELECT NULL WHERE false) AS one(value)) IN (${spellings})`,
    params,
  };
}

/**
 * Whether `error` is the provider refusing a statement — its answer carries a
 * provider code — rather than a failure of the transport.
 */
export function providerRefused(error: unknown): error is VibORMError {
  return (
    isVibORMError(error) &&
    !(error instanceof ConnectionError) &&
    (error.meta.providerCode !== undefined ||
      error.meta.providerSqlState !== undefined)
  );
}

export interface StepProgress {
  readonly operationId: string;
  readonly dispatchId: string;
  readonly skipped: boolean;
}

/**
 * Records one step's progress. An opaque stepwise step is announced (`none`)
 * before it runs, then answered: `committed`, or — refused whole, nothing of
 * it committed — `none` again with the refusal as `failure`. An announcement
 * never answered may have committed.
 */
type OnProgress = (
  progress: StepProgress,
  effect: LedgerEffectStateV1,
  failure?: string
) => Promise<void>;

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

/**
 * `atomic` is a program inside a real transaction (plan D5): its rollback
 * undoes whatever a failure leaves half done, so no step is probed and no
 * progress is reported, and the caller proves the destination once.
 */
export async function executeOperations(
  producer: AnyDriver,
  blob: Uint8Array,
  operations: readonly MigrationOperationV1[],
  boundary: "transactional" | "stepwise" | "atomic",
  onProgress?: OnProgress,
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
    if (!providerRefused(error)) throw error;
    throw refusal(site, dispatch.dispatchId, error);
  }
}

function refusal(
  site: DispatchSite,
  dispatchId: string,
  error: VibORMError,
  meta?: MigrationErrorMeta
): MigrationError {
  return new MigrationError(
    `Migration statement ${site.statementIndex} of operation ${site.operationId} failed`,
    VibORMErrorCode.MIGRATION_FAILED,
    {
      cause: error,
      meta: {
        ...siteMeta(site, dispatchId),
        providerCode: error.meta.providerCode,
        providerSqlState: error.meta.providerSqlState,
        ...meta,
      },
    }
  );
}

/**
 * Leaders of a statement that may COMMIT part of its work before it fails: a
 * procedure, a PostgreSQL `DO` block, a statement prepared earlier.
 */
const COMMITS_INSIDE = new Set(["CALL", "DO", "EXECUTE"]);

/**
 * Whether the provider's refusal of `sql` proves none of it committed: one
 * statement, run bare as a transaction of its own, which the server undoes
 * whole when it refuses it (VibORM's MySQL tables are InnoDB). Not one led by
 * {@link COMMITS_INSIDE}, nor a `CONCURRENTLY` statement, which commits in
 * phases.
 */
function refusedWhole(
  error: unknown,
  sql: string,
  dialect: AnyDriver["dialect"]
): error is VibORMError {
  if (!providerRefused(error)) return false;
  const statements = readExecutableStatements(sql, dialect);
  const [leader = "", ...rest] = statements[0] ?? [];
  return (
    statements.length === 1 &&
    !COMMITS_INSIDE.has(leader) &&
    !rest.includes("CONCURRENTLY")
  );
}

async function executeStep(
  producer: AnyDriver,
  blob: Uint8Array,
  site: DispatchSite,
  step: MigrationStepV1,
  boundary: "transactional" | "stepwise" | "atomic",
  onProgress?: OnProgress,
  targetNamespace?: string
): Promise<void> {
  const { operationId } = site;
  if (boundary === "atomic") {
    await runDispatch(producer, blob, site, step.execute, targetNamespace);
    return;
  }
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
    const progress = {
      operationId,
      dispatchId: step.execute.dispatchId,
      skipped: false,
    };
    await onProgress?.(progress, "none");
    try {
      await executeDispatch(producer, blob, step.execute, targetNamespace);
    } catch (error) {
      const sql = sliceDispatch(blob, step.execute);
      if (refusedWhole(error, sql, producer.dialect)) {
        const refused = refusal(site, step.execute.dispatchId, error, {
          effectState: "none",
          partial: true,
        });
        // Unrecorded, the announcement stands: it may have committed.
        await onProgress?.(
          progress,
          "none",
          `${refused.code}: ${refused.message}`
        )?.catch(() => undefined);
        throw refused;
      }
      throw new MigrationError(
        `Opaque stepwise dispatch ${step.execute.dispatchId} failed with an ambiguous outcome`,
        VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
        {
          cause: errorCause(error),
          meta: {
            ...siteMeta(site, step.execute.dispatchId),
            lastConfirmedStep: step.execute.dispatchId,
            effectState: "may-have-committed",
            partial: true,
          },
        }
      );
    }
    await onProgress?.(progress, "committed");
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

/**
 * The one owner of "authored checks must hold": every one of `checks` holds,
 * else `refusal` is the command's MIGRATION_DRIFT. Inside one request (plan
 * D7) each is asserted there instead, as its {@link checkCondition}.
 */
export async function assertAllChecks(
  producer: AnyDriver,
  blob: Uint8Array,
  checks: readonly MigrationBooleanCheckV1[],
  targetNamespace: string | undefined,
  refusal: string,
  batch?: MigrationBatch
): Promise<void> {
  const drift = () =>
    new MigrationError(refusal, VibORMErrorCode.MIGRATION_DRIFT);
  if (batch) {
    for (const check of checks) {
      const { sql, params } = checkCondition(blob, check, targetNamespace);
      batch.assert(sql, params, drift());
    }
    return;
  }
  if (!(await evaluateAllChecks(producer, blob, checks, targetNamespace))) {
    throw drift();
  }
}
