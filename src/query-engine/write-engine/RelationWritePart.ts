// biome-ignore-all lint/style/useFilenamingConvention: RelationWritePart is the architecture name.
import { NestedWriteError, QueryEngineError } from "@errors";
import type { Sql } from "@sql";
import type {
  ChildHeldToMany,
  ChildHeldToOne,
} from "../builders/relation-data-builder";
import type {
  NormalizedRelationUpsert,
  RelationMutationEntry,
} from "../builders/relation-mutation-parser";
import {
  buildParsedRelationPrograms,
  partitionModelData,
} from "../builders/relation-mutation-parser";
import { getWhereUniqueEntries } from "../builders/where-unique-builder";
import {
  buildDelete,
  buildDeleteMany,
  buildFind,
  buildFindUnique,
  buildUpdate,
  buildUpdateMany,
} from "../operations";
import { assertPortablePrimaryKeyUpdateInput } from "../operations/mutation-identity";
import type { QueryEngine } from "../query-engine";
import { assertRelationKeyUpdatesAreCompilable } from "../relation-key-legality";
import type { QueryScope } from "../types";
import {
  type FinalReferenceSource,
  foreignKeyCorrelationValue,
  foreignKeyWriteValue,
  pairForeignKeyMembers,
  planningSourceFromFinal,
} from "./foreign-key-reference";
import {
  affectedRows,
  exactlyOneRow,
  nestedWriteFailure,
  presenceGuard,
  referenceSql,
} from "./fragment-builders";
import {
  relationOwnsForeignKey,
  relationTargetNotFound,
  setRequiredOrphan,
  upsertPremiseChanged,
  upsertTargetVanished,
} from "./messages";
import type { FreshArmBuilder } from "./nested-target-parts";
import type {
  OperationStep,
  ReadStep,
  StatementStep,
  WriteStep,
} from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { planningKey } from "./Part";
import {
  buildRecordUpdateCompiler,
  type RecordUpdateCompiler,
} from "./RecordUpdateCompiler";
import { requiredForeignKeyFields } from "./relation-nullability";
import type { StepScope } from "./StepScope";
import { UnsupportedOperationError, uniqueSelectorConjuncts } from "./shared";

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

type ChildHeldRelation = ChildHeldToOne | ChildHeldToMany;

export interface RelationWriteConfig {
  readonly engine: QueryEngine;
  readonly childScope: QueryScope;
  readonly childName: string;
  readonly relation: ChildHeldRelation;
  readonly kind: RelationWriteKind;
  /**
   * The child-held foreign-key columns and the parent columns they reference,
   * index-aligned (compound keys are per-field, ATOM §1's multi-field produces).
   * A single-column edge is the length-1 case; nothing else changes.
   */
  readonly childPrimaryKey: string;
  /** The located parent id (a planning value, inlined as a literal at compile). */
  readonly parentId: FinalReferenceSource;
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
   * update payload. The locator stays the FK correlation alone (no unique `where`); the
   * absent arm has no `racePin` and no found guard (V1's `missingPin: none`), the
   * found arm carries the upsert-family premise/vanished wording.
   */
  /** N4-U2 — the inverse-side to-one upsert's CREATE arm is always a fresh subtree. */
  readonly upsertCreateSubtree?: Part;
}

export class RelationWritePart implements Part {
  private readonly config: RelationWriteConfig;
  private readonly probeId: string;
  private readonly writeId: string;
  private readonly guardId: string;
  private readonly probe?: ReadStep;
  // The validated scalar assignments of a targeted `update`/`updateMany` (∅ when a
  // relation-only nested update carries no scalars — then no self-UPDATE is emitted,
  // only the child Parts). Computed once at construction.
  private readonly updateScalarData?: Record<string, unknown>;
  private readonly updateCompiler?: RecordUpdateCompiler;
  // N7-U-B — a nested `update`/`updateMany` arm that asks for nothing: no scalar
  // assignment, no deeper relation write, and not an upsert arm (whose CREATE half
  // still runs when the probe finds no row). Prisma skips such an arm entirely, so
  // this Part emits NO step — not the probe, not the presence guard, not an empty-SET
  // UPDATE — and in particular does not require the target to exist.
  private readonly isNoOpUpdate: boolean = false;

  private get relationName(): string {
    return this.config.relation.relationInfo.name;
  }

  private get foreignFields(): readonly string[] {
    return this.config.relation.foreignFields;
  }

  private get referencedFields(): readonly string[] {
    return this.config.relation.referencedFields;
  }

  constructor(scope: StepScope, config: RelationWriteConfig) {
    this.config = config;
    if (config.kind === "update" && config.upsertCreateSubtree === undefined) {
      this.updateCompiler = this.buildUpdateCompiler(scope);
      this.isNoOpUpdate = this.updateCompiler === undefined;
    }
    if (this.isNoOpUpdate) {
      this.probeId = "";
      this.writeId = "";
      this.guardId = "";
      return;
    }
    this.probeId =
      this.updateCompiler?.targetReadId ??
      scope.allocate(`${config.childName}.find`);
    this.writeId =
      this.updateCompiler?.writeId ??
      scope.allocate(`${config.childName}.${config.kind}`);
    this.guardId = scope.allocate(`${config.childName}.guard.exists`);
    // Payload-determined support decisions are made at CONSTRUCTION — before any
    // I/O — so a shape V2 does not own declines with a typed UnsupportedOperationError
    // that PROPAGATES (post-P6: no V1 fallback catches it). A nested relation write
    // inside `update`/`updateMany` data was, pre-T3b, such a shape; mechanism 1 now
    // folds it one level deeper (see `interpretChildParts`).
    if (
      config.kind === "updateMany" ||
      (config.kind === "update" && config.upsertCreateSubtree !== undefined)
    ) {
      this.updateScalarData = this.parseScalarUpdateData();
      this.isNoOpUpdate =
        config.upsertCreateSubtree === undefined &&
        Object.keys(this.updateScalarData).length === 0;
    }
    // The probe is built LAST: whether it owes the deeper edges the located primary
    // key is a fact about the child Parts, which are interpreted above. A no-op arm
    // gets no probe — it must not make the target's existence a precondition.
    this.probe =
      this.isTargeted() && !this.isNoOpUpdate ? this.buildProbe() : undefined;
  }

  planning(scope: StepScope): readonly StatementStep[] {
    if (this.isNoOpUpdate) return [];
    const steps: StatementStep[] = this.probe ? [this.probe] : [];
    if (this.updateCompiler) steps.push(...this.updateCompiler.planning());
    if (this.config.upsertCreateSubtree) {
      steps.push(...this.config.upsertCreateSubtree.planning(scope));
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
    if (this.config.upsertCreateSubtree !== undefined) {
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
    if (this.updateCompiler) {
      steps.push(...this.updateCompiler.compile(known));
      return steps;
    }
    throw new QueryEngineError(
      `query-engine-v2 update for relation '${this.relationName}' has no record compiler.`
    );
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
      const createSubtree = this.config.upsertCreateSubtree;
      if (!createSubtree) {
        throw new QueryEngineError(
          `query-engine-v2 upsert for relation '${this.relationName}' requires a create subtree.`
        );
      }
      return createSubtree.compile(scope, known);
    }
    const first = rows[0];
    if (!(first && typeof first === "object")) {
      throw new NestedWriteError(
        `query-engine-v2 upsert probe for relation '${this.relationName}' captured no row shape.`,
        this.relationName
      );
    }
    // Found + an update arm that asks for nothing: Prisma's no-op (the same rule
    // `isNoOpUpdate` pins for plain update arms — measured, N7 review). The CREATE
    // half is what kept this Part out of `isNoOpUpdate`; on the FOUND branch that
    // half is not taken, so there is nothing to write and no premise to pin.
    if (!this.hasSelfUpdate()) return [];
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
            upsertPremiseChanged(this.relationName),
            this.relationName,
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
        `query-engine-v2 upsert probe for relation '${this.relationName}' did not expose rows.`,
        this.relationName
      );
    }
    return rows;
  }

  /** Found arm of the inverse-side to-one upsert: UPDATE the captured child, pinned
   *  in tx by the upsert-vanished affected-rows expectation. */
  private buildUpsertUpdateArm(where: Record<string, unknown>): WriteStep {
    const step: WriteStep = {
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
        message: upsertTargetVanished(this.relationName),
        relation: this.relationName,
        raceable: false,
      }),
    };
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

  private buildDeleteMany(known: PlanningKnown): WriteStep {
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
                { kind: "firstRowField" as const, field },
              ])
            )
          : {}),
      },
    };
    return this.updateCompiler
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
        select: Object.fromEntries(
          selectedFields.map((field) => [field, true])
        ),
        forUpdate: this.config.txMode,
      },
      { limit: 1 }
    );
  }

  /** `WHERE fk = <parentLiteral> [AND filter]` for a bulk write. */
  private correlatedFilter(known: PlanningKnown): Record<string, unknown> {
    const correlation =
      this.foreignFields.length === 1
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
    return this.foreignFields.map((fkField, index) => {
      const referencedField = this.referencedFields[index]!;
      const member = {
        foreignField: fkField,
        referencedField,
        writeSource: this.config.parentId,
      };
      return {
        [fkField]: {
          equals: useRef
            ? foreignKeyCorrelationValue({
                ...member,
                readSource: planningSourceFromFinal(
                  this.config.parentId,
                  this.relationName,
                  this.config.kind
                ),
              })
            : foreignKeyWriteValue(
                member,
                known,
                this.relationName,
                this.config.kind
              ),
        },
      };
    });
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
    return buildRecordUpdateCompiler({
      scope,
      engine: this.config.engine,
      targetScope: this.config.childScope,
      data,
      targetReadLabel: `${this.config.childName}.find`,
      writeLabel: `${this.config.childName}.update`,
      locate: {
        ...(this.config.where ? { where: this.config.where } : {}),
        parentId: this.config.parentId,
        childFields: this.foreignFields,
        parentFields: this.referencedFields,
        ...(this.config.targetFilter
          ? { filter: this.config.targetFilter }
          : {}),
        relationName: this.relationName,
        notFoundMessage: relationTargetNotFound(
          this.config.relation.relationInfo,
          "update"
        ),
      },
    });
  }

  /** Bulk updates and the legacy inverse-to-one upsert leaf accept scalar data only. */
  private parseScalarUpdateData(): Record<string, unknown> {
    const { data, childScope, kind } = this.config;
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
      const operation =
        this.config.upsertCreateSubtree === undefined ? kind : "upsert";
      throw new UnsupportedOperationError(
        `query-engine-v2 ${operation} for relation '${this.relationName}' does not support nested relation writes in its data.`
      );
    }
    return scalarData;
  }

  /** The validated scalar assignments of a targeted `update`/`updateMany`; the leaf
   *  UPDATE consumes them. Present for every `update`/`updateMany` (computed once at
   *  construction); a relation-only nested update never reaches a leaf that needs it. */
  private requireUpdateScalarData(): Record<string, unknown> {
    if (!this.updateScalarData) {
      throw new QueryEngineError(
        `query-engine-v2 ${this.config.kind} for relation '${this.relationName}' has no scalar data.`
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
        `query-engine-v2 ${this.config.kind} probe for relation '${this.relationName}' did not expose rows.`,
        this.relationName
      );
    }
    if (rows.length === 0) {
      throw new NestedWriteError(
        relationTargetNotFound(
          this.config.relation.relationInfo,
          this.targetedOp()
        ),
        this.relationName
      );
    }
    const first = rows[0];
    if (!(first && typeof first === "object")) {
      throw new NestedWriteError(
        `query-engine-v2 ${this.config.kind} probe for relation '${this.relationName}' captured no row shape.`,
        this.relationName
      );
    }
    return (first as Record<string, unknown>)[this.config.childPrimaryKey];
  }

  private targetFailure() {
    return nestedWriteFailure(
      relationTargetNotFound(
        this.config.relation.relationInfo,
        this.targetedOp()
      ),
      this.relationName,
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

  /** W4-U3 — the inverse-side to-one `update: { where, data }` filter on the currently
   *  connected record, as a single ordinary `WhereInput` term (not a unique
   *  discriminator, so it is handed to the find builder whole). `[]` for the bare
   *  `update: <data>` spelling and for every other kind, which keeps their probe and
   *  guard SQL byte-identical to pre-W4-U3. */
  private targetFilters(): Record<string, unknown>[] {
    const filter = this.config.targetFilter;
    return filter && Object.keys(filter).length > 0 ? [filter] : [];
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
  readonly relation: ChildHeldRelation;
  readonly childPrimaryKey: string;
  readonly requiredFk: boolean;
  readonly requiredFields: readonly string[];
  readonly targets: readonly Record<string, unknown>[];
  readonly parentId: FinalReferenceSource;
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
  readonly membershipReadSource?: FinalReferenceSource;
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
  private readonly departingRead?: ReadStep;

  private get relationName(): string {
    return this.config.relation.relationInfo.name;
  }

  private get foreignFields(): readonly string[] {
    return this.config.relation.foreignFields;
  }

  private get referencedFields(): readonly string[] {
    return this.config.relation.referencedFields;
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
   * P4 — the departing half, then every target's batch guard, then ONE reparent
   * write over the captured primary keys.
   *
   * `set` already addressed each target by the primary key its own probe captured
   * (V1's mutation-identity: the write can never land on a replacement), so the
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
              relationTargetNotFound(this.config.relation.relationInfo, "set"),
              this.relationName,
              false
            )
          )
        );
      }
    }
    if (capturedPks.length > 0) {
      steps.push({
        // The first target's write id, because this statement replaces exactly
        // the writes those targets used to emit one at a time.
        id: this.targets[0]!.reparentId,
        kind: "write",
        statement: buildUpdateMany(this.config.childScope, {
          // Reparent the captured rows by their PKs, not the user selectors
          // (V1's mutation-identity), so the write can never land on a
          // replacement.
          where: { [this.config.childPrimaryKey]: { in: capturedPks } },
          data: this.fkAssignData(known),
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
        `query-engine-v2 set for relation '${this.relationName}' did not expose its target rows.`,
        this.relationName
      );
    }
    if (rows.length === 0) {
      throw new NestedWriteError(
        relationTargetNotFound(this.config.relation.relationInfo, "set"),
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

  /** The reparent write's FK assignment: every FK column ← its referenced parent
   *  column value (one entry per compound-key field, ATOM §1). */
  private fkAssignData(known: PlanningKnown): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (let index = 0; index < this.foreignFields.length; index += 1) {
      const fkField = this.foreignFields[index]!;
      data[fkField] = referenceSql(
        this.config.engine,
        this.config.childScope.model,
        fkField,
        foreignKeyWriteValue(
          {
            foreignField: fkField,
            referencedField: this.referencedFields[index]!,
            writeSource: this.config.parentId,
          },
          known,
          this.relationName,
          "set"
        )
      );
    }
    return data;
  }

  /** The departing-null write's FK assignment: null every FK column. */
  private fkNullData(): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const fkField of this.foreignFields) data[fkField] = { set: null };
    return data;
  }

  /** `fk_i = <parent_i>` for every compound-key field — a SQL `Ref` at planning
   *  (technique #1), or the inlined literal at compile. Reads the DEPARTING-side
   *  parent value ({@link RelationSetConfig.membershipReadSource}), which is the
   *  assigned one everywhere except under a non-cascade transition. */
  private correlationFilters(
    known: PlanningKnown | undefined,
    useRef: boolean
  ): Record<string, unknown>[] {
    const source = this.config.membershipReadSource ?? this.config.parentId;
    return this.foreignFields.map((fkField, index) => {
      const member = {
        foreignField: fkField,
        referencedField: this.referencedFields[index]!,
        writeSource: source,
      };
      return {
        [fkField]: {
          equals: useRef
            ? foreignKeyCorrelationValue({
                ...member,
                readSource: planningSourceFromFinal(
                  source,
                  this.relationName,
                  "set"
                ),
              })
            : foreignKeyWriteValue(member, known, this.relationName, "set"),
        },
      };
    });
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
  /** N4-U2: the fresh-arm seam the inverse-side to-one upsert's relation-carrying
   *  CREATE arm is built through. REQUIRED, so the absorption cannot be reached without
   *  it — a caller that forgot the seam would otherwise turn a typed refusal into an
   *  internal invariant break, and a runtime fallback for that would be a guard with no
   *  reachable coverage to name. */
  readonly freshArm: FreshArmBuilder;
}

/**
 * **M12 — the relation's own foreign key, spelled in nested UPDATE data.** The column
 * `fkFields` names is not the payload's to write here: this family DERIVES it from the
 * row the enclosing step acted on (`fk = <parent>`, the correlation every Part below is
 * built around). A value spelled beside the relation is a SECOND provenance for that
 * same column — and it WINS, because it rides the target's own SET, which lands after
 * the correlation has already chosen the row. Measured live (PGlite, public client): the
 * parent silently loses the child it was updating through, no error, wrong row reparented.
 * That is the wrong-row doctrine at the value path, so the shape is refused, not absorbed.
 *
 * ONE check covers BOTH spellings, by construction rather than by a second branch: the
 * parse boundary coerces a bare literal into the `{ set: … }` envelope
 * (`validation/primitives/shorthand.ts`), and the model-data partition files it under the
 * FIELD NAME whichever envelope it wears — so keying on the key is spelling-blind, and an
 * unwrap here would be a check with no coverage of its own to name. `undefined` is
 * absence (the partition drops it), matching Prisma and the adopt-family seam.
 *
 * The three nested UPDATE positions call this; the nested CREATE positions do not need
 * it (`v.omit(core.create, fkFields)` answers them at the parse boundary), and the adopt family already has its
 * own (`buildOneUpsertPart`, `RelationUpsertPart.ts`). All say it from one string.
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

/** `update`: one targeted correlated part per `{ where, data }` item. A target whose
 *  data carries the located-target projection of mechanism 1/2 (a parent-held to-one
 *  write, or a non-PK / compound referenced edge — D4) delegates its WHOLE update to an
 *  {@link UpdateOperation} nested-target sub-op (X1c); the common child-held-to-PK / m2m
 *  / create target stays on the proven leaf path. */
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
    // M12 position 1 — the to-many `update` arm's data (`posts: { update: { where,
    // data } }`). Uniquely covered here because it is the only place this payload is
    // held before the fork below: refusing on BOTH sides costs one check, while a
    // check inside either branch would leave the other silent.
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
  // M12 position 2 — the inverse-side to-one `update` arm's data (`profile: { update:
  // … } }`). Uniquely covered here: this is the only place BOTH the bare and the
  // `{ data, where }` spellings are the same object (`splitToOneUpdateTarget` has just
  // reconciled them) and the only place before the X1c fork below. This relation's FK
  // is the child's whole locator — spelling it moves the row OUT of the parent that is
  // updating through it.
  assertOwnedFkAbsentFromUpdateData(base, target.data);
  return new RelationWritePart(base.scope, {
    ...partConfig(base, "update"),
    data: target.data,
    ...(target.target.filter ? { targetFilter: target.target.filter } : {}),
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
  input: NormalizedRelationUpsert
): RelationWritePart {
  const relationName = base.relation.relationInfo.name;
  if (input.target.kind !== "correlated") {
    throw new QueryEngineError(
      `query-engine-v2 internal: to-one upsert for relation '${relationName}' requires a correlated target.`
    );
  }
  const createData = input.create;
  // M12 position 3 — the inverse-side to-one `upsert` UPDATE arm. Uniquely covered
  // here: this arm reaches `RelationWritePart` as an `update` config, but through a
  // builder position no other guard sees, and it is the arm the FOUND branch runs — the
  // one branch whose row already belongs to this parent and can therefore be stolen from
  // it. The CREATE arm needs nothing: `v.omit(core.create, fkFields)` refuses the key at
  // the parse boundary.
  assertOwnedFkAbsentFromUpdateData(base, input.update);
  // N4-U2 — a relation-carrying create arm is the create SUBTREE, the same absorption
  // the to-many adopt family's create arm takes. The arm's foreign key is injected into
  // the subtree's root INSERT by the identical expression the scalar arm writes, so the
  // two spellings land the same row under the same parent.
  const subtree = base.freshArm({
    childScope: base.childScope,
    data: createData,
    incomingForeignKey: pairForeignKeyMembers(
      base.relation.foreignFields,
      base.relation.referencedFields,
      base.relation.referencedFields.map(() => base.parentId)
    ),
    relationName,
  });
  return new RelationWritePart(base.scope, {
    ...partConfig(base, "update"),
    data: input.update,
    upsertCreateSubtree: subtree,
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

/** `set`: one membership Part over every unique target `where`. `membershipReadSource`
 *  (N5-U1) splits the departing half off the assigned half; omit it and both read
 *  `base.parentId`. */
export function buildToManySetPart(
  base: WritePartBase,
  entry: Extract<RelationMutationEntry, { kind: "set" }>,
  membershipReadSource?: FinalReferenceSource
): RelationSetPart {
  const requiredFields = requiredForeignKeyFields(base.relation);
  return new RelationSetPart(base.scope, {
    membershipReadSource,
    engine: base.engine,
    childScope: base.childScope,
    childName: base.childName,
    relation: base.relation,
    childPrimaryKey: base.childPrimaryKey,
    requiredFk: requiredFields.length > 0,
    requiredFields,
    targets: entry.targets,
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
    relation: base.relation,
    kind,
    childPrimaryKey: base.childPrimaryKey,
    parentId: base.parentId,
    txMode: base.txMode,
  };
}
