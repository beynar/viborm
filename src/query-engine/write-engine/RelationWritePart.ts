// biome-ignore-all lint/style/useFilenamingConvention: RelationWritePart is the architecture name.
import { NestedWriteError, QueryEngineError } from "@errors";
import type { Sql } from "@sql";
import type {
  ChildHeldToMany,
  ChildHeldToOne,
  PolymorphicChildHeldToMany,
  PolymorphicChildHeldToOne,
} from "../builders/relation-data-builder";
import type {
  NestedUpdateManyInput,
  NormalizedRelationUpsert,
  RelationMutationEntry,
} from "../builders/relation-mutation-parser";
import {
  buildParsedRelationPrograms,
  partitionModelData,
} from "../builders/relation-mutation-parser";
import { getWhereUniqueEntries } from "../builders/where-unique-builder";
import { getTableName } from "../context/query-scope";
import {
  buildDelete,
  buildDeleteMany,
  buildFind,
  buildFindUnique,
  buildUpdateMany,
} from "../operations";
import { assertPortablePrimaryKeyUpdateInput } from "../operations/mutation-identity";
import type { QueryEngine } from "../query-engine";
import {
  assertRelationKeyUpdatesAreCompilable,
  assertSelectedUpdateManyDataIsScalar,
  relationWriteKeys,
} from "../relation-key-legality";
import type { QueryScope } from "../types";
import {
  exactlyOneRow,
  nestedWriteFailure,
  presenceGuard,
} from "./fragment-builders";
import {
  relationOwnsForeignKey,
  relationTargetNotFound,
  setRequiredOrphan,
  upsertPremiseChanged,
  upsertTargetVanished,
} from "./messages";
import type {
  OperationStep,
  ReadStep,
  StatementStep,
  WriteStep,
} from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { conditionalArmPlanning, planningKey } from "./Part";
import type {
  RecordCompilerSeam,
  RecordUpdateCompiler,
} from "./RecordUpdateCompiler";
import {
  bindCorrelatedRelationMembership,
  bindRelationMembership,
  type CorrelatedRelationMembershipBinding,
  type FinalReferenceSource,
  finalMembershipCondition,
  lowerEmptyMembership,
  lowerMembershipWrite,
  planningMembershipCondition,
  planningSourceFromFinal,
  type RelationMembershipBinding,
} from "./relation-membership";
import { requiredForeignKeyFields } from "./relation-nullability";
import type { StepScope } from "./StepScope";
import {
  isRecord,
  pinnedTargetValues,
  UnsupportedOperationError,
  uniqueSelectorConjuncts,
} from "./shared";
import {
  capturedTargetColumnPredicate,
  capturedTargetFilters,
  capturedTargetValues,
  capturedTargetWhere,
  type TargetProjection,
  targetProjectionColumns,
  targetProjectionOutputs,
  targetProjectionRowKeySelect,
  targetProjectionSelect,
} from "./target-projection";

/**
 * The correlated child-write family: nested `update` / `updateMany` / `delete` /
 * `deleteMany` on a child-held-FK to-many relation. Each is a root write plus an
 * FK edge, with an operation-specific SQL leaf and failure.
 *
 * - **targeted** (`update` one, `delete` one): a *correlated* existence probe —
 *   `WHERE unique AND fk = Ref(parentLocate)` (technique #1's SQL-level
 *   planning→planning `Ref`) with **no** found-uncorrelated arm; present →
 *   `UPDATE … SET data` / `DELETE … WHERE unique`, pinned in batch by an exists
 *   guard on the correlated row; absent → the public `Cannot {op} … for this
 *   parent` error.
 * - **bulk** (`updateMany`, `deleteMany`): no probe — one correlated bulk write
 *   `WHERE fk = parent AND filter`; zero matched rows is a silent success, so
 *   there is no postcondition.
 *
 * The membership/target row sets never cross a write boundary at runtime (ATOM
 * §3 corollary): the located parent id is inlined at compile as a literal, and
 * every correlation is expressed in SQL.
 */
type ChildHeldRelation =
  | ChildHeldToOne
  | ChildHeldToMany
  | PolymorphicChildHeldToOne
  | PolymorphicChildHeldToMany;

interface RelationWriteContext {
  readonly engine: QueryEngine;
  readonly childScope: QueryScope;
  readonly childName: string;
  readonly membership: CorrelatedRelationMembershipBinding;
  /**
   * What the target probe publishes. A targeted arm with a record compiler uses
   * that compiler's own projection; this one is the compiler-less fallback, and
   * its row key is what every captured selector here is built from.
   */
  readonly targetProjection: TargetProjection;
  readonly recordCompilers: RecordCompilerSeam;
  readonly txMode: boolean;
  /** Targeted (`update`/`delete`): the child's unique locator. */
  readonly where?: Record<string, unknown>;
  /** Targeted `update`: the validated scalar data (nested relations rejected). */
  readonly data?: Record<string, unknown>;
  /** Bulk (`updateMany`/`deleteMany`): the user filter, correlated to the parent. */
  readonly filter?: Record<string, unknown>;
  /** Optional non-unique filter that the currently connected inverse to-one row
   * must satisfy. It narrows the probe and guard, while the write uses captured
   * identity. Unlike a bulk filter, no match is a target-not-found failure. */
  readonly targetFilter?: Record<string, unknown>;
  /**
   * H3 — this targeted `update` modifies the member a SIBLING SUPPLIER in the same
   * to-one payload is bringing in, so `where` is that supplier's own unique selector
   * and the FK correlation is deliberately absent from the probe and the guard: the
   * incoming row is NOT a member yet when they run (the planning probe precedes every
   * write, and the batch guard is asserted inside the same atomic unit as the link
   * write it must not presume). Correlating would address the OUTGOING member — §6 H3's
   * wrong-row trap — or find nothing at all on an empty slot.
   *
   * The identity is nonetheless exact: the selector names one row, the probe captures
   * that row's complete key, and the write addresses the captured key. What the guard
   * gives up is only the membership premise, which the supplier's own Part owns.
   */
  readonly suppliedTarget?: boolean;
}

/** H3 — what a SUPPLIED target's probe correlates on: nothing. The incoming row is not
 *  a member yet when the probe and the batch guard run, and its own unique selector is
 *  the whole locator ({@link RelationWriteContext.suppliedTarget}). */
const EMPTY_MEMBERSHIP_CONDITION: {
  readonly filters: readonly Record<string, unknown>[];
  readonly predicate: undefined;
} = { filters: [], predicate: undefined };

export type RelationWriteConfig = RelationWriteContext &
  (
    | {
        readonly kind: "delete" | "deleteMany" | "update" | "updateMany";
        readonly createSubtree?: never;
      }
    | {
        readonly kind: "inverseUpsert";
        readonly data: Record<string, unknown>;
        readonly createSubtree: Part;
      }
  );

export class RelationWritePart implements Part {
  private readonly config: RelationWriteConfig;
  private readonly probeId: string;
  private readonly writeId: string;
  private readonly guardId: string;
  private readonly probe?: ReadStep;
  // The validated scalar assignments of a targeted `update`/`updateMany` (∅ when a
  // relation-only nested update carries no scalars — then no self-UPDATE is emitted,
  // only the child Parts). Computed once at construction.
  private readonly updateScalarData: Record<string, unknown> = {};
  private readonly updateCompiler?: RecordUpdateCompiler;
  // An upsert found arm's update legality, deferred until that arm is SELECTED
  // (ATOM §13). The untaken update subtree of a missing create is never analyzed,
  // so a payload the found arm would refuse compiles when the row is absent.
  // A targeted `update` arm is unconditional and keeps its legality at construction.
  private readonly updateLegality?: () => void;
  // A nested update that asks for nothing emits no probe, guard, or empty SET;
  // target existence is not a precondition. An upsert remains non-empty because
  // its create arm can still run.
  private readonly isNoOpUpdate: boolean = false;

  private get relationName(): string {
    return this.config.membership.relation.relationInfo.name;
  }

  private get operationKind() {
    return this.config.kind === "inverseUpsert" ? "update" : this.config.kind;
  }

  constructor(scope: StepScope, config: RelationWriteConfig) {
    this.config = config;
    let updateCompiler: RecordUpdateCompiler | undefined;
    if (config.kind === "update") {
      updateCompiler = this.buildUpdateCompiler(scope);
      this.isNoOpUpdate = updateCompiler === undefined;
    }
    if (this.isNoOpUpdate) {
      this.updateCompiler = undefined;
      this.probeId = "";
      this.writeId = "";
      this.guardId = "";
      return;
    }
    this.probeId =
      updateCompiler?.targetReadId ??
      scope.allocate(`${config.childName}.find`);
    this.writeId =
      updateCompiler?.writeId ??
      scope.allocate(`${config.childName}.${this.operationKind}`);
    this.guardId = scope.allocate(`${config.childName}.guard.exists`);
    // Payload support is decided before I/O. Targeted updates and the upsert found
    // arm delegate nested relations to the record compiler; bulk leaves remain
    // scalar-only.
    if (config.kind === "updateMany") {
      this.updateScalarData = this.parseScalarUpdateData();
      this.isNoOpUpdate = Object.keys(this.updateScalarData).length === 0;
    } else if (config.kind === "inverseUpsert") {
      // G1 — ONE parse of the complete record boundary. Dropping `polymorphic` here
      // used to discard a direct polymorphic mutation whose intent carries no
      // program (a disconnect), so the found arm silently wrote nothing.
      const parsed = buildParsedRelationPrograms(
        config.childScope,
        config.data
      );
      updateCompiler = config.recordCompilers.updateSelected({
        scope,
        engine: config.engine,
        targetScope: config.childScope,
        scalarData: parsed.scalarData,
        relations: parsed.relations,
        polymorphic: parsed.polymorphic,
        // No `incomingMembership`: the correlated probe found the row BY the
        // membership, so this arm never reparents. No `pinnedTarget`: a correlated
        // inverse to-one has no unique `where`, so nothing is construction-known —
        // every value comes from the located row.
        targetRead: { id: this.probeId },
        rootWrite: { id: this.writeId },
        relationName: this.relationName,
        rootWriteFailure: {
          kind: "notFound",
          message: upsertTargetVanished(this.relationName),
          relation: this.relationName,
          raceable: false,
        },
      });
      // G2 — the found arm's legality, deferred to the moment the arm is selected.
      this.updateLegality = updateCompiler
        ? () => {
            assertPortablePrimaryKeyUpdateInput(
              config.childScope.model,
              "update",
              {
                data: parsed.scalarData,
              }
            );
            assertRelationKeyUpdatesAreCompilable(
              config.childScope,
              parsed.scalarData,
              parsed.relations
            );
            assertSelectedUpdateManyDataIsScalar(
              config.childScope,
              parsed.relations
            );
          }
        : undefined;
    }
    this.updateCompiler = updateCompiler;
    // The probe is built LAST: whether it owes the deeper edges the located primary
    // key is a fact about the child Parts, which are interpreted above. A no-op arm
    // gets no probe — it must not make the target's existence a precondition.
    const isTargeted =
      config.kind !== "updateMany" && config.kind !== "deleteMany";
    this.probe =
      isTargeted && !this.isNoOpUpdate ? this.buildProbe() : undefined;
  }

  planning(scope: StepScope): readonly StatementStep[] {
    if (this.isNoOpUpdate) return [];
    const steps: StatementStep[] = this.probe ? [this.probe] : [];
    if (this.updateCompiler) {
      // Both arms of an upsert plan (technique #2's widened superset), but only one
      // later compiles: the found arm's descendant probes must not reject planning
      // or demand a first-row field while the create arm is the one taken. A
      // targeted `update` has no untaken arm and keeps its expectations.
      steps.push(
        ...(this.config.kind === "inverseUpsert"
          ? conditionalArmPlanning(this.updateCompiler.planning())
          : this.updateCompiler.planning())
      );
    }
    if (this.config.kind === "inverseUpsert") {
      steps.push(...this.config.createSubtree.planning(scope));
    }
    return steps;
  }

  compile(scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    if (this.isNoOpUpdate) return [];
    if (this.config.kind === "updateMany") return [this.buildUpdateMany(known)];
    if (this.config.kind === "deleteMany") return [this.buildDeleteMany(known)];
    return this.compileTargeted(scope, known);
  }

  /**
   * `update` one / `delete` one: the leaf write addresses the **captured row key**
   * the probe selected — every member of it — not the user selector. In batch mode
   * the presence guard binds the original selector, parent correlation, and that
   * whole captured row key to the same row, so moving the selector to a replacement
   * fails the guard.
   */
  private compileTargeted(
    scope: StepScope,
    known: PlanningKnown
  ): readonly OperationStep[] {
    if (this.config.kind === "inverseUpsert") {
      return this.compileInverseToOneUpsert(
        scope,
        known,
        this.config.createSubtree
      );
    }
    const captured = this.capturedRow(known);
    const steps: OperationStep[] = [];
    if (!this.config.txMode) {
      steps.push(
        presenceGuard(
          this.guardId,
          this.correlatedProbeStatement(known, false, captured),
          this.targetFailure()
        )
      );
    }
    if (this.config.kind === "delete") {
      steps.push(
        this.buildDeleteOne(
          capturedTargetWhere(
            this.config.childScope.model,
            this.targetProjection,
            captured
          )
        )
      );
      return steps;
    }
    if (this.updateCompiler) {
      steps.push(...this.updateCompiler.compile(known));
      return steps;
    }
    throw new QueryEngineError(
      `query-engine-v2 update for relation '${this.relationName}' has no record compiler.`
    );
  }

  /**
   * The inverse-side one-to-one upsert. The correlated
   * probe (`WHERE fk = parent`) already decided the three-way at plan time:
   *
   * - absent (0 rows) → CREATE arm: `INSERT child (createData, fk = parent)`. It
   *   has no unique target to pin, so a losing concurrent insert surfaces the
   *   child-FK constraint error;
   * - found → UPDATE arm: the captured correlated child, pinned in batch by an exists
   *   guard on `fk = parent AND <every captured row-key member>` (the upsert-family
   *   premise wording),
   *   and in tx by the update's affected-rows expectation (the upsert-vanished wording).
   *
   * This composes the already-certified correlated-update leaf with a create leaf; the
   * root parent does not hold the FK, so no parent-side FK rebind follows.
   */
  private compileInverseToOneUpsert(
    scope: StepScope,
    known: PlanningKnown,
    createSubtree: Part
  ): readonly OperationStep[] {
    const rows = this.probeRows(known);
    if (rows.length === 0) {
      return createSubtree.compile(scope, known);
    }
    const first = rows[0];
    if (!(first && typeof first === "object")) {
      throw new NestedWriteError(
        `query-engine-v2 upsert probe for relation '${this.relationName}' captured no row shape.`,
        this.relationName
      );
    }
    // The branch read remains necessary for the missing create arm, but an empty
    // selected update has no compiler and therefore no found-arm effect to pin.
    if (!this.updateCompiler) return [];
    const steps: OperationStep[] = [];
    if (!this.config.txMode) {
      steps.push(
        presenceGuard(
          this.guardId,
          this.correlatedProbeStatement(
            known,
            false,
            first as Record<string, unknown>
          ),
          nestedWriteFailure(
            upsertPremiseChanged(this.relationName),
            this.relationName,
            false
          )
        )
      );
    }
    this.updateLegality?.();
    steps.push(...this.updateCompiler.compile(known));
    return steps;
  }

  /** The correlated probe's rows without the target-not-found throw — the upsert's
   *  absent arm is legal, so an empty result is the CREATE decision, not an error. */
  private probeRows(known: PlanningKnown): readonly unknown[] {
    const rows = known[planningKey(this.probeId, "rows")];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 upsert probe for relation '${this.relationName}' did not expose rows.`,
        this.relationName
      );
    }
    return rows;
  }

  private buildDeleteOne(where: Record<string, unknown>): WriteStep {
    return {
      id: this.writeId,
      kind: "write",
      statement: buildDelete(this.config.childScope, { where }),
      outputs: {},
    };
  }

  private buildUpdateMany(known: PlanningKnown): WriteStep {
    const membership = finalMembershipCondition(
      this.config.engine,
      this.config.childScope,
      this.config.membership,
      getTableName(this.config.childScope.model),
      known,
      "updateMany"
    );
    return {
      id: this.writeId,
      kind: "write",
      statement: buildUpdateMany(this.config.childScope, {
        where: this.correlatedFilter(membership.filters),
        data: this.updateScalarData,
        ...(membership.predicate ? { predicate: membership.predicate } : {}),
      }),
      outputs: {},
    };
  }

  private buildDeleteMany(known: PlanningKnown): WriteStep {
    const membership = finalMembershipCondition(
      this.config.engine,
      this.config.childScope,
      this.config.membership,
      getTableName(this.config.childScope.model),
      known,
      "deleteMany"
    );
    return {
      id: this.writeId,
      kind: "write",
      statement: buildDeleteMany(this.config.childScope, {
        where: this.correlatedFilter(membership.filters),
        ...(membership.predicate ? { predicate: membership.predicate } : {}),
      }),
      outputs: {},
    };
  }

  /**
   * The correlated existence probe for a targeted `update`/`delete`. A planning
   * step, so it correlates by a SQL `Ref` to the located-parent read in BOTH
   * modes (technique #1) — the literal is not known until that read runs.
   */
  private buildProbe(): ReadStep {
    const step: ReadStep = {
      id: this.probeId,
      kind: "read",
      statement: this.correlatedProbeStatement(undefined, true),
      outputs: {
        rows: { kind: "rows" },
        ...(this.updateCompiler
          ? targetProjectionOutputs(
              this.updateCompiler.targetProjection,
              this.config.kind === "inverseUpsert"
            )
          : {}),
      },
    };
    return this.updateCompiler && this.config.kind !== "inverseUpsert"
      ? { ...step, expects: exactlyOneRow(this.targetFailure()) }
      : step;
  }

  /**
   * `WHERE unique AND fk = <parent> [AND <row key> = <captured>]`, limited to one
   * row. When `useRef` the correlation carries a SQL `Ref` to the located-parent
   * planning read (technique #1, in the planning probe); otherwise the located id
   * is inlined as a literal (the batch exists guard, a final-fragment step). The
   * batch guard additionally pins EVERY captured row-key member so the selector and
   * the row the probe locked must still coincide (the split-witness correlation);
   * the planning probe omits them (it is what captures the row key).
   */
  private correlatedProbeStatement(
    known: PlanningKnown | undefined,
    useRef: boolean,
    capturedRow?: Record<string, unknown>
  ): Sql {
    const projection = this.targetProjection;
    const selectedColumns = targetProjectionColumns(
      this.config.childScope,
      projection
    );
    const membership = this.config.suppliedTarget
      ? EMPTY_MEMBERSHIP_CONDITION
      : useRef
        ? planningMembershipCondition(
            this.config.engine,
            this.config.childScope,
            this.config.membership,
            this.config.childScope.rootAlias
          )
        : finalMembershipCondition(
            this.config.engine,
            this.config.childScope,
            this.config.membership,
            this.config.childScope.rootAlias,
            known ?? {},
            this.operationKind
          );
    const capturedRows = known?.[planningKey(this.probeId, "rows")];
    const captured =
      Array.isArray(capturedRows) && isRecord(capturedRows[0])
        ? capturedRows[0]
        : undefined;
    const capturedColumns = captured
      ? capturedTargetColumnPredicate(
          this.config.childScope,
          projection,
          captured
        )
      : undefined;
    const predicates = [membership.predicate, capturedColumns].filter(
      (predicate): predicate is Sql => predicate !== undefined
    );
    return buildFind(
      this.config.childScope,
      {
        where: {
          AND: [
            ...this.optionalWhereFilters(),
            ...this.targetFilters(),
            ...membership.filters,
            ...(capturedRow
              ? capturedTargetFilters(
                  this.config.childScope.model,
                  projection,
                  capturedRow
                )
              : []),
          ],
        },
        select: targetProjectionSelect(projection),
        forUpdate: this.config.txMode,
      },
      {
        limit: 1,
        ...(predicates.length
          ? {
              predicate:
                predicates.length === 1
                  ? predicates[0]
                  : this.config.childScope.adapter.operators.and(...predicates),
            }
          : {}),
        ...(selectedColumns.length
          ? {
              additionalColumns: selectedColumns.map((column) => column.sql),
            }
          : {}),
      }
    );
  }

  /** `WHERE fk = <parentLiteral> [AND filter]` for a bulk write. */
  private correlatedFilter(
    filters: readonly Record<string, unknown>[]
  ): Record<string, unknown> | undefined {
    const correlation =
      filters.length === 0
        ? undefined
        : filters.length === 1
          ? filters[0]!
          : { AND: filters };
    const filter = this.config.filter;
    const hasFilter = filter && Object.keys(filter).length > 0;
    if (!correlation) return hasFilter ? filter : undefined;
    return hasFilter ? { AND: [correlation, filter] } : correlation;
  }

  private buildUpdateCompiler(
    scope: StepScope
  ): RecordUpdateCompiler | undefined {
    const data = this.config.data;
    if (!data) {
      throw new QueryEngineError(
        `query-engine-v2 update for relation '${this.relationName}' requires data.`
      );
    }
    const parsed = buildParsedRelationPrograms(this.config.childScope, data);
    const pinnedTarget = this.config.where
      ? pinnedTargetValues(this.config.childScope, this.config.where)
      : {};
    assertPortablePrimaryKeyUpdateInput(
      this.config.childScope.model,
      "update",
      {
        data: parsed.scalarData,
      }
    );
    assertRelationKeyUpdatesAreCompilable(
      this.config.childScope,
      parsed.scalarData,
      parsed.relations
    );
    assertSelectedUpdateManyDataIsScalar(
      this.config.childScope,
      parsed.relations
    );
    return this.config.recordCompilers.updateSelected({
      scope,
      engine: this.config.engine,
      targetScope: this.config.childScope,
      scalarData: parsed.scalarData,
      relations: parsed.relations,
      polymorphic: parsed.polymorphic,
      targetRead: { label: `${this.config.childName}.find` },
      rootWrite: { label: `${this.config.childName}.update` },
      relationName: this.relationName,
      pinnedTarget,
    });
  }

  /**
   * Bulk updates accept scalar data only: a set-based UPDATE has no per-row captured
   * identity for a descendant write to correlate to (ATOM §17). The inverse-upsert
   * found arm was the other caller until Package G routed it through the record
   * compiler; what remains here is the nested `updateMany` leaf.
   *
   * The refusal reads {@link relationWriteKeys}, not `relations` alone: a direct
   * polymorphic `disconnect` carries no relation program, so reading one map used to
   * let it past this wall and then drop it on the floor (the measured silent wrong
   * answer recorded at that function). One question, one owner, three readers.
   */
  private parseScalarUpdateData(): Record<string, unknown> {
    const { data, childScope } = this.config;
    const kind = this.operationKind;
    if (!data) {
      throw new QueryEngineError(
        `query-engine-v2 ${kind} for relation '${this.relationName}' requires data.`
      );
    }
    const parsed = buildParsedRelationPrograms(childScope, data);
    const { scalarData, relations } = parsed;
    assertPortablePrimaryKeyUpdateInput(childScope.model, kind, {
      data: scalarData,
    });
    assertRelationKeyUpdatesAreCompilable(childScope, scalarData, relations);
    if (relationWriteKeys(parsed).length > 0) {
      throw new UnsupportedOperationError(
        `query-engine-v2 ${kind} for relation '${this.relationName}' does not support nested relation writes in its data.`
      );
    }
    return scalarData;
  }

  /** The row the correlated probe captured — the one source of every row-key
   * member this arm addresses. An absent row uses the relation family's
   * target-not-found failure. */
  private capturedRow(known: PlanningKnown): Record<string, unknown> {
    const rows = known[planningKey(this.probeId, "rows")];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 ${this.operationKind} probe for relation '${this.relationName}' did not expose rows.`,
        this.relationName
      );
    }
    if (rows.length === 0) {
      throw new NestedWriteError(
        relationTargetNotFound(
          this.config.membership.relation.relationInfo,
          this.targetedOp()
        ),
        this.relationName
      );
    }
    const first = rows[0];
    if (!(first && typeof first === "object")) {
      throw new NestedWriteError(
        `query-engine-v2 ${this.operationKind} probe for relation '${this.relationName}' captured no row shape.`,
        this.relationName
      );
    }
    return first as Record<string, unknown>;
  }

  /** A targeted arm with a record compiler publishes that compiler's projection;
   *  the compiler-less arms publish the configured one. Both open with the same
   *  complete row key, which is what the captured selectors are built from. */
  private get targetProjection(): TargetProjection {
    return (
      this.updateCompiler?.targetProjection ?? this.config.targetProjection
    );
  }

  private targetFailure() {
    return nestedWriteFailure(
      relationTargetNotFound(
        this.config.membership.relation.relationInfo,
        this.targetedOp()
      ),
      this.relationName,
      false
    );
  }

  /** The correlated-operation name for the target-not-found message (update/delete). */
  private targetedOp(): "delete" | "update" {
    return this.operationKind === "update" ? "update" : "delete";
  }

  /** The optional inverse-side to-one update filter on the currently connected
   * record. It is an ordinary `WhereInput`, not a unique discriminator. */
  private targetFilters(): Record<string, unknown>[] {
    const filter = this.config.targetFilter;
    return filter && Object.keys(filter).length > 0 ? [filter] : [];
  }

  /**
   * The child's unique-selector conjuncts, or `[]` when this targeted mutation has
   * no unique `where` — the inverse-side to-one case, where FK correlation is the
   * whole locator. A to-many targeted
   * `update`/`delete` always supplies its unique `where`.
   *
   * Extended-selector filters ride with the discriminator through
   * {@link uniqueSelectorConjuncts}. Both the planning probe and batch guard must
   * address the same narrowed row.
   */
  private optionalWhereFilters(): Record<string, unknown>[] {
    return this.config.where
      ? uniqueSelectorConjuncts(this.config.childScope, this.config.where)
      : [];
  }
}

export interface RelationSetConfig {
  readonly engine: QueryEngine;
  readonly childScope: QueryScope;
  readonly childName: string;
  readonly membership: RelationMembershipBinding;
  /** Reads may use the pre-transition source while writes use the new value. */
  readonly departingMembership: CorrelatedRelationMembershipBinding;
  readonly targetProjection: TargetProjection;
  readonly requiredFk: boolean;
  readonly requiredFields: readonly string[];
  readonly targets: readonly Record<string, unknown>[];
  readonly txMode: boolean;
}

interface SetTarget {
  readonly where: Record<string, unknown>;
  readonly existId: string;
  readonly reparentId: string;
  readonly guardId: string;
  readonly exist: ReadStep;
}

/**
 * Address a captured target set portably.
 *
 * One member: the `IN` list the per-target writes folded into, byte for byte.
 * Several members: `OR` of one `AND` per captured row — correlated conjunctions
 * through the ordinary where-builder, because provider row-value `IN` syntax and
 * its null semantics are not portable (plan N2). Still ONE statement either way.
 */
function capturedTargetSetWhere(
  scope: QueryScope,
  projection: TargetProjection,
  captured: readonly Record<string, unknown>[]
): Record<string, unknown> {
  if (projection.identityFields.length === 1) {
    const single = projection.identityFields[0]!;
    return {
      [single]: {
        in: captured.map(
          (row) => capturedTargetValues(scope.model, projection, row)[single]
        ),
      },
    };
  }
  return {
    OR: captured.map((row) => ({
      AND: capturedTargetFilters(scope.model, projection, row),
    })),
  };
}

/**
 * The `set` membership Part for a child-held-FK to-many relation. It
 * makes the parent's children exactly the target set: departing children are
 * disconnected (nullable FK) or, if their FK is required, the operation is
 * rejected by the **retained `notExists` orphan guard** (ATOM “Branch premises and pins,” `raceable:
 * true`); target children are (re)parented. `set` adopts globally, so target
 * existence is verified by an uncorrelated read; absence uses the public
 * `Cannot set …` message without "for this parent".
 *
 * The departing set is a planning-time correlated read inlined at compile (a SQL
 * `NOT (unique … )` list of runtime cardinality); it never threads a row set
 * through a write boundary (ATOM “Planning fragments”).
 */
export class RelationSetPart implements Part {
  private readonly config: RelationSetConfig;
  private readonly targets: readonly SetTarget[];
  private readonly departingId: string;
  private readonly departingGuardId: string;
  private readonly orphanNullId: string;
  private readonly departingRead?: ReadStep;

  private get relationName(): string {
    return this.config.membership.relation.relationInfo.name;
  }

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
            select: targetProjectionRowKeySelect(config.targetProjection),
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

  planning(): readonly StatementStep[] {
    const steps: StatementStep[] = this.targets.map((target) => target.exist);
    if (this.departingRead) steps.push(this.departingRead);
    return steps;
  }

  /**
   * Emit the departing half, every target's batch guard, then one reparent write
   * over the captured primary keys.
   *
   * `set` addresses each target by the primary key its own probe captured, so the
   * whole target list is one `UPDATE … SET fk = parent WHERE pk IN (…)`. The
   * per-target PROBES stay, and so do the per-target guards: each guard is the
   * split-witness assertion pairing ONE selector with the primary key THAT
   * selector's probe captured, and a grouped probe cannot hand that pairing back
   * without comparing a decoded column value against an input value. Moving the
   * guards ahead of the single write changes nothing — inside an atomic unit a
   * failed assertion aborts the whole unit, and in transaction mode there are no
   * guards at all.
   */
  compile(_scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    const capturedRows = this.targets.map((target) =>
      this.capturedTargetRow(target, known)
    );
    const steps: OperationStep[] = [];
    this.compileDeparting(known, steps);
    if (!this.config.txMode) {
      for (const [index, target] of this.targets.entries()) {
        // Split-witness correlation: the guard requires the ORIGINAL selector and
        // the captured row key to still name the same row. A concurrent move of the
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
                    ...capturedTargetFilters(
                      this.config.childScope.model,
                      this.config.targetProjection,
                      capturedRows[index]!
                    ),
                  ],
                },
                select: targetProjectionRowKeySelect(
                  this.config.targetProjection
                ),
              },
              { limit: 1 }
            ),
            nestedWriteFailure(
              relationTargetNotFound(
                this.config.membership.relation.relationInfo,
                "set"
              ),
              this.relationName,
              false
            )
          )
        );
      }
    }
    if (capturedRows.length > 0) {
      const membership = lowerMembershipWrite(
        this.config.engine,
        this.config.childScope,
        this.config.membership,
        known,
        "set"
      );
      steps.push({
        // The first target's write id, because this statement replaces exactly
        // the writes those targets used to emit one at a time.
        id: this.targets[0]!.reparentId,
        kind: "write",
        statement: buildUpdateMany(this.config.childScope, {
          // Reparent captured rows by their row keys, never by a selector that
          // can move.
          where: capturedTargetSetWhere(
            this.config.childScope,
            this.config.targetProjection,
            capturedRows
          ),
          data: membership.data,
          ...(membership.polymorphicStorage.length > 0
            ? { polymorphicStorage: membership.polymorphicStorage }
            : {}),
        }),
        outputs: {},
      });
    }
    return steps;
  }

  /**
   * The departing rows (currently this parent's children NOT in the target set).
   * Required FK: reject at compile if any exist, and pin the
   * emptiness in batch with the retained `notExists` guard. Nullable FK: null
   * their FK with one correlated bulk update.
   */
  private compileDeparting(known: PlanningKnown, steps: OperationStep[]): void {
    if (this.config.requiredFk) {
      const rows = this.departingRows(known);
      if (rows.length > 0) {
        throw new NestedWriteError(
          setRequiredOrphan(this.relationName, this.config.requiredFields),
          this.relationName
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
            setRequiredOrphan(this.relationName, this.config.requiredFields),
            this.relationName,
            true
          ),
        });
      }
      return;
    }
    const condition = finalMembershipCondition(
      this.config.engine,
      this.config.childScope,
      this.config.departingMembership,
      getTableName(this.config.childScope.model),
      known,
      "set"
    );
    const membership = lowerEmptyMembership(this.config.membership);
    steps.push({
      id: this.orphanNullId,
      kind: "write",
      statement: buildUpdateMany(this.config.childScope, {
        where: this.departingWhere(condition.filters),
        data: membership.data,
        ...(condition.predicate ? { predicate: condition.predicate } : {}),
        ...(membership.polymorphicStorage.length > 0
          ? { polymorphicStorage: membership.polymorphicStorage }
          : {}),
      }),
      outputs: {},
    });
  }

  private departingRows(known: PlanningKnown): readonly unknown[] {
    const rows = known[planningKey(this.departingId, "rows")];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 set for relation '${this.relationName}' did not expose departing rows.`,
        this.relationName
      );
    }
    return rows;
  }

  private departingStatement(
    known: PlanningKnown | undefined,
    useRef: boolean
  ): Sql {
    const membership = useRef
      ? planningMembershipCondition(
          this.config.engine,
          this.config.childScope,
          this.config.departingMembership,
          this.config.childScope.rootAlias
        )
      : finalMembershipCondition(
          this.config.engine,
          this.config.childScope,
          this.config.departingMembership,
          this.config.childScope.rootAlias,
          known ?? {},
          "set"
        );
    return buildFind(
      this.config.childScope,
      {
        where: this.departingWhere(membership.filters),
        select: targetProjectionRowKeySelect(this.config.targetProjection),
        forUpdate: this.config.txMode,
      },
      {
        limit: 1,
        ...(membership.predicate ? { predicate: membership.predicate } : {}),
      }
    );
  }

  /** `fk_i = <parent_i> [AND …] AND NOT (unique(t1) OR unique(t2) …)`. */
  private departingWhere(
    correlation: readonly Record<string, unknown>[]
  ): Record<string, unknown> | undefined {
    const exclusion =
      this.targets.length === 0
        ? []
        : [
            {
              NOT: {
                OR: this.targets.map((target) => ({
                  AND: this.uniqueEqualityFilters(target.where),
                })),
              },
            },
          ];
    const membership = [...correlation, ...exclusion];
    if (membership.length === 0) return undefined;
    return membership.length === 1 ? membership[0]! : { AND: membership };
  }

  private capturedTargetRow(
    target: SetTarget,
    known: PlanningKnown
  ): Record<string, unknown> {
    const rows = known[planningKey(target.existId, "rows")];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 set for relation '${this.relationName}' did not expose its target rows.`,
        this.relationName
      );
    }
    if (rows.length === 0) {
      throw new NestedWriteError(
        relationTargetNotFound(
          this.config.membership.relation.relationInfo,
          "set"
        ),
        this.relationName
      );
    }
    const first = rows[0];
    if (!(first && typeof first === "object")) {
      throw new NestedWriteError(
        `query-engine-v2 set for relation '${this.relationName}' captured no target row shape.`,
        this.relationName
      );
    }
    return first as Record<string, unknown>;
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
  readonly relation: ChildHeldRelation;
  readonly childName: string;
  readonly childScope: QueryScope;
  /** What the child's probe publishes — its complete row key at minimum. */
  readonly targetProjection: TargetProjection;
  readonly parentId: FinalReferenceSource;
  /**
   * What EXISTING membership is read by, beside the `parentId` new membership is
   * written with. D1 — REQUIRED: the two are the same source wherever the parent's
   * referenced value is not in transition, and every construction site says so
   * itself. `?? parentId` was the old-from-new inference Package D deletes; it was
   * benign only because every site that HAD a transition happened to thread this
   * explicitly, which is a property of the callers, not of the type.
   */
  readonly membershipReadSource: FinalReferenceSource;
  readonly txMode: boolean;
  /** Compiler dependency for an inverse upsert's relation-bearing create arm. */
  readonly recordCompilers: RecordCompilerSeam;
}

/**
 * Reject a nested update that assigns the relation-owned FK. Correlation derives
 * that column from the enclosing record; a second value source could move the
 * selected child away after it was located. The parse boundary normalizes scalar
 * shorthand, so checking the partitioned field name covers both spellings.
 *
 * RETAINED, and this is the route that keeps it (Package N1 enumerated the others and
 * measured each one closed). N1 built every nested update schema from the omitted-FK
 * owner — `v.omit(core.update, fkFields)`, `UpdateWithOmittedFk` in
 * `src/validation/relations/create.ts` — so the ordinary payload no longer arrives.
 * What still arrives is a schema on which the two scanners DISAGREE about which column
 * the relation owns:
 *
 *  · `getInverseRelationMap` (validation) tests `state.fields` for TRUTHINESS, so a
 *    relation spelled `.fields()` with zero arguments answers `[]` and the omission
 *    removes nothing;
 *  · `bindRelation` (this layer) tests `fields && fields.length > 0`, so the SAME
 *    relation is child-held and `findInverseRelationState` resolves the target's real
 *    back-reference.
 *
 * THREE of the four call positions below are reachable that way and are pinned in
 * `tests/contracts/engine/write/nested-update-owned-fk.test.ts` ("the retained engine
 * guard still catches what the parse cannot omit"); deleting the condition turns them
 * red.
 *
 * The fourth call — `buildToManyUpdateManyParts` — was added by the Package N gate, and
 * the reason is the one measurement that matters here. `updateMany` was position 4 of
 * this family and the ONLY position the guard never covered; before N1 it accepted the
 * spelled key on every schema and reparented the row. N1's omission closed it wherever
 * the two scanners agree, but on the divergent schema they do not, and the arm had no
 * owner at all: measured through the public client, `posts.updateMany.data.userId`
 * returned success and left `po1` under `thief`. One invariant, one guard, every
 * position that can violate it — not three of four.
 *
 * `buildToManyUpdateParts` has no measured live route: on the same divergent schema the
 * targeted `update` arm dies earlier, in the engine's own scanner
 * (`Cannot determine FK fields for relation 'ghost'`), because a targeted to-many update
 * binds the target's relations and the zero-argument side cannot be bound. That
 * asymmetry with `updateMany` — which binds nothing and therefore arrives — is why the
 * position that looked safest was the one standing open. It stays a guard-ownership-
 * ledger note, not licence to split one rule across two owners.
 *
 * Junction and polymorphic child-held relations never reach any of these four calls
 * (`RecordUpdateCompiler.interpretRelation` returns for both before this dispatch), so
 * the guard cannot see a `manyToMany` arm — which is the same edge `UpdateWithOmittedFk`
 * declines to omit, from the other side.
 *
 * ROUTES MEASURED CLOSED by the omission, each through the public client: nesting depth
 * ≥ 2 (`buildParsedRelationPrograms` re-validates nothing, but `core.update` recurses
 * into the target's own relation update schemas); `UpdateManyRecordSeries` members, which
 * are handed the RAW constructor args (the envelope is validated once at the series and
 * each member re-parses `data`); `CreateManyRecordSeries` rows; the composed
 * supplier+modify path with its `suppliedWhere` locator; the X1c whole-target delegation;
 * and the inverse-upsert seam's update arm.
 */
function assertOwnedFkAbsentFromUpdateData(
  base: WritePartBase,
  data: Record<string, unknown>
): void {
  const { scalarData } = partitionModelData(base.childScope, data);
  if (
    base.relation.foreignFields.some((foreignField) =>
      Object.hasOwn(scalarData, foreignField)
    )
  ) {
    throw new UnsupportedOperationError(
      relationOwnsForeignKey(
        base.relation.relationInfo.name,
        base.relation.foreignFields
      )
    );
  }
}

/** `update`: one targeted correlated Part per `{ where, data }` item. The Part owns
 * target selection and failure semantics; its `RecordUpdateCompiler` owns the selected
 * row's scalar and descendant mutations. */
export function buildToManyUpdateParts(
  base: WritePartBase,
  entry: Extract<RelationMutationEntry, { kind: "update" }>
): Part[] {
  const relationName = base.relation.relationInfo.name;
  return entry.items.map((item) => {
    if (item.target.kind !== "unique") {
      throw new QueryEngineError(
        `query-engine-v2 internal: to-many update for relation '${relationName}' requires a unique target.`
      );
    }
    // Refuse a second value source for the FK before record compilation forks.
    assertOwnedFkAbsentFromUpdateData(base, item.data);
    return new RelationWritePart(base.scope, {
      ...partConfig(base, "update"),
      where: item.target.where,
      data: item.data,
    });
  });
}

/**
 * `update` on an **inverse-side one-to-one** (child-held FK) relation: one
 * targeted correlated part whose locator is the FK correlation alone — a to-one
 * `update` carries no unique `where`. The captured PK is the single correlated
 * child and the write addresses that captured identity.
 *
 * The payload arrives as the relation update schema's canonical
 * `{ data, where? }` envelope — the ONE place the bare/wrapper spellings are told
 * apart is that parse, off the user's own payload ({@link splitToOneUpdateTarget}).
 * The wrapper's `where` is a NON-unique filter the connected record must satisfy; it
 * joins the correlated probe (and the batch guard), so a filter-miss is the family's
 * existing `Cannot update … for this parent` abort. The bare form yields no filter.
 */
export function buildToOneUpdatePart(
  base: WritePartBase,
  entry: Extract<RelationMutationEntry, { kind: "update" }>,
  /**
   * H3 — the unique selector of a sibling `connect` this modify composes with. When
   * present it REPLACES the FK correlation as the locator: the row it names is the
   * member this payload is bringing in, and correlation would find the outgoing one.
   */
  suppliedWhere?: Record<string, unknown>
): Part {
  const relationName = base.relation.relationInfo.name;
  const target = entry.items[0];
  if (!target || target.target.kind !== "correlated") {
    throw new QueryEngineError(
      `query-engine-v2 internal: to-one update for relation '${relationName}' requires one correlated target.`
    );
  }
  // The relation owns this FK, so it is never update data — whether the locator is the
  // FK correlation (a lone modify) or `suppliedWhere` (one composed with a supplier,
  // whose own assignment writes the same column).
  assertOwnedFkAbsentFromUpdateData(base, target.data);
  return new RelationWritePart(base.scope, {
    ...partConfig(base, "update"),
    data: target.data,
    ...(suppliedWhere ? { where: suppliedWhere, suppliedTarget: true } : {}),
    ...(target.target.filter ? { targetFilter: target.target.filter } : {}),
  });
}

/**
 * `upsert` on an inverse-side one-to-one (child-held FK) relation: the correlated
 * child (`WHERE fk = parent`) is the locator — no
 * unique `where`, exactly as the to-one `update` arm. Found → update it; absent →
 * create it with `fk = parent`. Composes the certified correlated-update leaf
 * ({@link buildToOneUpdatePart}) with an absent-arm create: a scalar-only arm is one
 * INSERT, and a relation-carrying arm is the create subtree below.
 */
export function buildInverseToOneUpsertPart(
  base: WritePartBase,
  input: NormalizedRelationUpsert
): RelationWritePart {
  const relationName = base.relation.relationInfo.name;
  if (input.target.kind !== "correlated") {
    throw new QueryEngineError(
      `query-engine-v2 internal: to-one upsert for relation '${relationName}' requires a correlated target.`
    );
  }
  const createData = input.create;
  // The found arm cannot move the child away by assigning its relation-owned FK.
  assertOwnedFkAbsentFromUpdateData(base, input.update);
  // A relation-bearing create arm uses the ordinary fresh-record compiler; its
  // incoming membership is injected into the subtree's root INSERT.
  const subtree = base.recordCompilers.createFresh({
    childScope: base.childScope,
    data: createData,
    incomingMembership: bindRelationMembership(base.relation, base.parentId),
    relationName,
  });
  return new RelationWritePart(base.scope, {
    ...partConfig(base, "update"),
    kind: "inverseUpsert",
    data: input.update,
    createSubtree: subtree,
  });
}

/** `updateMany`: one bulk correlated part per `{ where?, data }` item. */
export function buildToManyUpdateManyParts(
  base: WritePartBase,
  entry: Extract<RelationMutationEntry, { kind: "updateMany" }>
): RelationWritePart[] {
  return entry.items.map((item) => {
    // The bulk arm derives the same correlation the targeted one does — `WHERE fk =
    // <parent>` — so a spelled FK is the same second value source, and it rides the
    // bulk SET that lands after the correlation chose the rows.
    assertOwnedFkAbsentFromUpdateData(base, item.data);
    return new RelationWritePart(base.scope, {
      ...partConfig(base, "updateMany"),
      filter: item.where ?? {},
      data: item.data,
    });
  });
}

/** Keep an invalid nested updateMany arm structural until its owner runs legality.
 *  Same question, same owner as the legality check itself ({@link relationWriteKeys}):
 *  when this answers "no relations" and the legality check answers "yes", the Part is
 *  built AND the write is refused — or, as measured before both read one predicate, the
 *  Part is built and a polymorphic disconnect is silently dropped. */
export function updateManyCarriesRelations(
  childScope: QueryScope,
  inputs: readonly NestedUpdateManyInput[]
): boolean {
  return inputs.some(
    (input) =>
      relationWriteKeys(buildParsedRelationPrograms(childScope, input.data))
        .length > 0
  );
}

/** `delete`: one targeted correlated part per unique `where`. */
export function buildToManyDeleteParts(
  base: WritePartBase,
  entry: Extract<RelationMutationEntry, { kind: "delete" }>
): RelationWritePart[] {
  const relationName = base.relation.relationInfo.name;
  if (entry.target.kind !== "selectors") {
    throw new QueryEngineError(
      `query-engine-v2 internal: to-many delete for relation '${relationName}' requires selector targets.`
    );
  }
  return entry.target.targets.map(
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
  entry: Extract<RelationMutationEntry, { kind: "deleteMany" }>
): RelationWritePart[] {
  return entry.filters.map(
    (filter) =>
      new RelationWritePart(base.scope, {
        ...partConfig(base, "deleteMany"),
        filter,
      })
  );
}

/** `set`: one membership Part over every unique target `where`. An explicit
 * membership source separates old-key reads from new-key assignments. */
export function buildToManySetPart(
  base: WritePartBase,
  entry: Extract<RelationMutationEntry, { kind: "set" }>
): RelationSetPart {
  const requiredFields = requiredForeignKeyFields(base.relation);
  const readSource = base.membershipReadSource;
  return new RelationSetPart(base.scope, {
    engine: base.engine,
    childScope: base.childScope,
    childName: base.childName,
    membership: bindRelationMembership(base.relation, base.parentId),
    departingMembership: bindCorrelatedRelationMembership(
      base.relation,
      planningSourceFromFinal(
        readSource,
        base.relation.relationInfo.name,
        "set"
      ),
      readSource
    ),
    targetProjection: base.targetProjection,
    requiredFk: requiredFields.length > 0,
    requiredFields,
    targets: entry.targets,
    txMode: base.txMode,
  });
}

function partConfig(
  base: WritePartBase,
  kind: "delete" | "deleteMany" | "update" | "updateMany"
): RelationWriteConfig {
  return {
    engine: base.engine,
    childScope: base.childScope,
    childName: base.childName,
    membership: bindCorrelatedRelationMembership(
      base.relation,
      planningSourceFromFinal(
        base.membershipReadSource,
        base.relation.relationInfo.name,
        kind
      ),
      base.parentId
    ),
    kind,
    targetProjection: base.targetProjection,
    recordCompilers: base.recordCompilers,
    txMode: base.txMode,
  };
}
