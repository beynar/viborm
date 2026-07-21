// biome-ignore-all lint/style/useFilenamingConvention: RelationWritePart is the architecture name.
import { NestedWriteError, QueryEngineError } from "@errors";
import type { Sql } from "@sql";
import { separateData } from "../query-engine/builders/relation-data-builder";
import { buildInsert } from "../query-engine/builders/values-builder";
import { getWhereUniqueEntries } from "../query-engine/builders/where-unique-builder";
import { getTableName } from "../query-engine/context/query-scope";
import {
  buildDelete,
  buildDeleteMany,
  buildFind,
  buildFindUnique,
  buildUpdate,
  buildUpdateMany,
} from "../query-engine/operations";
import { assertPortablePrimaryKeyUpdateInput } from "../query-engine/operations/mutation-identity";
import type { QueryEngine } from "../query-engine/query-engine";
import type { QueryScope, RelationInfo } from "../query-engine/types";
import {
  affectedRows,
  nestedWriteFailure,
  presenceGuard,
  referenceSql,
} from "./fragment-builders";
import {
  relationTargetNotFound,
  setRequiredOrphan,
  upsertPremiseChanged,
  upsertTargetVanished,
} from "./messages";
import type { OperationStep, StatementStep } from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { planningKey } from "./Part";
import { referencedFieldRef, referencedFieldValue } from "./parent-reference";
import type { ParentIdSource } from "./RelationUpsertPart";
import type { StepScope } from "./StepScope";
import { UnsupportedOperationError } from "./shared";

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
   * Inverse-side one-to-one **upsert** (TO-ONE.md §7.2, family F): the create-arm
   * scalar data taken when the correlated probe finds NO child of this parent. When
   * present, this `kind: "update"` part becomes an upsert — `data` is the found-arm
   * update payload, `upsertCreateData` the absent-arm insert payload (fk = parent
   * injected). The locator stays the FK correlation alone (no unique `where`); the
   * absent arm has no `racePin` and no found guard (V1's `missingPin: none`), the
   * found arm carries the upsert-family premise/vanished wording. Scalar-only arms;
   * a relation-carrying arm routes the whole tree to V1 at construction.
   */
  readonly upsertCreateData?: Record<string, unknown>;
}

export class RelationWritePart implements Part {
  private readonly config: RelationWriteConfig;
  private readonly probeId: string;
  private readonly writeId: string;
  private readonly upsertCreateId?: string;
  private readonly guardId: string;
  private readonly probe?: StatementStep;

  constructor(scope: StepScope, config: RelationWriteConfig) {
    this.config = config;
    this.probeId = scope.allocate(`${config.childName}.find`);
    this.writeId = scope.allocate(`${config.childName}.${config.kind}`);
    this.guardId = scope.allocate(`${config.childName}.guard.exists`);
    this.probe = this.isTargeted() ? this.buildProbe() : undefined;
    // Payload-determined support decisions are made at CONSTRUCTION — before any
    // I/O — so the per-tree router falls back to V1 for a shape V2 does not own.
    // A nested relation write inside `update`/`updateMany` data (V1's surface,
    // not P2c's) is such a shape. Deferring this `scalarData()` rejection to
    // `compile()` fired it AFTER the planning read, escaping the router's
    // construction-time `UnsupportedOperationError` catch and surfacing V2's
    // message where V1's byte-identical error was the contract.
    if (config.kind === "update" || config.kind === "updateMany") {
      this.scalarData();
      // V1's PK-arithmetic portability check on the nested child data (float/decimal
      // non-portability, divide-by-zero, one-op) — a payload legality gate at
      // construction (before the probe), matching RelationUpdates. Reuses V1's
      // verbatim messages.
      if (config.data) {
        assertPortablePrimaryKeyUpdateInput(
          config.childScope.model,
          config.kind,
          {
            data: config.data,
          }
        );
      }
    }
    if (config.upsertCreateData !== undefined) {
      // Family F: the absent-arm insert. Allocate its own write id and validate the
      // create payload at construction (scalar-only, no relations, no owned FK) so a
      // relation-carrying create arm routes the whole tree to V1 before any I/O.
      this.upsertCreateId = scope.allocate(`${config.childName}.create`);
      this.upsertCreateScalarData();
    }
  }

  planning(): readonly OperationStep[] {
    return this.probe ? [this.probe] : [];
  }

  compile(_scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    if (this.config.kind === "updateMany") return [this.buildUpdateMany(known)];
    if (this.config.kind === "deleteMany") return [this.buildDeleteMany(known)];
    return this.compileTargeted(known);
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
  private compileTargeted(known: PlanningKnown): readonly OperationStep[] {
    if (this.config.upsertCreateData !== undefined) {
      return this.compileInverseToOneUpsert(known);
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
    steps.push(
      this.config.kind === "update"
        ? this.buildUpdateOne(capturedWhere)
        : this.buildDeleteOne(capturedWhere)
    );
    return steps;
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
    known: PlanningKnown
  ): readonly OperationStep[] {
    const rows = this.probeRows(known);
    if (rows.length === 0) return [this.buildUpsertCreateArm(known)];
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
        data: this.scalarData(),
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
      // A relation-carrying create arm is V1's surface — route the whole tree to V1.
      throw new UnsupportedOperationError(
        `query-engine-v2 upsert for relation '${this.config.relationName}' does not support nested relation writes in its create arm.`
      );
    }
    if (
      this.config.fkFields.some((fkField) => Object.hasOwn(scalarData, fkField))
    ) {
      throw new UnsupportedOperationError(
        `Relation '${this.config.relationName}' owns '${this.config.fkFields.join(", ")}'; omit it from the nested upsert create data.`
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
        data: this.scalarData(),
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
        data: this.scalarData(),
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
    return {
      id: this.probeId,
      kind: "read",
      statement: this.correlatedProbeStatement(undefined, true),
      outputs: { rows: { kind: "rows" } },
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
   *  located-parent read at planning (technique #1), or the inlined literal at
   *  compile. */
  private correlationFilters(
    known: PlanningKnown | undefined,
    useRef: boolean
  ): Record<string, unknown>[] {
    return this.config.fkFields.map((fkField, index) => ({
      [fkField]: {
        equals: useRef
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

  private scalarData(): Record<string, unknown> {
    const { data, childScope, relationName, kind } = this.config;
    if (!data) {
      throw new QueryEngineError(
        `query-engine-v2 ${kind} for relation '${relationName}' requires data.`
      );
    }
    const { scalarData, relations } = separateData(childScope, data);
    if (Object.keys(relations).length > 0) {
      // Nested relation writes inside a nested update/updateMany are V1's
      // surface, not P2c's — route the whole tree to V1.
      throw new UnsupportedOperationError(
        `query-engine-v2 ${kind} for relation '${relationName}' does not support nested relation writes in its data.`
      );
    }
    if (Object.keys(scalarData).length === 0) {
      throw new UnsupportedOperationError(
        `query-engine-v2 ${kind} for relation '${relationName}' requires at least one scalar assignment.`
      );
    }
    return scalarData;
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

  private uniqueEqualityFilters(
    where: Record<string, unknown>
  ): Record<string, unknown>[] {
    return getWhereUniqueEntries(this.config.childScope, where).map(
      ({ fieldName, value }) => ({ [fieldName]: { equals: value } })
    );
  }

  /**
   * The child's unique-selector equality filters, or `[]` when this targeted
   * mutation has no unique `where` — the **inverse-side to-one** case (TO-ONE.md
   * §7.2), where the FK correlation is the whole locator (V1's `normalizeUpdateInputs`
   * yields `{ data }` with no selector for a to-one, and `RelationUpdates` locates
   * the child by `filter: correlatedWhere(fk, parentValues)` alone). A to-many
   * targeted `update`/`delete` always supplies its unique `where`.
   */
  private optionalWhereFilters(): Record<string, unknown>[] {
    return this.config.where
      ? this.uniqueEqualityFilters(this.config.where)
      : [];
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
   *  (technique #1), or the inlined literal at compile. */
  private correlationFilters(
    known: PlanningKnown | undefined,
    useRef: boolean
  ): Record<string, unknown>[] {
    return this.config.fkFields.map((fkField, index) => ({
      [fkField]: {
        equals: useRef
          ? referencedFieldRef(
              this.config.parentId,
              this.config.referencedFields[index]!,
              this.config.relationName,
              "set"
            )
          : referencedFieldValue(
              this.config.parentId,
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
}

/** `update`: one targeted correlated part per `{ where, data }` item. */
export function buildToManyUpdateParts(
  base: WritePartBase,
  input: unknown
): RelationWritePart[] {
  return normalizeWhereData(input, base.relationName, "update").map(
    (item) =>
      new RelationWritePart(base.scope, {
        ...partConfig(base, "update"),
        where: item.where,
        data: item.data,
      })
  );
}

/**
 * `update` on an **inverse-side one-to-one** (child-held FK) relation: one
 * targeted correlated part whose locator is the FK correlation alone — the to-one
 * `update: <data>` payload carries no unique `where` (TO-ONE.md §7.2, V1's
 * `normalizeUpdateInputs` yields `{ data }` for a to-one). The captured PK is the
 * single correlated child; the write addresses it (V1's mutation-identity).
 */
export function buildToOneUpdatePart(
  base: WritePartBase,
  data: unknown
): RelationWritePart {
  if (!(data && typeof data === "object" && !Array.isArray(data))) {
    throw new QueryEngineError(
      `query-engine-v2 update for relation '${base.relationName}' requires a data object.`
    );
  }
  return new RelationWritePart(base.scope, {
    ...partConfig(base, "update"),
    data: data as Record<string, unknown>,
  });
}

/**
 * `upsert` on an **inverse-side one-to-one** (child-held FK) relation (TO-ONE.md
 * §7.2, family F): the correlated child (`WHERE fk = parent`) is the locator — no
 * unique `where`, exactly as the to-one `update` arm. Found → update it; absent →
 * create it with `fk = parent`. Composes the certified correlated-update leaf
 * ({@link buildToOneUpdatePart}) with an absent-arm create; scalar-only arms (a
 * relation-carrying arm routes the whole tree to V1 at construction).
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
  return new RelationWritePart(base.scope, {
    ...partConfig(base, "update"),
    data: update as Record<string, unknown>,
    upsertCreateData: create as Record<string, unknown>,
  });
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

/** `set`: one membership Part over every unique target `where`. */
export function buildToManySetPart(
  base: WritePartBase,
  input: unknown
): RelationSetPart {
  const requiredFields = requiredFkFieldsFor(base);
  return new RelationSetPart(base.scope, {
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
