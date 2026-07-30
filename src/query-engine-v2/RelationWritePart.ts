// biome-ignore-all lint/style/useFilenamingConvention: RelationWritePart is the architecture name.
import { NestedWriteError, QueryEngineError } from "@errors";
import type { Sql } from "@sql";
import { splitToOneUpdateTarget } from "@validation/relations/to-one-update-form";
import { getPrimaryKeyFields } from "../query-engine/builders/correlation-utils";
import {
  getFkDirection,
  type RelationMutation,
  separateData,
} from "../query-engine/builders/relation-data-builder";
import { buildInsert } from "../query-engine/builders/values-builder";
import { getWhereUniqueEntries } from "../query-engine/builders/where-unique-builder";
import {
  createQueryScope,
  getTableName,
} from "../query-engine/context/query-scope";
import {
  buildDelete,
  buildDeleteMany,
  buildFind,
  buildFindUnique,
  buildUpdate,
  buildUpdateMany,
} from "../query-engine/operations";
import {
  assertPortablePrimaryKeyUpdateInput,
  getUpdatedPrimaryKeyValue,
} from "../query-engine/operations/mutation-identity";
import type { QueryEngine } from "../query-engine/query-engine";
import { assertRelationKeyUpdatesAreCompilable } from "../query-engine/relation-key-legality";
import type { QueryScope, RelationInfo } from "../query-engine/types";
import {
  absenceGuard,
  affectedRows,
  exactlyOneRow,
  nestedWriteFailure,
  presenceGuard,
  referenceSql,
} from "./fragment-builders";
import {
  relationKeyOccupiedMessage,
  relationTargetNotFound,
  setRequiredOrphan,
  upsertPremiseChanged,
  upsertTargetVanished,
} from "./messages";
import {
  buildNestedTargetUpdatePart,
  type FreshArmBuilder,
  type NestedChildBuilder,
  targetNeedsFullUpdate,
} from "./nested-target-parts";
import type { OperationStep, StatementStep } from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { planningKey } from "./Part";
import { referencedFieldRef, referencedFieldValue } from "./parent-reference";
import {
  literalParentId,
  type ParentIdSource,
  plannedParentId,
} from "./RelationUpsertPart";
import type { StepScope } from "./StepScope";
import {
  getStepModelName,
  sameScalarValue,
  UnsupportedOperationError,
  uniqueSelectorConjuncts,
} from "./shared";

/**
 * The correlated child-write family (PLAN P2c): nested `update` / `updateMany` /
 * `delete` / `deleteMany` on a child-held-FK to-many relation. Each is a root
 * write plus an FK edge (WHY §4.2) — the same shape as connect/disconnect
 * (`RelationLinkPart`), differing only in the SQL leaf and the failure name
 * (WHY §4.1 "one write part, leaves differ"). No new vocabulary.
 *
 * - **targeted** (`update` one, `delete` one): a *correlated* existence probe —
 *   `WHERE unique AND fk = Ref(parentLocate)` (technique #1's SQL-level
 *   planning→planning `Ref`) with **no** found-uncorrelated arm; present →
 *   `UPDATE … SET data` / `DELETE … WHERE unique`, pinned in batch by an exists
 *   guard on the correlated row; absent → V1's verbatim `Cannot {op} … for this
 *   parent` error.
 * - **bulk** (`updateMany`, `deleteMany`): no probe — one correlated bulk write
 *   `WHERE fk = parent AND filter`; zero matched rows is a silent success (V1's
 *   contract), so no postcondition.
 *
 * The membership/target row sets never cross a write boundary at runtime (ATOM
 * §3 corollary): the located parent id is inlined at compile as a literal, and
 * every correlation is expressed in SQL.
 */
export type RelationWriteKind =
  | "delete"
  | "deleteMany"
  | "update"
  | "updateMany";

export interface RelationWriteConfig {
  readonly engine: QueryEngine;
  readonly childScope: QueryScope;
  readonly childName: string;
  readonly relationName: string;
  readonly relationInfo: RelationInfo;
  readonly kind: RelationWriteKind;
  /**
   * The child-held foreign-key columns and the parent columns they reference,
   * index-aligned (compound keys are per-field, ATOM §1's multi-field produces).
   * A single-column edge is the length-1 case; nothing else changes.
   */
  readonly fkFields: readonly string[];
  readonly referencedFields: readonly string[];
  readonly childPrimaryKey: string;
  /** The located parent id (a planning value, inlined as a literal at compile). */
  readonly parentId: ParentIdSource;
  readonly txMode: boolean;
  /** Targeted (`update`/`delete`): the child's unique locator. */
  readonly where?: Record<string, unknown>;
  /** Targeted `update`: the validated scalar data (nested relations rejected). */
  readonly data?: Record<string, unknown>;
  /** Bulk (`updateMany`/`deleteMany`): the user filter, correlated to the parent. */
  readonly filter?: Record<string, unknown>;
  /**
   * W4-U3 — an **inverse-side to-one** `update: { where, data }`: the NON-unique
   * `WhereInput` the CURRENTLY CONNECTED record must satisfy. It is ANDed into the
   * correlated probe and the batch presence guard, never into the write (which
   * addresses the captured PK), so a connected row that fails it simply leaves the
   * probe empty — already this family's `Cannot update … for this parent` abort,
   * atomic on both substrates. Distinct from {@link filter}: a bulk filter selects a
   * possibly-empty set and matching nothing is a silent success; this one is a
   * precondition on the single connected row.
   */
  readonly targetFilter?: Record<string, unknown>;
  /**
   * Inverse-side one-to-one **upsert** (TO-ONE.md §7.2, family F): the create-arm
   * scalar data taken when the correlated probe finds NO child of this parent. When
   * present, this `kind: "update"` part becomes an upsert — `data` is the found-arm
   * update payload, `upsertCreateData` the absent-arm insert payload (fk = parent
   * injected). The locator stays the FK correlation alone (no unique `where`); the
   * absent arm has no `racePin` and no found guard (V1's `missingPin: none`), the
   * found arm carries the upsert-family premise/vanished wording.
   */
  readonly upsertCreateData?: Record<string, unknown>;
  /**
   * N4-U2 — the inverse-side to-one upsert's CREATE arm when its payload carries
   * relations: the whole arm is a create SUBTREE (the {@link FreshArmBuilder} seam),
   * owning the arm's INSERT and every relation below it at any depth, exactly as the
   * to-many adopt family's create arm does. Absent for a scalar-only arm, which stays
   * {@link buildUpsertCreateArm}'s single INSERT, byte-identically.
   */
  readonly upsertCreateSubtree?: Part;
  /**
   * T3b mechanism 1: the recursion seam. When a targeted `update`'s `data` carries
   * nested relation writes, its located target builds its OWN child Parts through
   * this builder, exactly as a root update does — the family-B boundary lifted. The
   * target's primary key reaches them under either provenance (N4-U1): a {@link
   * literalParentId} when the unique `where` names it, a {@link plannedParentId} into
   * this part's own locate probe when some other unique does. A relation-carrying
   * `update` with no builder, a bulk `updateMany`, or an inverse-side to-one update
   * with no unique locator still declines.
   */
  readonly nestedBuilder?: NestedChildBuilder;
}

export class RelationWritePart implements Part {
  private readonly config: RelationWriteConfig;
  private readonly probeId: string;
  private readonly writeId: string;
  private readonly upsertCreateId?: string;
  private readonly guardId: string;
  private readonly probe?: StatementStep;
  // T3b mechanism 1 — the located target's own child Parts (built from its `data`
  // relations) and whether its self-UPDATE must land AFTER them (a PK transition it
  // rewrites, carried to the deeper FK by ON UPDATE CASCADE — the root's
  // `reorderRootUpdateAfterChildren` ported to depth). Empty / false when the
  // targeted update carries no nested relation writes.
  private readonly childParts: readonly Part[];
  private readonly reorderAfterChildren: boolean;
  // The validated scalar assignments of a targeted `update`/`updateMany` (∅ when a
  // relation-only nested update carries no scalars — then no self-UPDATE is emitted,
  // only the child Parts). Computed once at construction.
  private readonly updateScalarData?: Record<string, unknown>;
  // N4-U1: this part's own probe is the target's LOCATE, so its captured primary key
  // can be the deeper edges' parent value when the `where` does not name it. Set when
  // the child Parts were built against a `planned` source pointing at {@link probeId} —
  // the probe then owes them a `firstRowField` output and a not-found postcondition.
  private readonly probeCarriesLocatedPk: boolean;

  constructor(scope: StepScope, config: RelationWriteConfig) {
    this.config = config;
    this.probeId = scope.allocate(`${config.childName}.find`);
    this.writeId = scope.allocate(`${config.childName}.${config.kind}`);
    this.guardId = scope.allocate(`${config.childName}.guard.exists`);
    this.childParts = [];
    this.reorderAfterChildren = false;
    this.probeCarriesLocatedPk = false;
    // Payload-determined support decisions are made at CONSTRUCTION — before any
    // I/O — so a shape V2 does not own declines with a typed UnsupportedOperationError
    // that PROPAGATES (post-P6: no V1 fallback catches it). A nested relation write
    // inside `update`/`updateMany` data was, pre-T3b, such a shape; mechanism 1 now
    // folds it one level deeper (see `interpretChildParts`).
    if (config.kind === "update" || config.kind === "updateMany") {
      const built = this.interpretChildParts(scope);
      this.childParts = built.childParts;
      this.reorderAfterChildren = built.reorderAfterChildren;
      this.updateScalarData = built.scalarData;
      this.probeCarriesLocatedPk = built.parentIsLocatedPk;
      // MERGE (N4 + N5): the PK-arithmetic portability check that used to stand here
      // moved INTO `interpretChildParts` (N5-U1b) — it must run before that method
      // derives a post-transition primary key from the same scalar assignments.
    }
    if (config.upsertCreateData !== undefined && !config.upsertCreateSubtree) {
      // Family F: the absent-arm insert. Allocate its own write id and validate the
      // create payload at construction (no owned FK) before any I/O. A
      // relation-carrying arm took the subtree branch instead, and the subtree's own
      // create root owns both its id and its payload legality.
      this.upsertCreateId = scope.allocate(`${config.childName}.create`);
      this.upsertCreateScalarData();
    }
    // The probe is built LAST: whether it owes the deeper edges the located primary
    // key is a fact about the child Parts, which are interpreted above.
    this.probe = this.isTargeted() ? this.buildProbe() : undefined;
  }

  planning(scope: StepScope): readonly OperationStep[] {
    const steps: OperationStep[] = this.probe ? [this.probe] : [];
    // Depth (T3b mechanism 1): the located target's own child Parts plan their
    // probes here, one level deeper — the same unconditional planning superset the
    // root and the upsert-arm recursion already use (ATOM §3 technique 2). The
    // upsert CREATE arm's subtree plans here too, unconditionally: which arm compiles
    // is a compile-time decision, and planning is the widened superset of both.
    for (const child of this.childParts) steps.push(...child.planning(scope));
    if (this.config.upsertCreateSubtree) {
      steps.push(...this.config.upsertCreateSubtree.planning(scope));
    }
    return steps;
  }

  compile(scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    if (this.config.kind === "updateMany") return [this.buildUpdateMany(known)];
    if (this.config.kind === "deleteMany") return [this.buildDeleteMany(known)];
    return this.compileTargeted(scope, known);
  }

  /**
   * `update` one / `delete` one: the leaf write addresses the **captured PK** the
   * probe locked at planning, not the user selector (V1's mutation-identity, the
   * `WHERE id` mechanics). In batch mode the presence guard correlates the ORIGINAL
   * selector AND that captured PK on the same row (fk = parent too): a concurrent
   * "split-witness" that moves the selector to a replacement row leaves no row
   * matching both, so the guard fails and the batch rolls back — V2 never mutates
   * the replacement the selector-alone guard would have found.
   */
  private compileTargeted(
    scope: StepScope,
    known: PlanningKnown
  ): readonly OperationStep[] {
    if (this.config.upsertCreateData !== undefined) {
      return this.compileInverseToOneUpsert(scope, known);
    }
    const capturedPk = this.capturedPk(known);
    const capturedWhere = { [this.config.childPrimaryKey]: capturedPk };
    const steps: OperationStep[] = [];
    if (!this.config.txMode) {
      steps.push(
        presenceGuard(
          this.guardId,
          this.correlatedProbeStatement(known, false, capturedPk),
          this.targetFailure()
        )
      );
    }
    if (this.config.kind === "delete") {
      steps.push(this.buildDeleteOne(capturedWhere));
      return steps;
    }
    // `update` — mechanism 1. The self-UPDATE (emitted only when the payload carries
    // scalar assignments; a relation-only nested update writes no parent row) lands
    // BEFORE the located target's child Parts by default, or AFTER them when its SET
    // rewrites the target's own primary key (a PK transition the deeper FK references,
    // carried to the new value by ON UPDATE CASCADE — `reorderRootUpdateAfterChildren`
    // ported to depth). The child Parts correlate to the PRE-transition literal PK.
    const childSteps: OperationStep[] = [];
    for (const child of this.childParts) {
      childSteps.push(...child.compile(scope, known));
    }
    const selfUpdate = this.hasSelfUpdate()
      ? this.buildUpdateOne(capturedWhere)
      : undefined;
    if (selfUpdate && !this.reorderAfterChildren) steps.push(selfUpdate);
    steps.push(...childSteps);
    if (selfUpdate && this.reorderAfterChildren) steps.push(selfUpdate);
    return steps;
  }

  /** Whether a targeted `update` writes the target row itself (a non-empty scalar
   *  SET). A relation-only nested update (`{ friends: { connect } }`) writes only its
   *  child Parts — no empty-SET UPDATE. */
  private hasSelfUpdate(): boolean {
    return Object.keys(this.updateScalarData ?? {}).length > 0;
  }

  /**
   * Family F — the inverse-side one-to-one `upsert` (TO-ONE.md §7.2). The correlated
   * probe (`WHERE fk = parent`) already decided the three-way at plan time:
   *
   * - absent (0 rows) → CREATE arm: `INSERT child (createData, fk = parent)`. No
   *   `racePin`, no found guard — V1's `missingPin: none` for a to-one upsert with no
   *   unique `where` (the child FK's UNIQUE constraint is the sole invariant; a losing
   *   concurrent insert surfaces its constraint error, exactly as V1 leaves it).
   * - found → UPDATE arm: the captured correlated child, pinned in batch by an exists
   *   guard on `fk = parent AND pk = capturedPk` (the upsert-family premise wording),
   *   and in tx by the update's affected-rows expectation (the upsert-vanished wording).
   *
   * This composes the already-certified correlated-update leaf with a create leaf; the
   * root parent does not hold the FK, so no parent-side FK rebind follows.
   */
  private compileInverseToOneUpsert(
    scope: StepScope,
    known: PlanningKnown
  ): readonly OperationStep[] {
    const rows = this.probeRows(known);
    if (rows.length === 0) {
      return this.config.upsertCreateSubtree
        ? this.config.upsertCreateSubtree.compile(scope, known)
        : [this.buildUpsertCreateArm(known)];
    }
    const first = rows[0];
    if (!(first && typeof first === "object")) {
      throw new NestedWriteError(
        `query-engine-v2 upsert probe for relation '${this.config.relationName}' captured no row shape.`,
        this.config.relationName
      );
    }
    const capturedPk = (first as Record<string, unknown>)[
      this.config.childPrimaryKey
    ];
    const capturedWhere = { [this.config.childPrimaryKey]: capturedPk };
    const steps: OperationStep[] = [];
    if (!this.config.txMode) {
      steps.push(
        presenceGuard(
          this.guardId,
          this.correlatedProbeStatement(known, false, capturedPk),
          nestedWriteFailure(
            upsertPremiseChanged(this.config.relationName),
            this.config.relationName,
            false
          )
        )
      );
    }
    steps.push(this.buildUpsertUpdateArm(capturedWhere));
    return steps;
  }

  /** The correlated probe's rows without the target-not-found throw — the upsert's
   *  absent arm is legal, so an empty result is the CREATE decision, not an error. */
  private probeRows(known: PlanningKnown): readonly unknown[] {
    const rows = known[planningKey(this.probeId, "rows")];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 upsert probe for relation '${this.config.relationName}' did not expose rows.`,
        this.config.relationName
      );
    }
    return rows;
  }

  /** Found arm of the inverse-side to-one upsert: UPDATE the captured child, pinned
   *  in tx by the upsert-vanished affected-rows expectation. */
  private buildUpsertUpdateArm(where: Record<string, unknown>): StatementStep {
    const step: StatementStep = {
      id: this.writeId,
      kind: "write",
      statement: buildUpdate(this.config.childScope, {
        where,
        data: this.requireUpdateScalarData(),
        select: { [this.config.childPrimaryKey]: true },
      }),
      outputs: {},
    };
    if (!this.config.txMode) return step;
    return {
      ...step,
      expects: affectedRows(1, {
        kind: "notFound",
        message: upsertTargetVanished(this.config.relationName),
        relation: this.config.relationName,
        raceable: false,
      }),
    };
  }

  /** Absent arm of the inverse-side to-one upsert: INSERT the child with the FK set
   *  to the parent (V1's `childForeignKeys`), no `racePin`, no guard. */
  private buildUpsertCreateArm(known: PlanningKnown): StatementStep {
    return {
      id: this.upsertCreateId ?? this.writeId,
      kind: "write",
      statement: buildInsert(
        this.config.childScope,
        getTableName(this.config.childScope.model),
        {
          ...this.upsertCreateScalarData(),
          ...this.upsertFkAssignData(known),
        }
      ),
      outputs: {},
    };
  }

  /** The create-arm scalar data (validated: no nested relations, no owned FK). */
  private upsertCreateScalarData(): Record<string, unknown> {
    const createData = this.config.upsertCreateData;
    if (!createData) {
      throw new QueryEngineError(
        `query-engine-v2 upsert for relation '${this.config.relationName}' requires create data.`
      );
    }
    const { scalarData, relations } = separateData(
      this.config.childScope,
      createData
    );
    if (Object.keys(relations).length > 0) {
      // N4-U2 absorbed the relation-carrying arm: `buildInverseToOneUpsertPart` routes
      // it to the create SUBTREE and this method is never called for it (the
      // constructor gates on `upsertCreateSubtree`). Reaching here means an arm carries
      // relations AND no subtree was built — an engine invariant break, not a shape we
      // decline (the X1c disposition for a branch unreachable by construction). The
      // absorbed shape's own witness is in `inverse-to-one-create-behavior.ts`: a
      // conversion like this leaves the census grep either way, so the shape has to be
      // exercised somewhere or the count moved on nothing.
      throw new QueryEngineError(
        `query-engine-v2 internal: the upsert create arm for relation '${this.config.relationName}' carries nested relation writes but no create subtree.`
      );
    }
    if (
      this.config.fkFields.some((fkField) => Object.hasOwn(scalarData, fkField))
    ) {
      // Unreachable by construction (N7-U-A, the X1c disposition): the nested create
      // schema is `v.omit(core.create, fkFields)` (`toManyUpdateFactory.getCreateSchema`),
      // so spelling the owned FK in an upsert create arm is answered by the parse boundary
      // first (`ValidationError: Unknown key: <fkField>`). An engine invariant, not a
      // route — and NOT the same site as the nested UPDATE arm's FK, which IS reachable
      // and stays a Prisma-parity refusal (`RelationUpsertPart.ts` :847).
      throw new QueryEngineError(
        `query-engine-v2 internal: the upsert create arm for relation '${this.config.relationName}' carries the owned foreign key '${this.config.fkFields.join(", ")}', which the nested create schema omits.`
      );
    }
    return scalarData;
  }

  /** `fk_i = <parent_i>` for the create arm — the referenced parent column inlined
   *  as a compile-time literal (the parent was located by the root write). */
  private upsertFkAssignData(known: PlanningKnown): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (let index = 0; index < this.config.fkFields.length; index += 1) {
      const fkField = this.config.fkFields[index]!;
      data[fkField] = referenceSql(
        this.config.engine,
        this.config.childScope.model,
        fkField,
        referencedFieldValue(
          this.config.parentId,
          this.config.referencedFields[index]!,
          known,
          this.config.relationName,
          "upsert"
        )
      );
    }
    return data;
  }

  private buildUpdateOne(where: Record<string, unknown>): StatementStep {
    return {
      id: this.writeId,
      kind: "write",
      statement: buildUpdate(this.config.childScope, {
        where,
        data: this.requireUpdateScalarData(),
        select: { [this.config.childPrimaryKey]: true },
      }),
      outputs: {},
    };
  }

  private buildDeleteOne(where: Record<string, unknown>): StatementStep {
    return {
      id: this.writeId,
      kind: "write",
      statement: buildDelete(this.config.childScope, { where }),
      outputs: {},
    };
  }

  private buildUpdateMany(known: PlanningKnown): StatementStep {
    return {
      id: this.writeId,
      kind: "write",
      statement: buildUpdateMany(this.config.childScope, {
        where: this.correlatedFilter(known),
        data: this.requireUpdateScalarData(),
      }),
      outputs: {},
    };
  }

  private buildDeleteMany(known: PlanningKnown): StatementStep {
    return {
      id: this.writeId,
      kind: "write",
      statement: buildDeleteMany(this.config.childScope, {
        where: this.correlatedFilter(known),
      }),
      outputs: {},
    };
  }

  /**
   * The correlated existence probe for a targeted `update`/`delete`. A planning
   * step, so it correlates by a SQL `Ref` to the located-parent read in BOTH
   * modes (technique #1) — the literal is not known until that read runs.
   */
  private buildProbe(): StatementStep {
    const step: StatementStep = {
      id: this.probeId,
      kind: "read",
      statement: this.correlatedProbeStatement(undefined, true),
      outputs: { rows: { kind: "rows" } },
    };
    if (!this.probeCarriesLocatedPk) return step;
    // N4-U1: the deeper edges take this probe's captured primary key as a `planned`
    // source, so the probe must PUBLISH it — a `firstRowField` output the deeper
    // planning probes can `Ref` in SQL, alongside the `rows` the compile-time inline
    // already reads. That eager extraction throws on an empty result, so the probe also
    // carries the not-found postcondition here (enforced during planning, before any
    // write, with this family's own verbatim target-not-found wording) rather than
    // leaving it to `capturedPk` at compile. Exactly the shape the parent-held to-one
    // update probe already takes when its target carries child Parts
    // (UpdateOperation.buildParentHeldUpdate).
    return {
      ...step,
      outputs: {
        rows: { kind: "rows" },
        [this.config.childPrimaryKey]: {
          kind: "firstRowField",
          field: this.config.childPrimaryKey,
        },
      },
      expects: exactlyOneRow(this.targetFailure()),
    };
  }

  /**
   * `WHERE unique AND fk = <parent> [AND pk = <capturedPk>]`, limited to one row.
   * When `useRef` the correlation carries a SQL `Ref` to the located-parent
   * planning read (technique #1, in the planning probe); otherwise the located id
   * is inlined as a literal (the batch exists guard, a final-fragment step). The
   * batch guard additionally pins the captured PK so the selector and the row the
   * probe locked must still coincide (the split-witness correlation); the planning
   * probe omits it (it is what captures the PK).
   */
  private correlatedProbeStatement(
    known: PlanningKnown | undefined,
    useRef: boolean,
    capturedPk?: unknown
  ): Sql {
    return buildFind(
      this.config.childScope,
      {
        where: {
          AND: [
            ...this.optionalWhereFilters(),
            ...this.targetFilters(),
            ...this.correlationFilters(known, useRef),
            ...(capturedPk === undefined
              ? []
              : [{ [this.config.childPrimaryKey]: { equals: capturedPk } }]),
          ],
        },
        select: { [this.config.childPrimaryKey]: true },
        forUpdate: this.config.txMode,
      },
      { limit: 1 }
    );
  }

  /** `WHERE fk = <parentLiteral> [AND filter]` for a bulk write. */
  private correlatedFilter(known: PlanningKnown): Record<string, unknown> {
    const correlation =
      this.config.fkFields.length === 1
        ? this.correlationFilters(known, false)[0]!
        : { AND: this.correlationFilters(known, false) };
    const filter = this.config.filter;
    return filter && Object.keys(filter).length > 0
      ? { AND: [correlation, filter] }
      : correlation;
  }

  /** `fk_i = <parent_i>` for every compound-key field — a SQL `Ref` to the
   *  located-parent read at planning (technique #1) for a `planned` parent, or the
   *  inlined literal at compile. A `literal` parent id — a depth-composed inverse-side
   *  to-one under a located-by-PK nested target (T3b mechanism 1) — is a compile-time
   *  constant, so even the planning probe inlines its value (no `Ref` is possible or
   *  needed), exactly as the junction membership read already does. */
  private correlationFilters(
    known: PlanningKnown | undefined,
    useRef: boolean
  ): Record<string, unknown>[] {
    const refable = useRef && this.config.parentId.kind === "planned";
    return this.config.fkFields.map((fkField, index) => ({
      [fkField]: {
        equals: refable
          ? referencedFieldRef(
              this.config.parentId,
              this.config.referencedFields[index]!,
              this.config.relationName,
              this.config.kind
            )
          : referencedFieldValue(
              this.config.parentId,
              this.config.referencedFields[index]!,
              known,
              this.config.relationName,
              this.config.kind
            ),
      },
    }));
  }

  /**
   * Separate a targeted `update`/`updateMany` payload into its scalar assignments
   * and its child Parts (T3b mechanism 1). Pre-T3b this threw for any nested relation
   * write; now a targeted `update` located by its unique PK folds those relations one
   * level deeper ({@link nestedBuilder}), the located target building its own child
   * Parts exactly as a root update does. A relation-carrying `updateMany` (bulk, no
   * captured PK), an inverse-side to-one `update` with no unique `where`, or a build
   * without the recursion seam still routes the whole tree to V1.
   */
  private interpretChildParts(scope: StepScope): {
    childParts: readonly Part[];
    reorderAfterChildren: boolean;
    scalarData: Record<string, unknown>;
    parentIsLocatedPk: boolean;
  } {
    const { data, childScope, relationName, kind } = this.config;
    if (!data) {
      throw new QueryEngineError(
        `query-engine-v2 ${kind} for relation '${relationName}' requires data.`
      );
    }
    const { scalarData, relations } = separateData(childScope, data);
    // V1's PK-arithmetic portability check on the nested child data (float/decimal
    // non-portability, divide-by-zero, one-op) — a payload legality gate at construction
    // (before the probe), matching RelationUpdates, on the scalar assignments only
    // (nested relation writes are not PK arithmetic). It runs HERE rather than after this
    // method because N5-U1 derives a post-transition primary key from those same
    // assignments below, and that derivation is only sound once the operand is known
    // portable — the same precondition `resolveCreateParent` states at the root.
    assertPortablePrimaryKeyUpdateInput(childScope.model, kind, {
      data: scalarData,
    });
    // CLASS IV (T4c) — V1's `assertRelationKeyUpdatesAreCompilable`, reused: the
    // located target's own relation-key fields may not be rewritten by a non-literal
    // op while it mutates that relation (`authorId: { increment }` alongside
    // `author: { update }`). V1 runs this at EVERY `compileLocatedUpdate` level; this
    // is the nested level (a to-many/inverse-to-one `update` target's payload), so the
    // reject recurses into nested update data BEFORE any outer effect, byte-identical.
    assertRelationKeyUpdatesAreCompilable(childScope, scalarData, relations);
    if (Object.keys(relations).length === 0) {
      if (Object.keys(scalarData).length === 0) {
        throw new UnsupportedOperationError(
          `query-engine-v2 ${kind} for relation '${relationName}' requires at least one scalar assignment.`
        );
      }
      return {
        childParts: [],
        reorderAfterChildren: false,
        scalarData,
        parentIsLocatedPk: false,
      };
    }
    // Nested relation writes present. Only a targeted `update` with a unique `where`
    // and the recursion seam folds them; a bulk `updateMany` (no per-row identity) and
    // an inverse-side to-one `update` with no unique locator still decline.
    if (kind !== "update" || !this.config.where || !this.config.nestedBuilder) {
      throw new UnsupportedOperationError(
        `query-engine-v2 ${kind} for relation '${relationName}' does not support nested relation writes in its data.`
      );
    }
    // N4-U1 — the target's primary key, whichever unique named the row.
    //
    // The deeper edges' foreign keys reference THIS target's primary key. When the
    // `where` names it, that is a compile-time literal and nothing is read. When it
    // names some OTHER unique (`{ slug }`, `{ email }`), the key is not unknowable —
    // this part ALREADY locates the row: `correlatedProbeStatement` selects the
    // primary key and `capturedPk` is the identity the self-UPDATE addresses. So the
    // deeper edges take a `planned` source pointing at that same probe, exactly as N1
    // gave the root's child edges the located-parent Ref, and the value they spend is
    // read from THE ROW THE PROBE LOCKED — never re-derived from the `where` (the
    // wrong-row doctrine). Both provenances converge on one identity: the located row.
    const pkEntry = getWhereUniqueEntries(childScope, this.config.where).find(
      (entry) => entry.fieldName === this.config.childPrimaryKey
    );
    const parentIsLocatedPk = pkEntry === undefined;
    const primaryKey = this.config.childPrimaryKey;
    // Does this target's own SET rewrite the primary key the deeper edges reference?
    //
    // Named reorder obligation (TO-ONE.md §7.7): the root reorders on its full
    // referenced-column union (PK ∪ every child-referenced column, D4-style non-PK
    // references included); the PK is the ONLY referenced column that can reach this
    // depth check, because `buildNestedTargetChildParts` routes every deeper edge whose
    // FK references a non-PK column of the target to V1 (the literal/planned parent id
    // carries only the target's PK per-field). So checking the PK here is complete —
    // no D4-style deep non-PK reference is silently reordered wrong; it never arrives.
    //
    // A SET that names the primary key is not automatically a TRANSITION. `set` to the
    // value the key already carries and `increment: 0` write the key without MOVING it,
    // and the root has always answered that with `{ regime: "none" }` — no occupied
    // guard, no reordering, the ordinary parts byte-identical (pinned by "allows
    // same-value set on an occupied setNull relation" and "allows increment zero …" in
    // `relation-key-update-legality.test.ts`). Depth owes the same answer, from the same
    // two literals: the where-pinned pre-value and `getUpdatedPrimaryKeyValue` over the
    // operand, both already in hand here. Asking `Object.hasOwn` alone made an occupied
    // slot a REJECTION at depth for a payload the root ACCEPTS, under a message claiming
    // a transition that is not happening — one rule answering two ways.
    //
    // Only the where-pinned spelling can be decided: a target named by another unique
    // has no compile-time pre-value to compare against, so a no-op there is
    // indistinguishable from a move and takes the ordinary transition path — the same
    // place the root's `pastSurface` leaves an unpinned pre-value.
    const setsPk = Object.hasOwn(scalarData, primaryKey);
    const afterPk =
      setsPk && pkEntry !== undefined
        ? getUpdatedPrimaryKeyValue(
            childScope.model,
            primaryKey,
            pkEntry.value,
            scalarData[primaryKey],
            getStepModelName(childScope.model, relationName)
          )
        : undefined;
    const transitionsPk =
      setsPk &&
      !(pkEntry !== undefined && sameScalarValue(pkEntry.value, afterPk));
    // Two orderings, one per referential action, and the action is what picks:
    //
    //  · CASCADE (the implicit m2m junction FK, serializer default): write the edge
    //    against the PRE-transition literal FIRST, then let the self-UPDATE's
    //    `ON UPDATE CASCADE` carry it old → new. `reorderAfterChildren`.
    //  · NON-cascade (a child-held one-to-many / inverse-side one-to-one FK, NO ACTION
    //    by default): the same order strands the edge on the id the transition vacates.
    //    N5-U1 gives it the ordering the root already had — write against the
    //    POST-transition literal AFTER the self-UPDATE — plus the CLASS IV occupied
    //    guard the root emits for exactly this situation, so an OCCUPIED old slot is the
    //    same typed rejection at depth that it is at the root instead of the referential
    //    action silently nulling those children.
    const postTransition =
      transitionsPk &&
      !pkTransitionCascadeSafe(childScope, relations, primaryKey);
    if (postTransition && hasJunctionRelation(relations)) {
      // A junction alongside a non-cascade edge is the one mix this ordering cannot
      // serve: a junction Part reads MEMBERSHIP at planning, correlated to the parent
      // key, and planning runs before the self-UPDATE has written the new one — so the
      // post-transition ordering would have it read a key no row carries yet, while the
      // pre-transition ordering strands the non-cascade edge. Neither order is right for
      // both edges at once; closing it needs the junction's membership read to correlate
      // on the pre-transition key while its writes use the post-transition one, which is
      // the two-source split `RelationSetConfig.correlationParentId` makes for `set`,
      // carried into `RelationJunctionPart`. Named, measured, and not smuggled in here.
      throw new UnsupportedOperationError(
        `query-engine-v2 update for relation '${relationName}' transitions the target primary key '${primaryKey}' while writing both a many-to-many edge and a child-held edge whose foreign key does not cascade on update.`
      );
    }
    const childParts: Part[] = [];
    let parentSource: ParentIdSource;
    if (pkEntry === undefined) {
      if (postTransition) {
        // MERGE (N4 × N5) — the one shape neither lane's mechanism reaches, and it
        // exists only where the two absorptions MEET. N4 lets the target be named by
        // any unique, giving the deeper edges a `planned` source into this part's
        // probe; N5 orders a NON-cascade deeper edge after the self-UPDATE and binds
        // it to the POST-transition key. Intersect them and the edge needs a value
        // that is neither: the probe runs BEFORE the self-UPDATE, so a `planned`
        // source reads the key the transition is about to vacate, and no
        // `ParentIdSource` applies the SET's operand to a planned value at compile —
        // `literal`, `planned` and `ref` each carry a value verbatim, none transforms
        // it. The occupied guard below needs the same pre-transition literal to say
        // which slot it is checking. Both wants are the ONE mechanism N5's own record
        // names for a follow-on unit (an operand-applying `planned` source), so this
        // fails closed rather than binding a stale key. Neither lane REGRESSES here:
        // at the shared base both spellings of this payload already declined.
        throw new UnsupportedOperationError(
          `query-engine-v2 update for relation '${relationName}' transitions the target primary key '${primaryKey}' while writing a deeper edge whose foreign key does not cascade on update; it must locate the target by that primary key.`
        );
      }
      parentSource = plannedParentId(this.probeId, primaryKey);
    } else {
      if (postTransition) {
        childParts.push(
          ...buildPkTransitionOccupiedGuards({
            scope,
            childScope,
            relations,
            transitioningPk: primaryKey,
            before: pkEntry.value,
            txMode: this.config.txMode,
          })
        );
      }
      parentSource = literalParentId(postTransition ? afterPk : pkEntry.value);
    }
    childParts.push(
      ...this.config.nestedBuilder(
        childScope,
        parentSource,
        relations,
        this.config.txMode
      )
    );
    return {
      childParts,
      reorderAfterChildren:
        childParts.length > 0 && transitionsPk && !postTransition,
      scalarData,
      parentIsLocatedPk: parentIsLocatedPk && childParts.length > 0,
    };
  }

  /** The validated scalar assignments of a targeted `update`/`updateMany`; the leaf
   *  UPDATE consumes them. Present for every `update`/`updateMany` (computed once at
   *  construction); a relation-only nested update never reaches a leaf that needs it. */
  private requireUpdateScalarData(): Record<string, unknown> {
    if (!this.updateScalarData) {
      throw new QueryEngineError(
        `query-engine-v2 ${this.config.kind} for relation '${this.config.relationName}' has no scalar data.`
      );
    }
    return this.updateScalarData;
  }

  /**
   * The primary key the correlated probe captured at planning — the row this
   * targeted mutation is pinned to. Absent rows are V1's verbatim target-not-found
   * (the correlated probe found no child of this parent matching the selector).
   */
  private capturedPk(known: PlanningKnown): unknown {
    const rows = known[planningKey(this.probeId, "rows")];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 ${this.config.kind} probe for relation '${this.config.relationName}' did not expose rows.`,
        this.config.relationName
      );
    }
    if (rows.length === 0) {
      throw new NestedWriteError(
        relationTargetNotFound(this.config.relationInfo, this.targetedOp()),
        this.config.relationName
      );
    }
    const first = rows[0];
    if (!(first && typeof first === "object")) {
      throw new NestedWriteError(
        `query-engine-v2 ${this.config.kind} probe for relation '${this.config.relationName}' captured no row shape.`,
        this.config.relationName
      );
    }
    return (first as Record<string, unknown>)[this.config.childPrimaryKey];
  }

  private targetFailure() {
    return nestedWriteFailure(
      relationTargetNotFound(this.config.relationInfo, this.targetedOp()),
      this.config.relationName,
      false
    );
  }

  /** The correlated-operation name for the target-not-found message (update/delete). */
  private targetedOp(): "delete" | "update" {
    return this.config.kind === "update" ? "update" : "delete";
  }

  private isTargeted(): boolean {
    return this.config.kind === "update" || this.config.kind === "delete";
  }

  /**
   * The child's unique-selector conjuncts, or `[]` when this targeted mutation has
   * no unique `where` — the **inverse-side to-one** case (TO-ONE.md §7.2), where the
   * FK correlation is the whole locator (V1's `normalizeUpdateInputs` yields
   * `{ data }` with no selector for a to-one, and `RelationUpdates` locates the child
   * by `filter: correlatedWhere(fk, parentValues)` alone). A to-many targeted
   * `update`/`delete` always supplies its unique `where`.
   *
   * N6-U1: the selector may now be EXTENDED, so its filter half rides along —
   * {@link uniqueSelectorConjuncts} is the one home that appends it. Both consumers
   * of this list need it and for the same reason: the correlated probe LOCATES the
   * row the caller named, and the batch guard re-asserts that the located row is
   * still that row. Feeding the probe the filter but not the guard would let a
   * concurrent write to the filtered column slip a row past the guard the locate had
   * excluded.
   */
  /** W4-U3 — the inverse-side to-one `update: { where, data }` filter on the currently
   *  connected record, as a single ordinary `WhereInput` term (not a unique
   *  discriminator, so it is handed to the find builder whole). `[]` for the bare
   *  `update: <data>` spelling and for every other kind, which keeps their probe and
   *  guard SQL byte-identical to pre-W4-U3. */
  private targetFilters(): Record<string, unknown>[] {
    const filter = this.config.targetFilter;
    return filter && Object.keys(filter).length > 0 ? [filter] : [];
  }

  private optionalWhereFilters(): Record<string, unknown>[] {
    return this.config.where
      ? uniqueSelectorConjuncts(this.config.childScope, this.config.where)
      : [];
  }
}

/**
 * Whether a nested-update PK transition can safely use the pre-transition-literal +
 * reorder mechanism ({@link RelationWritePart} `compileTargeted`): the child edge is
 * written against the target's OLD primary key, then the self-UPDATE rewrites that PK,
 * and the deeper FK is carried old→new by ON UPDATE CASCADE. That is sound only when
 * every deeper edge referencing the transitioning PK cascades on update:
 *
 * - an implicit **m2m junction** FK is ON UPDATE CASCADE by default (serializer) — safe;
 * - a **child-held** one-to-many / inverse-side one-to-one FK defaults to NO ACTION, so
 *   the edge written against the old id is stranded when the PK moves (a ForeignKeyError
 *   V1 never raises — V1 orders the edge against the POST-transition id). Route to V1.
 *
 * All non-m2m relations reaching here already survived the child-Part builder, so their
 * FK is child-held (`holdsFK: false`) and `pkFields` are the target's referenced fields.
 */
function pkTransitionCascadeSafe(
  targetScope: QueryScope,
  relations: Record<string, RelationMutation>,
  transitioningPk: string
): boolean {
  for (const mutation of Object.values(relations)) {
    const info = mutation.relationInfo;
    // getFkDirection throws for m2m; a junction FK cascades on update by default.
    if (info.type === "manyToMany") continue;
    const fk = getFkDirection(targetScope, info);
    if (fk.pkFields.includes(transitioningPk) && fk.onUpdate !== "cascade") {
      return false;
    }
  }
  return true;
}

/** Whether any deeper relation goes through a junction — the one edge kind whose
 *  PLANNING read is correlated to the parent key, which is why it cannot share the
 *  post-transition ordering (see {@link RelationWritePart.interpretChildParts}). */
function hasJunctionRelation(
  relations: Record<string, RelationMutation>
): boolean {
  return Object.values(relations).some(
    (mutation) => mutation.relationInfo.type === "manyToMany"
  );
}

/**
 * CLASS IV AT DEPTH (N5-U1) — the occupied-slot rejection the root emits for a
 * non-cascade referenced-key transition, for a nested update TARGET that transitions
 * its OWN primary key.
 *
 * The root's version ({@link UpdateOperation} `pushOccupiedGuard`) reads the old slot
 * through the operation's own `relationKeyGuards` list; at depth there is no such list,
 * so the same read/verdict pair is a Part — which is the point of Parts. Both ask one
 * question: does any child still carry the key this update is about to move? Occupied is
 * V1's typed `Cannot update relation '…' with onUpdate('…') while the current relation
 * is occupied.`; empty is what makes the post-transition ordering correct, because it
 * means no edge is being left behind on the vacated key.
 *
 * One Part per deeper relation that actually holds a non-cascade foreign key referencing
 * the transitioning primary key — the same predicate {@link pkTransitionCascadeSafe}
 * answers, here reported per relation instead of as one boolean.
 */
function buildPkTransitionOccupiedGuards(args: {
  scope: StepScope;
  childScope: QueryScope;
  relations: Record<string, RelationMutation>;
  transitioningPk: string;
  before: unknown;
  txMode: boolean;
}): RelationKeyOccupiedPart[] {
  const { scope, childScope, relations, transitioningPk, before, txMode } =
    args;
  const guards: RelationKeyOccupiedPart[] = [];
  for (const [relationName, mutation] of Object.entries(relations)) {
    const info = mutation.relationInfo;
    if (info.type === "manyToMany") continue;
    const fk = getFkDirection(childScope, info);
    if (
      fk.holdsFK ||
      fk.onUpdate === "cascade" ||
      !fk.pkFields.includes(transitioningPk)
    ) {
      continue;
    }
    const deeperScope = createQueryScope(childScope.adapter, info.targetModel);
    guards.push(
      new RelationKeyOccupiedPart(scope, {
        deeperScope,
        deeperName: getStepModelName(info.targetModel, relationName),
        relationName,
        action: fk.onUpdate ?? "restrict",
        fkField: fk.fkFields[fk.pkFields.indexOf(transitioningPk)]!,
        before,
        txMode,
      })
    );
  }
  return guards;
}

interface RelationKeyOccupiedConfig {
  readonly deeperScope: QueryScope;
  readonly deeperName: string;
  readonly relationName: string;
  readonly action: string;
  readonly fkField: string;
  readonly before: unknown;
  readonly txMode: boolean;
}

/** The read + verdict pair described by {@link buildPkTransitionOccupiedGuards}.
 *  Transaction mode inspects the locked planning probe and throws before any write;
 *  batch mode pins the empty-slot decision with a `notExists` guard (`raceable: true` —
 *  a concurrent plant can invalidate it), exactly as the root's does. */
class RelationKeyOccupiedPart implements Part {
  private readonly config: RelationKeyOccupiedConfig;
  private readonly probeId: string;
  private readonly guardId: string;
  private readonly statement: Sql;

  constructor(scope: StepScope, config: RelationKeyOccupiedConfig) {
    this.config = config;
    this.probeId = scope.allocate(`${config.deeperName}.transition.find`);
    this.guardId = scope.allocate(`${config.deeperName}.guard.occupied`);
    this.statement = buildFind(
      config.deeperScope,
      {
        where: { [config.fkField]: { equals: config.before } },
        select: {
          [getPrimaryKeyFields(config.deeperScope.model)[0]!]: true,
        },
        forUpdate: config.txMode,
      },
      { limit: 1 }
    );
  }

  planning(): readonly OperationStep[] {
    return [
      {
        id: this.probeId,
        kind: "read",
        statement: this.statement,
        outputs: { rows: { kind: "rows" } },
      },
    ];
  }

  compile(_scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    const message = relationKeyOccupiedMessage(
      this.config.relationName,
      this.config.action
    );
    if (this.config.txMode) {
      const rows = known[planningKey(this.probeId, "rows")];
      if (Array.isArray(rows) && rows.length > 0) {
        throw new NestedWriteError(message, this.config.relationName);
      }
      return [];
    }
    return [
      absenceGuard(
        this.guardId,
        this.statement,
        nestedWriteFailure(message, this.config.relationName, true)
      ),
    ];
  }
}

// ---------------------------------------------------------------------------
// set — membership as leaves (ATOM §2/§3). The departing-rows orphan guard is a
// RETAINED notExists pin (raceable: true); the departing set is a planning-time
// read inlined at compile, never crossing a write boundary at runtime.
// ---------------------------------------------------------------------------

export interface RelationSetConfig {
  readonly engine: QueryEngine;
  readonly childScope: QueryScope;
  readonly childName: string;
  readonly relationName: string;
  readonly relationInfo: RelationInfo;
  /** Child FK columns and their index-aligned referenced parent columns (ATOM §1). */
  readonly fkFields: readonly string[];
  readonly referencedFields: readonly string[];
  readonly childPrimaryKey: string;
  readonly requiredFk: boolean;
  readonly requiredFields: readonly string[];
  readonly targets: readonly Record<string, unknown>[];
  readonly parentId: ParentIdSource;
  /**
   * N5-U1 — where this parent's children ALREADY are, when that is not where the
   * reparented ones must GO. `set` is two halves against one parent value: the
   * departing half asks "which rows carry my key today", the target half writes
   * "carry my key from now on". They coincide everywhere except under a non-cascade
   * referenced-key transition, where the part is ordered after the root UPDATE and
   * assigns the POST-transition key while the departing rows still carry the
   * PRE-transition one. Absent → both halves read {@link parentId}, byte-identical
   * to pre-N5.
   */
  readonly correlationParentId?: ParentIdSource;
  readonly txMode: boolean;
}

interface SetTarget {
  readonly where: Record<string, unknown>;
  readonly existId: string;
  readonly reparentId: string;
  readonly guardId: string;
  readonly exist: StatementStep;
}

/**
 * The `set` membership Part (PLAN P2c) for a child-held-FK to-many relation. It
 * makes the parent's children exactly the target set: departing children are
 * disconnected (nullable FK) or, if their FK is required, the operation is
 * rejected by the **retained `notExists` orphan guard** (ATOM §2, `raceable:
 * true`); target children are (re)parented. `set` adopts globally, so target
 * existence is verified by an *uncorrelated* read (V1's `set` capture) —
 * absent → V1's verbatim `Cannot set … ` (no "for this parent").
 *
 * The departing set is a planning-time correlated read inlined at compile (a SQL
 * `NOT (unique … )` list of runtime cardinality); it never threads a row set
 * through a write boundary (ATOM §3 corollary).
 */
export class RelationSetPart implements Part {
  private readonly config: RelationSetConfig;
  private readonly targets: readonly SetTarget[];
  private readonly departingId: string;
  private readonly departingGuardId: string;
  private readonly orphanNullId: string;
  private readonly departingRead?: StatementStep;

  constructor(scope: StepScope, config: RelationSetConfig) {
    this.config = config;
    this.targets = config.targets.map((where): SetTarget => {
      const existId = scope.allocate(`${config.childName}.find`);
      return {
        where,
        existId,
        reparentId: scope.allocate(`${config.childName}.set`),
        guardId: scope.allocate(`${config.childName}.guard.exists`),
        exist: {
          id: existId,
          kind: "read",
          statement: buildFindUnique(config.childScope, {
            where,
            select: { [config.childPrimaryKey]: true },
            forUpdate: config.txMode,
          }),
          outputs: { rows: { kind: "rows" } },
        },
      };
    });
    this.departingId = scope.allocate(`${config.childName}.departing`);
    this.departingGuardId = scope.allocate(
      `${config.childName}.guard.departing`
    );
    this.orphanNullId = scope.allocate(`${config.childName}.orphan`);
    // A required FK cannot be nulled, so the departing rows are read at planning
    // (correlated to the parent by a SQL Ref — technique #1) to decide the
    // orphan rejection at compile and pin it in batch.
    this.departingRead = config.requiredFk
      ? {
          id: this.departingId,
          kind: "read",
          statement: this.departingStatement(undefined, true),
          outputs: { rows: { kind: "rows" } },
        }
      : undefined;
  }

  planning(): readonly OperationStep[] {
    const steps: OperationStep[] = this.targets.map((target) => target.exist);
    if (this.departingRead) steps.push(this.departingRead);
    return steps;
  }

  compile(_scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    const capturedPks = this.targets.map((target) =>
      this.capturedTargetPk(target, known)
    );
    const steps: OperationStep[] = [];
    this.compileDeparting(known, steps);
    for (let index = 0; index < this.targets.length; index += 1) {
      const target = this.targets[index]!;
      const capturedPk = capturedPks[index];
      if (!this.config.txMode) {
        // Split-witness correlation: the guard requires the ORIGINAL selector and
        // the captured PK to still name the same row. A concurrent move of the
        // selector onto a replacement leaves no such row — reject, never adopt the
        // replacement a selector-only guard would have found.
        steps.push(
          presenceGuard(
            target.guardId,
            buildFind(
              this.config.childScope,
              {
                where: {
                  AND: [
                    ...this.uniqueEqualityFilters(target.where),
                    { [this.config.childPrimaryKey]: { equals: capturedPk } },
                  ],
                },
                select: { [this.config.childPrimaryKey]: true },
              },
              { limit: 1 }
            ),
            nestedWriteFailure(
              relationTargetNotFound(this.config.relationInfo, "set"),
              this.config.relationName,
              false
            )
          )
        );
      }
      steps.push({
        id: target.reparentId,
        kind: "write",
        statement: buildUpdate(this.config.childScope, {
          // Reparent the captured row by its PK, not the user selector (V1's
          // mutation-identity), so the write can never land on a replacement.
          where: { [this.config.childPrimaryKey]: capturedPk },
          data: this.fkAssignData(known),
          select: { [this.config.childPrimaryKey]: true },
        }),
        outputs: {},
      });
    }
    return steps;
  }

  /**
   * The departing rows (currently this parent's children NOT in the target set).
   * Required FK: reject at compile if any exist (V1's orphan error), and pin the
   * emptiness in batch with the retained `notExists` guard. Nullable FK: null
   * their FK with one correlated bulk update.
   */
  private compileDeparting(known: PlanningKnown, steps: OperationStep[]): void {
    if (this.config.requiredFk) {
      const rows = this.departingRows(known);
      if (rows.length > 0) {
        throw new NestedWriteError(
          setRequiredOrphan(
            this.config.relationName,
            this.config.requiredFields
          ),
          this.config.relationName
        );
      }
      if (!this.config.txMode) {
        steps.push({
          id: this.departingGuardId,
          kind: "guard",
          premise: {
            kind: "notExists",
            statement: this.departingStatement(known, false),
          },
          failure: nestedWriteFailure(
            setRequiredOrphan(
              this.config.relationName,
              this.config.requiredFields
            ),
            this.config.relationName,
            true
          ),
        });
      }
      return;
    }
    steps.push({
      id: this.orphanNullId,
      kind: "write",
      statement: buildUpdateMany(this.config.childScope, {
        where: this.departingWhere(known, false),
        data: this.fkNullData(),
      }),
      outputs: {},
    });
  }

  private departingRows(known: PlanningKnown): readonly unknown[] {
    const rows = known[planningKey(this.departingId, "rows")];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 set for relation '${this.config.relationName}' did not expose departing rows.`,
        this.config.relationName
      );
    }
    return rows;
  }

  private departingStatement(
    known: PlanningKnown | undefined,
    useRef: boolean
  ): Sql {
    return buildFind(
      this.config.childScope,
      {
        where: this.departingWhere(known, useRef),
        select: { [this.config.childPrimaryKey]: true },
        forUpdate: this.config.txMode,
      },
      { limit: 1 }
    );
  }

  /** `fk_i = <parent_i> [AND …] AND NOT (unique(t1) OR unique(t2) …)`. */
  private departingWhere(
    known: PlanningKnown | undefined,
    useRef: boolean
  ): Record<string, unknown> {
    const correlation = this.correlationFilters(known, useRef);
    const membership =
      this.targets.length === 0
        ? correlation
        : [
            ...correlation,
            {
              NOT: {
                OR: this.targets.map((target) => ({
                  AND: this.uniqueEqualityFilters(target.where),
                })),
              },
            },
          ];
    return membership.length === 1 ? membership[0]! : { AND: membership };
  }

  private capturedTargetPk(target: SetTarget, known: PlanningKnown): unknown {
    const rows = known[planningKey(target.existId, "rows")];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 set for relation '${this.config.relationName}' did not expose its target rows.`,
        this.config.relationName
      );
    }
    if (rows.length === 0) {
      throw new NestedWriteError(
        relationTargetNotFound(this.config.relationInfo, "set"),
        this.config.relationName
      );
    }
    const first = rows[0];
    if (!(first && typeof first === "object")) {
      throw new NestedWriteError(
        `query-engine-v2 set for relation '${this.config.relationName}' captured no target row shape.`,
        this.config.relationName
      );
    }
    return (first as Record<string, unknown>)[this.config.childPrimaryKey];
  }

  /** The reparent write's FK assignment: every FK column ← its referenced parent
   *  column value (one entry per compound-key field, ATOM §1). */
  private fkAssignData(known: PlanningKnown): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (let index = 0; index < this.config.fkFields.length; index += 1) {
      const fkField = this.config.fkFields[index]!;
      data[fkField] = referenceSql(
        this.config.engine,
        this.config.childScope.model,
        fkField,
        referencedFieldValue(
          this.config.parentId,
          this.config.referencedFields[index]!,
          known,
          this.config.relationName,
          "set"
        )
      );
    }
    return data;
  }

  /** The departing-null write's FK assignment: null every FK column. */
  private fkNullData(): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const fkField of this.config.fkFields) data[fkField] = { set: null };
    return data;
  }

  /** `fk_i = <parent_i>` for every compound-key field — a SQL `Ref` at planning
   *  (technique #1), or the inlined literal at compile. Reads the DEPARTING-side
   *  parent value ({@link RelationSetConfig.correlationParentId}), which is the
   *  assigned one everywhere except under a non-cascade transition. */
  private correlationFilters(
    known: PlanningKnown | undefined,
    useRef: boolean
  ): Record<string, unknown>[] {
    const source = this.config.correlationParentId ?? this.config.parentId;
    return this.config.fkFields.map((fkField, index) => ({
      [fkField]: {
        equals: useRef
          ? referencedFieldRef(
              source,
              this.config.referencedFields[index]!,
              this.config.relationName,
              "set"
            )
          : referencedFieldValue(
              source,
              this.config.referencedFields[index]!,
              known,
              this.config.relationName,
              "set"
            ),
      },
    }));
  }

  private uniqueEqualityFilters(
    where: Record<string, unknown>
  ): Record<string, unknown>[] {
    return getWhereUniqueEntries(this.config.childScope, where).map(
      ({ fieldName, value }) => ({ [fieldName]: { equals: value } })
    );
  }
}

// ---------------------------------------------------------------------------
// Builders — fold one to-many relation mutation kind into its Part(s). The FK
// must be child-held; a parent-held FK is a same-row change handled elsewhere.
// ---------------------------------------------------------------------------

interface WritePartBase {
  readonly scope: StepScope;
  readonly engine: QueryEngine;
  readonly relationName: string;
  readonly relationInfo: RelationInfo;
  readonly childName: string;
  readonly childScope: QueryScope;
  readonly fkFields: readonly string[];
  readonly referencedFields: readonly string[];
  readonly childPrimaryKey: string;
  readonly parentId: ParentIdSource;
  readonly txMode: boolean;
  /** T3b mechanism 1: the recursion seam a targeted `update` uses to fold nested
   *  relation writes in its `data` one level deeper. Absent for the leaf families
   *  (delete/deleteMany/updateMany), so those keep declining a relation payload. */
  readonly nestedBuilder?: NestedChildBuilder;
  /** N4-U2: the fresh-arm seam the inverse-side to-one upsert's relation-carrying
   *  CREATE arm is built through. REQUIRED, so the absorption cannot be reached without
   *  it — a caller that forgot the seam would otherwise turn a typed refusal into an
   *  internal invariant break, and a runtime fallback for that would be a guard with no
   *  reachable coverage to name. */
  readonly freshArm: FreshArmBuilder;
}

/** `update`: one targeted correlated part per `{ where, data }` item. A target whose
 *  data carries the located-target projection of mechanism 1/2 (a parent-held to-one
 *  write, or a non-PK / compound referenced edge — D4) delegates its WHOLE update to an
 *  {@link UpdateOperation} nested-target sub-op (X1c); the common child-held-to-PK / m2m
 *  / create target stays on the proven leaf path. */
export function buildToManyUpdateParts(
  base: WritePartBase,
  input: unknown
): Part[] {
  return normalizeWhereData(input, base.relationName, "update").map((item) =>
    targetNeedsFullUpdate(base.childScope, item.data)
      ? buildNestedTargetUpdatePart({
          scope: base.scope,
          engine: base.engine,
          targetModel: base.childScope.model,
          data: item.data,
          locate: {
            where: item.where,
            parentId: base.parentId,
            childFields: base.fkFields,
            parentFields: base.referencedFields,
            relationName: base.relationName,
            notFoundMessage: relationTargetNotFound(
              base.relationInfo,
              "update"
            ),
          },
        })
      : new RelationWritePart(base.scope, {
          ...partConfig(base, "update"),
          where: item.where,
          data: item.data,
        })
  );
}

/**
 * `update` on an **inverse-side one-to-one** (child-held FK) relation: one
 * targeted correlated part whose locator is the FK correlation alone — a to-one
 * `update` carries no UNIQUE `where` (TO-ONE.md §7.2, V1's `normalizeUpdateInputs`
 * yields `{ data }` for a to-one). The captured PK is the single correlated child;
 * the write addresses it (V1's mutation-identity).
 *
 * W4-U3: the payload arrives as the relation update schema's canonical
 * `{ data, where? }` envelope — the ONE place the bare/wrapper spellings are told
 * apart is that parse, off the user's own payload ({@link splitToOneUpdateTarget}).
 * The wrapper's `where` is a NON-unique filter the connected record must satisfy; it
 * joins the correlated probe (and the batch guard), so a filter-miss is the family's
 * existing `Cannot update … for this parent` abort. The bare form yields no filter
 * and every step is byte-identical to pre-W4-U3, at the root and at every depth.
 */
export function buildToOneUpdatePart(base: WritePartBase, data: unknown): Part {
  const target = splitToOneUpdateTarget(data);
  // X1c: an inverse-side to-one target whose data carries a parent-held to-one write
  // (child-SET folding) or a D4 edge delegates its whole update to the update root,
  // located by the FK correlation alone (a to-one carries no unique `where`).
  if (targetNeedsFullUpdate(base.childScope, target.data)) {
    return buildNestedTargetUpdatePart({
      scope: base.scope,
      engine: base.engine,
      targetModel: base.childScope.model,
      data: target.data,
      locate: {
        parentId: base.parentId,
        childFields: base.fkFields,
        parentFields: base.referencedFields,
        ...(target.filter ? { filter: target.filter } : {}),
        relationName: base.relationName,
        notFoundMessage: relationTargetNotFound(base.relationInfo, "update"),
      },
    });
  }
  return new RelationWritePart(base.scope, {
    ...partConfig(base, "update"),
    data: target.data,
    ...(target.filter ? { targetFilter: target.filter } : {}),
  });
}

/**
 * `upsert` on an **inverse-side one-to-one** (child-held FK) relation (TO-ONE.md
 * §7.2, family F): the correlated child (`WHERE fk = parent`) is the locator — no
 * unique `where`, exactly as the to-one `update` arm. Found → update it; absent →
 * create it with `fk = parent`. Composes the certified correlated-update leaf
 * ({@link buildToOneUpdatePart}) with an absent-arm create: a scalar-only arm is one
 * INSERT, and — N4-U2 — a relation-carrying arm is the create SUBTREE below.
 */
export function buildInverseToOneUpsertPart(
  base: WritePartBase,
  input: unknown
): RelationWritePart {
  if (!(input && typeof input === "object" && !Array.isArray(input))) {
    throw new QueryEngineError(
      `query-engine-v2 upsert for relation '${base.relationName}' requires an object.`
    );
  }
  const { create, update } = input as {
    create?: unknown;
    update?: unknown;
  };
  if (
    !(
      create &&
      typeof create === "object" &&
      !Array.isArray(create) &&
      update &&
      typeof update === "object" &&
      !Array.isArray(update)
    )
  ) {
    throw new QueryEngineError(
      `query-engine-v2 upsert for relation '${base.relationName}' requires 'create' and 'update' objects.`
    );
  }
  const createData = create as Record<string, unknown>;
  // N4-U2 — a relation-carrying create arm is the create SUBTREE, the same absorption
  // the to-many adopt family's create arm takes. The arm's foreign key is injected into
  // the subtree's root INSERT by the identical expression the scalar arm writes, so the
  // two spellings land the same row under the same parent.
  const { relations } = separateData(base.childScope, createData);
  const subtree =
    Object.keys(relations).length > 0
      ? base.freshArm({
          childScope: base.childScope,
          data: createData,
          rootFkInject: (known) => upsertArmFkInject(base, known),
        })
      : undefined;
  return new RelationWritePart(base.scope, {
    ...partConfig(base, "update"),
    data: update as Record<string, unknown>,
    upsertCreateData: createData,
    ...(subtree ? { upsertCreateSubtree: subtree } : {}),
  });
}

/** `fk_i = <parent_i>` for an inverse-side to-one upsert arm — the referenced parent
 *  column inlined at compile, the one expression both the scalar create leaf and the
 *  create SUBTREE's root INSERT fold. */
function upsertArmFkInject(
  base: WritePartBase,
  known: PlanningKnown
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (let index = 0; index < base.fkFields.length; index += 1) {
    const fkField = base.fkFields[index]!;
    data[fkField] = referenceSql(
      base.engine,
      base.childScope.model,
      fkField,
      referencedFieldValue(
        base.parentId,
        base.referencedFields[index]!,
        known,
        base.relationName,
        "upsert"
      )
    );
  }
  return data;
}

/** `updateMany`: one bulk correlated part per `{ where?, data }` item. */
export function buildToManyUpdateManyParts(
  base: WritePartBase,
  input: unknown
): RelationWritePart[] {
  return normalizeWhereData(input, base.relationName, "updateMany").map(
    (item) =>
      new RelationWritePart(base.scope, {
        ...partConfig(base, "updateMany"),
        filter: item.where ?? {},
        data: item.data,
      })
  );
}

/** `delete`: one targeted correlated part per unique `where`. */
export function buildToManyDeleteParts(
  base: WritePartBase,
  input: unknown
): RelationWritePart[] {
  return normalizeWheres(input, base.relationName, "delete").map(
    (where) =>
      new RelationWritePart(base.scope, {
        ...partConfig(base, "delete"),
        where,
      })
  );
}

/** `deleteMany`: one bulk correlated part per filter `where`. */
export function buildToManyDeleteManyParts(
  base: WritePartBase,
  input: unknown
): RelationWritePart[] {
  return normalizeWheres(input, base.relationName, "deleteMany").map(
    (filter) =>
      new RelationWritePart(base.scope, {
        ...partConfig(base, "deleteMany"),
        filter,
      })
  );
}

/** `set`: one membership Part over every unique target `where`. `correlationParentId`
 *  (N5-U1) splits the departing half off the assigned half; omit it and both read
 *  `base.parentId`. */
export function buildToManySetPart(
  base: WritePartBase,
  input: unknown,
  correlationParentId?: ParentIdSource
): RelationSetPart {
  const requiredFields = requiredFkFieldsFor(base);
  return new RelationSetPart(base.scope, {
    correlationParentId,
    engine: base.engine,
    childScope: base.childScope,
    childName: base.childName,
    relationName: base.relationName,
    relationInfo: base.relationInfo,
    fkFields: base.fkFields,
    referencedFields: base.referencedFields,
    childPrimaryKey: base.childPrimaryKey,
    requiredFk: requiredFields.length > 0,
    requiredFields,
    targets: normalizeWheres(input, base.relationName, "set"),
    parentId: base.parentId,
    txMode: base.txMode,
  });
}

function partConfig(
  base: WritePartBase,
  kind: RelationWriteKind
): RelationWriteConfig {
  return {
    engine: base.engine,
    childScope: base.childScope,
    childName: base.childName,
    relationName: base.relationName,
    relationInfo: base.relationInfo,
    kind,
    fkFields: base.fkFields,
    referencedFields: base.referencedFields,
    childPrimaryKey: base.childPrimaryKey,
    parentId: base.parentId,
    txMode: base.txMode,
    nestedBuilder: base.nestedBuilder,
  };
}

/** Which of the child's FK fields are required (non-nullable) — V1's rule. */
function requiredFkFieldsFor(base: WritePartBase): string[] {
  const scalars = base.childScope.model["~"].state.scalars;
  return base.fkFields.filter(
    (field) => scalars[field]?.["~"].state.nullable !== true
  );
}

function normalizeWheres(
  value: unknown,
  relation: string,
  kind: string
): Record<string, unknown>[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (!(item && typeof item === "object")) {
      throw new QueryEngineError(
        `query-engine-v2 ${kind} for relation '${relation}' requires a where object.`
      );
    }
    return item as Record<string, unknown>;
  });
}

function normalizeWhereData(
  value: unknown,
  relation: string,
  kind: string
): { where?: Record<string, unknown>; data: Record<string, unknown> }[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (!(item && typeof item === "object")) {
      throw new QueryEngineError(
        `query-engine-v2 ${kind} for relation '${relation}' requires a { where, data } object.`
      );
    }
    const record = item as Record<string, unknown>;
    const data = record.data;
    if (!(data && typeof data === "object")) {
      throw new QueryEngineError(
        `query-engine-v2 ${kind} for relation '${relation}' requires a data object.`
      );
    }
    const where =
      record.where && typeof record.where === "object"
        ? (record.where as Record<string, unknown>)
        : undefined;
    return { where, data: data as Record<string, unknown> };
  });
}
