// biome-ignore-all lint/style/useFilenamingConvention: OperationFragment is the architecture name.
import { NestedWriteError, NotFoundError, TransactionError } from "@errors";
import type { Sql } from "@sql";
import type { RecordSeriesOperation } from "./record-series";

export const OPERATION_VALUE_REFERENCE = Symbol(
  "viborm.operationValueReference"
);

/**
 * A promised value: "whatever step X produced under name Y" (ATOM's
 * `The execution vocabulary`). A plain marker that rides inside `Sql.values`;
 * it cannot collide with user data because its `kind` is a unique symbol.
 */
export interface OperationValueReference {
  readonly kind: typeof OPERATION_VALUE_REFERENCE;
  readonly step: string;
  readonly output: string;
}

type ConsumedStatementValue =
  | { readonly kind: "literal"; readonly value: unknown }
  | {
      readonly kind: "reference";
      readonly reference: OperationValueReference;
    };

/**
 * Where a produced value comes from — capability knowledge (ATOM's
 * `The execution vocabulary`). Declaring the source gives every value a stable
 * address consumers use identically under `RETURNING` and `insertId`
 * capabilities.
 */
export type StatementOutputSource =
  | { readonly kind: "rows" }
  | { readonly kind: "rowCount" }
  | { readonly kind: "insertId" }
  | {
      /**
       * Publish the exact pre-cast value this successful statement consumed.
       *
       * This is not generated-value inference: the statement compiler supplies
       * the same literal or backward reference it put in the mutation assignment.
       * The executor exposes it only after the statement succeeds. It lets a row
       * that receives its identity from a selected relation arm become the single
       * publication owner for descendants and terminal selection, including on a
       * non-returning provider.
       */
      readonly kind: "consumedValue";
      readonly source: ConsumedStatementValue;
    }
  | {
      readonly kind: "firstRowField";
      readonly field: string;
      /**
       * Tolerate an empty result (resolve to `undefined`) instead of throwing.
       * Set only when an empty probe selects another branch, leaving this output
       * without a compiled consumer. A required read never sets it.
       */
      readonly optional?: boolean;
    };

/**
 * A typed operation failure (ATOM's `The execution vocabulary`). Carries the
 * full V1 taxonomy and the `raceable` bit whose values are fixed by the branch
 * premise classes.
 */
export interface Failure {
  readonly kind: "nestedWrite" | "notFound" | "query";
  readonly message: string;
  readonly relation?: string;
  readonly raceable: boolean;
}

/**
 * A statement postcondition — what constitutes success (ATOM's `The execution
 * vocabulary` and README's `Execution atom`). Enforced where the substrate
 * allows: transaction mode checks the provider result before commit.
 */
export type Postcondition =
  | { readonly kind: "exactlyOneRow"; readonly failure: Failure }
  | {
      readonly kind: "affectedRows";
      readonly expected: number | { readonly min: number };
      readonly failure: Failure;
    };

/**
 * A pinned unique-target annotation carried by a write whose unique-constraint
 * violation is the raceable signal (ATOM's `Branch premises and pins`).
 * Construct it by reusing the `TargetConstraint` machinery
 * (`uniqueConflictTarget`), never by reinventing target resolution.
 */
export interface TargetConstraintPin {
  readonly fields: readonly string[];
  readonly table: string;
  readonly columns: readonly string[];
  readonly constraints: readonly string[];
}

export interface StatementStepBase {
  readonly id: string;
  readonly statement: Sql;
  readonly outputs: Readonly<Record<string, StatementOutputSource>>;
  /**
   * Public model whose rows this statement addresses, when the compiler that
   * emitted it knows one. A nested subtree's statements belong to the nested
   * model, not to the public operation's root model, and the executor hands
   * that attribution to the driver so a provider failure names the model whose
   * table and constraint the provider already named. Absent on statements no
   * single model owns (a junction row, an adapter-lowered batch reference);
   * those keep the operation's own attribution.
   */
  readonly model?: string;
  /** Statement postcondition — see README's `Execution atom`. */
  readonly expects?: Postcondition;
  /**
   * Exact premise a later non-atomic segment must re-assert when it consumes a
   * provider value this step published. The compiler owns the premise because
   * only it knows both the complete row identity and any non-row-key membership
   * value the consumer will spend. Atomic execution ignores it.
   */
  readonly progressiveContinuation?: GuardStep;
}

export interface ReadStep extends StatementStepBase {
  readonly kind: "read";
}

export interface WriteStep extends StatementStepBase {
  readonly kind: "write";
  /** Present on writes whose unique-constraint violation is the raceable signal. */
  readonly racePin?: TargetConstraintPin;
  /**
   * The `onUniqueConflict: "skip"` bulk disposition (ATOM's `Bulk
   * specializations`): a write whose unique-constraint violation is *absorbed*
   * rather than propagated — the
   * `createMany` skipDuplicates row on a dialect whose skip strategy is
   * `recoverableUniqueError` (no portable `ON CONFLICT DO NOTHING` that reports a
   * skipped-row count). It is an **executor effect**, not a plain SQL leaf: the
   * executor runs the write behind a savepoint and, on a unique violation,
   * yields a zero-row result instead of aborting the atomic unit (V1's
   * `executeSkippableWrite`). It has no lowering to a plain atomic batch, so a
   * batch-mode step carrying it fails closed. Dialects whose skip *is* a plain
   * SQL leaf (`INSERT … ON CONFLICT DO NOTHING`, `INSERT OR IGNORE`) never set
   * this — the leaf carries the semantics and lowers to batch unchanged.
   */
  readonly onUniqueConflict?: "skip";
}

export type StatementStep = ReadStep | WriteStep;

export interface GuardStep {
  readonly id: string;
  readonly kind: "guard";
  readonly premise: {
    readonly kind: "exists" | "notExists";
    readonly statement: Sql;
  };
  readonly failure: Failure;
}

/**
 * Suspend the enclosing record fragment at one exact ordered position and run a
 * data-dependent number of ordinary record operations before the fragment resumes.
 *
 * This is the nested placement of the existing record-series execution form. It
 * carries no SQL and publishes no value into its enclosing fragment. Planning
 * fragments remain statement-only: a nested series is selected only after the
 * enclosing operation has completed its one planning phase.
 */
export interface RecordSeriesStep {
  readonly id: string;
  readonly kind: "recordSeries";
  readonly series: RecordSeriesOperation;
  /**
   * A progressive commit creates a concurrency boundary that an interactive
   * transaction does not have. The compiler must either provide the exact
   * existing-row premise every later write batch can re-assert, or name why this
   * placement cannot run progressively. Runtime value materialization alone is
   * never an existence or membership proof.
   */
  readonly progressive:
    | { readonly kind: "guarded"; readonly guard: GuardStep }
    | { readonly kind: "unsupported"; readonly reason: string };
}

export type OperationStep = StatementStep | GuardStep | RecordSeriesStep;

/**
 * A fragment output names either a single produced value or an ordered list of
 * them, whose rows concatenate and whose counts sum (ATOM's `The execution
 * vocabulary`) — e.g. `createManyAndReturn` on non-returning drivers and SQLite
 * `createMany`.
 */
export type FragmentOutputSource =
  | OperationValueReference
  | readonly OperationValueReference[];

export interface OperationFragment {
  readonly steps: readonly OperationStep[];
  readonly outputs: Readonly<Record<string, FragmentOutputSource>>;
}

export interface PlanningFragment {
  // No outputs map: planning publication is DERIVED — the executor exposes
  // every declared statement output under `planningKey(step.id, name)`, so a
  // producer cannot under-publish (the old hand-built maps could) and a
  // capture cannot land its members on a different address than they expect.
  // Final `OperationFragment` output selection stays explicit.
  readonly steps: readonly StatementStep[];
}

export function bucketOperationSteps(
  steps: readonly OperationStep[],
  guards: OperationStep[],
  statements: OperationStep[]
): void {
  for (const step of steps) {
    (step.kind === "guard" ? guards : statements).push(step);
  }
}

export function ref(step: string, output: string): OperationValueReference {
  return { kind: OPERATION_VALUE_REFERENCE, step, output };
}

export function isOperationValueReference(
  value: unknown
): value is OperationValueReference {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === OPERATION_VALUE_REFERENCE &&
    "step" in value &&
    typeof value.step === "string" &&
    "output" in value &&
    typeof value.output === "string"
  );
}

/**
 * Materialize a step's declared {@link Failure} as its typed error — the ONE
 * Failure→Error construction, shared by normal execution and merged-batch
 * attribution (their ATTRIBUTION algorithms stay separate; only what a failure
 * becomes is one fact).
 */
export function createFailureError(
  failure: Failure,
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
  // A `query` guard abort can be raceable too — the sole producer is the
  // retained notExists skip-premise pin (`raceableQueryFailure`, ATOM "Branch
  // premises and pins"). The mark is what lets the routed retry re-plan and
  // converge; dropping it here strands the flag the fragment validator required.
  if (failure.raceable) {
    error.meta.raceable = true;
  }
  return error;
}

/**
 * SQL-bound reference discovery. A statement can also forward a prior output
 * through `consumedValue`; {@link statementOutputReferences} owns that distinct
 * output view. Dependency consumers combine both views, while per-value
 * substitution stays local because each execution substrate owns what replaces
 * a reference.
 */
export function statementReferences(
  statement: Sql
): readonly OperationValueReference[] {
  return statement.values.filter(isOperationValueReference);
}

/** Backward references carried by value-forwarding statement outputs. */
export function statementOutputReferences(
  step: StatementStep
): readonly OperationValueReference[] {
  const references: OperationValueReference[] = [];
  for (const source of Object.values(step.outputs)) {
    if (source.kind === "consumedValue" && source.source.kind === "reference") {
      references.push(source.source.reference);
    }
  }
  return references;
}

/** Discovery-only fast view: does the statement hold ANY reference? */
export function statementHasReferences(statement: Sql): boolean {
  return statement.values.some(isOperationValueReference);
}
