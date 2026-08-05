// biome-ignore-all lint/style/useFilenamingConvention: RelationLinkPart is the architecture name.
import { NestedWriteError, QueryEngineError } from "@errors";
import type { Sql } from "@sql";
import type { RelationMutationEntry } from "../builders/relation-mutation-parser";
import { getWhereUniqueEntries } from "../builders/where-unique-builder";
import {
  buildFind,
  buildFindUnique,
  buildUpdate,
  buildUpdateMany,
} from "../operations";
import type { QueryEngine } from "../query-engine";
import type { QueryScope, RelationInfo } from "../types";
import {
  nestedWriteFailure,
  presenceGuard,
  referenceSql,
} from "./fragment-builders";
import {
  countDistinctTargets,
  groupLinkTargets,
  linkGroupSelector,
} from "./link-target-groups";
import { relationTargetNotFound } from "./messages";
import type { OperationStep, ReadStep, WriteStep } from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { planningKey } from "./Part";
import { referencedFieldCorrelation } from "./parent-reference";
import type { ParentIdSource } from "./RelationUpsertPart";
import type { StepScope } from "./StepScope";

export type LinkKind = "connect" | "disconnect";

export interface RelationLinkConfig {
  readonly engine: QueryEngine;
  readonly childScope: QueryScope;
  readonly childName: string;
  readonly relationName: string;
  readonly relationInfo: RelationInfo;
  readonly kind: LinkKind;
  /**
   * The child unique locators this Part links — one **key-shape group** (P4), in
   * input order. A one-entry group is the arity-1 case and keeps every statement
   * byte-identical to the per-target spelling that preceded the fold; a group of
   * N sends one probe and one write for all N. {@link groupLinkTargets} decides
   * the grouping.
   */
  readonly wheres?: readonly Record<string, unknown>[];
  /** `disconnect: true` — null every child currently connected to the parent. */
  readonly disconnectAll?: boolean;
  /**
   * The child-held foreign-key columns and the parent columns they reference,
   * index-aligned (compound keys are per-field, ATOM §1's multi-field produces).
   * A single-column edge is the length-1 case; nothing else changes.
   */
  readonly fkFields: readonly string[];
  readonly referencedFields: readonly string[];
  readonly childPrimaryKey: string;
  /**
   * Where the parent id the child FK points at comes from. In the update family
   * this is a **planned** value (the root locate read), inlined as a literal at
   * compile (a final-fragment step may not ref a planning step, ATOM §9 inv. 2).
   * The disconnect probe, however, IS a planning step, so it correlates by a SQL
   * `Ref` to that same locate read — technique #1's positive witness (ATOM §3).
   */
  readonly parentId: ParentIdSource;
  readonly txMode: boolean;
}

/**
 * The to-many (child-held-FK) connect/disconnect Part (PLAN P2a). A nested link
 * mutation is a root write plus an FK edge (WHY §4.2): connect sets the child's
 * FK to the parent, disconnect nulls it. It composes exactly like the upsert
 * Part — planning probe + compile-the-taken-arm — and adds no vocabulary.
 *
 * - **connect** plans an *uncorrelated* existence probe (the target exists
 *   globally); compile emits `UPDATE child SET fk = parent WHERE unique`, pinned
 *   in batch by an exists guard on the target. Absent target → V1's verbatim
 *   `Cannot connect …` error.
 *
 * **The IN-list fold (Phase 4).** One Part now carries a whole key-shape GROUP of
 * targets, not one target: `connect: [a, b, c]` sends one `… WHERE key IN (a,b,c)
 * FOR UPDATE` probe and one `UPDATE … WHERE key IN (a,b,c)` write instead of six
 * statements. The probe is still a planning read whose rows `compile(known)`
 * consumes — the same mechanism as before, with a wider `WHERE`, so the Pin Rule
 * is untouched. The batch presence guards stay PER TARGET (they are free
 * assertions inside the atomic unit, and one guard per target is what says which
 * target went missing). See {@link groupLinkTargets} for what may share a group.
 * - **disconnect** plans a *correlated* existence probe — `WHERE unique AND
 *   fk = Ref(locate.id)` — the hard-correlation nested read ATOM §8.1 note (a)
 *   scheduled here: its probe SQL literally carries a `Ref` to the locate
 *   planning step, and it has no found-uncorrelated arm. Present → `UPDATE child
 *   SET fk = NULL WHERE unique`; absent → V1's verbatim `Cannot disconnect … for
 *   this parent` error.
 * - **disconnect: true** needs no probe: `UPDATE child SET fk = NULL WHERE
 *   fk = parent` nulls the whole set.
 *
 * To-one (parent-held-FK) connect/disconnect is not a child write — it changes
 * the parent row's own FK — so it is folded into the root update by
 * {@link UpdateOperation}, not represented here.
 */
export class RelationLinkPart implements Part {
  private readonly config: RelationLinkConfig;
  private readonly probeId: string;
  private readonly writeId: string;
  /** One id per target — the batch presence guards stay per target. */
  private readonly guardIds: readonly string[];
  /**
   * How many DISTINCT rows the group's selector can name. The probe's row count
   * is compared against this to decide the missing-target error, which is exact
   * because a unique key names at most one row: `rows.length` IS the number of
   * distinct keys that exist. See {@link countDistinctTargets}.
   */
  private readonly distinctTargets: number;
  private readonly probe?: ReadStep;

  constructor(scope: StepScope, config: RelationLinkConfig) {
    this.config = config;
    this.probeId = scope.allocate(`${config.childName}.find`);
    this.writeId = scope.allocate(`${config.childName}.${config.kind}`);
    this.guardIds = (config.wheres ?? []).map(() =>
      scope.allocate(`${config.childName}.guard.exists`)
    );
    this.distinctTargets = countDistinctTargets(
      config.childScope,
      config.wheres ?? []
    );
    this.probe = this.buildProbe();
  }

  planning(): readonly ReadStep[] {
    return this.probe ? [this.probe] : [];
  }

  compile(_scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    if (this.config.kind === "connect") return this.compileConnect(known);
    return this.compileDisconnect(known);
  }

  /** The uncorrelated (connect) / correlated (disconnect) existence probe. */
  private buildProbe(): ReadStep | undefined {
    if (this.config.disconnectAll) return undefined;
    const { childScope, txMode, childPrimaryKey } = this.config;
    const wheres = this.requiredWheres();
    const select = { [childPrimaryKey]: true };
    if (this.config.kind === "connect") {
      return {
        id: this.probeId,
        kind: "read",
        statement:
          wheres.length === 1
            ? buildFindUnique(childScope, {
                where: wheres[0]!,
                select,
                forUpdate: txMode,
              })
            : // The group's whole IN list in one locked read. No `limit` — the
              // selector is a set of unique keys, so it bounds itself, and a
              // limit would only add an ORDER BY the read does not need.
              buildFind(childScope, {
                where: this.groupSelector(),
                select,
                forUpdate: txMode,
              }),
        outputs: { rows: { kind: "rows" } },
      };
    }
    // Disconnect: correlate the probe to the located parent by a SQL Ref — the
    // hard-correlation read that carries technique #1's positive witness.
    return {
      id: this.probeId,
      kind: "read",
      statement: buildFind(
        childScope,
        {
          where: {
            AND: [...this.selectorConjuncts(), ...this.correlationFilters()],
          },
          select,
          forUpdate: txMode,
        },
        wheres.length === 1 ? { limit: 1 } : {}
      ),
      outputs: { rows: { kind: "rows" } },
    };
  }

  private compileConnect(known: PlanningKnown): readonly OperationStep[] {
    this.requireProbeFoundAll(known, "connect");
    const { childScope } = this.config;
    const wheres = this.requiredWheres();
    const steps: OperationStep[] = [];
    if (!this.config.txMode) {
      // Batch: pin each target's presence before the reparent write (atomicity
      // then makes the grouped update affect exactly one row per target). One
      // guard per target, not one per group: the guards are free in-batch
      // assertions, and per target is what names the target that went missing.
      for (const [index, where] of wheres.entries()) {
        steps.push(
          presenceGuard(
            this.guardIds[index]!,
            buildFindUnique(childScope, {
              where,
              select: { [this.config.childPrimaryKey]: true },
            }),
            this.connectFailure()
          )
        );
      }
    }
    steps.push({
      id: this.writeId,
      kind: "write",
      statement: this.linkWrite(this.fkAssignData(known)),
      outputs: {},
    });
    return steps;
  }

  private compileDisconnect(known: PlanningKnown): readonly OperationStep[] {
    if (this.config.disconnectAll) return [this.buildDisconnectAll(known)];
    this.requireProbeFoundAll(known, "disconnect");
    const { childScope } = this.config;
    const wheres = this.requiredWheres();
    const steps: OperationStep[] = [];
    if (!this.config.txMode) {
      // Batch: pin that each child is still connected to this parent.
      for (const [index, where] of wheres.entries()) {
        steps.push(
          presenceGuard(
            this.guardIds[index]!,
            buildFind(
              childScope,
              {
                where: {
                  AND: [
                    ...this.uniqueEqualityFilters(where),
                    ...this.guardCorrelationFilters(known),
                  ],
                },
                select: { [this.config.childPrimaryKey]: true },
              },
              { limit: 1 }
            ),
            this.disconnectFailure()
          )
        );
      }
    }
    steps.push({
      id: this.writeId,
      kind: "write",
      statement: this.linkWrite(this.fkNullData()),
      outputs: {},
    });
    return steps;
  }

  /**
   * The group's one write. A one-target group keeps `UPDATE … WHERE <the unique
   * where the caller wrote>` verbatim; a group of N addresses its rows by the
   * SAME unique key columns, widened to an IN list. Addressing by the caller's
   * key rather than by the probe's primary keys is deliberate: in batch mode the
   * probe runs before the atomic unit, so a primary key read there is older than
   * the guard that admits the write, while the key columns are exactly what the
   * guard re-asserts.
   */
  private linkWrite(data: Record<string, unknown>): Sql {
    const { childScope } = this.config;
    const wheres = this.requiredWheres();
    if (wheres.length === 1) {
      return buildUpdate(childScope, {
        where: wheres[0]!,
        data,
        select: { [this.config.childPrimaryKey]: true },
      });
    }
    return buildUpdateMany(childScope, { where: this.groupSelector(), data });
  }

  private groupSelector(): Record<string, unknown> {
    return linkGroupSelector(this.config.childScope, this.requiredWheres());
  }

  /** The selector half of the disconnect probe: the arity-1 spelling verbatim,
   *  or the group's one IN-list / OR term. */
  private selectorConjuncts(): Record<string, unknown>[] {
    const wheres = this.requiredWheres();
    if (wheres.length === 1) return this.uniqueEqualityFilters(wheres[0]!);
    return [this.groupSelector()];
  }

  private buildDisconnectAll(known: PlanningKnown): WriteStep {
    const { childScope } = this.config;
    return {
      id: this.writeId,
      kind: "write",
      statement: buildUpdateMany(childScope, {
        where: { AND: this.guardCorrelationFilters(known) },
        data: this.fkNullData(),
      }),
      outputs: {},
    };
  }

  /**
   * Every target in the group must have been found, or the operation raises V1's
   * verbatim target-not-found for this relation — the same message, the same
   * attribution and the same phase (compile, before any write) as the per-target
   * path raised.
   *
   * The verdict is a COUNT, and the count is exact rather than approximate: each
   * member of the group is a complete unique key, so the group's selector names
   * at most one row per DISTINCT key, and the probe therefore returns exactly as
   * many rows as there are distinct keys that exist. Fewer rows than distinct
   * keys means at least one named target is not there. This needs no comparison
   * of a decoded column value against an input value — which is why a repeated
   * target (`connect: [{ id: 1 }, { id: 1 }]`, one row, two entries) still
   * succeeds, and why {@link groupLinkTargets} folds only keys whose values it
   * can compare exactly.
   */
  private requireProbeFoundAll(known: PlanningKnown, kind: LinkKind): void {
    const rows = known[planningKey(this.probeId, "rows")];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 ${kind} probe for relation '${this.config.relationName}' did not expose rows.`,
        this.config.relationName
      );
    }
    if (rows.length < this.distinctTargets) {
      throw new NestedWriteError(
        kind === "connect"
          ? relationTargetNotFound(this.config.relationInfo, "connect")
          : relationTargetNotFound(this.config.relationInfo, "disconnect"),
        this.config.relationName
      );
    }
  }

  private connectFailure() {
    return nestedWriteFailure(
      relationTargetNotFound(this.config.relationInfo, "connect"),
      this.config.relationName,
      false
    );
  }

  private disconnectFailure() {
    return nestedWriteFailure(
      relationTargetNotFound(this.config.relationInfo, "disconnect"),
      this.config.relationName,
      false
    );
  }

  /** The connect write's FK assignment: every FK column ← its referenced parent
   *  column value (one entry per compound-key field, ATOM §1). */
  private fkAssignData(known: PlanningKnown): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (let index = 0; index < this.config.fkFields.length; index += 1) {
      const fkField = this.config.fkFields[index]!;
      data[fkField] = referenceSql(
        this.config.engine,
        this.config.childScope.model,
        fkField,
        this.parentReferenced(known, index)
      );
    }
    return data;
  }

  /** The disconnect write's FK assignment: null every FK column. */
  private fkNullData(): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const fkField of this.config.fkFields) data[fkField] = { set: null };
    return data;
  }

  /** The disconnect probe's `fk_i = Ref(locate.referenced_i)` clauses — the
   *  technique #1 markers, one per compound-key field — or, under a depth-composed
   *  LITERAL parent (a located-by-PK nested target, an upsert UPDATE arm named by its
   *  own primary key), that parent's compile-time constant inlined. One home for both
   *  provenances: {@link referencedFieldCorrelation}. */
  private correlationFilters(): Record<string, unknown>[] {
    return this.config.fkFields.map((fkField, index) => ({
      [fkField]: {
        equals: referencedFieldCorrelation(
          this.config.parentId,
          this.config.referencedFields[index]!,
          this.config.relationName,
          "disconnect"
        ),
      },
    }));
  }

  /** The batch disconnect guard's `fk_i = <literal referenced_i>` clauses. */
  private guardCorrelationFilters(
    known: PlanningKnown
  ): Record<string, unknown>[] {
    return this.config.fkFields.map((fkField, index) => ({
      [fkField]: { equals: this.parentReferenced(known, index) },
    }));
  }

  /** The concrete value of the parent column the FK field `index` references
   *  (never a Ref — inlined at compile). */
  private parentReferenced(known: PlanningKnown, index: number): unknown {
    const source = this.config.parentId;
    if (source.kind === "literal") return source.value;
    if (source.kind !== "planned") {
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
    return (row as Record<string, unknown>)[
      this.config.referencedFields[index]!
    ];
  }

  private uniqueEqualityFilters(
    where: Record<string, unknown>
  ): Record<string, unknown>[] {
    return getWhereUniqueEntries(this.config.childScope, where).map(
      ({ fieldName, value }) => ({ [fieldName]: { equals: value } })
    );
  }

  private requiredWheres(): readonly Record<string, unknown>[] {
    const wheres = this.config.wheres;
    if (!wheres || wheres.length === 0) {
      throw new QueryEngineError(
        `query-engine-v2 ${this.config.kind} for relation '${this.config.relationName}' requires a unique where.`
      );
    }
    return wheres;
  }
}

/**
 * Fold one to-many connect/disconnect relation mutation into link Parts — one
 * per **key-shape group** of targets ({@link groupLinkTargets}), plus the
 * `disconnect: true` / `connect`-single spellings. The FK must be child-held; a
 * parent-held FK is a same-row change and is handled in {@link UpdateOperation}.
 */
export function buildToManyLinkParts(
  scope: StepScope,
  engine: QueryEngine,
  relationName: string,
  relationInfo: RelationInfo,
  childName: string,
  childScope: QueryScope,
  fkFields: readonly string[],
  referencedFields: readonly string[],
  childPrimaryKey: string,
  entry: Extract<RelationMutationEntry, { kind: "connect" | "disconnect" }>,
  parentId: ParentIdSource,
  txMode: boolean
): RelationLinkPart[] {
  const base = {
    engine,
    childScope,
    childName,
    relationName,
    relationInfo,
    kind: entry.kind,
    fkFields,
    referencedFields,
    childPrimaryKey,
    parentId,
    txMode,
  } as const;
  if (entry.kind === "disconnect" && entry.target.kind === "current") {
    return [new RelationLinkPart(scope, { ...base, disconnectAll: true })];
  }
  const targets =
    entry.kind === "connect"
      ? entry.targets
      : entry.target.kind === "selectors"
        ? entry.target.targets
        : [];
  return groupLinkTargets(childScope, targets).map(
    (wheres) => new RelationLinkPart(scope, { ...base, wheres })
  );
}
