// biome-ignore-all lint/style/useFilenamingConvention: RelationWritePart is the architecture name.
import { NestedWriteError, QueryEngineError } from "@errors";
import type { Sql } from "@sql";
import { separateData } from "../query-engine/builders/relation-data-builder";
import { getWhereUniqueEntries } from "../query-engine/builders/where-unique-builder";
import {
  buildDelete,
  buildDeleteMany,
  buildFind,
  buildFindUnique,
  buildUpdate,
  buildUpdateMany,
} from "../query-engine/operations";
import type { QueryEngine } from "../query-engine/query-engine";
import type { QueryScope, RelationInfo } from "../query-engine/types";
import {
  nestedWriteFailure,
  presenceGuard,
  referenceSql,
} from "./fragment-builders";
import { relationTargetNotFound, setRequiredOrphan } from "./messages";
import {
  type OperationStep,
  ref,
  type StatementStep,
} from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { planningKey } from "./Part";
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
  readonly childForeignKey: string;
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
}

export class RelationWritePart implements Part {
  private readonly config: RelationWriteConfig;
  private readonly probeId: string;
  private readonly writeId: string;
  private readonly guardId: string;
  private readonly probe?: StatementStep;

  constructor(scope: StepScope, config: RelationWriteConfig) {
    this.config = config;
    this.probeId = scope.allocate(`${config.childName}.find`);
    this.writeId = scope.allocate(`${config.childName}.${config.kind}`);
    this.guardId = scope.allocate(`${config.childName}.guard.exists`);
    this.probe = this.isTargeted() ? this.buildProbe() : undefined;
  }

  planning(): readonly OperationStep[] {
    return this.probe ? [this.probe] : [];
  }

  compile(_scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    if (this.config.kind === "updateMany") return [this.buildUpdateMany(known)];
    if (this.config.kind === "deleteMany") return [this.buildDeleteMany(known)];
    return this.compileTargeted(known);
  }

  /** `update` one / `delete` one: correlated probe, then the leaf write. */
  private compileTargeted(known: PlanningKnown): readonly OperationStep[] {
    this.requireProbeFound(known);
    const where = this.requiredWhere();
    const steps: OperationStep[] = [];
    if (!this.config.txMode) {
      // Batch: pin the child is still this parent's before the write.
      steps.push(
        presenceGuard(
          this.guardId,
          this.correlatedProbeStatement(known, false),
          this.targetFailure()
        )
      );
    }
    steps.push(
      this.config.kind === "update"
        ? this.buildUpdateOne(where)
        : this.buildDeleteOne(where)
    );
    return steps;
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
   * `WHERE unique AND fk = <parent>`, limited to one row. When `useRef` the
   * correlation carries a SQL `Ref` to the located-parent planning read
   * (technique #1, in the planning probe); otherwise the located id is inlined
   * as a literal (the batch exists guard, a final-fragment step).
   */
  private correlatedProbeStatement(
    known: PlanningKnown | undefined,
    useRef: boolean
  ): Sql {
    return buildFind(
      this.config.childScope,
      {
        where: {
          AND: [
            ...this.uniqueEqualityFilters(this.requiredWhere()),
            {
              [this.config.childForeignKey]: {
                equals: useRef ? this.parentRef() : this.parentLiteral(known),
              },
            },
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
    const correlation = {
      [this.config.childForeignKey]: { equals: this.parentLiteral(known) },
    };
    const filter = this.config.filter;
    return filter && Object.keys(filter).length > 0
      ? { AND: [correlation, filter] }
      : correlation;
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

  private requireProbeFound(known: PlanningKnown): void {
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

  private parentRef() {
    const source = this.config.parentId;
    if (source.kind !== "planned") {
      throw new QueryEngineError(
        `query-engine-v2 ${this.config.kind} for relation '${this.config.relationName}' requires a planned parent id to correlate its probe.`
      );
    }
    return ref(source.readStep, source.field);
  }

  private parentLiteral(known: PlanningKnown | undefined): unknown {
    const source = this.config.parentId;
    if (source.kind === "literal") return source.value;
    if (source.kind !== "planned" || !known) {
      throw new QueryEngineError(
        `query-engine-v2 ${this.config.kind} for relation '${this.config.relationName}' requires a planned parent id.`
      );
    }
    const rows = known[planningKey(source.readStep, "rows")];
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!(row && typeof row === "object")) {
      throw new NestedWriteError(
        `query-engine-v2 ${this.config.kind} for relation '${this.config.relationName}' could not resolve its parent id.`,
        this.config.relationName
      );
    }
    return (row as Record<string, unknown>)[source.field];
  }

  private uniqueEqualityFilters(
    where: Record<string, unknown>
  ): Record<string, unknown>[] {
    return getWhereUniqueEntries(this.config.childScope, where).map(
      ({ fieldName, value }) => ({ [fieldName]: { equals: value } })
    );
  }

  private requiredWhere(): Record<string, unknown> {
    if (!this.config.where) {
      throw new QueryEngineError(
        `query-engine-v2 ${this.config.kind} for relation '${this.config.relationName}' requires a unique where.`
      );
    }
    return this.config.where;
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
  readonly childForeignKey: string;
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
          statement: this.departingStatement(this.parentRef()),
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
    for (const target of this.targets) this.requireTargetExists(target, known);
    const steps: OperationStep[] = [];
    this.compileDeparting(known, steps);
    for (const target of this.targets) {
      if (!this.config.txMode) {
        steps.push(
          presenceGuard(
            target.guardId,
            buildFindUnique(this.config.childScope, {
              where: target.where,
              select: { [this.config.childPrimaryKey]: true },
            }),
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
          where: target.where,
          data: { [this.config.childForeignKey]: this.parentIdValue(known) },
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
            statement: this.departingStatement(this.parentLiteral(known)),
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
        where: this.departingWhere(this.parentLiteral(known)),
        data: { [this.config.childForeignKey]: { set: null } },
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

  private departingStatement(parent: unknown): Sql {
    return buildFind(
      this.config.childScope,
      {
        where: this.departingWhere(parent),
        select: { [this.config.childPrimaryKey]: true },
        forUpdate: this.config.txMode,
      },
      { limit: 1 }
    );
  }

  /** `fk = <parent> AND NOT (unique(t1) OR unique(t2) …)`. */
  private departingWhere(parent: unknown): Record<string, unknown> {
    const correlation = { [this.config.childForeignKey]: { equals: parent } };
    if (this.targets.length === 0) return correlation;
    return {
      AND: [
        correlation,
        {
          NOT: {
            OR: this.targets.map((target) => ({
              AND: this.uniqueEqualityFilters(target.where),
            })),
          },
        },
      ],
    };
  }

  private requireTargetExists(target: SetTarget, known: PlanningKnown): void {
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
  }

  private parentIdValue(known: PlanningKnown): Sql {
    return referenceSql(
      this.config.engine,
      this.config.childScope.model,
      this.config.childForeignKey,
      this.parentLiteral(known)
    );
  }

  private parentRef() {
    const source = this.config.parentId;
    if (source.kind !== "planned") {
      throw new QueryEngineError(
        `query-engine-v2 set for relation '${this.config.relationName}' requires a planned parent id to correlate its departing read.`
      );
    }
    return ref(source.readStep, source.field);
  }

  private parentLiteral(known: PlanningKnown): unknown {
    const source = this.config.parentId;
    if (source.kind === "literal") return source.value;
    if (source.kind !== "planned") {
      throw new QueryEngineError(
        `query-engine-v2 set for relation '${this.config.relationName}' requires a planned parent id.`
      );
    }
    const rows = known[planningKey(source.readStep, "rows")];
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!(row && typeof row === "object")) {
      throw new NestedWriteError(
        `query-engine-v2 set for relation '${this.config.relationName}' could not resolve its parent id.`,
        this.config.relationName
      );
    }
    return (row as Record<string, unknown>)[source.field];
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
  readonly childForeignKey: string;
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
  fkFields: readonly string[],
  input: unknown
): RelationSetPart {
  const requiredFields = requiredFkFieldsFor(base, fkFields);
  return new RelationSetPart(base.scope, {
    engine: base.engine,
    childScope: base.childScope,
    childName: base.childName,
    relationName: base.relationName,
    relationInfo: base.relationInfo,
    childForeignKey: base.childForeignKey,
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
    childForeignKey: base.childForeignKey,
    childPrimaryKey: base.childPrimaryKey,
    parentId: base.parentId,
    txMode: base.txMode,
  };
}

/** Which of the child's FK fields are required (non-nullable) — V1's rule. */
function requiredFkFieldsFor(
  base: WritePartBase,
  fkFields: readonly string[]
): string[] {
  const scalars = base.childScope.model["~"].state.scalars;
  return fkFields.filter(
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
