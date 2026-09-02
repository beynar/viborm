/**
 * K3 — premises, fragments and programs (pattern-engine-ideal-state.md §6, §8,
 * §13.2).
 *
 * Statements reuse the existing execution vocabulary (`OperationStep` and its
 * step kinds): it is already the target algebra, the executors already run it,
 * and reusing it makes the differential (K4) a plain comparison. What this
 * module adds is what the scheduler knows and the vocabulary did not carry:
 * the premise a read states, the reason a fragment ended, and the program as
 * an ordered list of fragments.
 */
import type {
  GuardStep,
  OperationStep,
  StatementStep,
  TargetConstraintPin,
} from "../write-engine/OperationFragment";
import type { RowId, VariableId } from "./pattern";

// ---------------------------------------------------------------------------
// Premises (D6)
// ---------------------------------------------------------------------------

/**
 * What an assertion relies on, stated once by the match that produced the
 * bindings it consumes. The executor enforces it: a locked match in a
 * transaction, a guard statement in an atomic batch, the guard repeated in each
 * later segment.
 */
export type Premise =
  | {
      /** The matched row still exists, addressed by its captured key. Not raceable: it was replaced or removed after the decision. */
      readonly kind: "exists";
      readonly row: RowId;
      readonly raceable: false;
    }
  | {
      /**
       * The row the match did not find still does not exist. Raceable iff a
       * same-target unique constraint will catch the race at the insert (the Pin
       * Rule, ATOM §12); the pin then rides the write, not a guard.
       */
      readonly kind: "notExists";
      readonly row: RowId;
      readonly raceable: boolean;
      readonly pin?: TargetConstraintPin;
    }
  | {
      /** The unique reference cell's occupant is exactly `occupant` (or none). */
      readonly kind: "occupant";
      readonly row: RowId;
      readonly occupant: RowId | undefined;
      readonly raceable: boolean;
    }
  | {
      /** No holder still references the old key (occupied-slot refusal before a non-cascading transition). */
      readonly kind: "unreferenced";
      readonly row: RowId;
      readonly raceable: false;
    };

/**
 * A premise bound to its enforcement. `guard` is present when packing decided
 * the batch guard is NOT the match re-run (the probe-first upsert's
 * selector-plus-key reassertion, the singular transfer's `take: 1` guard);
 * otherwise the executor derives the guard from the match statement.
 */
export interface BoundPremise {
  readonly premise: Premise;
  /** The match statement whose bindings the premise protects. */
  readonly match: StatementStep;
  readonly guard?: GuardStep;
}

// ---------------------------------------------------------------------------
// Fragments (D5)
// ---------------------------------------------------------------------------

export type FragmentBoundary =
  | { readonly kind: "end" }
  | {
      /** A variable is bound only by executing `statement`; the substrate cannot bind it in place. */
      readonly kind: "executionBinding";
      readonly variable: VariableId;
      readonly statement: string;
    }
  | {
      /** A bulk member must observe the previous member's assertions (row N sees row N−1). */
      readonly kind: "member";
      readonly index: number;
    }
  | {
      /** A merge outcome (skipDuplicates root) must be observed before its dependents assert. */
      readonly kind: "mergeOutcome";
      readonly row: RowId;
    };

/**
 * One fragment: its matches (run first, grouped by dependency level), then its
 * asserts and retracts in dataflow order, the premises the asserts rely on, and
 * why it ended. `steps` are the existing vocabulary so the executors and the
 * differential consume them unchanged; guard steps appear only where packing
 * supplied an explicit guard (see {@link BoundPremise.guard}).
 */
export interface Fragment {
  /** Matches, grouped by dependency level; each level is one round trip. */
  readonly matches: readonly (readonly StatementStep[])[];
  /** Asserts and retracts in dataflow order (already respecting the anti-dependency). */
  readonly writes: readonly OperationStep[];
  readonly premises: readonly BoundPremise[];
  /**
   * Inherited premises a later segment must re-assert: the parent's complete
   * row key (liveness) and the exact referenced tuple each later write stores
   * (membership). Empty for a junction side or a polymorphic inverse, whose
   * reference is the complete key by construction.
   */
  readonly inherited: readonly BoundPremise[];
  readonly boundary: FragmentBoundary;
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

/** The scheduled pattern: fragments in order, plus the terminal projection's outputs. */
export interface Program {
  readonly fragments: readonly Fragment[];
  /** Step ids published to the terminal result (the existing fragment `outputs` contract). */
  readonly outputs: Readonly<Record<string, string | readonly string[]>>;
  /** Public model and operation, for attribution of engine-owned failures. */
  readonly model: string;
  readonly operation: string;
}
