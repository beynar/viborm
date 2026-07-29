import { TransactionError } from "@errors";
import type { Model } from "@schema/model";
import type { QueryEngine } from "../query-engine/query-engine";
import type { ParentIdSource } from "./RelationUpsertPart";
import type { StepScope } from "./StepScope";

/**
 * X1c — how a nested UPDATE target (a to-many / inverse-to-one child, or a
 * parent-held to-one) whose data carries a mechanism the child-Part builder cannot
 * fold in place — a **parent-held to-one write** (its identity folded into the
 * target's OWN update SET — child-SET folding) or a **non-PK / compound referenced
 * edge** (D4) — is located and correlated by the delegated {@link UpdateOperation}.
 * The correlation is the ONE piece the located-target reuse adds over `nestedFresh`
 * (a fresh create needs no locate): the target is verified to belong to the
 * enclosing parent by `child.<childFields[i]> = parent.<parentFields[i]>` (a SQL
 * `Ref` to the enclosing locate for a `planned` parent — technique #1 — or an
 * inlined literal), ANDed with the target's own unique `where` when it has one (a
 * child-held to-many `update`; a to-one / parent-held target locates by correlation
 * alone). A located miss is the target's own `Cannot … relation` not-found, not the
 * root not-found.
 */
export interface NestedTargetLocate {
  /** The target's unique selector (child-held to-many `update`); absent for a
   *  to-one / parent-held target located by correlation alone. */
  readonly where?: Record<string, unknown>;
  /** The enclosing parent's id — a `planned` locate (a SQL `Ref`) or a compile-time
   *  literal (a depth-composed literal-parent target). */
  readonly parentId: ParentIdSource;
  /** The target's correlation columns (child-held: its FK; parent-held: the columns
   *  the parent's FK references), index-aligned with {@link parentFields}. */
  readonly childFields: readonly string[];
  /** The enclosing parent's columns the correlation reads (child-held: the parent's
   *  referenced columns; parent-held: the parent's FK columns). */
  readonly parentFields: readonly string[];
  /** W4-U3 — the to-one `update: { where, data }` wrapper's NON-unique filter on the
   *  currently connected record. ANDed into the locate (and the batch presence guard)
   *  alongside the correlation: a connected row that fails it makes the locate empty,
   *  so the target's own not-found fires and the whole operation aborts atomically,
   *  state unchanged. Absent for the bare `update: <data>` spelling — then the locate
   *  is byte-identical to pre-W4-U3. Never compiled into the WRITE (which addresses
   *  the captured primary key), so a relation filter here is portable. */
  readonly filter?: Record<string, unknown>;
  readonly relationName: string;
  /** V1's byte-identical `Cannot … relation … for this parent` not-found message
   *  the enclosing caller sources from `relationTargetNotFound(info, "update")`. */
  readonly notFoundMessage: string;
}

/**
 * How a root operation is reused as one arm of a composing operation (T3c — the
 * top-level `upsert`'s create/update arms compose the create-root / update-root
 * machinery, TO-ONE.md §7.8). A `CreateOperation`/`UpdateOperation` constructed
 * with these options is NOT a standalone operation: it shares the enclosing
 * operation's {@link StepScope} (so no two arms collide on a step id), and it
 * defers the analyses the enclosing operation must run **per-arm** — V1's upsert
 * runs the own-write barrier inside the taken branch only, so a violation in an
 * un-taken arm must not reject the whole tree (`skipOwnWrite` hands that timing to
 * the caller). The absent-row postcondition is dropped for the update arm
 * (`locateNotFoundOptional`): under an upsert a located-miss is the CREATE
 * decision, not a not-found error.
 */
export interface SubOperationOptions {
  /** Share the enclosing operation's id allocator instead of minting a fresh one. */
  readonly scope?: StepScope;
  /** Skip the constructor own-write preflight; the caller runs it per-arm (deferred). */
  readonly skipOwnWrite?: boolean;
  /** Drop the locate's exactly-one-row postcondition (upsert: absent → create arm). */
  readonly locateNotFoundOptional?: boolean;
  /**
   * Skip the constructor payload-legality analyses (whole-args validation, PK-arithmetic
   * portability, relation-key-update legality) and expose them as a method the caller runs
   * per-arm. V1's upsert validates its update branch INSIDE the whenTrue branch only — an
   * invalid UNTAKEN update branch (the create arm is taken) must not reject the whole tree.
   */
  readonly deferArmLegality?: boolean;
  /**
   * X1b — a nested fresh `create` at DEPTH: this `CreateOperation` is not a standalone
   * operation but a create SUBTREE spliced under a located target's write (a nested
   * `create` arm one or more levels deep). It carries the ALREADY-VALIDATED create data
   * (`data` — the enclosing operation's whole-args parse validated the whole tree, so this
   * subtree does NOT re-parse; re-parsing a schema's transformed output is non-idempotent,
   * X2). It emits NO terminal read (the enclosing operation owns the result), and it folds
   * the located parent's foreign key into its ROOT record's INSERT via `rootFkInject`,
   * resolved at COMPILE (a `literal` parent id yields a constant; a `planned` parent id
   * reads the located row from `known`). Every mechanism the create ROOT already
   * supports — a database-generated / compound PK (backward `Ref` / per-field identity),
   * a parent-held-FK to-one grandchild (before-parent create), the fresh-parent adopt
   * family and M2M — falls out unchanged, one architecture, at any depth.
   */
  readonly nestedFresh?: {
    readonly data: Record<string, unknown>;
    readonly rootFkInject: (
      known: Readonly<Record<string, unknown>>
    ) => Record<string, unknown>;
  };
  /**
   * X1c — a nested UPDATE target at DEPTH whose data carries the located-target
   * projection of mechanism 1/2 (a parent-held to-one write needing child-SET
   * folding, or a non-PK / compound referenced edge — D4) is not folded in place by
   * the child-Part builder; the whole target UPDATE delegates to this operation, the
   * update-root analogue of `nestedFresh`. It carries the ALREADY-PARSED update
   * `data` — the enclosing operation's relation-schema parse produced it, and that
   * schema IS this target's `core.update`, so every scalar SET and relation payload
   * below is already in post-transform form and NOTHING here parses again (a
   * transform is not idempotent: a JSON write's `{ set: … }` envelope is itself a
   * legal JSON document, so a second pass persists the ORM's envelope as the user's
   * data). It emits NO terminal read (the enclosing op owns the result), it shares the
   * enclosing `StepScope`, and it LOCATES + CORRELATES the target to its enclosing
   * parent ({@link NestedTargetLocate}). Every mechanism the update ROOT already
   * carries — a parent-held to-one before-root write folded into the SET, a
   * generated / D4 referenced identity threaded from the located row, the PK-transition
   * reorder, the child-held / m2m families — falls out unchanged, one architecture,
   * at any depth.
   */
  readonly nestedTarget?: {
    readonly data: Record<string, unknown>;
    readonly locate: NestedTargetLocate;
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type ExecutionMode = "transaction" | "batch";

/**
 * Pick the compile-time execution substrate from driver capability. A driver
 * with neither substrate gets the nominal `"transaction"` mode rather than a
 * throw here: a **single-statement** operation (a read, a scalar bulk write)
 * runs directly with no atomic envelope on any driver (V1's statement-atomicity),
 * so it must be constructible. The executor enforces the capability requirement
 * for a **multi-statement** operation, failing closed with V1's byte-identical
 * {@link TransactionError} (see `OperationExecutor.execute`).
 */
export function selectExecutionMode(
  engine: QueryEngine,
  _operation: string
): ExecutionMode {
  if (engine.driver.supportsBatch && !engine.driver.supportsTransactions) {
    return "batch";
  }
  return "transaction";
}

/**
 * V1's byte-identical "no atomic substrate" failure, raised by the executor when
 * a multi-statement operation cannot run (a single-statement one runs directly).
 */
export function noAtomicSubstrateError(
  driverName: string,
  operation: string
): TransactionError {
  return new TransactionError(
    `Driver '${driverName}' supports neither transactions nor atomic batch execution.`,
    { meta: { driver: driverName, operation } }
  );
}

/**
 * Thrown by a concrete operation's constructor when the requested payload shape is
 * outside V2's supported family (a wrong argument key, an unsupported relation kind, a
 * compound key or a non-literal fold at a documented boundary, …). **Post-P6 there is no V1
 * and no fallback:** this error PROPAGATES as a typed refusal — the pre-P6 framing (the P2a
 * proxy switched on it to "let V1 handle this whole tree") describes a mechanism deleted at
 * P6. Every shape that raises it is either a PARITY REFUSAL V1 also rejected, or a DOCUMENTED
 * narrower boundary reached by no conformance scenario (route-inventory category iii); the
 * decline-surface gate proves no accept-and-execute shape raises it. Any other construction
 * error (a `ValidationError` from the parse boundary, the own-write preflight rejection) is a
 * real failure the schema / preflight raises and likewise propagates.
 *
 * The class itself lives in `src/errors/query.ts` (public surface: its own
 * `diagnosticName` and `V8003 UNSUPPORTED_OPERATION` code, exported from the
 * package root so users can `instanceof` a deliberate capability boundary
 * instead of seeing a `V9001` engine crash); re-exported here so every engine
 * throw site and test keeps one import home.
 */
export { UnsupportedOperationError } from "@errors";

export function getStepModelName(model: Model<any>, fallback: string): string {
  return model["~"].names.ts ?? model["~"].names.sql ?? fallback;
}
