// biome-ignore-all lint/style/useFilenamingConvention: OperationFragment is the architecture name.
import type { Sql } from "@sql";

export const OPERATION_VALUE_REFERENCE = Symbol(
  "viborm.operationValueReference"
);

/**
 * A promised value: "whatever step X produced under name Y" (ATOM §1 `Ref`).
 * A plain marker that rides inside `Sql.values`; it cannot collide with user
 * data because its `kind` is a unique symbol.
 */
export interface OperationValueReference {
  readonly kind: typeof OPERATION_VALUE_REFERENCE;
  readonly step: string;
  readonly output: string;
}

/**
 * Where a produced value comes from — capability knowledge (ATOM §1 `Source`).
 * Declaring the source gives every value a stable address consumers use
 * identically under `RETURNING` and `insertId` capabilities.
 */
export type StatementOutputSource =
  | { readonly kind: "rows" }
  | { readonly kind: "rowCount" }
  | { readonly kind: "insertId" }
  | {
      readonly kind: "firstRowField";
      readonly field: string;
      /**
       * Tolerate an empty result (resolve to `undefined`) instead of throwing.
       * Set ONLY on a locate whose missing row is a legitimate branch — an upsert
       * update arm's superset locate (`locateNotFoundOptional`): when the create
       * arm is taken the parent is absent, so this firstRowField has no compiled
       * consumer and must not fail planning. A required locate never sets it.
       */
      readonly optional?: boolean;
    };

/**
 * A typed operation failure (ATOM §1 `Failure`). Carries the full V1 taxonomy
 * and the `raceable` bit whose values are fixed by the Pin Rule classes.
 */
export interface Failure {
  readonly kind: "nestedWrite" | "notFound" | "query";
  readonly message: string;
  readonly relation?: string;
  readonly raceable: boolean;
}

/**
 * A statement postcondition — what constitutes success (ATOM §1 / README §6).
 * Enforced where the substrate allows: transaction mode checks the provider
 * result before commit.
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
 * violation is the raceable signal (ATOM §1 `racePin`). Construct it by reusing
 * the `TargetConstraint` machinery (`uniqueConflictTarget`), never by
 * reinventing target resolution.
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
  /** Statement postcondition — what constitutes success (README §6). */
  readonly expects?: Postcondition;
}

export interface ReadStep extends StatementStepBase {
  readonly kind: "read";
}

export interface WriteStep extends StatementStepBase {
  readonly kind: "write";
  /** Present on writes whose unique-constraint violation is the raceable signal. */
  readonly racePin?: TargetConstraintPin;
  /**
   * The census's `onUniqueConflict: "skip"` disposition (ATOM §8): a write whose
   * unique-constraint violation is *absorbed* rather than propagated — the
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

export type OperationStep = StatementStep | GuardStep;

/**
 * A probe pairs a planning read with the premise its decision creates (ATOM §2).
 * The pairing is structural, not conventional: it is how the Pin Rule stays
 * machine-checkable when a branch decision moves into opaque compile-time JS.
 * `compile(known)` consumes the probe and emits the taken branch through it, so
 * the branch contributes the correct pin (or none) automatically.
 */
export interface Probe {
  /** The planning read (locked in transaction mode). */
  readonly read: ReadStep;
  readonly pin: {
    /** Existing-row premise: pinned, `raceable: false`. */
    readonly whenFound: GuardStep | "none";
    /**
     * `"constraint"`: the branch INSERTs into the same model under the unique
     * key — the database constraint enforces the premise and its violation is
     * the raceable signal (`racePin` on the write). Emitting a `notExists`
     * guard here is the production-FATAL class; these are NEVER pinned.
     */
    readonly whenMissing: GuardStep | "constraint" | "none";
  };
}

/**
 * A fragment output names either a single produced value or an ordered list of
 * them, whose rows concatenate and whose counts sum (ATOM §1) — e.g.
 * `createManyAndReturn` on non-returning drivers and SQLite `createMany`.
 */
export type FragmentOutputSource =
  | OperationValueReference
  | readonly OperationValueReference[];

export interface OperationFragment {
  readonly steps: readonly OperationStep[];
  readonly outputs: Readonly<Record<string, FragmentOutputSource>>;
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
