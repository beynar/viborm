// biome-ignore-all lint/style/useFilenamingConvention: RelationJunctionPart is the architecture name.
import { NestedWriteError, QueryEngineError } from "@errors";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import { isRecord } from "@validation/value-guards";
import { getPrimaryKeyFields } from "../builders/correlation-utils";
import { getManyToManyJoinInfo } from "../builders/many-to-many-utils";
import {
  bindRelation,
  type JunctionRelation,
} from "../builders/relation-data-builder";
import {
  buildParsedRelationPrograms,
  type RelationMutationProgram,
} from "../builders/relation-mutation-parser";
import { buildInsert } from "../builders/values-builder";
import { createQueryScope, getTableName } from "../context/query-scope";
import {
  type ManyToManyOperation,
  ManyToManyStatements,
} from "../ManyToManyStatements";
import {
  buildCreate,
  buildCreateMany,
  buildDelete,
  buildDeleteMany,
  buildFind,
  buildFindUnique,
} from "../operations";
import { assertPortablePrimaryKeyUpdateInput } from "../operations/mutation-identity";
import type { QueryEngine } from "../query-engine";
import {
  assertRelationKeyUpdatesAreCompilable,
  assertSelectedUpdateManyDataIsScalar,
} from "../relation-key-legality";
import type { QueryScope } from "../types";
import type { FreshRecordPart } from "./CreateOperation";
import {
  childRacePin,
  exactlyOneRow,
  nestedWriteFailure,
  presenceGuard,
  referenceSql,
} from "./fragment-builders";
import {
  m2mDisconnectRequiresSelector,
  m2mMembershipRace,
  nestedReplacement,
  relationTargetNotFound,
  upsertTargetNotFoundForParent,
} from "./messages";
import type { JunctionTargetRelationsBuilder } from "./nested-target-parts";
import {
  bucketOperationSteps,
  type GuardStep,
  type OperationStep,
  type ReadStep,
  ref,
  type StatementStep,
  type TargetConstraintPin,
  type WriteStep,
} from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { conditionalArmPlanning, planningKey } from "./Part";
import type {
  RecordCompilerSeam,
  RecordUpdateCompiler,
} from "./RecordUpdateCompiler";
import {
  type CorrelatedForeignKeyMember,
  type FinalReferenceSource,
  type ForeignKeyMember,
  foreignKeyCorrelationValue,
  foreignKeyResolvedReadValue,
  foreignKeyWriteValueWith,
  literalParentId,
  planningSourceFromFinal,
} from "./relation-membership";
import type { StepScope } from "./StepScope";
import {
  capturedSelectorWhere,
  getStepModelName,
  pinnedTargetValues,
  UnsupportedOperationError,
} from "./shared";
import {
  buildTargetProjection,
  capturedTargetColumnPredicate,
  targetProjectionColumns,
  targetProjectionRowKeySelect,
  targetProjectionSelect,
} from "./target-projection";

/**
 * One junction Part owns membership probes and effects for every M2M mutation.
 * Membership reads happen during planning. Final writes consume the captured set;
 * batch guards pin target identity and `deleteMany` membership differences.
 */
interface JunctionContext {
  readonly engine: QueryEngine;
  readonly parentScope: QueryScope;
  readonly relation: JunctionRelation;
  readonly parentId: FinalReferenceSource;
  readonly membershipReadSource: FinalReferenceSource;
  readonly txMode: boolean;
}

type JunctionIdentity =
  | { readonly kind: "literal"; readonly value: unknown }
  | {
      readonly kind: "produced";
      readonly value: unknown;
      readonly field: string;
    };

type PreparedFreshTarget =
  | {
      readonly kind: "inline";
      readonly data: Record<string, unknown>;
      readonly descendants: readonly Part[];
    }
  | {
      readonly kind: "record";
      readonly record: FreshRecordPart;
      readonly identity: JunctionIdentity;
    };

type JunctionUpsertUpdate =
  | { readonly kind: "none" }
  | {
      readonly kind: "member";
      readonly compiler: RecordUpdateCompiler;
      readonly assertLegality: () => void;
    }
  | {
      readonly kind: "global";
      readonly compiler: RecordUpdateCompiler;
      readonly assertLegality: () => void;
    };

interface PreparedUpsertTargetBase {
  readonly where: Record<string, unknown>;
  readonly target: PreparedFreshTarget;
  readonly probes: { readonly member: string; readonly global: string };
}

interface PreparedLocatedUpsertTarget extends PreparedUpsertTargetBase {
  readonly update: Extract<JunctionUpsertUpdate, { kind: "none" | "member" }>;
}

interface PreparedFreshUpsertTarget extends PreparedUpsertTargetBase {
  readonly update: Extract<JunctionUpsertUpdate, { kind: "none" | "global" }>;
}

type JunctionMutation =
  | {
      readonly kind: "connect";
      readonly targets: readonly Record<string, unknown>[];
    }
  | {
      readonly kind: "disconnect";
      readonly targets: readonly Record<string, unknown>[];
    }
  | {
      readonly kind: "set";
      readonly targets: readonly Record<string, unknown>[];
    }
  | {
      readonly kind: "delete";
      readonly targets: readonly Record<string, unknown>[];
    }
  | {
      readonly kind: "deleteMany";
      readonly filters: readonly Record<string, unknown>[];
    }
  | {
      readonly kind: "update";
      readonly items: readonly {
        readonly where: Record<string, unknown>;
        readonly compiler: RecordUpdateCompiler;
      }[];
    }
  | {
      readonly kind: "updateMany";
      readonly items: readonly {
        readonly where: Record<string, unknown>;
        readonly data: Record<string, unknown>;
      }[];
    }
  | {
      readonly kind: "create";
      readonly targets: readonly PreparedFreshTarget[];
    }
  | {
      readonly kind: "createMany";
      readonly targets: readonly PreparedFreshTarget[];
      readonly skipDuplicates: boolean;
    }
  | {
      readonly kind: "connectOrCreate";
      readonly items: readonly {
        readonly where: Record<string, unknown>;
        readonly target: PreparedFreshTarget;
      }[];
    }
  | {
      readonly kind: "upsert";
      readonly parentState: "located";
      readonly items: readonly PreparedLocatedUpsertTarget[];
    }
  | {
      readonly kind: "upsert";
      readonly parentState: "fresh";
      readonly items: readonly PreparedFreshUpsertTarget[];
    };

type RelationJunctionInput = JunctionContext & JunctionMutation;

/** A per-target probe slot (connect/set/delete/update) with its write ids. */
interface TargetSlot {
  readonly where: Record<string, unknown>;
  readonly probeId: string;
  readonly guardId: string;
  readonly writeId: string;
  readonly childId: string;
  readonly probe: ReadStep;
}

interface UpdateSlot extends TargetSlot {
  readonly compiler: RecordUpdateCompiler;
}

/** A per-filter bulk slot (deleteMany) with its materialized-set difference ids. */
interface BulkSlot {
  readonly filter: Record<string, unknown>;
  readonly readId: string;
  readonly addedGuardId: string;
  readonly removedGuardId: string;
  readonly junctionId: string;
  readonly childId: string;
  readonly read: ReadStep;
}

/** A probe-less write slot — one allocated write id per item. */
interface BareSlot {
  readonly where: Record<string, unknown>;
  readonly writeId: string;
}

type UpdateManySlot = BareSlot & { readonly data: Record<string, unknown> };

/** A fresh target plus the already allocated target and join writes. */
interface CreateSlot {
  readonly target: PreparedFreshTarget;
  readonly identity: JunctionIdentity;
  readonly childId: string;
  readonly joinId: string;
  readonly skipDuplicates: boolean;
}

/** A `connectOrCreate` slot — a global probe, then adopt (join) or create+join. */
interface AdoptSlot {
  readonly where: Record<string, unknown>;
  readonly target: PreparedFreshTarget;
  readonly identity: JunctionIdentity;
  readonly probeId: string;
  readonly guardId: string;
  readonly childId: string;
  readonly joinId: string;
  readonly probe: ReadStep;
}

/** An `upsert` slot — a membership probe + a global probe decide the three-way. */
interface UpsertSlotBase {
  readonly where: Record<string, unknown>;
  readonly target: PreparedFreshTarget;
  readonly identity: JunctionIdentity;
  readonly globalProbeId: string;
  readonly guardId: string;
  readonly childId: string;
  readonly joinId: string;
  readonly globalProbe: ReadStep;
  readonly update: JunctionUpsertUpdate;
}

interface LocatedUpsertSlot extends UpsertSlotBase {
  readonly membershipProbeId: string;
  readonly membershipProbe: ReadStep;
  readonly update: Extract<JunctionUpsertUpdate, { kind: "none" | "member" }>;
}

interface FreshUpsertSlot extends UpsertSlotBase {
  readonly update: Extract<JunctionUpsertUpdate, { kind: "none" | "global" }>;
}

type JunctionPlan =
  | { readonly kind: "connect"; readonly slots: readonly TargetSlot[] }
  | { readonly kind: "disconnect"; readonly slots: readonly BareSlot[] }
  | {
      readonly kind: "set";
      readonly slots: readonly TargetSlot[];
      readonly clearId: string;
      readonly insertId: string;
    }
  | { readonly kind: "delete"; readonly slots: readonly TargetSlot[] }
  | { readonly kind: "deleteMany"; readonly slots: readonly BulkSlot[] }
  | { readonly kind: "update"; readonly slots: readonly UpdateSlot[] }
  | { readonly kind: "updateMany"; readonly slots: readonly UpdateManySlot[] }
  | { readonly kind: "create"; readonly slots: readonly CreateSlot[] }
  | { readonly kind: "createMany"; readonly slots: readonly CreateSlot[] }
  | { readonly kind: "connectOrCreate"; readonly slots: readonly AdoptSlot[] }
  | {
      readonly kind: "upsert";
      readonly parentState: "located";
      readonly slots: readonly LocatedUpsertSlot[];
    }
  | {
      readonly kind: "upsert";
      readonly parentState: "fresh";
      readonly slots: readonly FreshUpsertSlot[];
    };

export class RelationJunctionPart implements Part {
  private readonly context: JunctionContext;
  private readonly childName: string;
  /**
   * JUNCTION CARVE-OUT (plan N2 / §7.4). This is the ONE selected-target key in the
   * write engine that is still a single field, and it is deliberate: a junction side
   * is one column today, so `getManyToManyJoinInfo` resolves it through
   * `getRequiredSinglePrimaryKeyField`, which THROWS for a compound-keyed target
   * before this Part is ever constructed. Every projection-derived read below
   * therefore describes the same one-member row key the join info already fixed;
   * this field is the junction's STORED REFERENCE to that target, not a second
   * answer to "what is the target's row key".
   *
   * Compound many-to-many is an unimplemented capability, not a seal: N2 fixes its
   * future shape as two ordered `JunctionSide` reference keys, which replaces this
   * field, `sourcePkField`, and the join-info channel together. Package C does not
   * add those types, and — the point of this comment — it must not DEEPEN the scalar
   * assumption either: nothing new here may read a row key through this field.
   */
  private readonly targetPkField: string;
  /** The junction's stored reference to the SOURCE side; same carve-out. */
  private readonly sourcePkField: string;
  private readonly sourceFieldName: string;
  private readonly childScope: QueryScope;
  private readonly statements: ManyToManyStatements;
  private readonly plan: JunctionPlan;

  private get relationInfo() {
    return this.context.relation.relationInfo;
  }

  private get relationName(): string {
    return this.relationInfo.name;
  }

  constructor(scope: StepScope, input: RelationJunctionInput) {
    this.context = input;
    this.childName = getStepModelName(
      input.relation.relationInfo.targetModel,
      input.relation.relationInfo.name
    );
    const join = getManyToManyJoinInfo(
      input.parentScope,
      input.relation.relationInfo
    );
    this.targetPkField = join.targetPkField;
    this.sourcePkField = join.sourcePkField;
    this.sourceFieldName = join.sourceFieldName;
    this.childScope = createQueryScope(
      input.engine.adapter,
      input.relation.relationInfo.targetModel
    );
    this.statements = new ManyToManyStatements(input.parentScope, input.txMode);
    this.plan = this.allocatePlan(scope, input);
  }

  planning(scope: StepScope): readonly StatementStep[] {
    const steps: StatementStep[] = [];
    // biome-ignore lint/style/useDefaultSwitchClause: JunctionPlan is exhaustive.
    switch (this.plan.kind) {
      case "connect":
      case "set":
      case "delete":
        for (const slot of this.plan.slots) steps.push(slot.probe);
        break;
      case "update":
        for (const slot of this.plan.slots) {
          steps.push(slot.probe, ...slot.compiler.planning());
        }
        break;
      case "deleteMany":
        for (const slot of this.plan.slots) steps.push(slot.read);
        break;
      case "connectOrCreate":
        for (const slot of this.plan.slots) {
          steps.push(slot.probe);
          this.planFreshTarget(slot.target, scope, steps);
        }
        break;
      case "create":
      case "createMany":
        for (const slot of this.plan.slots) {
          this.planFreshTarget(slot.target, scope, steps);
        }
        break;
      case "upsert":
        if (this.plan.parentState === "located") {
          for (const slot of this.plan.slots) {
            steps.push(slot.membershipProbe);
            steps.push(slot.globalProbe);
            this.planFreshTarget(slot.target, scope, steps);
            if (slot.update.kind === "member") {
              steps.push(
                ...conditionalArmPlanning(slot.update.compiler.planning())
              );
            }
          }
        } else {
          for (const slot of this.plan.slots) {
            steps.push(slot.globalProbe);
            this.planFreshTarget(slot.target, scope, steps);
            if (slot.update.kind === "global") {
              steps.push(
                ...conditionalArmPlanning(slot.update.compiler.planning())
              );
            }
          }
        }
        break;
      case "disconnect":
      case "updateMany":
        break;
    }
    return steps;
  }

  compile(scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    const parent = this.parentLiteral(known);
    switch (this.plan.kind) {
      case "connect":
        return this.compileConnect(parent, known, this.plan.slots);
      case "disconnect":
        return this.compileDisconnect(parent, this.plan.slots);
      case "set":
        return this.compileSet(parent, known, this.plan);
      case "delete":
        return this.compileDelete(parent, known, this.plan.slots);
      case "deleteMany":
        return this.compileDeleteMany(parent, known, this.plan.slots);
      case "update":
        return this.compileUpdate(scope, known, this.plan.slots);
      case "updateMany":
        return this.compileUpdateMany(parent, this.plan.slots);
      case "create":
      case "createMany":
        return this.compileCreate(scope, parent, known, this.plan.slots);
      case "connectOrCreate":
        return this.compileConnectOrCreate(
          scope,
          parent,
          known,
          this.plan.slots
        );
      case "upsert":
        return this.plan.parentState === "fresh"
          ? this.compileFreshUpsert(scope, parent, known, this.plan.slots)
          : this.compileUpsert(scope, parent, known, this.plan.slots);
      default: {
        const exhaustive: never = this.plan;
        throw new QueryEngineError(
          `query-engine-v2 junction part has no compile for '${String(exhaustive)}'.`
        );
      }
    }
  }

  // Target probes stay per selector; their captured keys preserve split-witness guards.
  private compileConnect(
    parent: unknown,
    known: PlanningKnown,
    slots: readonly TargetSlot[]
  ): readonly OperationStep[] {
    const guards: OperationStep[] = [];
    const targetPks: unknown[] = [];
    for (const target of slots) {
      const targetPk = this.requireTarget(target, known, "connect");
      targetPks.push(targetPk);
      if (!this.context.txMode) {
        guards.push(this.targetPresenceGuard(target, "connect", targetPk));
      }
    }
    if (targetPks.length === 0) return guards;
    return [
      ...guards,
      this.junctionWrite(slots[0]!.writeId, "junctionInsertMany", {
        parentValue: parent,
        targetValues: targetPks,
      }),
    ];
  }

  // disconnect — DELETE join rows by target subquery; idempotent, no probe.
  private compileDisconnect(
    parent: unknown,
    slots: readonly BareSlot[]
  ): readonly OperationStep[] {
    return slots.map((slot) =>
      this.junctionWrite(slot.writeId, "junctionDelete", {
        parentValue: parent,
        targetWhere: slot.where,
      })
    );
  }

  // set — replace the whole membership with the target set (V1's semantics).
  private compileSet(
    parent: unknown,
    known: PlanningKnown,
    plan: Extract<JunctionPlan, { kind: "set" }>
  ): readonly OperationStep[] {
    const guards: OperationStep[] = [];
    const targetPks: unknown[] = [];
    for (const target of plan.slots) {
      const targetPk = this.requireTarget(target, known, "set");
      targetPks.push(targetPk);
      if (!this.context.txMode) {
        guards.push(this.targetPresenceGuard(target, "set", targetPk));
      }
    }
    const writes: OperationStep[] = [
      this.junctionWrite(plan.clearId, "junctionDelete", {
        parentValue: parent,
      }),
    ];
    if (targetPks.length > 0) {
      writes.push(
        this.junctionWrite(plan.insertId, "junctionInsertMany", {
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
    known: PlanningKnown,
    slots: readonly TargetSlot[]
  ): readonly OperationStep[] {
    const guards: OperationStep[] = [];
    const writes: OperationStep[] = [];
    for (const target of slots) {
      const targetPk = this.requireTarget(target, known, "delete");
      if (!this.context.txMode) {
        guards.push(
          this.connectedPresenceGuard(
            target,
            this.membershipLiteral(known),
            "delete",
            targetPk
          )
        );
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
    known: PlanningKnown,
    slots: readonly BulkSlot[]
  ): readonly OperationStep[] {
    const guards: OperationStep[] = [];
    const writes: OperationStep[] = [];
    for (const bulk of slots) {
      const targetPks = this.connectedSet(bulk, known);
      if (!this.context.txMode) {
        const membershipParent = this.membershipLiteral(known);
        guards.push(
          this.differenceGuard(bulk, membershipParent, targetPks, "added"),
          this.differenceGuard(bulk, membershipParent, targetPks, "removed")
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
  // `update` takes no written parent value: its guard asserts membership on the READ
  // correlation and its write addresses the target's own captured primary key.
  private compileUpdate(
    _scope: StepScope,
    known: PlanningKnown,
    slots: readonly UpdateSlot[]
  ): readonly OperationStep[] {
    const guards: OperationStep[] = [];
    const writes: OperationStep[] = [];
    for (const target of slots) {
      const targetPk = this.requireTarget(target, known, "update");
      const capturedColumns = this.capturedCompilerPredicate(
        target.compiler,
        target.probeId,
        known
      );
      if (!this.context.txMode) {
        guards.push(
          this.connectedPresenceGuard(
            target,
            this.membershipLiteral(known),
            "update",
            targetPk,
            capturedColumns
          )
        );
      }
      bucketOperationSteps(target.compiler.compile(known), guards, writes);
    }
    return [...guards, ...writes];
  }

  // updateMany — UPDATE every connected∧filter child in one correlated write.
  private compileUpdateMany(
    parent: unknown,
    slots: readonly UpdateManySlot[]
  ): readonly OperationStep[] {
    const steps: OperationStep[] = [];
    for (const slot of slots) {
      const data = slot.data;
      if (Object.keys(data).length === 0) continue;
      steps.push({
        id: slot.writeId,
        kind: "write",
        statement: this.statements.materialize(
          this.relationInfo,
          "membershipUpdateMany",
          {
            parentValue: parent,
            ...(Object.keys(slot.where).length > 0
              ? { where: slot.where }
              : {}),
            data,
          }
        ),
        outputs: {},
      });
    }
    return steps;
  }

  // create — INSERT the fresh child row, then the join row (V1's
  // `ManyToManyMemberships.create`). No probe, no missing premise: an
  // unconditional insert whose own unique violation is a genuine error.
  private compileCreate(
    scope: StepScope,
    parent: unknown,
    known: PlanningKnown,
    slots: readonly CreateSlot[]
  ): readonly OperationStep[] {
    const steps: OperationStep[] = [];
    for (const slot of slots) {
      steps.push(
        ...this.compileFreshTarget(scope, known, parent, slot, undefined)
      );
    }
    return steps;
  }

  // connectOrCreate — a global probe adopts (join) an existing target or creates
  // it (V1's `ManyToManyMemberships.connectOrCreate`). Found premise pinned by
  // the exists guard (raceable:false); missing premise enforced by the child's
  // unique constraint (racePin), never a notExists guard (Pin Rule).
  private compileConnectOrCreate(
    scope: StepScope,
    parent: unknown,
    known: PlanningKnown,
    slots: readonly AdoptSlot[]
  ): readonly OperationStep[] {
    const steps: OperationStep[] = [];
    // Sequential first-create-wins: a later duplicate adopts the earlier row.
    const created = new Map<string, unknown>();
    for (const slot of slots) {
      const rows = known[planningKey(slot.probeId, "rows")];
      const found = Array.isArray(rows) && rows.length > 0;
      if (found) {
        const capturedPk = this.pkOf(rows[0]);
        if (!this.context.txMode) {
          steps.push(this.adoptFoundGuard(slot, capturedPk));
        }
        steps.push(this.joinInsert(slot.joinId, parent, capturedPk));
        continue;
      }
      const key = adoptDedupKey(slot);
      if (created.has(key)) {
        // The earlier item owns the complete create payload and descendants.
        steps.push(this.joinInsert(slot.joinId, parent, created.get(key)));
        continue;
      }
      created.set(key, slot.identity.value);
      steps.push(
        ...this.compileFreshTarget(scope, known, parent, slot, slot.where)
      );
    }
    return steps;
  }

  // upsert — the correlated three-way (V1's `ManyToManyMutations.upsert`): a
  // member is updated; a globally-existing non-member is the typed V7001; an
  // absent target is created and joined. Member premise pinned by the membership
  // exists guard (raceable:false); absent premise by the child constraint (racePin).
  private compileUpsert(
    scope: StepScope,
    parent: unknown,
    known: PlanningKnown,
    slots: readonly LocatedUpsertSlot[]
  ): readonly OperationStep[] {
    const steps: OperationStep[] = [];
    // Upsert never deduplicates: every item must update the row its own selector names.
    for (const slot of slots) {
      const memberRows = known[planningKey(slot.membershipProbeId, "rows")];
      if (Array.isArray(memberRows) && memberRows.length > 0) {
        const memberPk = this.pkOf(memberRows[0]);
        const capturedColumns =
          slot.update.kind === "member"
            ? this.capturedCompilerPredicate(
                slot.update.compiler,
                slot.membershipProbeId,
                known
              )
            : undefined;
        if (!this.context.txMode) {
          steps.push(
            this.upsertMemberGuard(
              slot,
              this.membershipLiteral(known),
              memberPk,
              capturedColumns
            )
          );
        }
        if (slot.update.kind === "member") {
          slot.update.assertLegality();
          steps.push(...slot.update.compiler.compile(known));
        }
        continue;
      }
      const globalRows = known[planningKey(slot.globalProbeId, "rows")];
      if (Array.isArray(globalRows) && globalRows.length > 0) {
        // Exists globally but is not a member of this parent — the correlated
        // upsert cannot adopt a foreign row (ATOM's `Junction relations`).
        throw new NestedWriteError(
          upsertTargetNotFoundForParent(this.relationName),
          this.relationName
        );
      }
      steps.push(...this.upsertCreateArm(scope, slot, parent, known));
    }
    return steps;
  }

  /** A fresh parent has no members: global found means adopt-and-update; missing
   * means create-and-adopt. Both branches add the junction row. */
  private compileFreshUpsert(
    scope: StepScope,
    parent: unknown,
    known: PlanningKnown,
    slots: readonly FreshUpsertSlot[]
  ): readonly OperationStep[] {
    const steps: OperationStep[] = [];
    for (const slot of slots) {
      const globalRows = known[planningKey(slot.globalProbeId, "rows")];
      if (!(Array.isArray(globalRows) && globalRows.length > 0)) {
        steps.push(...this.upsertCreateArm(scope, slot, parent, known));
        continue;
      }
      const foundPk = this.pkOf(globalRows[0]);
      const capturedColumns =
        slot.update.kind === "global"
          ? this.capturedCompilerPredicate(
              slot.update.compiler,
              slot.globalProbeId,
              known
            )
          : undefined;
      if (!this.context.txMode) {
        steps.push(this.adoptFoundGuard(slot, foundPk, capturedColumns));
      }
      if (slot.update.kind === "global") {
        slot.update.assertLegality();
        steps.push(...slot.update.compiler.compile(known));
      }
      steps.push(this.joinInsert(slot.joinId, parent, foundPk));
    }
    return steps;
  }

  /** The upsert create arm — INSERT the target (or run its delegated subtree), then the
   *  join row, then the fresh target's own relations. One home, because the correlated
   *  three-way and the fresh-parent two-way take the same arm when nothing was found. */
  private upsertCreateArm(
    scope: StepScope,
    slot: UpsertSlotBase,
    parent: unknown,
    known: PlanningKnown
  ): readonly OperationStep[] {
    return this.compileFreshTarget(scope, known, parent, slot, slot.where);
  }

  // -------------------------------------------------------------------------
  // Slot construction (all step ids scope-allocated once, at construction).
  // -------------------------------------------------------------------------
  private allocatePlan(
    scope: StepScope,
    input: RelationJunctionInput
  ): JunctionPlan {
    // biome-ignore lint/style/useDefaultSwitchClause: JunctionMutation is exhaustive.
    switch (input.kind) {
      case "connect":
      case "delete":
        return {
          kind: input.kind,
          slots: input.targets.map((where) =>
            this.buildTargetSlot(scope, input.kind, where)
          ),
        };
      case "set":
        return {
          kind: "set",
          slots: input.targets.map((where) =>
            this.buildTargetSlot(scope, "set", where)
          ),
          clearId: scope.allocate(`${this.childName}.set.clear`),
          insertId: scope.allocate(`${this.childName}.set.insert`),
        };
      case "disconnect":
        return {
          kind: "disconnect",
          slots: input.targets.map((where) => ({
            where,
            writeId: scope.allocate(`${this.childName}.disconnect`),
          })),
        };
      case "deleteMany":
        return {
          kind: "deleteMany",
          slots: input.filters.map((filter) =>
            this.buildBulkSlot(scope, filter)
          ),
        };
      case "update":
        return {
          kind: "update",
          slots: input.items.map((item) =>
            this.buildUpdateSlot(scope, item.where, item.compiler)
          ),
        };
      case "updateMany":
        return {
          kind: "updateMany",
          slots: input.items.map((item) => ({
            ...item,
            writeId: scope.allocate(`${this.childName}.updateMany`),
          })),
        };
      case "create":
        return {
          kind: "create",
          slots: input.targets.map((target) =>
            this.buildCreateSlot(scope, target, false)
          ),
        };
      case "createMany":
        return {
          kind: "createMany",
          slots: input.targets.map((target) =>
            this.buildCreateSlot(scope, target, input.skipDuplicates)
          ),
        };
      case "connectOrCreate":
        return {
          kind: "connectOrCreate",
          slots: input.items.map((item) => this.buildAdoptSlot(scope, item)),
        };
      case "upsert":
        return input.parentState === "fresh"
          ? {
              kind: "upsert",
              parentState: "fresh",
              slots: input.items.map((item) =>
                this.buildFreshUpsertSlot(scope, item)
              ),
            }
          : {
              kind: "upsert",
              parentState: "located",
              slots: input.items.map((item) =>
                this.buildLocatedUpsertSlot(scope, item)
              ),
            };
    }
  }

  private buildTargetSlot(
    scope: StepScope,
    kind: "connect" | "delete" | "set" | "update",
    where: Record<string, unknown>,
    compiler?: RecordUpdateCompiler
  ): TargetSlot {
    const connected = kind === "delete" || kind === "update";
    const probeId =
      compiler?.targetReadId ?? scope.allocate(`${this.childName}.find`);
    const publishesPk = (compiler?.planning().length ?? 0) > 0;
    const projection =
      compiler?.targetProjection ??
      buildTargetProjection(this.childScope.model);
    const selectedFields = projection.fields;
    const selectedColumns = targetProjectionColumns(
      this.childScope,
      projection,
      getTableName(this.childScope.model)
    );
    const statement = connected
      ? this.membershipRead({
          parentValue: this.parentRef(),
          whereUnique: where,
          take: 1,
          select: targetProjectionSelect(projection),
          ...(selectedColumns.length
            ? {
                additionalColumns: selectedColumns.map((column) => column.sql),
              }
            : {}),
        })
      : buildFindUnique(this.childScope, {
          where,
          select: targetProjectionRowKeySelect(projection),
          forUpdate: this.context.txMode,
        });
    // N4-U1: a slot whose deeper edges `planned`-read this probe must publish the
    // captured target primary key as a `firstRowField`, and — because that extraction
    // is eager and would otherwise abort with an internal wording — carry this
    // family's own not-a-member message as the read's postcondition. Byte-identical to
    // `requireTarget`'s compile-time throw, moved one phase earlier (still before any
    // write, on both substrates).
    const probe: ReadStep = {
      id: probeId,
      kind: "read",
      statement,
      outputs: publishesPk
        ? {
            rows: { kind: "rows" },
            ...Object.fromEntries(
              selectedFields.map((field) => [
                field,
                { kind: "firstRowField", field },
              ])
            ),
          }
        : { rows: { kind: "rows" } },
      ...(publishesPk
        ? {
            expects: exactlyOneRow(
              nestedWriteFailure(
                relationTargetNotFound(this.relationInfo, "update"),
                this.relationName,
                false
              )
            ),
          }
        : {}),
    };
    return {
      where,
      probeId,
      guardId: scope.allocate(`${this.childName}.guard.exists`),
      writeId: compiler?.writeId ?? scope.allocate(`${this.childName}.${kind}`),
      childId: scope.allocate(`${this.childName}.delete.child`),
      probe,
    };
  }

  private buildUpdateSlot(
    scope: StepScope,
    where: Record<string, unknown>,
    compiler: RecordUpdateCompiler
  ): UpdateSlot {
    return {
      ...this.buildTargetSlot(scope, "update", where, compiler),
      compiler,
    };
  }

  private buildBulkSlot(
    scope: StepScope,
    filter: Record<string, unknown>
  ): BulkSlot {
    const readId = scope.allocate(`${this.childName}.members`);
    return {
      filter,
      readId,
      addedGuardId: scope.allocate(`${this.childName}.guard.added`),
      removedGuardId: scope.allocate(`${this.childName}.guard.removed`),
      junctionId: scope.allocate(`${this.childName}.junction.delete`),
      childId: scope.allocate(`${this.childName}.deleteMany`),
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

  private buildCreateSlot(
    scope: StepScope,
    target: PreparedFreshTarget,
    skipDuplicates: boolean
  ): CreateSlot {
    const childId = scope.allocate(`${this.childName}.create`);
    return {
      target,
      identity: this.resolveTargetIdentity(target, childId, skipDuplicates),
      childId,
      joinId: scope.allocate(`${this.childName}.junction.insert`),
      skipDuplicates,
    };
  }

  private buildAdoptSlot(
    scope: StepScope,
    item: { where: Record<string, unknown>; target: PreparedFreshTarget }
  ): AdoptSlot {
    const probeId = scope.allocate(`${this.childName}.find`);
    const childId = scope.allocate(`${this.childName}.create`);
    return {
      where: item.where,
      target: item.target,
      identity: this.resolveTargetIdentity(item.target, childId, false),
      probeId,
      guardId: scope.allocate(`${this.childName}.guard.exists`),
      childId,
      joinId: scope.allocate(`${this.childName}.junction.insert`),
      probe: {
        id: probeId,
        kind: "read",
        statement: buildFindUnique(this.childScope, {
          where: item.where,
          select: targetProjectionRowKeySelect(
            buildTargetProjection(this.childScope.model)
          ),
          forUpdate: this.context.txMode,
        }),
        outputs: { rows: { kind: "rows" } },
      },
    };
  }

  private buildUpsertSlotBase(
    scope: StepScope,
    item: PreparedUpsertTargetBase & { readonly update: JunctionUpsertUpdate }
  ): UpsertSlotBase {
    const childId = scope.allocate(`${this.childName}.create`);
    const projection = this.upsertArmProbeProjection(
      item.update,
      item.probes.global
    );
    return {
      where: item.where,
      target: item.target,
      identity: this.resolveTargetIdentity(item.target, childId, false),
      globalProbeId: item.probes.global,
      guardId: scope.allocate(`${this.childName}.guard.member`),
      childId,
      joinId: scope.allocate(`${this.childName}.junction.insert`),
      update: item.update,
      globalProbe: {
        id: item.probes.global,
        kind: "read",
        statement: buildFindUnique(
          this.childScope,
          {
            where: item.where,
            select: projection.select,
            forUpdate: this.context.txMode,
          },
          {
            ...(projection.additionalColumns.length
              ? { additionalColumns: projection.additionalColumns }
              : {}),
          }
        ),
        outputs: projection.outputs,
      },
    };
  }

  private buildLocatedUpsertSlot(
    scope: StepScope,
    item: PreparedLocatedUpsertTarget
  ): LocatedUpsertSlot {
    const base = this.buildUpsertSlotBase(scope, item);
    const projection = this.upsertArmProbeProjection(
      item.update,
      item.probes.member
    );
    return {
      ...base,
      update: item.update,
      membershipProbeId: item.probes.member,
      membershipProbe: {
        id: item.probes.member,
        kind: "read",
        statement: this.membershipRead({
          parentValue: this.parentRef(),
          whereUnique: item.where,
          take: 1,
          select: projection.select,
          additionalColumns: projection.additionalColumns,
        }),
        outputs: projection.outputs,
      },
    };
  }

  private buildFreshUpsertSlot(
    scope: StepScope,
    item: PreparedFreshUpsertTarget
  ): FreshUpsertSlot {
    return { ...this.buildUpsertSlotBase(scope, item), update: item.update };
  }

  /** The selected update probe publishes optional fields because a missing row
   * legitimately selects the create arm. */
  private upsertArmProbeProjection(
    update: JunctionUpsertUpdate,
    probeId: string
  ): {
    readonly select: Record<string, boolean>;
    readonly additionalColumns: readonly Sql[];
    readonly outputs: ReadStep["outputs"];
  } {
    if (update.kind === "none" || update.compiler.targetReadId !== probeId) {
      return {
        select: targetProjectionRowKeySelect(
          buildTargetProjection(this.childScope.model)
        ),
        additionalColumns: [],
        outputs: { rows: { kind: "rows" } },
      };
    }
    const projection = update.compiler.targetProjection;
    return {
      select: targetProjectionSelect(projection),
      additionalColumns: targetProjectionColumns(
        this.childScope,
        projection,
        getTableName(this.childScope.model)
      ).map((column) => column.sql),
      // Fields only, deliberately: the private columns travel as an inlined
      // predicate ({@link capturedCompilerPredicate}), never as declared outputs.
      outputs: {
        rows: { kind: "rows" },
        ...Object.fromEntries(
          projection.fields.map((field) => [
            field,
            { kind: "firstRowField" as const, field, optional: true },
          ])
        ),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Leaf builders — junction (V1's ManyToManyStatements) and child (V2 ops).
  // -------------------------------------------------------------------------
  private planFreshTarget(
    target: PreparedFreshTarget,
    scope: StepScope,
    steps: StatementStep[]
  ): void {
    if (target.kind === "record") {
      steps.push(...target.record.planning(scope));
      return;
    }
    for (const descendant of target.descendants) {
      steps.push(...descendant.planning(scope));
    }
  }

  private compileFreshTarget(
    scope: StepScope,
    known: PlanningKnown,
    parent: unknown,
    slot: {
      readonly target: PreparedFreshTarget;
      readonly identity: JunctionIdentity;
      readonly childId: string;
      readonly joinId: string;
      readonly skipDuplicates?: boolean;
    },
    where: Record<string, unknown> | undefined
  ): readonly OperationStep[] {
    if (slot.target.kind === "record") {
      return [
        ...slot.target.record.compile(scope, known),
        this.joinInsert(slot.joinId, parent, slot.identity.value),
      ];
    }
    const steps: OperationStep[] = [
      this.childInsert(
        slot.childId,
        slot.target.data,
        where,
        slot.identity.kind === "produced" ? slot.identity.field : undefined,
        slot.skipDuplicates === true
      ),
      this.joinInsert(slot.joinId, parent, slot.identity.value),
    ];
    for (const descendant of slot.target.descendants) {
      steps.push(...descendant.compile(scope, known));
    }
    return steps;
  }

  private resolveTargetIdentity(
    target: PreparedFreshTarget,
    childId: string,
    skipDuplicates: boolean
  ): JunctionIdentity {
    return target.kind === "record"
      ? target.identity
      : this.resolveCreatePk(target.data, childId, skipDuplicates);
  }

  private membershipRead(args: {
    parentValue: unknown;
    where?: Record<string, unknown>;
    whereUnique?: Record<string, unknown>;
    take?: number;
    select?: Record<string, boolean>;
    additionalColumns?: readonly Sql[];
    predicate?: Sql;
  }) {
    return this.statements.materialize(this.relationInfo, "membershipRead", {
      parentValue: args.parentValue,
      ...(args.whereUnique ? { whereUnique: args.whereUnique } : {}),
      ...(args.where && Object.keys(args.where).length > 0
        ? { where: args.where }
        : {}),
      select:
        args.select ??
        targetProjectionRowKeySelect(
          buildTargetProjection(this.childScope.model)
        ),
      ...(args.additionalColumns?.length
        ? { additionalColumns: args.additionalColumns }
        : {}),
      ...(args.predicate ? { predicate: args.predicate } : {}),
      ...(args.take !== undefined ? { take: args.take } : {}),
      lock: "transaction",
    });
  }

  private junctionWrite(
    id: string,
    operation: ManyToManyOperation,
    args: Record<string, unknown>
  ): WriteStep {
    return {
      id,
      kind: "write",
      statement: this.statements.materialize(
        this.relationInfo,
        operation,
        args
      ),
      outputs: {},
    };
  }

  /** The idempotent join-row insert (junction-PK skip) for a target PK. */
  private joinInsert(id: string, parent: unknown, targetValue: unknown) {
    return this.junctionWrite(id, "junctionInsert", {
      parentValue: parent,
      targetValue,
    });
  }

  /** A selector pins a missing adopt premise. A produced identity is captured by
   * `RETURNING` in transaction mode or `insertId` otherwise. */
  private childInsert(
    id: string,
    create: Record<string, unknown>,
    where?: Record<string, unknown>,
    generatedField?: string,
    skipDuplicates = false
  ): WriteStep {
    const returningTx =
      this.context.txMode &&
      this.context.engine.adapter.capabilities.supportsReturning;
    // The adapter owns SQL duplicate skipping; MySQL uses the executor's recoverable
    // unique-conflict effect.
    const recoverUnique =
      skipDuplicates &&
      this.context.engine.adapter.mutations.skipDuplicatesStrategy ===
        "recoverableUniqueError";
    let statement: Sql;
    if (skipDuplicates) {
      statement = buildCreateMany(this.childScope, [create], true);
    } else if (generatedField && returningTx) {
      statement = buildCreate(this.childScope, {
        data: create,
        select: { [generatedField]: true },
      });
    } else {
      statement = buildInsert(
        this.childScope,
        getTableName(this.childScope.model),
        create
      );
    }
    const step: WriteStep = {
      id,
      kind: "write",
      statement,
      outputs: generatedField
        ? {
            id: returningTx
              ? { kind: "firstRowField", field: generatedField }
              : { kind: "insertId" },
          }
        : {},
      ...(recoverUnique ? { onUniqueConflict: "skip" as const } : {}),
    };
    return where
      ? { ...step, racePin: childRacePin(this.childScope, where) }
      : step;
  }

  /** Resolve a literal key or bind the join to this INSERT's generated identity. */
  private resolveCreatePk(
    create: Record<string, unknown>,
    childId: string,
    skipDuplicates: boolean
  ): JunctionIdentity {
    const pk = create[this.targetPkField];
    if (pk !== undefined && pk !== null) return { kind: "literal", value: pk };
    const scalar = this.childScope.model["~"].state.scalars[this.targetPkField];
    if (pk === undefined && scalar?.["~"].state.autoGenerate === "increment") {
      // A skipped INSERT produces no trustworthy identity. Adopt-equivalent rows are
      // rewritten before this point; the remaining shape must refuse.
      if (skipDuplicates) {
        throw new UnsupportedOperationError(
          `query-engine-v2 createMany-through-junction for relation '${this.relationName}' cannot use 'skipDuplicates' when the target primary key '${this.targetPkField}' is database-generated: a skipped row produces no identity for its join row. Supply '${this.targetPkField}' in the createMany data, or drop 'skipDuplicates'.`
        );
      }
      return {
        kind: "produced",
        value: referenceSql(
          this.context.engine,
          this.childScope.model,
          this.targetPkField,
          ref(childId, "id")
        ),
        field: this.targetPkField,
      };
    }
    throw new QueryEngineError(
      `query-engine-v2 internal: the create-through-junction arm for relation '${this.relationName}' reached identity resolution with no value for the target primary key '${this.targetPkField}'.`
    );
  }

  /** The adopt family's found premise (batch): the adopted target still exists AND
   *  the captured PK still matches the selector (split-witness correlation — a
   *  concurrent move of the selector onto a replacement leaves no such row, so the
   *  join never links the replacement). Existing-row premise, raceable:false.
   *
   *  E5-U1 — the fresh-parent `upsert` takes the same premise through the same
   *  construction site, worded for ITS operation: the two members of the adopt family
   *  say `Record was replaced … during nested connectOrCreate` and `… nested upsert`,
   *  and one site keeps them from drifting. */
  private adoptFoundGuard(
    slot: { readonly guardId: string; readonly where: Record<string, unknown> },
    capturedPk: unknown,
    capturedColumns?: Sql
  ): GuardStep {
    return presenceGuard(
      slot.guardId,
      this.capturedSelectorRead(slot.where, capturedPk, capturedColumns),
      nestedWriteFailure(
        nestedReplacement(
          this.plan.kind === "upsert" ? "upsert" : "connectOrCreate"
        ),
        this.relationName,
        false
      )
    );
  }

  /** Reassert that the complete selector still names the captured target row. */
  private capturedSelectorRead(
    where: Record<string, unknown>,
    capturedPk: unknown,
    capturedColumns?: Sql
  ) {
    return buildFind(
      this.childScope,
      {
        where: capturedSelectorWhere(this.childScope, where, {
          [this.targetPkField]: capturedPk,
        }),
        select: targetProjectionRowKeySelect(
          buildTargetProjection(this.childScope.model)
        ),
      },
      {
        limit: 1,
        ...(capturedColumns ? { predicate: capturedColumns } : {}),
      }
    );
  }

  /** upsert member premise (batch): the target is still a member of this parent
   *  AND still the captured PK (split-witness correlation). Existing-row premise,
   *  pinned raceable:false, V1's replacement wording. */
  private upsertMemberGuard(
    slot: LocatedUpsertSlot,
    parent: unknown,
    capturedPk: unknown,
    capturedColumns?: Sql
  ): GuardStep {
    return {
      id: slot.guardId,
      kind: "guard",
      premise: {
        kind: "exists",
        statement: this.membershipRead({
          parentValue: parent,
          whereUnique: slot.where,
          where: { [this.targetPkField]: { equals: capturedPk } },
          ...(capturedColumns ? { predicate: capturedColumns } : {}),
          take: 1,
        }),
      },
      failure: nestedWriteFailure(
        nestedReplacement("upsert"),
        this.relationName,
        false
      ),
    };
  }

  private childDelete(id: string, targetPk: unknown): WriteStep {
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
  ): WriteStep {
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
          this.relationInfo,
          "membershipDifference",
          {
            parentValue: parent,
            ...(Object.keys(bulk.filter).length > 0
              ? { where: bulk.filter }
              : {}),
            targetValues: [...targetPks],
            difference,
          }
        ),
      },
      failure: nestedWriteFailure(
        m2mMembershipRace(this.relationName, "deleteMany"),
        this.relationName,
        true
      ),
    };
  }

  private targetPresenceGuard(
    target: TargetSlot,
    op: "connect" | "set",
    capturedPk: unknown
  ): GuardStep {
    return presenceGuard(
      target.guardId,
      // Split-witness correlation: the captured target must still match the
      // selector, so `set`/`connect` cannot adopt a replacement that inherited it.
      this.capturedSelectorRead(target.where, capturedPk),
      nestedWriteFailure(
        relationTargetNotFound(this.relationInfo, op),
        this.relationName,
        false
      )
    );
  }

  private connectedPresenceGuard(
    target: TargetSlot,
    parent: unknown,
    op: "delete" | "update",
    capturedPk: unknown,
    capturedColumns?: Sql
  ): GuardStep {
    return {
      id: target.guardId,
      kind: "guard",
      premise: {
        kind: "exists",
        // Split-witness correlation: the member matching the selector must still
        // be the captured PK. A concurrent move that connects a replacement under
        // the selector no longer satisfies `pk = capturedPk`, so delete/update
        // fails closed instead of acting on the replacement.
        statement: this.membershipRead({
          parentValue: parent,
          whereUnique: target.where,
          where: { [this.targetPkField]: { equals: capturedPk } },
          ...(capturedColumns ? { predicate: capturedColumns } : {}),
          take: 1,
        }),
      },
      failure: nestedWriteFailure(
        relationTargetNotFound(this.relationInfo, op),
        this.relationName,
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
        relationTargetNotFound(this.relationInfo, op),
        this.relationName
      );
    }
    return this.pkOf(rows[0]);
  }

  private capturedCompilerPredicate(
    compiler: RecordUpdateCompiler,
    probeId: string,
    known: PlanningKnown
  ): Sql | undefined {
    if (compiler.targetReadId !== probeId) return undefined;
    const rows = known[planningKey(probeId, "rows")];
    const captured = Array.isArray(rows) ? rows[0] : undefined;
    if (!isRecord(captured)) return undefined;
    return capturedTargetColumnPredicate(
      this.childScope,
      compiler.targetProjection,
      captured,
      getTableName(this.childScope.model)
    );
  }

  private connectedSet(bulk: BulkSlot, known: PlanningKnown): unknown[] {
    const rows = known[planningKey(bulk.readId, "rows")];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 deleteMany for relation '${this.relationName}' did not expose its membership set.`,
        this.relationName
      );
    }
    return rows.map((row) => this.pkOf(row));
  }

  private pkOf(row: unknown): unknown {
    if (!(row && typeof row === "object")) {
      throw new NestedWriteError(
        `query-engine-v2 junction membership for relation '${this.relationName}' returned a malformed row.`,
        this.relationName
      );
    }
    return (row as Record<string, unknown>)[this.targetPkField];
  }

  /**
   * The parent-id a planning membership read correlates on. A `planned` source
   * refs the not-yet-run locate by a SQL `Ref` (technique #1). A `literal` source
   * — a depth-composed junction under a located-by-PK nested target (T3b mechanism
   * 1) — inlines its compile-time value directly: the correlation is a known
   * constant, so the membership read is `WHERE parentColumn = <literal>`, exactly
   * as the write correlation ({@link parentLiteral}) already does. The membership
   * read's `parentValue` is materialized identically for a `Ref` or a literal
   * (both ride through `ManyToManyStatements.materialize`), so no leaf learns which.
   *
   * The read source differs from the write source only across a key transition.
   */
  private parentRef(): unknown {
    return foreignKeyCorrelationValue(this.membershipMember());
  }

  /** The compile-time parent value the junction writes correlate on: a located
   *  (`planned`) row's literal, a compile-time `literal`, or — a FRESH parent
   *  whose PK is DB-generated (create root, `ref` kind) — a backward `Ref` to
   *  the parent INSERT's produced identity, cast at the interpolation site and
   *  riding `Sql.values` exactly as the child-FK path does (materialized by the
   *  executor in tx mode; scratch-threaded insertId in batch mode). */
  private parentLiteral(known: PlanningKnown): unknown {
    const member = this.parentWriteMember();
    return foreignKeyWriteValueWith(
      member,
      known,
      this.relationName,
      "junction",
      (reference) =>
        referenceSql(
          this.context.engine,
          this.context.parentScope.model,
          member.referencedField,
          reference
        )
    );
  }

  /**
   * The compile-time parent value a BATCH GUARD asserts membership on — the read
   * correlation, not the write one.
   *
   * A guard re-asserts, at execution time, the premise its planning read established,
   * and the atomic unit evaluates every guard BEFORE any write in it (the root's
   * bucketing, `UpdateOperation.compile`: "a batch pins its premises before any
   * write"). So under a post-transition ordering the guard runs while the join rows
   * still carry the PRE-transition key — the same key the planning read asked for and
   * the only one that can be true at that moment. Taking the written value here would
   * assert membership under a key no row has yet and fail a premise that holds
   * (measured: `Cannot update relation '…': target record was not found for this
   * parent.` on the batch substrate while the transaction substrate succeeded).
   *
   * Without a transition the two sources are one value and every guard is
   * byte-identical to pre-E2-U3.
   */
  private membershipLiteral(known: PlanningKnown): unknown {
    return foreignKeyResolvedReadValue(
      this.membershipMember(),
      known,
      this.relationName,
      "junction"
    );
  }

  private parentWriteMember(): ForeignKeyMember {
    return {
      foreignField: this.sourceFieldName,
      referencedField: this.sourcePkField,
      writeSource: this.context.parentId,
    };
  }

  private membershipMember(): CorrelatedForeignKeyMember {
    const readSource = this.context.membershipReadSource;
    return {
      ...this.parentWriteMember(),
      readSource: planningSourceFromFinal(
        readSource,
        this.relationName,
        "junction"
      ),
      writeSource: this.context.parentId,
    };
  }
}

// ---------------------------------------------------------------------------
// Fold — one M2M relation's parsed mutation into its junction Parts. Each kind
// (connect/disconnect/set/delete/deleteMany/update/updateMany, plus the adopt
// family create/connectOrCreate/upsert) becomes one Part carrying every item of
// that kind; several kinds coexist on one relation as several Parts in the
// linear fragment. The adopt family's create arm is INSERT-child + INSERT-join
// (V1's junction SQL as leaves); its child PK is a literal the create data
// carries or — for a DB-generated target — an inline INSERT or delegated fresh
// subtree's produced identity, referenced backward by the join row. Upsert uses
// the same literal-or-produced identity paths.
// ---------------------------------------------------------------------------

export function buildJunctionParts(input: {
  scope: StepScope;
  engine: QueryEngine;
  parentScope: QueryScope;
  relation: JunctionRelation;
  program: RelationMutationProgram;
  parentId: FinalReferenceSource;
  /** Parent value carried by existing membership rows before a key transition. */
  membershipReadSource: FinalReferenceSource;
  /** A create-root parent has no pre-existing membership. */
  freshParent?: boolean;
  txMode: boolean;
  recordCompilers: RecordCompilerSeam;
  /** T3b-2: the depth-recursive child-Part builder (mechanism 2 / mechanism 1
   *  reuse). REQUIRED — every `buildJunctionParts` caller threads it: the root
   *  (UpdateOperation.ts:977, CreateOperation.ts:653) and depth
   *  (nested-target-parts.ts:164). A relation-carrying create/update/upsert target
   *  folds those relations one level deeper through it; the type makes threading it
   *  mandatory so no caller can silently fall back to a scalar-only boundary. */
  nestedBuilder: JunctionTargetRelationsBuilder;
}): RelationJunctionPart[] {
  const { scope, engine, parentScope, relation, program, parentId, txMode } =
    input;
  const { relationInfo } = relation;
  const relationName = relationInfo.name;
  const childName = getStepModelName(relationInfo.targetModel, relationName);
  const childScope = createQueryScope(engine.adapter, relationInfo.targetModel);
  /** The second holder of the junction carve-out documented on the class field
   *  of the same name: `getManyToManyJoinInfo` resolves it through
   *  `getRequiredSinglePrimaryKeyField`, which throws for a compound-keyed target
   *  before this builder runs, so it names the junction's STORED REFERENCE to a
   *  target whose row key is one member by construction. Nothing new may read a
   *  row key through it; N2's `JunctionSide` replaces both holders together. */
  const targetPkField = getManyToManyJoinInfo(
    parentScope,
    relationInfo
  ).targetPkField;
  const base = {
    engine,
    parentScope,
    relation,
    parentId,
    membershipReadSource: input.membershipReadSource,
    txMode,
  } as const;

  const requiresWholeFreshRecordCompiler = (
    relations: Readonly<Record<string, RelationMutationProgram>>
  ): boolean => {
    const targetPrimaryKeys = getPrimaryKeyFields(childScope.model);
    for (const mutation of Object.values(relations)) {
      const bound = bindRelation(childScope, mutation.relationInfo);
      if (bound.kind === "junction") continue;
      if (bound.kind === "parentHeldToOne") return true;
      const referencesTargetPk =
        targetPrimaryKeys.length === 1 &&
        bound.referencedFields.length === 1 &&
        bound.referencedFields[0] === targetPrimaryKeys[0];
      if (!referencesTargetPk) return true;
    }
    return false;
  };
  /** Inline scalar/literal targets keep the junction-local INSERT. A target that
   * needs produced identity propagation or parent-held folding delegates its complete
   * subtree to the fresh-record compiler; a missing-arm pin stays on its root INSERT. */
  const freshTargetFold = (
    create: Record<string, unknown>,
    foldKind: string,
    racePin?: TargetConstraintPin
  ): PreparedFreshTarget => {
    const { scalarData, relations } = buildParsedRelationPrograms(
      childScope,
      create
    );
    const spelledPk = create[targetPkField];
    const pkIsLiteral = spelledPk !== undefined && spelledPk !== null;
    if (Object.keys(relations).length === 0) {
      return {
        kind: "inline",
        data: scalarData,
        descendants: [],
      };
    }
    if (pkIsLiteral && !requiresWholeFreshRecordCompiler(relations)) {
      return {
        kind: "inline",
        data: scalarData,
        descendants: input.nestedBuilder(
          childScope,
          literalParentId(spelledPk),
          relations,
          txMode,
          // A target this statement is INSERTing has no existing membership to read;
          // the value that names it is the key it is being given.
          literalParentId(spelledPk)
        ),
      };
    }
    const subtree = input.recordCompilers.createFresh({
      childScope,
      data: create,
      relationName: "",
      ...(racePin ? { racePin } : {}),
    });
    if (pkIsLiteral) {
      return {
        kind: "record",
        record: subtree,
        identity: { kind: "literal", value: spelledPk },
      };
    }
    const produced = subtree.rootReferenced(targetPkField);
    if (produced === undefined) {
      // MEASURED UNREACHABLE (Package F, F4). This used to be a capability refusal —
      // "the target primary key must be in the create data" — and the shape it named is
      // real, but no payload arrives here holding it. `targetPkField` is
      // `getRequiredSinglePrimaryKeyField`, and `planNestedCreateIdentity` is TOTAL over
      // a single-member primary key: it puts a spelled value into the record's identity
      // (so `freshReferenced` answers with a literal), makes an absent auto-increment the
      // record's `generatedField` (so it answers with the produced reference), and throws
      // `NestedWriteError` for an absent key that is neither — one line EARLIER, inside
      // the `createFresh` call above. The two other candidates die further upstream: an
      // `Sql` primary key is parse-unreachable in write data (E6.6), and a `null` one is
      // refused by the target's own create schema before the engine sees it. So this is a
      // code path a user cannot reach, and a `QueryEngineError` is what that is — the
      // disposition `assertCreateTreeKinds` already carries for the same situation.
      throw new QueryEngineError(
        `query-engine-v2 internal: create-through-junction for relation '${relationName}' resolved no primary key '${targetPkField}' from the target subtree (${foldKind}).`
      );
    }
    let hasGeneratedIdentity = false;
    const pk = foreignKeyWriteValueWith(
      {
        foreignField: targetPkField,
        referencedField: targetPkField,
        writeSource: produced,
      },
      undefined,
      relationName,
      "create-through-junction",
      (reference) => {
        hasGeneratedIdentity = true;
        return referenceSql(engine, childScope.model, targetPkField, reference);
      }
    );
    return {
      kind: "record",
      record: subtree,
      identity: hasGeneratedIdentity
        ? { kind: "produced", value: pk, field: targetPkField }
        : { kind: "literal", value: pk },
    };
  };
  /** Generated-key `createMany` can adopt only when one complete nameable unique
   * identifies each skipped row. With no other declared unique the flag is vacuous.
   * Ambiguous or unnameable conflicts stay on the leaf path and refuse before a wrong
   * identity can reach the junction row. */
  const skipDuplicatesDisposition = (
    rows: readonly Record<string, unknown>[]
  ):
    | { kind: "leaf" }
    | { kind: "vacuous" }
    | { kind: "adopt"; wheres: readonly Record<string, unknown>[] } => {
    const scalar = childScope.model["~"].state.scalars[targetPkField];
    const everyRowOmitsPk = rows.every(
      (row) => row[targetPkField] === undefined
    );
    // A spelled primary key still has a compile-time identity, so the existing skip
    // leaf (or MySQL's savepoint effect) answers for it exactly as it does today.
    if (!everyRowOmitsPk || scalar?.["~"].state.autoGenerate !== "increment") {
      return { kind: "leaf" };
    }
    const { probeable, indexOnly } = conflictableUniques(childScope.model);
    if (probeable.length === 0 && indexOnly === 0) return { kind: "vacuous" };
    const wheres: Record<string, unknown>[] = [];
    for (const row of rows) {
      const spelled = probeable.filter((unique) =>
        unique.fields.every((field) => {
          const value = row[field];
          return value !== undefined && value !== null;
        })
      );
      const [only] = spelled;
      if (spelled.length !== 1 || !only) return { kind: "leaf" };
      wheres.push(
        only.fields.length === 1 && only.fields[0] === only.selector
          ? { [only.selector]: row[only.selector] }
          : {
              [only.selector]: Object.fromEntries(
                only.fields.map((field) => [field, row[field]])
              ),
            }
      );
    }
    return { kind: "adopt", wheres };
  };
  const parts: RelationJunctionPart[] = [];
  // A stable, V1-mirroring kind order: adopt/link first, then set, then the
  // correlated writes, then removals — every kind independent (the own-write
  // preflight has already rejected any overlapping pair).
  for (const entry of program.entries) {
    switch (entry.kind) {
      case "connect":
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "connect",
            targets: entry.targets,
          })
        );
        break;
      case "disconnect": {
        if (entry.target.kind === "current") {
          throw new NestedWriteError(
            m2mDisconnectRequiresSelector(relationName),
            relationName
          );
        }
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "disconnect",
            targets: entry.target.targets,
          })
        );
        break;
      }
      case "set":
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "set",
            targets: entry.targets,
          })
        );
        break;
      case "delete": {
        if (entry.target.kind === "current") {
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
            targets: entry.target.targets,
          })
        );
        break;
      }
      case "deleteMany":
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "deleteMany",
            filters: entry.filters,
          })
        );
        break;
      case "update": {
        const items = entry.items.map((item) => {
          if (item.target.kind !== "unique") {
            throw new QueryEngineError(
              `query-engine-v2 internal: many-to-many update for relation '${relationName}' requires a unique target.`
            );
          }
          return { where: item.target.where, data: item.data };
        });
        const compiled = items.flatMap((item) => {
          const parsed = buildParsedRelationPrograms(childScope, item.data);
          assertPortablePrimaryKeyUpdateInput(childScope.model, "update", {
            data: parsed.scalarData,
          });
          assertRelationKeyUpdatesAreCompilable(
            childScope,
            parsed.scalarData,
            parsed.relations
          );
          assertSelectedUpdateManyDataIsScalar(childScope, parsed.relations);
          const compiler = input.recordCompilers.updateSelected({
            scope,
            engine,
            targetScope: childScope,
            scalarData: parsed.scalarData,
            relations: parsed.relations,
            polymorphic: parsed.polymorphic,
            targetRead: { label: `${childName}.find` },
            rootWrite: { label: `${childName}.update` },
            relationName,
            pinnedTarget: pinnedTargetValues(childScope, item.where),
          });
          return compiler ? [{ where: item.where, compiler }] : [];
        });
        if (compiled.length === 0) break;
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "update",
            items: compiled,
          })
        );
        break;
      }
      case "updateMany": {
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "updateMany",
            items: entry.items.map((item) => ({
              where: item.where ?? {},
              data: scalarOnly(childScope, item.data),
            })),
          })
        );
        break;
      }
      case "create": {
        const folded = entry.items.map((create) =>
          freshTargetFold(create, "create")
        );
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "create",
            targets: folded,
          })
        );
        break;
      }
      case "createMany": {
        // Duplicate skipping applies to the child INSERT. Every resolved target still
        // receives its idempotent junction row.
        const rows = entry.rows;
        // An empty `data` writes nothing, exactly as the child-held-FK nested
        // `createMany` does (`CreateOperation.foldCreateMany`) — no Part, no steps.
        if (rows.length > 0) {
          const skipDuplicates = entry.skipDuplicates === true;
          // E6.8 — see {@link skipDuplicatesDisposition}. Only a generated target key
          // reaches a decision here: everything else keeps the skip leaf it has today.
          const disposition = skipDuplicates
            ? skipDuplicatesDisposition(rows)
            : ({ kind: "leaf" } as const);
          if (disposition.kind === "adopt") {
            // The rows ARE `connectOrCreate` items: the unique each row spells is the
            // selector, the row is the create payload. Nothing below is new machinery —
            // this is the adopt family verbatim, dedup ledger and racePin included.
            const armed = rows.map((create, index) =>
              freshTargetFold(
                create,
                "create",
                childRacePin(childScope, disposition.wheres[index]!)
              )
            );
            parts.push(
              new RelationJunctionPart(scope, {
                ...base,
                kind: "connectOrCreate",
                items: rows.map((_, index) => ({
                  where: disposition.wheres[index]!,
                  target: armed[index]!,
                })),
              })
            );
            break;
          }
          const foldedMany = rows.map((create) =>
            freshTargetFold(create, "create")
          );
          parts.push(
            new RelationJunctionPart(scope, {
              ...base,
              kind: "createMany",
              // `vacuous`: the flag is dropped because no constraint exists for it to
              // act on. `leaf`: it rides each INSERT as it always has (and, for a
              // generated key with no single naming unique, `resolveCreatePk` refuses).
              skipDuplicates: skipDuplicates && disposition.kind !== "vacuous",
              targets: foldedMany,
            })
          );
        }
        break;
      }
      case "connectOrCreate": {
        // E2-U2: the create arm folds its own relations one level deeper against its
        // literal PK (mechanism 2); the slot emits them on the create branch only.
        const items = entry.items;
        const armed = items.map((item) =>
          // E4-U3: the arm's missing-premise pin rides the delegated subtree's root
          // INSERT when the whole create is delegated (E2's carve, now wired).
          freshTargetFold(
            item.create,
            "connectOrCreate",
            childRacePin(childScope, item.where)
          )
        );
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "connectOrCreate",
            items: items.map((item, index) => ({
              where: item.where,
              target: armed[index]!,
            })),
          })
        );
        break;
      }
      case "upsert": {
        // T3b-2: both arms fold their own relations one level deeper against the
        // target's literal PK — the create arm (mechanism 2, fresh target) against
        // its `create` PK, the update arm (mechanism 1 reuse) against its `where` PK.
        // Each arm's child Parts are emitted branch-specifically by `compileUpsert`.
        const items = entry.items.map((item) => {
          if (item.target.kind !== "unique") {
            throw new QueryEngineError(
              `query-engine-v2 internal: many-to-many upsert for relation '${relationName}' requires a unique target.`
            );
          }
          return {
            where: item.target.where,
            create: item.create,
            update: item.update,
          };
        });
        const folded = items.map((item) => ({
          ...item,
          target: freshTargetFold(
            item.create,
            "create",
            childRacePin(childScope, item.where)
          ),
        }));
        // Allocate every probe before compiling any arm; StepScope suffixes stay stable.
        const probed = folded.map((item) => ({
          ...item,
          probes: {
            member: scope.allocate(`${childName}.member`),
            global: scope.allocate(`${childName}.find`),
          },
        }));
        const armed = probed.map((item) => {
          const parsed = buildParsedRelationPrograms(childScope, item.update);
          const pinnedTarget = pinnedTargetValues(childScope, item.where);
          const hasUpdate =
            Object.keys(parsed.scalarData).length +
              Object.keys(parsed.relations).length +
              Object.keys(parsed.polymorphic).length >
            0;
          const compiler = hasUpdate
            ? input.recordCompilers.updateSelected({
                scope,
                engine,
                targetScope: childScope,
                scalarData: parsed.scalarData,
                relations: parsed.relations,
                polymorphic: parsed.polymorphic,
                targetRead: {
                  id: input.freshParent
                    ? item.probes.global
                    : item.probes.member,
                },
                rootWrite: { label: `${childName}.update` },
                relationName,
                pinnedTarget,
              })
            : undefined;
          return {
            ...item,
            updateArm: compiler
              ? {
                  compiler,
                  assertLegality: () => {
                    assertPortablePrimaryKeyUpdateInput(
                      childScope.model,
                      "update",
                      { data: parsed.scalarData }
                    );
                    assertRelationKeyUpdatesAreCompilable(
                      childScope,
                      parsed.scalarData,
                      parsed.relations
                    );
                    assertSelectedUpdateManyDataIsScalar(
                      childScope,
                      parsed.relations
                    );
                  },
                }
              : undefined,
          };
        });
        if (input.freshParent) {
          parts.push(
            new RelationJunctionPart(scope, {
              ...base,
              kind: "upsert",
              parentState: "fresh",
              items: armed.map((item) => {
                const update: Extract<
                  JunctionUpsertUpdate,
                  { kind: "none" | "global" }
                > = item.updateArm
                  ? { kind: "global", ...item.updateArm }
                  : { kind: "none" };
                return {
                  where: item.where,
                  target: item.target,
                  probes: item.probes,
                  update,
                };
              }),
            })
          );
        } else {
          parts.push(
            new RelationJunctionPart(scope, {
              ...base,
              kind: "upsert",
              parentState: "located",
              items: armed.map((item) => {
                const update: Extract<
                  JunctionUpsertUpdate,
                  { kind: "none" | "member" }
                > = item.updateArm
                  ? { kind: "member", ...item.updateArm }
                  : { kind: "none" };
                return {
                  where: item.where,
                  target: item.target,
                  probes: item.probes,
                  update,
                };
              }),
            })
          );
        }
        break;
      }
      default: {
        const exhaustive: never = entry;
        throw new QueryEngineError(
          `query-engine-v2 junction part has no builder for '${String(exhaustive)}'.`
        );
      }
    }
  }
  return parts;
}

/** Split declared non-PK uniques by whether `whereUnique` can name them. */
function conflictableUniques(model: Model<any>): {
  probeable: { selector: string; fields: readonly string[] }[];
  indexOnly: number;
} {
  const state = model["~"].state;
  const primaryKeys = new Set(getPrimaryKeyFields(model));
  const probeable: { selector: string; fields: readonly string[] }[] = [];
  for (const field of Object.keys(state.uniques)) {
    // `state.uniques` carries `.id()` fields too (extractUniqueScalarMap keys on
    // `isUnique || isId`), so the primary key is filtered out here, once.
    if (primaryKeys.has(field)) continue;
    probeable.push({ selector: field, fields: [field] });
  }
  const compounds: Record<string, { entries: Record<string, unknown> }> =
    state.compoundUniques ?? {};
  for (const [selector, constraint] of Object.entries(compounds)) {
    probeable.push({ selector, fields: Object.keys(constraint.entries) });
  }
  const indexOnly = state.indexes.filter(
    (index) => index.options.unique === true
  ).length;
  return { probeable, indexOnly };
}

/** A stable key for a target primary key value (dedup of same-op created targets). */
function pkKey(value: unknown): string {
  return typeof value === "bigint" ? value.toString() : JSON.stringify(value);
}

/** Literal identities key directly; produced identities key by their selector. */
function adoptDedupKey(slot: {
  readonly where: Record<string, unknown>;
  readonly identity: JunctionIdentity;
}): string {
  return slot.identity.kind === "literal"
    ? `pk:${pkKey(slot.identity.value)}`
    : `where:${stableKey(slot.where)}`;
}

/** Stable selector key; bigint is tagged because JSON cannot encode it. */
function stableKey(record: Record<string, unknown>): string {
  const entries = Object.keys(record)
    .sort()
    .map((field) => [field, record[field]] as const);
  return JSON.stringify(entries, (_key, value) =>
    typeof value === "bigint" ? `${value}n` : value
  );
}

/**
 * The scalar half of a junction `updateMany` entry's data.
 *
 * A refusal stood here (Package O cluster 2, site 9) and is DELETED. It restated
 * `assertSelectedUpdateManyDataIsScalar`'s decision — which the enclosing selected
 * record's data has already answered on every route into this builder — and it read
 * `Object.keys(relations)` alone, the map-only question Package K proved is a
 * measured SILENT WRONG ANSWER for a direct polymorphic key (it carries no relation
 * program, so a `disconnect` walked past a map-only wall and was dropped on the
 * floor). It was the fourth such reader; deleting it removes the blind spot rather
 * than teaching a duplicate to see.
 */
function scalarOnly(
  childScope: QueryScope,
  data: Record<string, unknown>
): Record<string, unknown> {
  return buildParsedRelationPrograms(childScope, data).scalarData;
}
