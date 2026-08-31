// biome-ignore-all lint/style/useFilenamingConvention: RelationJunctionPart is the architecture name.
import { getAdapterInternals } from "@adapters/adapter-internals";
import { NestedWriteError, QueryEngineError } from "@errors";
import type { Sql } from "@sql";
import { isRecord } from "@validation/value-guards";
import { compileBindBudgetChunks } from "../bind-budget";
import { getPrimaryKeyFields } from "../builders/correlation-utils";
import {
  bindRelation,
  type JunctionBoundRelation,
  type JunctionSide,
  membershipReferencedFields,
} from "../builders/relation-data-builder";
import {
  buildParsedRelationPrograms,
  type ParsedRelationMutation,
  type RecordMutationData,
  type RelationMutationProgram,
  relationMutationPrograms,
} from "../builders/relation-mutation-parser";
import { buildInsert } from "../builders/values-builder";
import { createQueryScope, getTableName } from "../context/query-scope";
import {
  type JunctionInsertMaterializationMode,
  type JunctionOperation,
  JunctionStatements,
} from "../JunctionStatements";
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
import { assertRelationKeyUpdatesAreCompilable } from "../relation-key-legality";
import type { QueryScope } from "../types";
import type { FreshRecordPart } from "./CreateOperation";
import {
  type CreateRacePin,
  createDataSpellsRacePin,
  createRacePin,
} from "./create-race-pin";
import {
  exactlyOneRow,
  nestedWriteFailure,
  presenceGuard,
  queryFailure,
  referenceSql,
} from "./fragment-builders";
import {
  type JunctionCreateManyRowRoute,
  routeJunctionCreateManyRow,
} from "./junction-create-many-routing";
import {
  type JunctionSingularTransfer,
  type JunctionTransferAddress,
  type JunctionTransferMode,
  transferSingularJunctionMembership,
} from "./junction-singular-transfer";
import {
  m2mDisconnectRequiresSelector,
  m2mMembershipRace,
  nestedReplacement,
  relationTargetNotFound,
  upsertTargetNotFoundForParent,
} from "./messages";
import { NestedSelectedRecordSeries } from "./NestedSelectedRecordSeries";
import type { JunctionTargetRelationsBuilder } from "./nested-target-parts";
import type { ExecutableOperation } from "./OperationExecutor";
import {
  bucketOperationSteps,
  type GuardStep,
  type OperationFragment,
  type OperationStep,
  type PlanningFragment,
  type ReadStep,
  type RecordSeriesStep,
  ref,
  type StatementStep,
  type WriteStep,
} from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { conditionalArmPlanning, planningKey } from "./Part";
import type {
  RecordCompilerSeam,
  RecordUpdateCompiler,
} from "./RecordUpdateCompiler";
import type { RecordSeriesOperation } from "./record-series";
import {
  type CorrelatedForeignKeyMember,
  type FinalReferenceSource,
  type FinalReferenceSources,
  type ForeignKeyMember,
  foreignKeyCorrelationValue,
  foreignKeyResolvedReadValue,
  foreignKeyWriteValueWith,
  literalParentId,
  planningSourceFromFinal,
  resolveFinalReferenceRowKey,
} from "./relation-membership";
import type { StepScope } from "./StepScope";
import { parseCapturedRowKeys, parseCapturedRows } from "./series-result-read";
import {
  capturedSelectorWhere,
  getStepModelName,
  pinnedTargetValues,
} from "./shared";
import {
  buildTargetProjection,
  capturedTargetColumnPredicate,
  capturedTargetFilters,
  capturedTargetSetWhere,
  capturedTargetWhere,
  completeTargetPresenceGuard,
  rowKeysEqual,
  rowKeyToken,
  type TargetProjection,
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
  readonly relation: JunctionBoundRelation;
  readonly parentId: JunctionReferenceSources;
  /**
   * PHASE 5 PARTIAL — the read half stays its own channel beside `parentId`. Folding
   * the two into one source-bound member would have to narrow the read source
   * ({@link planningSourceFromFinal}) at the folding site; that narrowing is both lazy
   * and kind-named (see {@link RelationJunctionPart.membershipLiteral}, whose measured
   * batch-guard behaviour depends on taking the READ source, and only there).
   */
  readonly membershipReadSource: JunctionReferenceSources;
  readonly txMode: boolean;
  readonly recordCompilers: RecordCompilerSeam;
  /**
   * How a SINGULAR member's slot replacement must behave (plan §1.6). Absent —
   * and therefore `"preserveExact"` — for every ordinary junction, whose
   * cardinality is always `"many"` and which never reaches the transfer at all.
   * The collection coordinator sets `"reinsertAfterOwnerClear"` on the runs it
   * lowered from `set`, because its relation-wide clear already removed the row
   * the idempotent-reconnect shortcut would otherwise decline to re-add.
   */
  readonly membershipAddMode?: JunctionTransferMode;
}

type JunctionReferenceSources = FinalReferenceSources;
export type JunctionRowKey = Readonly<Record<string, unknown>>;

/**
 * One compilation's resolved singular-membership targets. The member table and
 * target-model object keep variants disjoint;
 * each innermost bucket still confirms candidates by complete row-key equality.
 */
export type ResolvedJunctionMembershipRegistry = Map<
  string,
  Map<object, Map<string, JunctionRowKey[]>>
>;

export function createResolvedJunctionMembershipRegistry(): ResolvedJunctionMembershipRegistry {
  return new Map();
}

/**
 * One compilation's missing-arm first-create ledger. The member table and
 * target-model object keep separate polymorphic variants from sharing a key.
 */
export type SharedAdoptCreatedRegistry = Map<
  string,
  Map<object, Map<string, JunctionRowKey>>
>;

export function createSharedAdoptCreatedRegistry(): SharedAdoptCreatedRegistry {
  return new Map();
}

/** A junction Part may receive collection-wide compile coordination from its
 * direct-polymorphic parent. Plain Parts ignore those optional arguments. */
export interface JunctionCompilePart extends Part {
  compile(
    scope: StepScope,
    known: PlanningKnown,
    sharedAdoptCreated?: SharedAdoptCreatedRegistry,
    resolvedMemberships?: ResolvedJunctionMembershipRegistry
  ): readonly OperationStep[];
}

type JunctionIdentity =
  | { readonly kind: "literal"; readonly values: JunctionRowKey }
  | {
      readonly kind: "produced";
      readonly values: JunctionRowKey;
      /** Present only for the legacy one-column inline INSERT leaf. */
      readonly generatedField?: string;
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
      readonly items: readonly JunctionUpdateManyItem[];
    }
  | {
      readonly kind: "create";
      readonly targets: readonly PreparedFreshTarget[];
    }
  | {
      readonly kind: "createMany";
      readonly targets: readonly {
        readonly target: PreparedFreshTarget;
        readonly joinWhenTargetExists: boolean;
      }[];
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

type JunctionUpdateManyItem = { readonly where: Record<string, unknown> } & (
  | {
      readonly route: "scalar";
      readonly data: Record<string, unknown>;
    }
  | { readonly route: "series"; readonly data: RecordMutationData }
);

type UpdateManySlot = BareSlot & JunctionUpdateManyItem;

/** A fresh target plus the already allocated target and join writes. */
interface CreateSlot {
  readonly target: PreparedFreshTarget;
  readonly identity: JunctionIdentity;
  readonly childId: string;
  readonly joinId: string;
  readonly skipDuplicates: boolean;
  readonly joinWhenTargetExists: boolean;
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

export class RelationJunctionPart implements JunctionCompilePart {
  private readonly context: JunctionContext;
  private readonly childName: string;
  private readonly childScope: QueryScope;
  private readonly targetProjection: TargetProjection;
  private readonly statements: JunctionStatements;
  private readonly plan: JunctionPlan;
  /**
   * One transfer per membership-adding write id, or EMPTY for every plural
   * junction — which is every ordinary many-to-many, so the whole estate outside
   * a singular polymorphic member is byte-identical.
   */
  private readonly transfers = new Map<string, JunctionSingularTransfer>();

  private get relationRef() {
    return this.context.relation.relationRef;
  }

  private get relationName(): string {
    return this.relationRef.name;
  }

  private get sourceSide(): JunctionSide {
    return this.context.relation.membership.source;
  }

  private get targetSide(): JunctionSide {
    return this.context.relation.membership.target;
  }

  constructor(scope: StepScope, input: RelationJunctionInput) {
    this.context = input;
    this.childName = getStepModelName(
      input.relation.relationRef.targetModel,
      input.relation.relationRef.name
    );
    this.childScope = createQueryScope(
      input.engine,
      input.relation.relationRef.targetModel
    );
    this.targetProjection = buildTargetProjection(this.childScope.model);
    this.statements = new JunctionStatements(input.parentScope, input.txMode);
    this.plan = this.allocatePlan(scope, input);
    this.allocateMembershipTransfers(scope);
  }

  // -------------------------------------------------------------------------
  // MEMBERSHIP ADD — the ONE branch every insert point takes (plan §1.6).
  //
  // Six sites add a membership row: `connect`, the coordinator's lowered `set`
  // runs, the fresh-target join, `connectOrCreate`'s found arm, both `upsert`
  // joins, and the createMany leaf/adopt joins. Rather than six copies of "is
  // this member singular", they all call {@link membershipAddWrites}, and the
  // captures they need are allocated once here.
  // -------------------------------------------------------------------------

  /**
   * Allocate one transfer per membership-adding write, addressed by whatever
   * names the target AT PLANNING TIME.
   *
   * A selector-addressed slot uses its `where` (the capture lowers it to the
   * same scalar subqueries `junctionDelete`'s `targetWhere` already builds), so
   * the capture is an ordinary planning read BESIDE the target probe rather than
   * one that waits on it. A literal create key addresses itself. A produced
   * identity addresses nothing — and needs to address nothing, because no
   * membership can reference a row that does not exist yet.
   */
  private allocateMembershipTransfers(scope: StepScope): void {
    if (this.context.relation.cardinality !== "one") return;
    for (const [writeId, address] of this.membershipAddSites()) {
      this.transfers.set(
        writeId,
        transferSingularJunctionMembership({
          engine: this.context.engine,
          scope,
          statements: this.statements,
          junction: this.context.relation,
          stepPrefix: `${this.childName}.slot`,
          address,
          mode: this.context.membershipAddMode ?? "preserveExact",
          txMode: this.context.txMode,
        })
      );
    }
  }

  /** Every membership-adding write id in this plan, with its planning address. */
  private membershipAddSites(): [string, JunctionTransferAddress][] {
    const freshAddress = (slot: CreateSlot | AdoptSlot | UpsertSlotBase) =>
      slot.identity.kind === "literal"
        ? ({ kind: "values", values: slot.identity.values } as const)
        : ({ kind: "fresh" } as const);
    // biome-ignore lint/style/useDefaultSwitchClause: JunctionPlan is exhaustive.
    switch (this.plan.kind) {
      case "connect":
      case "set":
        return this.plan.slots.map(
          (slot): [string, JunctionTransferAddress] => [
            slot.writeId,
            { kind: "selector", where: slot.where },
          ]
        );
      case "create":
      case "createMany":
        return this.plan.slots.map(
          (slot): [string, JunctionTransferAddress] => [
            slot.joinId,
            freshAddress(slot),
          ]
        );
      case "connectOrCreate":
        return this.plan.slots.map(
          (slot): [string, JunctionTransferAddress] => [
            slot.joinId,
            // The FOUND arm adopts an existing row, so the selector is the honest
            // address; the missing arm's capture is trivially empty and costs one
            // read that also proves the slot.
            { kind: "selector", where: slot.where },
          ]
        );
      case "upsert":
        return this.plan.slots.map(
          (slot): [string, JunctionTransferAddress] => [
            slot.joinId,
            { kind: "selector", where: slot.where },
          ]
        );
      case "disconnect":
      case "delete":
      case "deleteMany":
      case "update":
      case "updateMany":
        return [];
    }
  }

  private membershipAddPlanning(): readonly StatementStep[] {
    const steps: StatementStep[] = [];
    for (const transfer of this.transfers.values()) {
      steps.push(...transfer.planning);
    }
    return steps;
  }

  /**
   * The membership row(s) one site adds: a plain idempotent insert for a plural
   * member table, or the slot-replacement protocol for a singular one.
   */
  private membershipAddWrites(
    writeId: string,
    parent: unknown,
    targetValue: unknown,
    known: PlanningKnown,
    insert: () => WriteStep,
    mode: JunctionInsertMaterializationMode = "default"
  ): readonly OperationStep[] {
    if (mode === "exactMembershipNoop") return [insert()];
    const transfer = this.transfers.get(writeId);
    if (!transfer) return [insert()];
    return transfer.compile(known, {
      // A non-record target value is a PRODUCED identity, which reaches the
      // transfer only on the `fresh` address — where the slot is provably empty
      // and the key is never read.
      targetKey: isRecord(targetValue) ? targetValue : {},
      desiredOwner: isRecord(parent) ? parent : {},
      insert,
    });
  }

  /**
   * The bulk membership insert for `connect` / `set`, or one transfer per
   * resolved target when the member table is singular.
   *
   * Bind-budget chunking is the plural path's alone by construction: a singular
   * slot writes ONE row per target, so there is nothing to chunk, and the chunked
   * statement's historical id and SQL are untouched for every ordinary junction.
   */
  private membershipInsertWrites(
    parent: unknown,
    slots: readonly TargetSlot[],
    targetPks: readonly JunctionRowKey[],
    known: PlanningKnown,
    idForChunk: (start: number, index: number) => string,
    resolvedMemberships?: ResolvedJunctionMembershipRegistry
  ): readonly OperationStep[] {
    if (this.transfers.size === 0) {
      return this.junctionInsertManyWrites(parent, targetPks, idForChunk);
    }
    const writes: OperationStep[] = [];
    const resolvedTargets = new Map<string, JunctionRowKey[]>();
    for (const [index, slot] of slots.entries()) {
      const targetPk = targetPks[index]!;
      if (
        !this.registerResolvedMembership(
          resolvedTargets,
          resolvedMemberships,
          targetPk
        )
      ) {
        continue;
      }
      writes.push(
        ...this.membershipAddWrites(slot.writeId, parent, targetPk, known, () =>
          this.joinInsert(slot.writeId, parent, targetPk)
        )
      );
    }
    return writes;
  }

  private collectionResolvedTargets(
    registry: ResolvedJunctionMembershipRegistry
  ): Map<string, JunctionRowKey[]> {
    const table = this.context.relation.membership.table;
    let modelTargets = registry.get(table);
    if (!modelTargets) {
      modelTargets = new Map();
      registry.set(table, modelTargets);
    }
    let targets = modelTargets.get(this.childScope.model);
    if (!targets) {
      targets = new Map();
      modelTargets.set(this.childScope.model, targets);
    }
    return targets;
  }

  private collectionCreatedAdopts(
    registry: SharedAdoptCreatedRegistry
  ): Map<string, JunctionRowKey> {
    const table = this.context.relation.membership.table;
    let modelKeys = registry.get(table);
    if (!modelKeys) {
      modelKeys = new Map();
      registry.set(table, modelKeys);
    }
    let keys = modelKeys.get(this.childScope.model);
    if (!keys) {
      keys = new Map();
      modelKeys.set(this.childScope.model, keys);
    }
    return keys;
  }

  private registerResolvedTarget(
    targets: Map<string, JunctionRowKey[]>,
    targetPk: JunctionRowKey
  ): boolean {
    const token = rowKeyToken(this.childScope.model, targetPk);
    const candidates = targets.get(token);
    if (
      candidates?.some((candidate) =>
        rowKeysEqual(this.childScope.model, candidate, targetPk)
      )
    ) {
      return false;
    }
    if (candidates) candidates.push(targetPk);
    else targets.set(token, [targetPk]);
    return true;
  }

  /**
   * Keep one singular transition for a resolved target, both within this leaf
   * and across the direct polymorphic collection that owns its registry.
   */
  private registerResolvedMembership(
    resolvedTargets: Map<string, JunctionRowKey[]> | undefined,
    registry: ResolvedJunctionMembershipRegistry | undefined,
    targetPk: JunctionRowKey
  ): boolean {
    if (!resolvedTargets) return true;
    return (
      this.registerResolvedTarget(resolvedTargets, targetPk) &&
      (!registry ||
        this.registerResolvedTarget(
          this.collectionResolvedTargets(registry),
          targetPk
        ))
    );
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
    steps.push(...this.membershipAddPlanning());
    return steps;
  }

  compile(
    scope: StepScope,
    known: PlanningKnown,
    sharedAdoptCreated?: SharedAdoptCreatedRegistry,
    resolvedMemberships?: ResolvedJunctionMembershipRegistry
  ): readonly OperationStep[] {
    const parent = this.parentLiteral(known);
    switch (this.plan.kind) {
      case "connect":
        return this.compileConnect(
          parent,
          known,
          this.plan.slots,
          resolvedMemberships
        );
      case "disconnect":
        return this.compileDisconnect(parent, this.plan.slots);
      case "set":
        return this.compileSet(parent, known, this.plan, resolvedMemberships);
      case "delete":
        return this.compileDelete(parent, known, this.plan.slots);
      case "deleteMany":
        return this.compileDeleteMany(parent, known, this.plan.slots);
      case "update":
        return this.compileUpdate(scope, known, this.plan.slots);
      case "updateMany":
        return this.compileUpdateMany(parent, known, this.plan.slots);
      case "create":
      case "createMany":
        return this.compileCreate(
          scope,
          parent,
          known,
          this.plan.slots,
          resolvedMemberships
        );
      case "connectOrCreate":
        return this.compileConnectOrCreate(
          scope,
          parent,
          known,
          this.plan.slots,
          sharedAdoptCreated,
          resolvedMemberships
        );
      case "upsert":
        return this.plan.parentState === "fresh"
          ? this.compileFreshUpsert(
              scope,
              parent,
              known,
              this.plan.slots,
              resolvedMemberships
            )
          : this.compileUpsert(
              scope,
              parent,
              known,
              this.plan.slots,
              resolvedMemberships
            );
    }
  }

  // Target probes stay per selector; their captured keys preserve split-witness guards.
  private compileConnect(
    parent: unknown,
    known: PlanningKnown,
    slots: readonly TargetSlot[],
    resolvedMemberships?: ResolvedJunctionMembershipRegistry
  ): readonly OperationStep[] {
    const guards: OperationStep[] = [];
    const targetPks: JunctionRowKey[] = [];
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
      ...this.membershipInsertWrites(
        parent,
        slots,
        targetPks,
        known,
        (start) => slots[start]!.writeId,
        resolvedMemberships
      ),
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
    plan: Extract<JunctionPlan, { kind: "set" }>,
    resolvedMemberships?: ResolvedJunctionMembershipRegistry
  ): readonly OperationStep[] {
    const guards: OperationStep[] = [];
    const targetPks: JunctionRowKey[] = [];
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
        ...this.membershipInsertWrites(
          parent,
          plan.slots,
          targetPks,
          known,
          (start, index) =>
            index === 0 ? plan.insertId : plan.slots[start]!.writeId,
          resolvedMemberships
        )
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
    known: PlanningKnown,
    slots: readonly UpdateManySlot[]
  ): readonly OperationStep[] {
    const steps: OperationStep[] = [];
    for (const slot of slots) {
      if (slot.route === "series") {
        const membershipParent = this.membershipLiteral(known);
        const capture: ReadStep = {
          id: `${slot.writeId}.capture`,
          kind: "read",
          model: getStepModelName(this.childScope.model, "record"),
          statement: this.membershipRead({
            parentValue: membershipParent,
            where: slot.where,
            select: targetProjectionRowKeySelect(
              buildTargetProjection(this.childScope.model)
            ),
          }),
          outputs: { rows: { kind: "rows" } },
        };
        steps.push({
          id: slot.writeId,
          kind: "recordSeries",
          progressive: progressiveJunctionParentGuard({
            engine: this.context.engine,
            parentScope: this.context.parentScope,
            member: { scope: this.childScope, data: slot.data },
            relation: this.context.relation,
            source: this.context.membershipReadSource,
            known,
            operation: "updateMany",
            stepId: slot.writeId,
          }),
          series: new NestedSelectedRecordSeries({
            engine: this.context.engine,
            sourceScope: this.context.parentScope,
            targetScope: this.childScope,
            relationRef: this.relationRef,
            member: { kind: "replayPerRecord", data: slot.data },
            capture,
            recordCompilers: this.context.recordCompilers,
            membership: {
              kind: "junction",
              relation: this.context.relation,
              parentValue: membershipParent,
              txMode: this.context.txMode,
            },
          }),
        });
        continue;
      }
      const data = slot.data;
      if (Object.keys(data).length === 0) continue;
      steps.push({
        id: slot.writeId,
        kind: "write",
        model: getStepModelName(this.childScope.model, "record"),
        statement: this.statements.materialize(
          this.context.relation,
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
    slots: readonly CreateSlot[],
    resolvedMemberships?: ResolvedJunctionMembershipRegistry
  ): readonly OperationStep[] {
    const steps: OperationStep[] = [];
    const resolvedTargets =
      this.transfers.size > 0 ? new Map<string, JunctionRowKey[]>() : undefined;
    for (const slot of slots) {
      // A later skip must still keep its child INSERT and exact-key join: an
      // earlier row can skip on another unique while this key remains absent.
      const firstResolvedMembership =
        slot.identity.kind !== "literal" ||
        this.registerResolvedMembership(
          resolvedTargets,
          resolvedMemberships,
          slot.identity.values
        );
      steps.push(
        ...this.compileFreshTarget(
          scope,
          known,
          parent,
          slot,
          undefined,
          slot.skipDuplicates && !firstResolvedMembership
            ? "exactMembershipNoop"
            : "default"
        )
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
    slots: readonly AdoptSlot[],
    sharedCreated?: SharedAdoptCreatedRegistry,
    resolvedMemberships?: ResolvedJunctionMembershipRegistry
  ): readonly OperationStep[] {
    const steps: OperationStep[] = [];
    // Sequential first-create-wins: a later missing duplicate keeps its probe.
    // Singular members leave its target creation and membership to the first
    // arm; plural members replay their historical idempotent membership join.
    const created = sharedCreated
      ? this.collectionCreatedAdopts(sharedCreated)
      : new Map<string, JunctionRowKey>();
    // Only a singular member has a transition to coalesce. A FOUND arm registers
    // after its probe captured the complete target key; a MISSING arm can register
    // its literal key because its child insert is non-skippable.
    const resolvedTargets =
      this.transfers.size > 0 ? new Map<string, JunctionRowKey[]>() : undefined;
    for (const slot of slots) {
      const rows = known[planningKey(slot.probeId, "rows")];
      const [capturedPk] = Array.isArray(rows)
        ? this.capturedRowKeys(rows.slice(0, 1))
        : [];
      if (capturedPk !== undefined) {
        if (!this.context.txMode) {
          steps.push(this.adoptFoundGuard(slot, capturedPk));
        }
        if (
          resolvedTargets &&
          !this.registerResolvedMembership(
            resolvedTargets,
            resolvedMemberships,
            capturedPk
          )
        ) {
          continue;
        }
        steps.push(
          ...this.membershipAddWrites(
            slot.joinId,
            parent,
            capturedPk,
            known,
            () => this.joinInsert(slot.joinId, parent, capturedPk)
          )
        );
        continue;
      }
      const key = adoptDedupKey(slot);
      const adopted = created.get(key);
      if (adopted) {
        // A singular member must not repeat its captured transfer. Plural members
        // retain their ordinary idempotent join on the duplicate missing arm.
        if (this.transfers.size === 0) {
          steps.push(
            ...this.membershipAddWrites(
              slot.joinId,
              parent,
              adopted,
              known,
              () => this.joinInsert(slot.joinId, parent, adopted)
            )
          );
        }
        continue;
      }
      created.set(key, slot.identity.values);
      if (slot.identity.kind === "literal") {
        this.registerResolvedMembership(
          resolvedTargets,
          resolvedMemberships,
          slot.identity.values
        );
      }
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
    slots: readonly LocatedUpsertSlot[],
    resolvedMemberships?: ResolvedJunctionMembershipRegistry
  ): readonly OperationStep[] {
    const steps: OperationStep[] = [];
    const resolvedTargets =
      this.transfers.size > 0 ? new Map<string, JunctionRowKey[]>() : undefined;
    // Upsert never deduplicates: every item must update the row its own selector names.
    for (const slot of slots) {
      const memberRows = known[planningKey(slot.membershipProbeId, "rows")];
      const [capturedMember] = Array.isArray(memberRows)
        ? this.capturedRowKeys(memberRows.slice(0, 1))
        : [];
      if (capturedMember !== undefined) {
        let memberPk = capturedMember;
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
          const compiler = slot.update.compiler;
          steps.push(...compiler.compile(known));
          memberPk = this.updatedTargetPk(compiler, capturedMember);
        }
        this.registerResolvedMembership(
          resolvedTargets,
          resolvedMemberships,
          memberPk
        );
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
      steps.push(
        ...this.upsertCreateArm(
          scope,
          slot,
          parent,
          known,
          resolvedTargets,
          resolvedMemberships
        )
      );
    }
    return steps;
  }

  /** A fresh parent has no members: global found means adopt-and-update; missing
   * means create-and-adopt. Both branches add the junction row. */
  private compileFreshUpsert(
    scope: StepScope,
    parent: unknown,
    known: PlanningKnown,
    slots: readonly FreshUpsertSlot[],
    resolvedMemberships?: ResolvedJunctionMembershipRegistry
  ): readonly OperationStep[] {
    const steps: OperationStep[] = [];
    const resolvedTargets =
      this.transfers.size > 0 ? new Map<string, JunctionRowKey[]>() : undefined;
    for (const slot of slots) {
      const globalRows = known[planningKey(slot.globalProbeId, "rows")];
      const [captured] = Array.isArray(globalRows)
        ? this.capturedRowKeys(globalRows.slice(0, 1))
        : [];
      if (captured === undefined) {
        steps.push(
          ...this.upsertCreateArm(
            scope,
            slot,
            parent,
            known,
            resolvedTargets,
            resolvedMemberships
          )
        );
        continue;
      }
      const foundPk = captured;
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
      let joinedPk = foundPk;
      if (slot.update.kind === "global") {
        slot.update.assertLegality();
        const compiler = slot.update.compiler;
        const compiled = compiler.compile(known);
        joinedPk = this.updatedTargetPk(compiler, captured);
        steps.push(...compiled);
      }
      this.registerResolvedMembership(
        resolvedTargets,
        resolvedMemberships,
        joinedPk
      );
      steps.push(
        ...this.membershipAddWrites(slot.joinId, parent, joinedPk, known, () =>
          this.joinInsert(slot.joinId, parent, joinedPk)
        )
      );
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
    known: PlanningKnown,
    resolvedTargets: Map<string, JunctionRowKey[]> | undefined,
    resolvedMemberships: ResolvedJunctionMembershipRegistry | undefined
  ): readonly OperationStep[] {
    if (slot.identity.kind === "literal") {
      this.registerResolvedMembership(
        resolvedTargets,
        resolvedMemberships,
        slot.identity.values
      );
    }
    return this.compileFreshTarget(scope, known, parent, slot, slot.where);
  }

  private updatedTargetPk(
    compiler: RecordUpdateCompiler,
    captured: Readonly<Record<string, unknown>>
  ): JunctionRowKey {
    return Object.fromEntries(
      this.targetProjection.identityFields.map((field) => [
        field,
        compiler.updatedFieldValue(field, captured),
      ])
    );
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
            this.buildCreateSlot(scope, target, false, false)
          ),
        };
      case "createMany":
        return {
          kind: "createMany",
          slots: input.targets.map((item) =>
            this.buildCreateSlot(
              scope,
              item.target,
              input.skipDuplicates,
              item.joinWhenTargetExists
            )
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
    // A slot whose deeper edges `planned`-read this probe must publish the
    // captured target primary key as a `firstRowField`, and — because that extraction
    // is eager and would otherwise abort with an internal wording — carry this
    // family's own not-a-member message as the read's postcondition. Byte-identical to
    // `requireTarget`'s compile-time throw, moved one phase earlier (still before any
    // write, on both substrates).
    const probe: ReadStep = {
      id: probeId,
      kind: "read",
      model: getStepModelName(this.childScope.model, "record"),
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
                relationTargetNotFound(this.relationRef, "update"),
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
        model: getStepModelName(this.childScope.model, "record"),
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
    skipDuplicates: boolean,
    joinWhenTargetExists: boolean
  ): CreateSlot {
    const childId = scope.allocate(`${this.childName}.create`);
    return {
      target,
      identity: this.resolveTargetIdentity(target, childId),
      childId,
      joinId: scope.allocate(`${this.childName}.junction.insert`),
      skipDuplicates,
      joinWhenTargetExists,
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
      identity: this.resolveTargetIdentity(item.target, childId),
      probeId,
      guardId: scope.allocate(`${this.childName}.guard.exists`),
      childId,
      joinId: scope.allocate(`${this.childName}.junction.insert`),
      probe: {
        id: probeId,
        kind: "read",
        model: getStepModelName(this.childScope.model, "record"),
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
      identity: this.resolveTargetIdentity(item.target, childId),
      globalProbeId: item.probes.global,
      guardId: scope.allocate(`${this.childName}.guard.member`),
      childId,
      joinId: scope.allocate(`${this.childName}.junction.insert`),
      update: item.update,
      globalProbe: {
        id: item.probes.global,
        kind: "read",
        model: getStepModelName(this.childScope.model, "record"),
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
        model: getStepModelName(this.childScope.model, "record"),
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
  // Leaf builders — junction (V1's ManyToManyStatements, now JunctionStatements)
  // and child (V2 ops).
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
      readonly joinWhenTargetExists?: boolean;
    },
    where: Record<string, unknown> | undefined,
    membershipMode: JunctionInsertMaterializationMode = "default"
  ): readonly OperationStep[] {
    if (slot.target.kind === "record") {
      return [
        ...slot.target.record.compile(scope, known),
        ...this.membershipAddWrites(
          slot.joinId,
          parent,
          slot.identity.values,
          known,
          () =>
            this.joinInsert(
              slot.joinId,
              parent,
              slot.identity.values,
              membershipMode === "exactMembershipNoop",
              membershipMode
            ),
          membershipMode
        ),
      ];
    }
    const steps: OperationStep[] = [
      this.childInsert(
        slot.childId,
        slot.target.data,
        where,
        slot.identity.kind === "produced"
          ? slot.identity.generatedField
          : undefined,
        slot.skipDuplicates === true
      ),
      ...this.membershipAddWrites(
        slot.joinId,
        parent,
        slot.identity.values,
        known,
        () =>
          this.joinInsert(
            slot.joinId,
            parent,
            slot.identity.values,
            slot.joinWhenTargetExists === true ||
              membershipMode === "exactMembershipNoop",
            membershipMode
          ),
        membershipMode
      ),
    ];
    for (const descendant of slot.target.descendants) {
      steps.push(...descendant.compile(scope, known));
    }
    return steps;
  }

  private resolveTargetIdentity(
    target: PreparedFreshTarget,
    childId: string
  ): JunctionIdentity {
    return target.kind === "record"
      ? target.identity
      : this.resolveCreatePk(target.data, childId);
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
    return this.statements.materialize(
      this.context.relation,
      "membershipRead",
      {
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
        ...(args.take === undefined ? {} : { take: args.take }),
        lock: "transaction",
      }
    );
  }

  private junctionWrite(
    id: string,
    operation: JunctionOperation,
    args: Record<string, unknown>
  ): WriteStep {
    return {
      id,
      kind: "write",
      statement: this.statements.materialize(
        this.context.relation,
        operation,
        args
      ),
      outputs: {},
    };
  }

  /**
   * Connect and set already own an exact ordered list of complete target keys,
   * so their duplicate-skipping junction INSERT is semantically splittable.
   * Every chunk stays in the operation's existing transaction/native batch;
   * an under-budget statement keeps its historical SQL and step id.
   */
  private junctionInsertManyWrites(
    parentValue: unknown,
    targetValues: readonly JunctionRowKey[],
    idForChunk: (start: number, index: number) => string
  ): WriteStep[] {
    const chunks = compileBindBudgetChunks(
      targetValues.length,
      this.context.engine.maxBindParametersPerStatement,
      (start, end) =>
        this.statements.materialize(
          this.context.relation,
          "junctionInsertMany",
          {
            parentValue,
            targetValues: targetValues.slice(start, end),
          }
        )
    );
    return chunks.map((chunk, index) => ({
      id: idForChunk(chunk.start, index),
      kind: "write",
      statement: chunk.statement,
      outputs: {},
    }));
  }

  /** The idempotent join-row insert (junction-PK skip) for a target PK. */
  private joinInsert(
    id: string,
    parent: unknown,
    targetValue: unknown,
    joinWhenTargetExists = false,
    mode: JunctionInsertMaterializationMode = "default"
  ): WriteStep {
    const insert = this.statements.materializeJunctionInsert(
      this.context.relation,
      {
        parentValue: parent,
        targetValue,
        ...(joinWhenTargetExists ? { joinWhenTargetExists: true } : {}),
      },
      mode
    );
    return {
      id,
      kind: "write",
      statement: insert.statement,
      outputs: {},
      ...(insert.racePin ? { racePin: insert.racePin } : {}),
    };
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
    const capturesByReturning =
      this.context.engine.adapter.capabilities.supportsReturning &&
      (this.context.txMode ||
        !getAdapterInternals(this.context.engine.adapter).batchRefs
          .storeLastInsertId);
    // The adapter owns SQL duplicate skipping; MySQL uses the executor's recoverable
    // unique-conflict effect.
    const recoverUnique =
      skipDuplicates &&
      this.context.engine.adapter.mutations.skipDuplicatesStrategy ===
        "recoverableUniqueError";
    let statement: Sql;
    if (skipDuplicates) {
      statement = buildCreateMany(this.childScope, [create], true);
    } else if (generatedField && capturesByReturning) {
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
      model: getStepModelName(this.childScope.model, "record"),
      statement,
      outputs: generatedField
        ? {
            id: capturesByReturning
              ? { kind: "firstRowField", field: generatedField }
              : { kind: "insertId" },
          }
        : {},
      ...(generatedField
        ? {
            progressiveContinuation: completeTargetPresenceGuard(
              this.childScope,
              `${id}.continuation`,
              {
                [generatedField]: referenceSql(
                  this.context.engine,
                  this.childScope.model,
                  generatedField,
                  ref(id, "id")
                ),
              },
              queryFailure(
                `Created junction target '${getStepModelName(this.childScope.model, "record")}' changed across a generated-output segment boundary.`
              )
            ),
          }
        : {}),
      ...(recoverUnique ? { onUniqueConflict: "skip" as const } : {}),
    };
    const race = where ? createRacePin(this.childScope, where) : undefined;
    return race && createDataSpellsRacePin(create, race)
      ? { ...step, racePin: race.pin }
      : step;
  }

  /** Resolve a literal key or bind the join to this INSERT's generated identity.
   *
   *  This leaf never sees a SKIPPABLE generated key any more. A skipped INSERT
   *  produces no identity its join row could reference, so `routeJunctionCreateManyRow`
   *  routes that member away from the leaf BEFORE a slot is built: to the adopt
   *  family when one complete unique names the skipped-on row, to the vacuous drop
   *  when nothing can conflict, and otherwise to the suppression series where the
   *  target subtree and its join are one root-isolated member. What is left here
   *  is a literal key, or a generated key whose INSERT always runs. */
  private resolveCreatePk(
    create: Record<string, unknown>,
    childId: string
  ): JunctionIdentity {
    const values: Record<string, unknown> = {};
    let missingMember: string | undefined;
    for (const member of this.targetSide.members) {
      const value = create[member.referencedField];
      if (value === undefined || value === null) {
        missingMember = member.referencedField;
        break;
      }
      values[member.referencedField] = value;
    }
    if (!missingMember) return { kind: "literal", values };
    if (this.targetSide.members.length !== 1) {
      throw new QueryEngineError(
        "query-engine-v2 internal: a compound create-through-junction target reached the inline identity leaf without complete row-key values."
      );
    }
    const scalar = this.childScope.model["~"].state.scalars[missingMember];
    if (scalar?.["~"].state.autoGenerate?.kind === "increment") {
      return {
        kind: "produced",
        values: {
          [missingMember]: referenceSql(
            this.context.engine,
            this.childScope.model,
            missingMember,
            ref(childId, "id")
          ),
        },
        generatedField: missingMember,
      };
    }
    throw new QueryEngineError(
      `query-engine-v2 internal: the create-through-junction arm for relation '${this.relationName}' reached identity resolution with no value for the target primary key '${missingMember}'.`
    );
  }

  /** The adopt family's found premise (batch): the adopted target still exists AND
   *  the captured PK still matches the selector (split-witness correlation — a
   *  concurrent move of the selector onto a replacement leaves no such row, so the
   *  join never links the replacement). Existing-row premise, raceable:false.
   *
   *  The fresh-parent `upsert` takes the same premise through the same
   *  construction site, worded for ITS operation: the two members of the adopt family
   *  say `Record was replaced … during nested connectOrCreate` and `… nested upsert`,
   *  and one site keeps them from drifting. */
  private adoptFoundGuard(
    slot: { readonly guardId: string; readonly where: Record<string, unknown> },
    capturedPk: JunctionRowKey,
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
    capturedPk: JunctionRowKey,
    capturedColumns?: Sql
  ) {
    return buildFind(
      this.childScope,
      {
        where: capturedSelectorWhere(this.childScope, where, capturedPk),
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
    capturedPk: JunctionRowKey,
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
          where: this.targetIdentityFilter(capturedPk),
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

  private childDelete(id: string, targetPk: JunctionRowKey): WriteStep {
    return {
      id,
      kind: "write",
      model: getStepModelName(this.childScope.model, "record"),
      statement: buildDelete(this.childScope, {
        where: capturedTargetWhere(
          this.childScope.model,
          this.targetProjection,
          targetPk
        ),
      }),
      outputs: {},
    };
  }

  private childDeleteMany(
    id: string,
    targetPks: readonly JunctionRowKey[]
  ): WriteStep {
    return {
      id,
      kind: "write",
      model: getStepModelName(this.childScope.model, "record"),
      statement: buildDeleteMany(this.childScope, {
        where: this.targetKeysFilter(targetPks),
      }),
      outputs: {},
    };
  }

  private differenceGuard(
    bulk: BulkSlot,
    parent: unknown,
    targetPks: readonly JunctionRowKey[],
    difference: "added" | "removed"
  ): GuardStep {
    return {
      id: difference === "added" ? bulk.addedGuardId : bulk.removedGuardId,
      kind: "guard",
      premise: {
        kind: "notExists",
        statement: this.statements.materialize(
          this.context.relation,
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
    capturedPk: JunctionRowKey
  ): GuardStep {
    return presenceGuard(
      target.guardId,
      // Split-witness correlation: the captured target must still match the
      // selector, so `set`/`connect` cannot adopt a replacement that inherited it.
      this.capturedSelectorRead(target.where, capturedPk),
      nestedWriteFailure(
        relationTargetNotFound(this.relationRef, op),
        this.relationName,
        false
      )
    );
  }

  private connectedPresenceGuard(
    target: TargetSlot,
    parent: unknown,
    op: "delete" | "update",
    capturedPk: JunctionRowKey,
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
          where: this.targetIdentityFilter(capturedPk),
          ...(capturedColumns ? { predicate: capturedColumns } : {}),
          take: 1,
        }),
      },
      failure: nestedWriteFailure(
        relationTargetNotFound(this.relationRef, op),
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
  ): JunctionRowKey {
    const rows = known[planningKey(target.probeId, "rows")];
    const [captured] = Array.isArray(rows)
      ? this.capturedRowKeys(rows.slice(0, 1))
      : [];
    if (captured === undefined) {
      throw new NestedWriteError(
        relationTargetNotFound(this.relationRef, op),
        this.relationName
      );
    }
    return captured;
  }

  private capturedCompilerPredicate(
    compiler: RecordUpdateCompiler,
    probeId: string,
    known: PlanningKnown
  ): Sql | undefined {
    if (compiler.targetReadId !== probeId) return undefined;
    // The row key and private storage columns share one physical probe row. Its
    // exact target projection must cross the descriptor codec before either is
    // re-bound by this progressive guard.
    const rows = known[planningKey(probeId, "rows")];
    const rawCaptured = Array.isArray(rows) ? rows[0] : undefined;
    if (!isRecord(rawCaptured)) return undefined;
    const captured = parseCapturedRows(
      this.context.engine,
      this.childScope.model,
      [rawCaptured],
      targetProjectionSelect(compiler.targetProjection),
      compiler.targetProjection.columns
    )[0];
    if (!captured) return undefined;
    return capturedTargetColumnPredicate(
      this.childScope,
      compiler.targetProjection,
      captured,
      getTableName(this.childScope.model)
    );
  }

  private connectedSet(bulk: BulkSlot, known: PlanningKnown): JunctionRowKey[] {
    const rows = known[planningKey(bulk.readId, "rows")];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 deleteMany for relation '${this.relationName}' did not expose its membership set.`,
        this.relationName
      );
    }
    return [...this.capturedRowKeys(rows)];
  }

  /**
   * The captured membership rows as complete row KEYS.
   *
   * Every one of these values is re-addressed — a junction insert, a
   * `whereUnique`, a row-key token — through the ordinary where/values builder,
   * which lowers a LOGICAL value. A probe publishes the PHYSICAL row instead,
   * and the two disagree wherever a provider stores a scalar in another
   * spelling (a SQLite decimal column answers with its unscaled coefficient), so
   * the decode is what makes the captured member address the row it came from.
   * {@link parseCapturedRowKeys} owns it, and the row-shape refusal with it.
   */
  private capturedRowKeys(rows: readonly unknown[]): readonly JunctionRowKey[] {
    return parseCapturedRowKeys(
      this.context.engine,
      this.childScope.model,
      rows
    );
  }

  private targetIdentityFilter(
    target: JunctionRowKey
  ): Record<string, unknown> {
    return {
      AND: capturedTargetFilters(
        this.childScope.model,
        this.targetProjection,
        target
      ),
    };
  }

  private targetKeysFilter(
    targets: readonly JunctionRowKey[]
  ): Record<string, unknown> {
    return capturedTargetSetWhere(
      this.childScope.model,
      this.targetProjection,
      targets
    );
  }

  /**
   * The parent-id a planning membership read correlates on. A `planned` source
   * refs the not-yet-run locate by a SQL `Ref` (technique #1). A `literal` source
   * — a depth-composed junction under a located-by-PK nested target (T3b mechanism
   * 1) — inlines its compile-time value directly: the correlation is a known
   * constant, so the membership read is `WHERE parentColumn = <literal>`, exactly
   * as the write correlation ({@link parentLiteral}) already does. The membership
   * read's `parentValue` is materialized identically for a `Ref` or a literal
   * (both ride through `JunctionStatements.materialize`), so no leaf learns which.
   *
   * The read source differs from the write source only across a key transition.
   */
  private parentRef(): JunctionRowKey {
    return Object.fromEntries(
      this.membershipMembers().map((member) => [
        member.referencedField,
        foreignKeyCorrelationValue(member),
      ])
    );
  }

  /** The compile-time parent value the junction writes correlate on: a located
   *  (`planned`) row's literal, a compile-time `literal`, or — a FRESH parent
   *  whose PK is DB-generated (create root, `ref` kind) — a backward `Ref` to
   *  the parent INSERT's produced identity, cast at the interpolation site and
   *  riding `Sql.values` exactly as the child-FK path does (materialized by the
   *  executor in tx mode; scratch-threaded insertId in batch mode). */
  private parentLiteral(known: PlanningKnown): JunctionRowKey {
    return Object.fromEntries(
      this.parentWriteMembers().map((member) => [
        member.referencedField,
        foreignKeyWriteValueWith(
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
        ),
      ])
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
   * byte-identical to the no-transition plan.
   */
  private membershipLiteral(known: PlanningKnown): JunctionRowKey {
    return Object.fromEntries(
      this.membershipMembers().map((member) => [
        member.referencedField,
        foreignKeyResolvedReadValue(
          member,
          known,
          this.relationName,
          "junction"
        ),
      ])
    );
  }

  /**
   * PHASE 5 PARTIAL — these two are not a reconstruction of one fact but the LAZY
   * NARROWING BOUNDARY between them: {@link parentLiteral} takes the write member and
   * must not refuse when the read source is un-narrowable, while
   * {@link membershipLiteral} takes the correlated one and must. Collapsing them onto
   * a single member carried by {@link JunctionContext} moves that refusal, which the
   * batch-guard measurement above says is a behaviour change.
   */
  private parentWriteMembers(): readonly ForeignKeyMember[] {
    return this.sourceSide.members.map((member) => ({
      foreignField: member.junctionField,
      referencedField: member.referencedField,
      writeSource: this.parentSource(
        this.context.parentId,
        member.referencedField
      ),
    }));
  }

  private membershipMembers(): readonly CorrelatedForeignKeyMember[] {
    return this.parentWriteMembers().map((member) => ({
      ...member,
      readSource: planningSourceFromFinal(
        this.parentSource(
          this.context.membershipReadSource,
          member.referencedField
        ),
        this.relationName,
        "junction"
      ),
    }));
  }

  private parentSource(
    sources: JunctionReferenceSources,
    field: string
  ): FinalReferenceSource {
    const source = sources[field];
    if (source) return source;
    throw new QueryEngineError(
      `query-engine-v2 internal: junction relation '${this.relationName}' has no parent source for row-key field '${field}'.`
    );
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
  relation: JunctionBoundRelation;
  program: RelationMutationProgram;
  parentId: FinalReferenceSources;
  /** Parent value carried by existing membership rows before a key transition. */
  membershipReadSource: FinalReferenceSources;
  /** A create-root parent has no pre-existing membership. */
  freshParent?: boolean;
  txMode: boolean;
  recordCompilers: RecordCompilerSeam;
  /** Threaded straight onto every Part this fold builds (plan §1.6). Only the
   *  polymorphic collection coordinator ever sets it, and only on the runs it
   *  lowered from `set`. */
  membershipAddMode?: JunctionTransferMode;
  /** T3b-2: the depth-recursive child-Part builder (mechanism 2 / mechanism 1
   *  reuse). REQUIRED — every `buildJunctionParts` caller threads it: the root
   *  (UpdateOperation.ts:977, CreateOperation.ts:653) and depth
   *  (nested-target-parts.ts:164). A relation-carrying create/update/upsert target
   *  folds those relations one level deeper through it; the type makes threading it
   *  mandatory so no caller can silently fall back to a scalar-only boundary. */
  nestedBuilder: JunctionTargetRelationsBuilder;
}): JunctionCompilePart[] {
  const { scope, engine, parentScope, relation, program, parentId, txMode } =
    input;
  const { relationRef } = relation;
  const relationName = relationRef.name;
  const childName = getStepModelName(relationRef.targetModel, relationName);
  const childScope = createQueryScope(engine, relationRef.targetModel);
  const targetFields = relation.membership.target.members.map(
    (member) => member.referencedField
  );
  const base = {
    engine,
    parentScope,
    relation,
    parentId,
    membershipReadSource: input.membershipReadSource,
    txMode,
    recordCompilers: input.recordCompilers,
    ...(input.membershipAddMode
      ? { membershipAddMode: input.membershipAddMode }
      : {}),
  } as const;

  const requiresWholeFreshRecordCompiler = (
    relations: readonly ParsedRelationMutation[]
  ): boolean => {
    const targetPrimaryKeys = getPrimaryKeyFields(childScope.model);
    // A polymorphic COLLECTION arm nested in this target's create data reaches
    // the same verdict as an ordinary junction and reaches it one step earlier
    // (plan §1.2): every entry it carries is `position: "junction"`, which the
    // `continue` below returns on, so it does NOT force the whole-fresh
    // compiler. Its own Parts are built by the coordinator through
    // `nestedBuilder`, which is where that recursion is visible.
    for (const mutation of relationMutationPrograms(relations)) {
      const bound = bindRelation(childScope, mutation.relationRef);
      if (bound.position === "junction") continue;
      if (bound.position === "parentHeld") return true;
      const referenced = membershipReferencedFields(bound.membership);
      const referencesTargetPk =
        targetPrimaryKeys.length === 1 &&
        referenced.length === 1 &&
        referenced[0] === targetPrimaryKeys[0];
      if (!referencesTargetPk) return true;
    }
    return false;
  };
  /** Inline scalar/literal targets keep the junction-local INSERT. A target that
   * needs produced identity propagation or parent-held folding delegates its complete
   * subtree to the fresh-record compiler; a missing-arm pin stays on its root INSERT. */
  const freshTargetFold = (
    create: RecordMutationData,
    foldKind: string,
    racePin?: CreateRacePin,
    forceRecord = false,
    skipDuplicates = false
  ): PreparedFreshTarget => {
    const { scalarData, relations } = buildParsedRelationPrograms(
      childScope,
      create.parsed,
      create.source
    );
    const literalKey: Record<string, unknown> = {};
    let completeLiteralKey = true;
    for (const field of targetFields) {
      const value = create.parsed[field];
      if (value === undefined || value === null) {
        completeLiteralKey = false;
        continue;
      }
      literalKey[field] = value;
    }
    // CREATE-context data: `ToManyCreateSchema` spells no `disconnect`, so this
    // count is the same question it asked of the program map — the collection has
    // no entry here the map did not have.
    if (
      !forceRecord &&
      relations.length === 0 &&
      (targetFields.length === 1 || completeLiteralKey)
    ) {
      return {
        kind: "inline",
        data: scalarData,
        descendants: [],
      };
    }
    if (
      !forceRecord &&
      targetFields.length === 1 &&
      completeLiteralKey &&
      !requiresWholeFreshRecordCompiler(relations)
    ) {
      return {
        kind: "inline",
        data: scalarData,
        descendants: input.nestedBuilder(
          childScope,
          literalParentId(literalKey[targetFields[0]!]),
          relations,
          txMode,
          // A target this statement is INSERTing has no existing membership to read;
          // the value that names it is the key it is being given.
          literalParentId(literalKey[targetFields[0]!])
        ),
      };
    }
    const subtree = input.recordCompilers.createFresh(scope, {
      childScope,
      data: create,
      relationName: "",
      ...(racePin ? { racePin } : {}),
      ...(skipDuplicates ? { skipDuplicates: true } : {}),
    });
    if (completeLiteralKey) {
      return {
        kind: "record",
        record: subtree,
        identity: { kind: "literal", values: literalKey },
      };
    }
    const published = subtree.rootRowKey();
    let hasGeneratedIdentity = false;
    const values: Record<string, unknown> = {};
    for (const field of targetFields) {
      const source = published[field];
      if (!source) {
        throw new QueryEngineError(
          `query-engine-v2 internal: create-through-junction for relation '${relationName}' resolved no primary key '${field}' from the target subtree (${foldKind}).`
        );
      }
      values[field] = foreignKeyWriteValueWith(
        {
          foreignField: field,
          referencedField: field,
          writeSource: source,
        },
        undefined,
        relationName,
        "create-through-junction",
        (reference) => {
          hasGeneratedIdentity = true;
          return referenceSql(engine, childScope.model, field, reference);
        }
      );
    }
    return {
      kind: "record",
      record: subtree,
      identity: hasGeneratedIdentity
        ? { kind: "produced", values }
        : { kind: "literal", values },
    };
  };
  const parts: JunctionCompilePart[] = [];
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
          const parsed = buildParsedRelationPrograms(
            childScope,
            item.data.parsed,
            item.data.source
          );
          assertPortablePrimaryKeyUpdateInput(childScope.model, "update", {
            data: parsed.scalarData,
          });
          assertRelationKeyUpdatesAreCompilable(
            childScope,
            parsed.scalarData,
            parsed.relations
          );
          const compiler = input.recordCompilers.updateSelected({
            scope,
            engine,
            targetScope: childScope,
            scalarData: parsed.scalarData,
            relations: parsed.relations,
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
            items: entry.items.map((item): JunctionUpdateManyItem => {
              const parsed = buildParsedRelationPrograms(
                childScope,
                item.data.parsed,
                item.data.source
              );
              return parsed.relations.length > 0
                ? {
                    where: item.where ?? {},
                    route: "series",
                    data: item.data,
                  }
                : {
                    where: item.where ?? {},
                    route: "scalar",
                    data: parsed.scalarData,
                  };
            }),
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
          const routed = rows.map((row) =>
            routeJunctionCreateManyRow(
              childScope,
              targetFields,
              row,
              skipDuplicates
            )
          );
          const runs = contiguousJunctionCreateManyRuns(routed);
          const routedParts: JunctionCompilePart[] = [];
          for (const run of runs) {
            if (run.kind === "leaf") {
              routedParts.push(
                new RelationJunctionPart(scope, {
                  ...base,
                  kind: "createMany",
                  skipDuplicates: run.withSkip,
                  targets: run.rows.map((routedRow) => ({
                    target: freshTargetFold(routedRow.row, "create"),
                    joinWhenTargetExists: routedRow.joinWhenTargetExists,
                  })),
                })
              );
              continue;
            }
            if (run.kind === "adopt") {
              const armed = run.rows.map((routedRow) =>
                freshTargetFold(
                  routedRow.row,
                  "create",
                  createRacePin(childScope, routedRow.where)
                )
              );
              routedParts.push(
                new RelationJunctionPart(scope, {
                  ...base,
                  kind: "connectOrCreate",
                  items: run.rows.map((routedRow, index) => ({
                    where: routedRow.where,
                    target: armed[index]!,
                  })),
                })
              );
              continue;
            }
            const targets = run.rows.map((routedRow) =>
              freshTargetFold(
                routedRow.row,
                "createMany",
                undefined,
                true,
                routedRow.withSkip
              )
            );
            const records = targets.map((target) => {
              if (target.kind !== "record") {
                throw new QueryEngineError(
                  `query-engine-v2 internal: relation-bearing createMany for junction '${relationName}' did not delegate its target record.`
                );
              }
              return target.record;
            });
            const members = targets.map(
              (target) =>
                new RelationJunctionPart(scope, {
                  ...base,
                  kind: "create",
                  targets: [target],
                })
            );
            routedParts.push(
              buildJunctionCreateManySeriesPart({
                scope,
                engine,
                parentScope,
                relation,
                parentId,
                childName,
                txMode,
                members,
                records,
                droppingFlagHelps: run.droppingFlagHelps,
              })
            );
          }
          parts.push(
            orderedJunctionCreateManyParts({
              scope,
              engine,
              parentScope,
              relation,
              parentId,
              childName,
              txMode,
              sequentialPlanning: junctionRunsNeedSequentialPlanning(runs),
              parts: routedParts,
            })
          );
        }
        break;
      }
      case "connectOrCreate": {
        // The create arm folds its own relations one level deeper against its
        // literal PK (mechanism 2); the slot emits them on the create branch only.
        const items = entry.items;
        const armed = items.map((item) =>
          // The arm's missing-premise pin rides the delegated subtree's root
          // INSERT when the whole create is delegated.
          freshTargetFold(
            item.create,
            "connectOrCreate",
            createRacePin(childScope, item.where)
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
            createRacePin(childScope, item.where)
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
          const parsed = buildParsedRelationPrograms(
            childScope,
            item.update.parsed,
            item.update.source
          );
          const pinnedTarget = pinnedTargetValues(childScope, item.where);
          const hasUpdate =
            Object.keys(parsed.scalarData).length + parsed.relations.length > 0;
          const compiler = hasUpdate
            ? input.recordCompilers.updateSelected({
                scope,
                engine,
                targetScope: childScope,
                scalarData: parsed.scalarData,
                relations: parsed.relations,
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
    }
  }
  return parts;
}

/** A junction createMany member is one complete target subtree followed by its own
 * join. The wrapper places those ordinary junction Parts left-to-right and carries
 * only the delegated target root's skip disposition. Progressive execution isolates
 * a root that may skip, observes that root before dispatching descendants, and never
 * guesses which statement in a larger failed unit conflicted. */
function buildJunctionCreateManySeriesPart(input: {
  readonly scope: StepScope;
  readonly engine: QueryEngine;
  readonly parentScope: QueryScope;
  readonly relation: JunctionBoundRelation;
  readonly parentId: FinalReferenceSources;
  readonly childName: string;
  readonly txMode: boolean;
  readonly members: readonly RelationJunctionPart[];
  readonly records: readonly FreshRecordPart[];
  /** Dropping the flag removes suppression. A relation-bearing series remains,
   * but native atomic batch segments can run it. */
  readonly droppingFlagHelps: boolean;
}): JunctionCompilePart {
  const stepId = input.scope.allocate(`${input.childName}.createManySeries`);
  return {
    planning: () => [],
    compile: (scope, enclosingKnown) => [
      {
        id: stepId,
        kind: "recordSeries",
        progressive: progressiveJunctionParentGuard({
          engine: input.engine,
          parentScope: input.parentScope,
          relation: input.relation,
          source: input.parentId,
          known: enclosingKnown,
          operation: "createMany",
          stepId,
        }),
        series: junctionCreateManySeries(
          input.members,
          input.records,
          scope,
          enclosingKnown,
          input.txMode ? "transaction" : "batch"
        ),
      },
    ],
  };
}

export function progressiveJunctionParentGuard(input: {
  readonly engine: QueryEngine;
  readonly parentScope: QueryScope;
  readonly member?: {
    readonly scope: QueryScope;
    readonly data: RecordMutationData;
  };
  readonly relation: JunctionBoundRelation;
  readonly source: FinalReferenceSources;
  readonly known: PlanningKnown;
  readonly operation: "createMany" | "updateMany";
  readonly stepId: string;
}): RecordSeriesStep["progressive"] {
  if (
    input.engine.driver.supportsTransactions ||
    !input.engine.driver.supportsBatch
  ) {
    return {
      kind: "unsupported",
      reason: "this execution substrate does not use progressive commits",
    };
  }
  const relationName = input.relation.relationRef.name;
  const identity = resolveFinalReferenceRowKey(
    input.parentScope.model,
    input.relation.membership.source.members.map((member) => {
      const source = input.source[member.referencedField];
      if (!source) {
        throw new QueryEngineError(
          `query-engine-v2 internal: junction relation '${relationName}' has no progressive source for row-key field '${member.referencedField}'.`
        );
      }
      return { field: member.referencedField, source };
    }),
    input.known,
    relationName,
    input.operation
  );
  if (!identity) {
    return {
      kind: "unsupported",
      reason: `junction ${input.operation} on relation '${relationName}' cannot re-pin the complete parent row key`,
    };
  }
  return {
    kind: "guarded",
    guard: completeTargetPresenceGuard(
      input.parentScope,
      `${input.stepId}.parent`,
      identity,
      nestedWriteFailure(
        `Cannot ${input.operation === "createMany" ? "create" : "update"} relation '${relationName}': parent record changed across a committed segment.`,
        relationName
      )
    ),
  };
}

interface JunctionCreateManySeriesMember extends ExecutableOperation {
  readonly seriesRootConflict:
    | { readonly kind: "skipDuplicate"; readonly rootWriteId: string }
    | undefined;
}

function junctionCreateManySeries(
  parts: readonly RelationJunctionPart[],
  records: readonly FreshRecordPart[],
  scope: StepScope,
  enclosingKnown: PlanningKnown,
  mode: ExecutableOperation["mode"]
): RecordSeriesOperation {
  return {
    executionKind: "recordSeries",
    capture: (): PlanningFragment => ({ steps: [] }),
    compileMembers: () =>
      parts.map((part, index): JunctionCreateManySeriesMember => {
        const record = records[index]!;
        return {
          mode,
          planning: (): PlanningFragment => ({
            steps: part.planning(scope),
          }),
          compile: (memberKnown): OperationFragment => ({
            steps: part.compile(scope, {
              ...enclosingKnown,
              ...memberKnown,
            }),
            outputs: {},
          }),
          parse: <T>(): T => undefined as T,
          get seriesRootConflict() {
            return record.seriesRootConflict;
          },
        };
      }),
    compileResultReads: () => [],
    parseSeries: () => undefined,
  };
}

type JunctionCreateManyRun =
  | {
      readonly kind: "leaf";
      readonly withSkip: boolean;
      readonly rows: Extract<JunctionCreateManyRowRoute, { kind: "leaf" }>[];
    }
  | {
      readonly kind: "adopt";
      readonly relationBearing: boolean;
      readonly rows: Extract<JunctionCreateManyRowRoute, { kind: "adopt" }>[];
    }
  | {
      readonly kind: "series";
      readonly withSkip: boolean;
      readonly droppingFlagHelps: boolean;
      readonly rows: Extract<JunctionCreateManyRowRoute, { kind: "series" }>[];
    };

function contiguousJunctionCreateManyRuns(
  rows: readonly JunctionCreateManyRowRoute[]
): JunctionCreateManyRun[] {
  const runs: JunctionCreateManyRun[] = [];
  for (const row of rows) {
    const previous = runs.at(-1);
    if (
      row.kind === "leaf" &&
      previous?.kind === "leaf" &&
      previous.withSkip === row.withSkip
    ) {
      previous.rows.push(row);
      continue;
    }
    if (
      row.kind === "adopt" &&
      !row.relationBearing &&
      previous?.kind === "adopt" &&
      !previous.relationBearing
    ) {
      previous.rows.push(row);
      continue;
    }
    if (
      row.kind === "series" &&
      previous?.kind === "series" &&
      previous.withSkip === row.withSkip &&
      previous.droppingFlagHelps === row.droppingFlagHelps
    ) {
      previous.rows.push(row);
      continue;
    }
    if (row.kind === "leaf") {
      runs.push({ kind: "leaf", withSkip: row.withSkip, rows: [row] });
    } else if (row.kind === "adopt") {
      runs.push({
        kind: "adopt",
        relationBearing: row.relationBearing,
        rows: [row],
      });
    } else {
      runs.push({
        kind: "series",
        withSkip: row.withSkip,
        droppingFlagHelps: row.droppingFlagHelps,
        rows: [row],
      });
    }
  }
  return runs;
}

function orderedJunctionCreateManyParts(input: {
  readonly scope: StepScope;
  readonly engine: QueryEngine;
  readonly parentScope: QueryScope;
  readonly relation: JunctionBoundRelation;
  readonly parentId: FinalReferenceSources;
  readonly childName: string;
  readonly txMode: boolean;
  readonly sequentialPlanning: boolean;
  readonly parts: readonly JunctionCompilePart[];
}): JunctionCompilePart {
  const [only] = input.parts;
  if (input.parts.length === 1 && only) return only;
  if (!input.sequentialPlanning) {
    return {
      planning: (scope) => input.parts.flatMap((part) => part.planning(scope)),
      compile: (scope, known, sharedAdoptCreated, resolvedMemberships) => {
        const sharedCreated =
          sharedAdoptCreated ?? createSharedAdoptCreatedRegistry();
        const memberships =
          resolvedMemberships ?? createResolvedJunctionMembershipRegistry();
        return input.parts.flatMap((part) =>
          part.compile(scope, known, sharedCreated, memberships)
        );
      },
    };
  }
  const stepId = input.scope.allocate(`${input.childName}.createManyRuns`);
  return {
    planning: () => [],
    compile: (scope, known) => [
      {
        id: stepId,
        kind: "recordSeries",
        progressive: progressiveJunctionParentGuard({
          engine: input.engine,
          parentScope: input.parentScope,
          relation: input.relation,
          source: input.parentId,
          known,
          operation: "createMany",
          stepId,
        }),
        series: orderedJunctionCreateManyRuns(
          input.parts,
          scope,
          known,
          input.txMode ? "transaction" : "batch"
        ),
      },
    ],
  };
}

function junctionRunsNeedSequentialPlanning(
  runs: readonly JunctionCreateManyRun[]
): boolean {
  let hasPredecessor = false;
  let hasDynamicPredecessor = false;
  for (const run of runs) {
    if (
      run.kind === "adopt" &&
      hasPredecessor &&
      (run.relationBearing || hasDynamicPredecessor)
    ) {
      return true;
    }
    hasPredecessor = true;
    if (run.kind !== "adopt" || run.relationBearing) {
      hasDynamicPredecessor = true;
    }
  }
  return false;
}

/** Maximal route runs keep their bulk shape, while the existing record-series
 * execution form makes each later run plan after all predecessor effects. */
function orderedJunctionCreateManyRuns(
  parts: readonly Part[],
  scope: StepScope,
  enclosingKnown: PlanningKnown,
  mode: ExecutableOperation["mode"]
): RecordSeriesOperation {
  return {
    executionKind: "recordSeries",
    capture: (): PlanningFragment => ({ steps: [] }),
    compileMembers: () => {
      const sharedAdoptCreated = createSharedAdoptCreatedRegistry();
      return parts.map(
        (part): ExecutableOperation => ({
          mode,
          planning: (): PlanningFragment => ({ steps: part.planning(scope) }),
          compile: (memberKnown): OperationFragment => ({
            steps:
              part instanceof RelationJunctionPart
                ? part.compile(
                    scope,
                    {
                      ...enclosingKnown,
                      ...memberKnown,
                    },
                    sharedAdoptCreated
                  )
                : part.compile(scope, {
                    ...enclosingKnown,
                    ...memberKnown,
                  }),
            outputs: {},
          }),
          parse: <T>(): T => undefined as T,
        })
      );
    },
    compileResultReads: () => [],
    parseSeries: () => undefined,
  };
}

/** Literal identities key directly; produced identities key by their selector. */
function adoptDedupKey(slot: {
  readonly where: Record<string, unknown>;
  readonly identity: JunctionIdentity;
}): string {
  return slot.identity.kind === "literal"
    ? `pk:${stableKey(slot.identity.values)}`
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
