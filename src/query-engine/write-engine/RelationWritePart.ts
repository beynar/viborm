// biome-ignore-all lint/style/useFilenamingConvention: RelationWritePart is the architecture name.
import { NestedWriteError, QueryEngineError } from "@errors";
import type { Sql } from "@sql";
import type {
  ChildHeldToMany,
  ChildHeldToOne,
  PolymorphicChildHeldToMany,
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
  assertPinnedTransitionIsCompilable,
  assertRelationKeyUpdatesAreCompilable,
  assertSelectedUpdateManyDataIsScalar,
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
import { planningKey } from "./Part";
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
  pinnedTargetValues,
  UnsupportedOperationError,
  uniqueSelectorConjuncts,
} from "./shared";

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
  | PolymorphicChildHeldToMany;

interface RelationWriteContext {
  readonly engine: QueryEngine;
  readonly childScope: QueryScope;
  readonly childName: string;
  readonly membership: CorrelatedRelationMembershipBinding;
  readonly childPrimaryKey: string;
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
}

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
    // Payload support is decided before I/O. Ordinary targeted updates delegate
    // nested relations to the record compiler; bulk and inverse-upsert leaves
    // remain scalar-only.
    if (config.kind === "updateMany") {
      this.updateScalarData = this.parseScalarUpdateData();
      this.isNoOpUpdate = Object.keys(this.updateScalarData).length === 0;
    } else if (config.kind === "inverseUpsert") {
      const scalarData = this.parseScalarUpdateData();
      updateCompiler = config.recordCompilers.updateSelected({
        scope,
        engine: config.engine,
        targetScope: config.childScope,
        scalarData,
        relations: {},
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
    if (this.updateCompiler) steps.push(...this.updateCompiler.planning());
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
   * `update` one / `delete` one: the leaf write addresses the **captured PK** the
   * probe selected, not the user selector. In batch mode the presence guard binds
   * the original selector, parent correlation, and captured PK to the same row, so
   * moving the selector to a replacement fails the guard.
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
   *   guard on `fk = parent AND pk = capturedPk` (the upsert-family premise wording),
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
    const capturedPk = (first as Record<string, unknown>)[
      this.config.childPrimaryKey
    ];
    const steps: OperationStep[] = [];
    if (!this.config.txMode) {
      steps.push(
        presenceGuard(
          this.guardId,
          this.correlatedProbeStatement(known, false, capturedPk),
          nestedWriteFailure(
            upsertPremiseChanged(this.relationName),
            this.relationName,
            false
          )
        )
      );
    }
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
    const selectedFields = this.updateCompiler?.requiredTargetFields ?? [
      this.config.childPrimaryKey,
    ];
    const step: ReadStep = {
      id: this.probeId,
      kind: "read",
      statement: this.correlatedProbeStatement(undefined, true),
      outputs: {
        rows: { kind: "rows" },
        ...(this.updateCompiler
          ? Object.fromEntries(
              selectedFields.map((field) => [
                field,
                {
                  kind: "firstRowField" as const,
                  field,
                  ...(this.config.kind === "inverseUpsert"
                    ? { optional: true }
                    : {}),
                },
              ])
            )
          : {}),
      },
    };
    return this.updateCompiler && this.config.kind !== "inverseUpsert"
      ? { ...step, expects: exactlyOneRow(this.targetFailure()) }
      : step;
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
    const selectedFields = this.updateCompiler?.requiredTargetFields ?? [
      this.config.childPrimaryKey,
    ];
    const membership = useRef
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
    return buildFind(
      this.config.childScope,
      {
        where: {
          AND: [
            ...this.optionalWhereFilters(),
            ...this.targetFilters(),
            ...membership.filters,
            ...(capturedPk === undefined
              ? []
              : [{ [this.config.childPrimaryKey]: { equals: capturedPk } }]),
          ],
        },
        select: Object.fromEntries(
          selectedFields.map((field) => [field, true])
        ),
        forUpdate: this.config.txMode,
      },
      {
        limit: 1,
        ...(membership.predicate ? { predicate: membership.predicate } : {}),
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
    assertPinnedTransitionIsCompilable(
      this.config.childScope,
      parsed.scalarData,
      parsed.relations,
      this.relationName,
      pinnedTarget
    );
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

  /** Bulk updates and inverse-to-one upsert updates accept scalar data only. */
  private parseScalarUpdateData(): Record<string, unknown> {
    const { data, childScope } = this.config;
    const kind = this.operationKind;
    if (!data) {
      throw new QueryEngineError(
        `query-engine-v2 ${kind} for relation '${this.relationName}' requires data.`
      );
    }
    const { scalarData, relations } = buildParsedRelationPrograms(
      childScope,
      data
    );
    assertPortablePrimaryKeyUpdateInput(childScope.model, kind, {
      data: scalarData,
    });
    assertRelationKeyUpdatesAreCompilable(childScope, scalarData, relations);
    if (Object.keys(relations).length > 0) {
      const operation = this.config.kind === "inverseUpsert" ? "upsert" : kind;
      throw new UnsupportedOperationError(
        `query-engine-v2 ${operation} for relation '${this.relationName}' does not support nested relation writes in its data.`
      );
    }
    return scalarData;
  }

  /** The primary key captured by the correlated probe. An absent row uses the
   * relation family's target-not-found failure. */
  private capturedPk(known: PlanningKnown): unknown {
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
    return (first as Record<string, unknown>)[this.config.childPrimaryKey];
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
  readonly childPrimaryKey: string;
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
    const capturedPks = this.targets.map((target) =>
      this.capturedTargetPk(target, known)
    );
    const steps: OperationStep[] = [];
    this.compileDeparting(known, steps);
    if (!this.config.txMode) {
      for (const [index, target] of this.targets.entries()) {
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
                    {
                      [this.config.childPrimaryKey]: {
                        equals: capturedPks[index],
                      },
                    },
                  ],
                },
                select: { [this.config.childPrimaryKey]: true },
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
    if (capturedPks.length > 0) {
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
          // Reparent captured rows by PK, never by a selector that can move.
          where: { [this.config.childPrimaryKey]: { in: capturedPks } },
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
        select: { [this.config.childPrimaryKey]: true },
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

  private capturedTargetPk(target: SetTarget, known: PlanningKnown): unknown {
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
    return (first as Record<string, unknown>)[this.config.childPrimaryKey];
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
  readonly childPrimaryKey: string;
  readonly parentId: FinalReferenceSource;
  readonly txMode: boolean;
  /** Compiler dependency for an inverse upsert's relation-bearing create arm. */
  readonly recordCompilers: RecordCompilerSeam;
}

/**
 * Reject a nested update that assigns the relation-owned FK. Correlation derives
 * that column from the enclosing record; a second value source could move the
 * selected child away after it was located. The parse boundary normalizes scalar
 * shorthand, so checking the partitioned field name covers both spellings.
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
  entry: Extract<RelationMutationEntry, { kind: "update" }>
): Part {
  const relationName = base.relation.relationInfo.name;
  const target = entry.items[0];
  if (!target || target.target.kind !== "correlated") {
    throw new QueryEngineError(
      `query-engine-v2 internal: to-one update for relation '${relationName}' requires one correlated target.`
    );
  }
  // The relation-owned FK is the whole locator and cannot also be update data.
  assertOwnedFkAbsentFromUpdateData(base, target.data);
  return new RelationWritePart(base.scope, {
    ...partConfig(base, "update"),
    data: target.data,
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
  return entry.items.map(
    (item) =>
      new RelationWritePart(base.scope, {
        ...partConfig(base, "updateMany"),
        filter: item.where ?? {},
        data: item.data,
      })
  );
}

/** Keep an invalid nested updateMany arm structural until its owner runs legality. */
export function updateManyCarriesRelations(
  childScope: QueryScope,
  inputs: readonly NestedUpdateManyInput[]
): boolean {
  return inputs.some(
    (input) =>
      Object.keys(buildParsedRelationPrograms(childScope, input.data).relations)
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
  entry: Extract<RelationMutationEntry, { kind: "set" }>,
  membershipReadSource?: FinalReferenceSource
): RelationSetPart {
  const requiredFields = requiredForeignKeyFields(base.relation);
  const readSource = membershipReadSource ?? base.parentId;
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
    childPrimaryKey: base.childPrimaryKey,
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
        base.parentId,
        base.relation.relationInfo.name,
        kind
      ),
      base.parentId
    ),
    kind,
    childPrimaryKey: base.childPrimaryKey,
    recordCompilers: base.recordCompilers,
    txMode: base.txMode,
  };
}
