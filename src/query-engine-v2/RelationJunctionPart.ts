// biome-ignore-all lint/style/useFilenamingConvention: RelationJunctionPart is the architecture name.
import { NestedWriteError, QueryEngineError } from "@errors";
import { getManyToManyJoinInfo } from "../query-engine/builders/many-to-many-utils";
import {
  type RelationMutation,
  separateData,
} from "../query-engine/builders/relation-data-builder";
import { getRelationMutationKinds } from "../query-engine/builders/relation-mutation-parser";
import { createQueryScope } from "../query-engine/context/query-scope";
import { manyToManyStatement } from "../query-engine/ManyToManyMemberships";
import { ManyToManyStatements } from "../query-engine/ManyToManyStatements";
import {
  buildDelete,
  buildDeleteMany,
  buildFindUnique,
  buildUpdate,
} from "../query-engine/operations";
import type { QueryEngine } from "../query-engine/query-engine";
import type { QueryScope, RelationInfo } from "../query-engine/types";
import { nestedWriteFailure, presenceGuard } from "./fragment-builders";
import {
  m2mDisconnectRequiresSelector,
  m2mMembershipRace,
  relationTargetNotFound,
} from "./messages";
import {
  type GuardStep,
  type OperationStep,
  ref,
  type StatementStep,
} from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { planningKey } from "./Part";
import type { ParentIdSource } from "./RelationUpsertPart";
import type { StepScope } from "./StepScope";
import { getStepModelName, UnsupportedOperationError } from "./shared";

/**
 * Many-to-many is not special (WHY §4.3): a junction is two FK edges plus a
 * join-row write leaf, and membership mutations are *leaves* feeding the same
 * step vocabulary — never a subsystem. This one Part expresses every M2M
 * membership kind under a root `update` by composing V1's frozen junction SQL
 * builders (`ManyToMany*` / `many-to-many-utils`, the reuse target) as leaves.
 * Junction identity and self-referential A/B direction come from V1's
 * `getManyToManyJoinInfo`, proven by raw junction-row inspection tests.
 *
 * Membership reads are **planning-time** (ATOM §3 corollary): the connected set
 * a `deleteMany` targets is read at planning, correlated to the located parent
 * by a SQL `Ref` (technique #1), and inlined into the final junction/​target SQL
 * at compile — it never crosses a write boundary at runtime. The symmetric-
 * difference guards a `deleteMany` pins are the **retained `notExists`
 * materialized-set pins** (ATOM §2, `raceable: true` — Pin Rule class 3).
 *
 * - **connect**: probe the target exists (global), then INSERT the join row
 *   (idempotent via junction-PK skip). Absent → V1's verbatim `Cannot connect …`.
 * - **disconnect**: DELETE join rows matching source ∧ target (subquery); no
 *   probe (idempotent). Boolean `disconnect` is rejected before I/O.
 * - **set**: probe every target, DELETE all join rows for the parent, INSERT the
 *   target join rows (V1's replace-set); the materialized target set is inlined.
 * - **delete**: locate the connected child (membership ∧ unique), DELETE its join
 *   rows, then DELETE the child row. Absent → `Cannot delete … for this parent`.
 * - **deleteMany**: read the connected∧filter target set at planning, pin it with
 *   the added/removed difference guards (`raceable: true`), DELETE those join
 *   rows and child rows. Zero matches is a silent success.
 * - **update**: locate the connected child, UPDATE it by primary key. Absent →
 *   `Cannot update … for this parent`.
 * - **updateMany**: UPDATE every connected∧filter child in one correlated write.
 */
export type JunctionKind =
  | "connect"
  | "delete"
  | "deleteMany"
  | "disconnect"
  | "set"
  | "update"
  | "updateMany";

export interface RelationJunctionConfig {
  readonly engine: QueryEngine;
  readonly parentScope: QueryScope;
  readonly relationName: string;
  readonly relationInfo: RelationInfo;
  readonly childName: string;
  readonly kind: JunctionKind;
  /** The located parent id (a planning value; a literal at compile, a Ref at planning). */
  readonly parentId: ParentIdSource;
  readonly txMode: boolean;
  /** connect/disconnect/set/delete/update: the child unique locator(s). */
  readonly wheres?: readonly Record<string, unknown>[];
  /** update/updateMany: the validated scalar data, aligned to `wheres`/`filters`. */
  readonly data?: readonly Record<string, unknown>[];
  /** deleteMany/updateMany: the correlated filter(s). */
  readonly filters?: readonly Record<string, unknown>[];
}

/** A per-target probe slot (connect/set/delete/update) with its write ids. */
interface TargetSlot {
  readonly where: Record<string, unknown>;
  readonly probeId: string;
  readonly guardId: string;
  readonly writeId: string;
  readonly childId: string;
  readonly probe: StatementStep;
}

/** A per-filter bulk slot (deleteMany) with its materialized-set difference ids. */
interface BulkSlot {
  readonly filter: Record<string, unknown>;
  readonly readId: string;
  readonly addedGuardId: string;
  readonly removedGuardId: string;
  readonly junctionId: string;
  readonly childId: string;
  readonly read: StatementStep;
}

/** A probe-less slot (disconnect/updateMany) — a single write id per item. */
interface BareSlot {
  readonly where: Record<string, unknown>;
  readonly writeId: string;
  readonly data?: Record<string, unknown>;
}

export class RelationJunctionPart implements Part {
  private readonly config: RelationJunctionConfig;
  private readonly targetPkField: string;
  private readonly childScope: QueryScope;
  private readonly statements: ManyToManyStatements;
  private readonly targets: readonly TargetSlot[];
  private readonly bulks: readonly BulkSlot[];
  private readonly bare: readonly BareSlot[];
  private readonly setClearId: string;
  private readonly setInsertId: string;

  constructor(scope: StepScope, config: RelationJunctionConfig) {
    this.config = config;
    const join = getManyToManyJoinInfo(config.parentScope, config.relationInfo);
    this.targetPkField = join.targetPkField;
    this.childScope = createQueryScope(
      config.engine.adapter,
      config.relationInfo.targetModel
    );
    this.statements = new ManyToManyStatements(
      config.parentScope,
      config.txMode
    );

    const kind = config.kind;
    const usesTargetProbe =
      kind === "connect" ||
      kind === "set" ||
      kind === "delete" ||
      kind === "update";
    this.targets = usesTargetProbe
      ? (config.wheres ?? []).map((where, index) =>
          this.buildTargetSlot(scope, where, index)
        )
      : [];
    this.bulks =
      kind === "deleteMany"
        ? (config.filters ?? []).map((filter) =>
            this.buildBulkSlot(scope, filter)
          )
        : [];
    this.bare = this.buildBareSlots(scope);
    this.setClearId =
      kind === "set" ? scope.allocate(`${config.childName}.set.clear`) : "";
    this.setInsertId =
      kind === "set" ? scope.allocate(`${config.childName}.set.insert`) : "";
  }

  planning(): readonly OperationStep[] {
    const steps: OperationStep[] = [];
    for (const target of this.targets) steps.push(target.probe);
    for (const bulk of this.bulks) steps.push(bulk.read);
    return steps;
  }

  compile(_scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    const parent = this.parentLiteral(known);
    switch (this.config.kind) {
      case "connect":
        return this.compileConnect(parent, known);
      case "disconnect":
        return this.compileDisconnect(parent);
      case "set":
        return this.compileSet(parent, known);
      case "delete":
        return this.compileDelete(parent, known);
      case "deleteMany":
        return this.compileDeleteMany(parent, known);
      case "update":
        return this.compileUpdate(parent, known);
      case "updateMany":
        return this.compileUpdateMany(parent);
      default: {
        const exhaustive: never = this.config.kind;
        throw new QueryEngineError(
          `query-engine-v2 junction part has no compile for '${exhaustive}'.`
        );
      }
    }
  }

  // connect — probe the target globally, then INSERT the idempotent join row.
  private compileConnect(
    parent: unknown,
    known: PlanningKnown
  ): readonly OperationStep[] {
    const steps: OperationStep[] = [];
    for (const target of this.targets) {
      const targetPk = this.requireTarget(target, known, "connect");
      if (!this.config.txMode) {
        steps.push(this.targetPresenceGuard(target, "connect"));
      }
      steps.push(
        this.junctionWrite(target.writeId, "junctionInsert", {
          parentValue: parent,
          targetValue: targetPk,
        })
      );
    }
    return steps;
  }

  // disconnect — DELETE join rows by target subquery; idempotent, no probe.
  private compileDisconnect(parent: unknown): readonly OperationStep[] {
    return this.bare.map((slot) =>
      this.junctionWrite(slot.writeId, "junctionDelete", {
        parentValue: parent,
        targetWhere: slot.where,
      })
    );
  }

  // set — replace the whole membership with the target set (V1's semantics).
  private compileSet(
    parent: unknown,
    known: PlanningKnown
  ): readonly OperationStep[] {
    const guards: OperationStep[] = [];
    const targetPks: unknown[] = [];
    for (const target of this.targets) {
      targetPks.push(this.requireTarget(target, known, "set"));
      if (!this.config.txMode) {
        guards.push(this.targetPresenceGuard(target, "set"));
      }
    }
    const writes: OperationStep[] = [
      this.junctionWrite(this.setClearId, "junctionDelete", {
        parentValue: parent,
      }),
    ];
    if (targetPks.length > 0) {
      writes.push(
        this.junctionWrite(this.setInsertId, "junctionInsertMany", {
          parentValue: parent,
          targetValues: targetPks,
        })
      );
    }
    return [...guards, ...writes];
  }

  // delete — locate the connected child, DELETE its join rows, then the child.
  private compileDelete(
    parent: unknown,
    known: PlanningKnown
  ): readonly OperationStep[] {
    const guards: OperationStep[] = [];
    const writes: OperationStep[] = [];
    for (const target of this.targets) {
      const targetPk = this.requireTarget(target, known, "delete");
      if (!this.config.txMode) {
        guards.push(this.connectedPresenceGuard(target, parent, "delete"));
      }
      writes.push(
        this.junctionWrite(target.writeId, "junctionDeleteTargets", {
          parentValue: parent,
          targetValues: [targetPk],
        }),
        this.childDelete(target.childId, targetPk)
      );
    }
    return [...guards, ...writes];
  }

  // deleteMany — pin the connected∧filter set (raceable:true), then delete it.
  private compileDeleteMany(
    parent: unknown,
    known: PlanningKnown
  ): readonly OperationStep[] {
    const guards: OperationStep[] = [];
    const writes: OperationStep[] = [];
    for (const bulk of this.bulks) {
      const targetPks = this.connectedSet(bulk, known);
      if (!this.config.txMode) {
        guards.push(
          this.differenceGuard(bulk, parent, targetPks, "added"),
          this.differenceGuard(bulk, parent, targetPks, "removed")
        );
      }
      writes.push(
        this.junctionWrite(bulk.junctionId, "junctionDeleteTargets", {
          parentValue: parent,
          targetValues: targetPks,
        }),
        this.childDeleteMany(bulk.childId, targetPks)
      );
    }
    return [...guards, ...writes];
  }

  // update — locate the connected child, UPDATE it by primary key.
  private compileUpdate(
    parent: unknown,
    known: PlanningKnown
  ): readonly OperationStep[] {
    const guards: OperationStep[] = [];
    const writes: OperationStep[] = [];
    const data = this.config.data ?? [];
    for (let index = 0; index < this.targets.length; index += 1) {
      const target = this.targets[index]!;
      const targetPk = this.requireTarget(target, known, "update");
      if (!this.config.txMode) {
        guards.push(this.connectedPresenceGuard(target, parent, "update"));
      }
      writes.push(
        this.childUpdate(target.writeId, targetPk, data[index] ?? {})
      );
    }
    return [...guards, ...writes];
  }

  // updateMany — UPDATE every connected∧filter child in one correlated write.
  private compileUpdateMany(parent: unknown): readonly OperationStep[] {
    const steps: OperationStep[] = [];
    for (const slot of this.bare) {
      const data = slot.data ?? {};
      if (Object.keys(data).length === 0) continue;
      steps.push({
        id: slot.writeId,
        kind: "write",
        statement: this.statements.materialize(
          manyToManyStatement(
            this.config.parentScope,
            this.config.relationInfo,
            "membershipUpdateMany",
            {
              parentValue: parent,
              ...(Object.keys(slot.where).length > 0
                ? { where: slot.where }
                : {}),
              data,
            }
          )
        ),
        outputs: {},
      });
    }
    return steps;
  }

  // -------------------------------------------------------------------------
  // Slot construction (all step ids scope-allocated once, at construction).
  // -------------------------------------------------------------------------
  private buildTargetSlot(
    scope: StepScope,
    where: Record<string, unknown>,
    _index: number
  ): TargetSlot {
    const { kind, childName } = this.config;
    const connected = kind === "delete" || kind === "update";
    const probeId = scope.allocate(`${childName}.find`);
    const statement = connected
      ? this.membershipRead({
          parentValue: this.parentRef(),
          whereUnique: where,
          take: 1,
        })
      : buildFindUnique(this.childScope, {
          where,
          select: { [this.targetPkField]: true },
          forUpdate: this.config.txMode,
        });
    return {
      where,
      probeId,
      guardId: scope.allocate(`${childName}.guard.exists`),
      writeId: scope.allocate(`${childName}.${kind}`),
      childId: scope.allocate(`${childName}.delete.child`),
      probe: {
        id: probeId,
        kind: "read",
        statement,
        outputs: { rows: { kind: "rows" } },
      },
    };
  }

  private buildBulkSlot(
    scope: StepScope,
    filter: Record<string, unknown>
  ): BulkSlot {
    const { childName } = this.config;
    const readId = scope.allocate(`${childName}.members`);
    return {
      filter,
      readId,
      addedGuardId: scope.allocate(`${childName}.guard.added`),
      removedGuardId: scope.allocate(`${childName}.guard.removed`),
      junctionId: scope.allocate(`${childName}.junction.delete`),
      childId: scope.allocate(`${childName}.deleteMany`),
      read: {
        id: readId,
        kind: "read",
        statement: this.membershipRead({
          parentValue: this.parentRef(),
          where: filter,
        }),
        outputs: { rows: { kind: "rows" } },
      },
    };
  }

  private buildBareSlots(scope: StepScope): readonly BareSlot[] {
    const { kind, childName } = this.config;
    if (kind === "disconnect") {
      return (this.config.wheres ?? []).map((where) => ({
        where,
        writeId: scope.allocate(`${childName}.disconnect`),
      }));
    }
    if (kind === "updateMany") {
      const filters = this.config.filters ?? [];
      const data = this.config.data ?? [];
      return filters.map((where, index) => ({
        where,
        writeId: scope.allocate(`${childName}.updateMany`),
        data: data[index] ?? {},
      }));
    }
    return [];
  }

  // -------------------------------------------------------------------------
  // Leaf builders — junction (V1's ManyToManyStatements) and child (V2 ops).
  // -------------------------------------------------------------------------
  private membershipRead(args: {
    parentValue: unknown;
    where?: Record<string, unknown>;
    whereUnique?: Record<string, unknown>;
    take?: number;
  }) {
    return this.statements.materialize(
      manyToManyStatement(
        this.config.parentScope,
        this.config.relationInfo,
        "membershipRead",
        {
          parentValue: args.parentValue,
          ...(args.whereUnique ? { whereUnique: args.whereUnique } : {}),
          ...(args.where && Object.keys(args.where).length > 0
            ? { where: args.where }
            : {}),
          select: { [this.targetPkField]: true },
          ...(args.take !== undefined ? { take: args.take } : {}),
          lock: "transaction",
        }
      )
    );
  }

  private junctionWrite(
    id: string,
    operation: Parameters<typeof manyToManyStatement>[2],
    args: Record<string, unknown>
  ): StatementStep {
    return {
      id,
      kind: "write",
      statement: this.statements.materialize(
        manyToManyStatement(
          this.config.parentScope,
          this.config.relationInfo,
          operation,
          args
        )
      ),
      outputs: {},
    };
  }

  private childUpdate(
    id: string,
    targetPk: unknown,
    data: Record<string, unknown>
  ): StatementStep {
    return {
      id,
      kind: "write",
      statement: buildUpdate(this.childScope, {
        where: { [this.targetPkField]: targetPk },
        data,
        select: { [this.targetPkField]: true },
      }),
      outputs: {},
    };
  }

  private childDelete(id: string, targetPk: unknown): StatementStep {
    return {
      id,
      kind: "write",
      statement: buildDelete(this.childScope, {
        where: { [this.targetPkField]: targetPk },
      }),
      outputs: {},
    };
  }

  private childDeleteMany(
    id: string,
    targetPks: readonly unknown[]
  ): StatementStep {
    return {
      id,
      kind: "write",
      statement: buildDeleteMany(this.childScope, {
        where: { [this.targetPkField]: { in: [...targetPks] } },
      }),
      outputs: {},
    };
  }

  private differenceGuard(
    bulk: BulkSlot,
    parent: unknown,
    targetPks: readonly unknown[],
    difference: "added" | "removed"
  ): GuardStep {
    return {
      id: difference === "added" ? bulk.addedGuardId : bulk.removedGuardId,
      kind: "guard",
      premise: {
        kind: "notExists",
        statement: this.statements.materialize(
          manyToManyStatement(
            this.config.parentScope,
            this.config.relationInfo,
            "membershipDifference",
            {
              parentValue: parent,
              ...(Object.keys(bulk.filter).length > 0
                ? { where: bulk.filter }
                : {}),
              targetValues: [...targetPks],
              difference,
            }
          )
        ),
      },
      failure: nestedWriteFailure(
        m2mMembershipRace(this.config.relationName, "deleteMany"),
        this.config.relationName,
        true
      ),
    };
  }

  private targetPresenceGuard(
    target: TargetSlot,
    op: "connect" | "set"
  ): GuardStep {
    return presenceGuard(
      target.guardId,
      buildFindUnique(this.childScope, {
        where: target.where,
        select: { [this.targetPkField]: true },
      }),
      nestedWriteFailure(
        relationTargetNotFound(this.config.relationInfo, op),
        this.config.relationName,
        false
      )
    );
  }

  private connectedPresenceGuard(
    target: TargetSlot,
    parent: unknown,
    op: "delete" | "update"
  ): GuardStep {
    return {
      id: target.guardId,
      kind: "guard",
      premise: {
        kind: "exists",
        statement: this.membershipRead({
          parentValue: parent,
          whereUnique: target.where,
          take: 1,
        }),
      },
      failure: nestedWriteFailure(
        relationTargetNotFound(this.config.relationInfo, op),
        this.config.relationName,
        false
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Probe consumption + parent-id plumbing.
  // -------------------------------------------------------------------------
  private requireTarget(
    target: TargetSlot,
    known: PlanningKnown,
    op: "connect" | "delete" | "set" | "update"
  ): unknown {
    const rows = known[planningKey(target.probeId, "rows")];
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new NestedWriteError(
        relationTargetNotFound(this.config.relationInfo, op),
        this.config.relationName
      );
    }
    return this.pkOf(rows[0]);
  }

  private connectedSet(bulk: BulkSlot, known: PlanningKnown): unknown[] {
    const rows = known[planningKey(bulk.readId, "rows")];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 deleteMany for relation '${this.config.relationName}' did not expose its membership set.`,
        this.config.relationName
      );
    }
    return rows.map((row) => this.pkOf(row));
  }

  private pkOf(row: unknown): unknown {
    if (!(row && typeof row === "object")) {
      throw new NestedWriteError(
        `query-engine-v2 junction membership for relation '${this.config.relationName}' returned a malformed row.`,
        this.config.relationName
      );
    }
    return (row as Record<string, unknown>)[this.targetPkField];
  }

  /** The parent-id Ref used by planning membership reads (technique #1). */
  private parentRef(): unknown {
    const source = this.config.parentId;
    if (source.kind !== "planned") {
      throw new QueryEngineError(
        `query-engine-v2 junction for relation '${this.config.relationName}' requires a planned parent id to correlate its membership reads.`
      );
    }
    return ref(source.readStep, source.field);
  }

  /** The located parent id inlined as a literal (compile-time write correlation). */
  private parentLiteral(known: PlanningKnown): unknown {
    const source = this.config.parentId;
    if (source.kind === "literal") return source.value;
    if (source.kind !== "planned") {
      throw new QueryEngineError(
        `query-engine-v2 junction for relation '${this.config.relationName}' requires a planned or literal parent id.`
      );
    }
    const rows = known[planningKey(source.readStep, "rows")];
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!(row && typeof row === "object")) {
      throw new NestedWriteError(
        `query-engine-v2 junction for relation '${this.config.relationName}' could not resolve its parent id.`,
        this.config.relationName
      );
    }
    return (row as Record<string, unknown>)[source.field];
  }
}

// ---------------------------------------------------------------------------
// Fold — one M2M relation's parsed mutation into its junction Parts. Each kind
// (connect/disconnect/set/delete/deleteMany/update/updateMany) becomes one Part
// carrying every item of that kind; several kinds coexist on one relation as
// several Parts in the linear fragment. connectOrCreate/upsert/create nested
// under a M2M target keep V1's runtime (their create arm is create-through-
// junction), so they route the whole tree to V1 via UnsupportedOperationError.
// ---------------------------------------------------------------------------

export function buildJunctionParts(input: {
  scope: StepScope;
  engine: QueryEngine;
  parentScope: QueryScope;
  relationName: string;
  relationInfo: RelationInfo;
  mutation: RelationMutation;
  parsedRelation: Record<string, unknown>;
  parentId: ParentIdSource;
  txMode: boolean;
}): RelationJunctionPart[] {
  const {
    scope,
    engine,
    parentScope,
    relationName,
    relationInfo,
    mutation,
    parsedRelation,
    parentId,
    txMode,
  } = input;
  const childName = getStepModelName(relationInfo.targetModel, relationName);
  const childScope = createQueryScope(engine.adapter, relationInfo.targetModel);
  const base = {
    engine,
    parentScope,
    relationName,
    relationInfo,
    childName,
    parentId,
    txMode,
  } as const;
  const parts: RelationJunctionPart[] = [];
  // A stable, V1-mirroring kind order: adopt/link first, then set, then the
  // correlated writes, then removals — every kind independent (the own-write
  // preflight has already rejected any overlapping pair).
  for (const kind of getRelationMutationKinds(mutation)) {
    switch (kind) {
      case "connect":
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "connect",
            wheres: normalizeWheres(parsedRelation.connect, relationName, kind),
          })
        );
        break;
      case "disconnect": {
        if (parsedRelation.disconnect === true) {
          throw new NestedWriteError(
            m2mDisconnectRequiresSelector(relationName),
            relationName
          );
        }
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "disconnect",
            wheres: normalizeWheres(
              parsedRelation.disconnect,
              relationName,
              kind
            ),
          })
        );
        break;
      }
      case "set":
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "set",
            wheres: normalizeWheres(parsedRelation.set, relationName, kind),
          })
        );
        break;
      case "delete": {
        if (parsedRelation.delete === true) {
          parts.push(
            new RelationJunctionPart(scope, {
              ...base,
              kind: "deleteMany",
              filters: [{}],
            })
          );
          break;
        }
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "delete",
            wheres: normalizeWheres(parsedRelation.delete, relationName, kind),
          })
        );
        break;
      }
      case "deleteMany":
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "deleteMany",
            filters: normalizeWheres(
              parsedRelation.deleteMany,
              relationName,
              kind
            ),
          })
        );
        break;
      case "update": {
        const items = normalizeWhereData(
          parsedRelation.update,
          relationName,
          kind
        );
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "update",
            wheres: items.map((item) => {
              if (!item.where) {
                throw new QueryEngineError(
                  `query-engine-v2 update for relation '${relationName}' requires a where.`
                );
              }
              return item.where;
            }),
            data: items.map((item) =>
              scalarOnly(childScope, item.data, relationName, kind)
            ),
          })
        );
        break;
      }
      case "updateMany": {
        const items = normalizeWhereData(
          parsedRelation.updateMany,
          relationName,
          kind
        );
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "updateMany",
            filters: items.map((item) => item.where ?? {}),
            data: items.map((item) =>
              scalarOnly(childScope, item.data, relationName, kind)
            ),
          })
        );
        break;
      }
      default:
        // create / connectOrCreate / upsert nested under a M2M target keep V1's
        // create-through-junction runtime — route the whole tree to V1.
        throw new UnsupportedOperationError(
          `query-engine-v2 does not support nested '${kind}' on many-to-many relation '${relationName}'.`
        );
    }
  }
  return parts;
}

function scalarOnly(
  childScope: QueryScope,
  data: Record<string, unknown>,
  relationName: string,
  kind: string
): Record<string, unknown> {
  const { scalarData, relations } = separateData(childScope, data);
  if (Object.keys(relations).length > 0) {
    throw new UnsupportedOperationError(
      `query-engine-v2 nested '${kind}' on many-to-many relation '${relationName}' does not support nested relation writes in its data.`
    );
  }
  return scalarData;
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
