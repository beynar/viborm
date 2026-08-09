// biome-ignore-all lint/style/useFilenamingConvention: RecordUpdateCompiler is the architecture name.
import { NestedWriteError, QueryEngineError } from "@errors";
import type { PolymorphicStorageColumn } from "@schema/relation";
import { isSql, type Sql } from "@sql";
import type { ToOneUpdateTarget } from "@validation/relations/to-one-update-form";
import {
  buildPrimaryKeyWhereUnique,
  getPrimaryKeyFields,
} from "../builders/correlation-utils";
import type {
  PolymorphicStorageValue,
  ResolvedPolymorphicMutation,
} from "../builders/polymorphic-mutation";
import {
  type BoundPolymorphicChildHeldRelation,
  bindRelation,
  buildConnectSubqueryForField,
  type ChildHeldToMany,
  type ChildHeldToOne,
  type ParentHeldToOne,
  type PolymorphicChildHeldToMany,
  type PolymorphicChildHeldToOne,
} from "../builders/relation-data-builder";
import type {
  NormalizedRelationUpsert,
  RelationMutationEntry,
  RelationMutationProgram,
} from "../builders/relation-mutation-parser";
import { buildParsedRelationPrograms } from "../builders/relation-mutation-parser";
import { createQueryScope, getTableName } from "../context/query-scope";
import {
  buildDeleteMany,
  buildFind,
  buildFindUnique,
  buildUpdate,
} from "../operations";
import {
  assertPortablePrimaryKeyUpdateInput,
  getUpdatedPrimaryKeyValue,
  getUpdatedPrimaryKeyWhere,
} from "../operations/mutation-identity";
import type { QueryEngine } from "../query-engine";
import {
  assertPinnedTransitionIsCompilable,
  assertRelationKeyUpdatesAreCompilable,
  assertSelectedUpdateManyDataIsScalar,
} from "../relation-key-legality";
import { classifyRelationKeyScalarUpdate } from "../TargetConstraint";
import type {
  QueryScope,
  RelationInfo,
  ResolvedPolymorphicEdge,
} from "../types";
import type { FreshRecordBuilder, FreshRecordPart } from "./CreateOperation";
import {
  absenceGuard,
  affectedRows,
  childRacePin,
  exactlyOneRow,
  nestedWriteFailure,
  notFoundFailure,
  presenceGuard,
  referenceScalarSql,
  referenceSql,
} from "./fragment-builders";
import {
  lookupKeyIsNull,
  nestedReplacement,
  relationKeyOccupiedMessage,
  relationTargetNotFound,
  upsertPremiseChanged,
} from "./messages";
import {
  buildJunctionTargetRelationParts,
  buildLiteralParentCreateManyPart,
  buildPlannedParentCreateManyPart,
  buildPolymorphicParentCreateManyPart,
} from "./nested-target-parts";
import {
  bucketOperationSteps,
  type Failure,
  type OperationStep,
  type ReadStep,
  ref,
  type StatementStep,
  type TargetConstraintPin,
  type WriteStep,
} from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { conditionalArmPlanning, planningKey } from "./Part";
import { buildJunctionParts } from "./RelationJunctionPart";
import { buildToManyLinkParts } from "./RelationLinkPart";
import {
  buildConnectOrCreateParts,
  buildCorrelatedToManyUpsertParts,
} from "./RelationUpsertPart";
import {
  buildInverseToOneUpsertPart,
  buildToManyDeleteManyParts,
  buildToManyDeleteParts,
  buildToManySetPart,
  buildToManyUpdateManyParts,
  buildToManyUpdateParts,
  buildToOneUpdatePart,
  updateManyCarriesRelations,
} from "./RelationWritePart";
import {
  bindCorrelatedRelationMembership,
  bindRelationMembership,
  type FinalReferenceSource,
  type ForeignKeyMember,
  foreignKeyCorrelationValue,
  foreignKeyWriteValue,
  linkedPolymorphicStorage,
  literalParentId,
  literalReferenceSource,
  lowerMembershipWrite,
  pairCorrelatedForeignKeyMembers,
  pairForeignKeyMembers,
  plannedParentId,
  planningSourceFromFinal,
  type RelationMembershipBinding,
  resolvePolymorphicStorageValue,
  transitionedParentId,
} from "./relation-membership";
import { assertRelationCanDisconnect } from "./relation-nullability";
import type { StepScope } from "./StepScope";
import {
  capturedSelectorWhere,
  getStepModelName,
  isRecord,
  sameScalarValue,
  selectExecutionMode,
  UnsupportedOperationError,
} from "./shared";
import {
  buildTargetProjection,
  capturedTargetColumnPredicate,
  type TargetProjection,
  targetProjectionColumns,
  targetProjectionOutputs,
} from "./target-projection";

type ExecutionMode = "transaction" | "batch";
type ChildHeldRelation =
  | OrdinaryChildHeldRelation
  | PolymorphicChildHeldToOne
  | PolymorphicChildHeldToMany;
type OrdinaryChildHeldRelation = ChildHeldToOne | ChildHeldToMany;

export interface RecordUpdateCompiler {
  readonly targetReadId: string;
  readonly writeId: string;
  readonly targetProjection: TargetProjection;
  planning(): readonly StatementStep[];
  compile(known: PlanningKnown): readonly OperationStep[];
  updatedPrimaryKeyWhere(
    locatedRow: Record<string, unknown>
  ): Record<string, unknown>;
}

export type StepAddress = { readonly id: string } | { readonly label: string };

export interface RecordUpdateCompilerInput {
  readonly scope: StepScope;
  readonly engine: QueryEngine;
  readonly targetScope: QueryScope;
  readonly scalarData: Record<string, unknown>;
  readonly relations: Readonly<Record<string, RelationMutationProgram>>;
  readonly polymorphic?: Readonly<Record<string, ResolvedPolymorphicMutation>>;
  readonly targetRead: StepAddress;
  readonly rootWrite: StepAddress;
  readonly incomingMembership?: RelationMembershipBinding;
  readonly relationName: string;
  /** Returning-driver affected-row failure for this selected root write. */
  readonly rootWriteFailure?: Failure;
  /** Construction-known discriminator values only; never the selector itself. */
  readonly pinnedTarget?: Readonly<Record<string, unknown>>;
}

export interface RecordCompilerSeam {
  readonly createFresh: FreshRecordBuilder;
  readonly updateSelected: (
    input: RecordUpdateCompilerInput
  ) => RecordUpdateCompiler | undefined;
}

export function buildRecordUpdateCompiler(
  input: RecordUpdateCompilerInput,
  createFresh: FreshRecordBuilder
): RecordUpdateCompiler | undefined {
  if (
    Object.keys(input.scalarData).length === 0 &&
    Object.keys(input.relations).length === 0 &&
    Object.keys(input.polymorphic ?? {}).length === 0 &&
    input.incomingMembership === undefined
  ) {
    return undefined;
  }
  return new RecordUpdateCompilerState(input, createFresh);
}

function resolveStepAddress(scope: StepScope, address: StepAddress): string {
  return "id" in address ? address.id : scope.allocate(address.label);
}

interface ToOneLink {
  readonly relationInfo: RelationInfo;
  readonly referencedFields: readonly string[];
  /** FK assignment merged into the parent SET clause. */
  readonly assignment: Record<string, unknown>;
  /** Present for `connect`: an existence probe + its batch guard id. `fk`/`where`
   *  carry the edge and the selector the fold was built from, which the
   *  compile-time NULL check on a NON-referenced-unique lookup needs
   *  ({@link RecordUpdateCompilerState.assertLookupKeyPresent}, E1 U1). */
  readonly connect?: {
    readonly probeId: string;
    readonly guardId: string;
    readonly probe: ReadStep;
    readonly where: Record<string, unknown>;
    readonly capturedGuardField?: string;
  };
}

/**
 * A nested record created ahead of the root parent UPDATE, whose possibly
 * generated identity the parent's FK column
 * references. It is the arity-1 `create` payload of the parent-held direction, with
 * the parent INSERT replaced by the parent UPDATE.
 *
 * E1 U3 — the target is a create SUBTREE, not one INSERT: a whole
 * {@link FreshRecordPart} in its `nestedFresh` mode (the X1b/N4-U2 seam), so the
 * target's own relations at any depth fall out of the create root unchanged. The
 * identity flows the OTHER way here than it does for a nested fresh arm — the
 * enclosing UPDATE's SET reads the SUBTREE ROOT's key — and the subtree exports it
 * through {@link FreshRecordPart.rootReferenced}, the same resolution the
 * create root already spends for a before-parent target.
 *
 * The subtree PLANS unconditionally (technique 2 — the superset) and COMPILES only
 * in the arm that is taken: `buildBeforeTarget` serves three arms and two of them
 * choose at compile, so an unconditional compile would write an orphan row for an
 * arm nobody took.
 */
interface BeforeTarget {
  readonly subtree: FreshRecordPart;
}

/**
 * A parent-held-FK to-one arm under update whose target is written before the
 * root parent UPDATE and referenced by it. Unlike the
 * create-root fold (which lands in the record's own INSERT), the FK here is set by
 * the root parent UPDATE, so the target write is emitted first and its identity
 * flows backward into the UPDATE's SET. `connect`/`disconnect` stay in
 * {@link ToOneLink} (their FK literal is known at construction).
 *
 * - `create` — unconditional before-root INSERT; FK ← `ref(target.create, id)` (or
 *   a known literal). No pin (a unique violation is a genuine error).
 * - `connectOrCreate` — a global probe decides at compile: found → FK ← the where's
 *   referenced literal + a batch `exists` guard (`raceable: false`); missing →
 *   before-root INSERT (constraint + `racePin`, Pin Rule class 2) + FK ← `ref`.
 */
type ParentHeldTarget =
  | {
      readonly kind: "create";
      readonly relation: ParentHeldToOne;
      readonly before: BeforeTarget;
      readonly fkAssign: Record<string, unknown>;
    }
  | {
      readonly kind: "connectOrCreate";
      readonly relation: ParentHeldToOne;
      readonly probeId: string;
      readonly guardId: string;
      readonly guardProbe: Sql;
      readonly probe: ReadStep;
      readonly foundFkAssign: Record<string, unknown>;
      /** The edge and the selector the found arm's fold was built from — the
       *  compile-time NULL check on a NON-referenced-unique lookup needs both
       *  ({@link RecordUpdateCompilerState.assertLookupKeyPresent}, E1 U2). */
      readonly where: Record<string, unknown>;
      readonly before: BeforeTarget;
      readonly missingFkAssign: Record<string, unknown>;
    }
  // A parent-held to-one update locates the referenced row through the parent's
  // final FK values. Its batch guard pins that correlation before the child write.
  | {
      readonly kind: "update";
      readonly relation: ParentHeldToOne;
      readonly childScope: QueryScope;
      readonly childPrimaryKey: string;
      readonly probeId: string;
      readonly guardId: string;
      readonly correlation: ParentHeldCorrelation;
      readonly probe: ReadStep;
      /** W4-U3 — the `update: { where, data }` wrapper's NON-unique filter on the
       *  currently connected record, ANDed into the locate probe AND the batch
       *  split-witness guard (never the write, which addresses the captured PK).
       *  Absent for the bare `update: <data>` spelling. */
      readonly filter?: Record<string, unknown>;
      readonly compiler: RecordUpdateCompiler;
    }
  // A parent-held delete nulls the parent's FK before deleting by the old value.
  // It is idempotent, so zero matched rows need no probe or failure.
  | {
      readonly kind: "delete";
      readonly relation: ParentHeldToOne;
      readonly childScope: QueryScope;
      readonly nullWriteId: string;
      readonly deleteWriteId: string;
      readonly correlation: ParentHeldCorrelation;
    }
  // A parent-held upsert uses a correlated probe: found updates the located
  // target; absent creates it and rebinds the parent FK.
  | {
      readonly kind: "upsert";
      readonly relation: ParentHeldToOne;
      readonly childScope: QueryScope;
      readonly childPrimaryKey: string;
      readonly probeId: string;
      readonly guardId: string;
      readonly parentSetId: string;
      readonly correlation: ParentHeldCorrelation;
      readonly probe: ReadStep;
      readonly compiler?: RecordUpdateCompiler;
      readonly updateLegality?: () => void;
      readonly before: BeforeTarget;
      readonly missingFkAssign: Record<string, unknown>;
    }
  | {
      readonly kind: "polymorphicCreate";
      readonly before: BeforeTarget;
      readonly assignment: PolymorphicStorageValue<FinalReferenceSource>;
    }
  | {
      readonly kind: "polymorphicConnectOrCreate";
      readonly relationInfo: RelationInfo;
      readonly probeId: string;
      readonly guardId: string;
      readonly guardField: string;
      readonly where: Record<string, unknown>;
      readonly probe: ReadStep;
      readonly before: BeforeTarget;
      readonly foundAssignment: PolymorphicStorageValue<FinalReferenceSource>;
      readonly missingAssignment: PolymorphicStorageValue<FinalReferenceSource>;
    }
  | {
      readonly kind: "polymorphicUpdate";
      readonly edge: ResolvedPolymorphicEdge;
      readonly childScope: QueryScope;
      readonly childPrimaryKey: string;
      readonly probeId: string;
      readonly guardId: string;
      readonly probe: ReadStep;
      readonly filter?: Record<string, unknown>;
      readonly compiler: RecordUpdateCompiler;
    }
  | {
      readonly kind: "polymorphicDelete";
      readonly edge: ResolvedPolymorphicEdge;
      readonly childScope: QueryScope;
      readonly deleteWriteId: string;
    }
  | {
      readonly kind: "polymorphicUpsert";
      readonly edge: ResolvedPolymorphicEdge;
      readonly childScope: QueryScope;
      readonly childPrimaryKey: string;
      readonly probeId: string;
      readonly guardId: string;
      readonly probe: ReadStep;
      readonly compiler?: RecordUpdateCompiler;
      readonly before: BeforeTarget;
      readonly missingAssignment: PolymorphicStorageValue<FinalReferenceSource>;
    };

/**
 * How a family-A (parent-held) to-one write locates its referenced target:
 * `child.<childReferencedFields[i]> = <finalFk[i]>` where `finalFk[i]` is the
 * parent's FK column value AFTER any same-root scalar rebind (V1 correlates on the
 * post-update `parentValues` for a parent-held relation). A rebound column resolves to a
 * construction-time literal (`override`); an untouched column resolves to the
 * located parent row's value (a SQL `Ref` at planning, the literal at compile).
 */
interface ParentHeldCorrelation {
  readonly childReferencedFields: readonly string[];
  readonly parentFkFields: readonly string[];
  /** parentFkField → its rebound literal, when the same root update rewrites it. */
  readonly override: Record<string, unknown>;
}

/**
 * CLASS IV (T4c) — V1's `RelationUpdates.compileRelationKeyGuards`, ported to V2's
 * guard/probe vocabulary. A root update that TRANSITIONS a parent PK a child-held,
 * NON-cascade relation references (setNull / restrict / noAction) may not leave the
 * OLD slot occupied: V1 rejects `Cannot update relation '…' with onUpdate('…') while
 * the current relation is occupied.` The transition being REAL (before ≠ after) is a
 * compile-time fact (both literals — the where-pinned pre-value and
 * `getUpdatedPrimaryKeyValue`); occupancy is the runtime premise. Transaction mode
 * inspects the locked planning probe and throws BEFORE any write; batch mode pins the
 * empty-slot decision with an `exists` guard (the concurrent-plant race). The
 * absorbed accept-shape — an EMPTY slot — creates the child with the POST-transition
 * FK after the root UPDATE (the upsert's update arm is unreachable: occupied rejects,
 * empty creates), reusing the T4b `afterRootParts` machinery.
 */
interface RelationKeyGuard {
  readonly relation: ChildHeldRelation;
  readonly probeId: string;
  readonly guardId: string;
  readonly probe: ReadStep;
}

/**
 * N5-U1 — how the ADOPT family (`connect` / `connectOrCreate` / `set` / a to-many
 * `upsert`) is built under a `guarded` non-cascade referenced-PK transition. The
 * refusal this replaced said an adopt "writes a fresh FK on the pre-transition value,
 * orphaned by the referential action" — true of the ordering it had, and only of that.
 * Two facts make the shape ordinary:
 *   1. the OLD slot is proven EMPTY by the occupied guard the same relation just
 *      emitted, so nothing is being moved off a value the transition vacates; and
 *   2. the POST-transition value is a compile-time literal here (`after`).
 * So the edge is written against `after`, AFTER the root UPDATE that creates that id.
 * `membershipReadSource` is the pre-transition source for the one member that reads
 * existing membership as well as writing it (`set`'s departing half).
 */
interface PostTransitionAdopt {
  /** The value an adopt edge WRITES — the parent's post-transition referenced column. */
  readonly parentId: FinalReferenceSource;
  /** The value an adopt member READS existing children by — the located row's own. */
  readonly membershipReadSource: ReturnType<typeof plannedParentId>;
  /** The list whose writes are emitted after the root UPDATE (`afterRootParts`). */
  readonly target: Part[];
}

class RecordUpdateCompilerState implements RecordUpdateCompiler {
  readonly mode: ExecutionMode;
  readonly targetReadId: string;
  readonly writeId: string;
  readonly targetProjection: TargetProjection;

  private readonly engine: QueryEngine;
  private readonly targetScope: QueryScope;
  private readonly model: QueryScope["model"];
  private readonly scope: StepScope;
  private readonly relationName: string;
  private readonly rootWriteFailure: Failure | undefined;
  private readonly pinnedTarget: Readonly<Record<string, unknown>>;
  private readonly incomingMembership: RelationMembershipBinding | undefined;
  private readonly parentPrimaryKeys: readonly string[];
  private readonly parentIdSource: ReturnType<typeof plannedParentId>;
  private readonly childParts: readonly Part[];
  private readonly afterRootParts: readonly Part[];
  private readonly toOneLinks: readonly ToOneLink[];
  private readonly parentHeldTargets: readonly ParentHeldTarget[];
  private readonly relationKeyGuards: readonly RelationKeyGuard[];
  private readonly parentUpdateData: Record<string, unknown>;
  private readonly polymorphicStorage: readonly PolymorphicStorageValue<FinalReferenceSource>[];
  private readonly reorderRootUpdateAfterChildren: boolean;
  private readonly createFresh: FreshRecordBuilder;
  private readonly recordCompilers: RecordCompilerSeam;

  constructor(
    input: RecordUpdateCompilerInput,
    createFresh: FreshRecordBuilder
  ) {
    this.engine = input.engine;
    this.targetScope = input.targetScope;
    this.model = input.targetScope.model;
    this.scope = input.scope;
    this.mode = selectExecutionMode(input.engine, "update");
    this.relationName = input.relationName;
    this.rootWriteFailure = input.rootWriteFailure;
    this.pinnedTarget = input.pinnedTarget ?? {};
    this.incomingMembership = input.incomingMembership;
    this.createFresh = createFresh;
    this.recordCompilers = {
      createFresh,
      updateSelected: (nestedInput) =>
        buildRecordUpdateCompiler(nestedInput, createFresh),
    };

    const parentPrimaryKeys = getPrimaryKeyFields(this.model);
    if (parentPrimaryKeys.length === 0) {
      throw new QueryEngineError(
        "query-engine-v2 internal: selected update reached a model with no primary key."
      );
    }
    this.parentPrimaryKeys = parentPrimaryKeys;
    this.targetReadId = resolveStepAddress(input.scope, input.targetRead);
    this.writeId = resolveStepAddress(input.scope, input.rootWrite);

    const parentIdSource = plannedParentId(this.targetReadId);
    this.parentIdSource = parentIdSource;
    const childParts: Part[] = [];
    const afterRootParts: Part[] = [];
    const toOneLinks: ToOneLink[] = [];
    const parentHeldTargets: ParentHeldTarget[] = [];
    const polymorphicStorage: PolymorphicStorageValue<FinalReferenceSource>[] =
      [];
    const relationKeyGuards: RelationKeyGuard[] = [];
    const locateFields = new Set<string>(parentPrimaryKeys);
    const parentFkLocateFields = new Set<string>();
    const targetColumns = new Map<string, PolymorphicStorageColumn>();
    const txMode = this.mode === "transaction";
    for (const program of Object.values(input.relations)) {
      const polymorphic = input.polymorphic?.[program.relationInfo.name];
      if (polymorphic?.kind === "targeted") {
        const entry = program.entries[0];
        if (
          entry?.kind === "update" ||
          entry?.kind === "delete" ||
          entry?.kind === "upsert"
        ) {
          for (const column of [
            polymorphic.edge.storage.typeColumn,
            polymorphic.edge.storage.idColumn,
          ]) {
            targetColumns.set(column.name, column);
          }
        }
        this.interpretPolymorphicRelation({
          scope: input.scope,
          mutation: polymorphic,
          program,
          txMode,
          toOneLinks,
          parentHeldTargets,
          polymorphicStorage,
        });
        continue;
      }
      this.interpretRelation({
        scope: input.scope,
        parent: input.targetScope,
        program,
        parentIdSource,
        txMode,
        childParts,
        afterRootParts,
        toOneLinks,
        parentHeldTargets,
        relationKeyGuards,
        locateFields,
        parentFkLocateFields,
        rootScalarData: input.scalarData,
      });
    }
    for (const mutation of Object.values(input.polymorphic ?? {})) {
      if (mutation.kind !== "disconnect") continue;
      polymorphicStorage.push({
        kind: "empty",
        storage: mutation.storage,
      });
    }
    this.childParts = childParts;
    this.afterRootParts = afterRootParts;
    this.toOneLinks = toOneLinks;
    this.parentHeldTargets = parentHeldTargets;
    this.polymorphicStorage = polymorphicStorage;
    this.relationKeyGuards = relationKeyGuards;

    const parentSet = { ...input.scalarData };
    for (const link of toOneLinks) Object.assign(parentSet, link.assignment);
    this.parentUpdateData = parentSet;
    this.reorderRootUpdateAfterChildren =
      childParts.length > 0 &&
      [...locateFields].some((field) => Object.hasOwn(parentSet, field));
    this.targetProjection = buildTargetProjection(
      [...new Set([...locateFields, ...parentFkLocateFields])],
      [...targetColumns.values()]
    );
  }

  planning(): readonly StatementStep[] {
    const steps: StatementStep[] = [];
    for (const guard of this.relationKeyGuards) steps.push(guard.probe);
    for (const link of this.toOneLinks) {
      if (link.connect) steps.push(link.connect.probe);
    }
    for (const target of this.parentHeldTargets) {
      if (
        target.kind === "connectOrCreate" ||
        target.kind === "update" ||
        target.kind === "upsert" ||
        target.kind === "polymorphicConnectOrCreate" ||
        target.kind === "polymorphicUpdate" ||
        target.kind === "polymorphicUpsert"
      ) {
        steps.push(target.probe);
      }
      if (
        target.kind === "create" ||
        target.kind === "connectOrCreate" ||
        target.kind === "upsert" ||
        target.kind === "polymorphicCreate" ||
        target.kind === "polymorphicConnectOrCreate" ||
        target.kind === "polymorphicUpsert"
      ) {
        steps.push(...target.before.subtree.planning(this.scope));
      }
      if (target.kind === "update") {
        steps.push(...target.compiler.planning());
      }
      if (target.kind === "polymorphicUpdate") {
        steps.push(...target.compiler.planning());
      }
      if (target.kind === "upsert" && target.compiler) {
        steps.push(...conditionalArmPlanning(target.compiler.planning()));
      }
      if (target.kind === "polymorphicUpsert" && target.compiler) {
        steps.push(...conditionalArmPlanning(target.compiler.planning()));
      }
    }
    for (const part of this.childParts) {
      steps.push(...part.planning(this.scope));
    }
    for (const part of this.afterRootParts) {
      steps.push(...part.planning(this.scope));
    }
    return steps;
  }

  compile(known: PlanningKnown): readonly OperationStep[] {
    const rows = known[planningKey(this.targetReadId, "rows")];
    if (!(Array.isArray(rows) && isRecord(rows[0]))) {
      throw new QueryEngineError(
        "query-engine-v2 selected record compiler received no captured target row."
      );
    }
    return this.compileLocatedRecord(known, rows[0]);
  }

  updatedPrimaryKeyWhere(
    locatedRow: Record<string, unknown>
  ): Record<string, unknown> {
    const target = createQueryScope(this.engine.adapter, this.model);
    return getUpdatedPrimaryKeyWhere(
      target,
      locatedRow,
      this.parentUpdateData,
      getStepModelName(this.model, this.relationName || "record")
    );
  }

  private compileLocatedRecord(
    known: Readonly<Record<string, unknown>>,
    locatedRow: Record<string, unknown>
  ): OperationStep[] {
    // Build-don't-select (P1.2): to-one connect checks + child arms construct
    // their taken steps; the shared root update and deep terminal read emit once.
    // Guards hoist ahead of every write (batch pins premises first).
    const guards: OperationStep[] = [];
    const writes: OperationStep[] = [];
    // CLASS IV (T4c): the referential-action occupied guards. The transition is real
    // (before != after, decided at construction). tx mode inspects the locked probe
    // and throws V1's byte-identical `NestedWriteError` before any write; batch mode
    // pins the empty-slot decision with an `exists` guard that aborts the atomic unit
    // if the slot is occupied (the concurrent-plant race).
    this.compileRelationKeyGuards(known, guards);
    for (const link of this.toOneLinks) {
      guards.push(...this.compileToOneConnect(link, known));
    }
    // Parent-held target INSERTs land before the root UPDATE, whose FK assignment
    // references the possibly just-created identity.
    const beforeRootWrites: OperationStep[] = [];
    const rootExtraSet = this.compileParentHeldTargets(
      known,
      locatedRow,
      guards,
      beforeRootWrites,
      writes
    );
    const dynamicPolymorphicStorage = rootExtraSet.polymorphicStorage;
    const incoming = this.incomingMembership
      ? lowerMembershipWrite(
          this.engine,
          this.targetScope,
          this.incomingMembership,
          known,
          "update"
        )
      : { data: {}, polymorphicStorage: [] };
    Object.assign(rootExtraSet.data, incoming.data);
    for (const part of this.childParts) {
      bucketOperationSteps(part.compile(this.scope, known), guards, writes);
    }
    // The post-transition Parts (T4b create leaves + N5-U1's guarded adopt family).
    // Their GUARDS join every other guard at the front — a batch pins its premises
    // before any write, and every premise these Parts assert (the connect target
    // exists; the departing set is empty) is a fact about rows the root UPDATE does
    // not touch, so hoisting it past that UPDATE changes nothing it asserts. Their
    // WRITES are held back and appended after the root UPDATE below.
    const afterRootWrites: OperationStep[] = [];
    for (const part of this.afterRootParts) {
      bucketOperationSteps(
        part.compile(this.scope, known),
        guards,
        afterRootWrites
      );
    }
    const steps: OperationStep[] = [...guards, ...beforeRootWrites];
    const polymorphicStorage = [
      ...this.polymorphicStorage.map((value) =>
        resolvePolymorphicStorageValue(this.engine, value, known, "update")
      ),
      ...dynamicPolymorphicStorage,
      ...incoming.polymorphicStorage,
    ];
    const hasRootUpdate =
      Object.keys(this.parentUpdateData).length > 0 ||
      Object.keys(rootExtraSet.data).length > 0 ||
      polymorphicStorage.length > 0;
    const rootUpdate = hasRootUpdate
      ? this.buildRootUpdate(locatedRow, rootExtraSet.data, polymorphicStorage)
      : undefined;
    // A root SET that rewrites a child-referenced column (a PK transition
    // `id: 2`, or a literal on a non-PK referenced unique) must land AFTER the
    // child edge writes: a self-M2M junction row / a child reparent references the
    // parent by its CURRENT (pre-transition) value, so the edge is written first
    // against the located id and the root UPDATE's `ON UPDATE CASCADE` then carries
    // it to the new value. Emitting the root UPDATE first would strand the edge on
    // an id the transition just vacated (ForeignKeyError where V1 succeeds).
    // Correlation stays on the pre-transition value — the row still holds the old
    // FK until the cascade fires, so a nested update/delete of an existing member
    // matches by the located id, not the post-transition one.
    if (rootUpdate && !this.reorderRootUpdateAfterChildren) {
      steps.push(rootUpdate);
    }
    steps.push(...writes);
    if (rootUpdate && this.reorderRootUpdateAfterChildren) {
      steps.push(rootUpdate);
    }
    // T4b CLASS III + N5-U1 — every write whose foreign key is the POST-transition
    // referenced value lands here: the transitioned-PK create INSERTs, and the guarded
    // adopt family's reparent UPDATEs. They must follow the root UPDATE, which is what
    // makes the new parent row exist (a NO-ACTION foreign key does not cascade a fresh
    // or reparented row onto an id the transition has not written yet).
    if (this.afterRootParts.length > 0) {
      if (!rootUpdate) {
        throw new QueryEngineError(
          "query-engine-v2 update built a post-transition child write with no root UPDATE to run before it."
        );
      }
      steps.push(...afterRootWrites);
    }
    return steps;
  }

  private compileRelationKeyGuards(
    known: Readonly<Record<string, unknown>>,
    guards: OperationStep[]
  ): void {
    for (const guard of this.relationKeyGuards) {
      const relationName = guard.relation.relationInfo.name;
      const message = relationKeyOccupiedMessage(
        relationName,
        guard.relation.onUpdate ?? "restrict"
      );
      if (this.mode === "batch") {
        // V1's `notExistsWhenChanged` premise: assert the OLD slot is EMPTY; the batch
        // aborts (rejects "occupied") if a row exists — a `notExists` guard whose
        // materialized condition a concurrent plant can invalidate, so `raceable: true`
        // (the empty-slot race; the validator requires it of every notExists guard).
        guards.push(
          absenceGuard(
            guard.guardId,
            guard.probe.statement,
            nestedWriteFailure(message, relationName, true)
          )
        );
        continue;
      }
      const rows = known[planningKey(guard.probeId, "rows")];
      if (Array.isArray(rows) && rows.length > 0) {
        throw new NestedWriteError(message, relationName, {
          meta: { operation: "update", relation: relationName },
        });
      }
    }
  }

  // -------------------------------------------------------------------------

  private interpretPolymorphicRelation(input: {
    readonly scope: StepScope;
    readonly mutation: Extract<
      ResolvedPolymorphicMutation,
      { kind: "targeted" }
    >;
    readonly program: RelationMutationProgram;
    readonly txMode: boolean;
    readonly toOneLinks: ToOneLink[];
    readonly parentHeldTargets: ParentHeldTarget[];
    readonly polymorphicStorage: PolymorphicStorageValue<FinalReferenceSource>[];
  }): void {
    const { edge } = input.mutation;
    const { program } = input;
    const relationName = edge.relationInfo.name;
    const childScope = createQueryScope(this.engine.adapter, edge.targetModel);
    const entry = program.entries[0];
    if (!(entry && program.entries.length === 1)) {
      throw new QueryEngineError(
        `query-engine internal: direct polymorphic update relation '${relationName}' requires one operation.`
      );
    }
    if (entry.kind === "create") {
      const data = entry.items[0];
      if (!data) {
        throw new QueryEngineError(
          `query-engine internal: polymorphic create on relation '${relationName}' has no item.`
        );
      }
      const before = this.buildBeforeTarget(childScope, data);
      const source = before.subtree.rootReferenced(edge.referencedField);
      if (!source) {
        throw new QueryEngineError(
          `query-engine update cannot resolve referenced field '${edge.referencedField}' for relation '${relationName}'.`
        );
      }
      input.parentHeldTargets.push({
        kind: "polymorphicCreate",
        before,
        assignment: linkedPolymorphicStorage(edge, source),
      });
      return;
    }
    if (entry.kind === "connectOrCreate") {
      const spec = entry.items[0];
      if (!spec) {
        throw new QueryEngineError(
          `query-engine internal: polymorphic connectOrCreate on relation '${relationName}' has no item.`
        );
      }
      const before = this.buildBeforeTarget(
        childScope,
        spec.create,
        childRacePin(childScope, spec.where)
      );
      const source = before.subtree.rootReferenced(edge.referencedField);
      if (!source) {
        throw new QueryEngineError(
          `query-engine update cannot resolve referenced field '${edge.referencedField}' for relation '${relationName}'.`
        );
      }
      const childName = getStepModelName(edge.targetModel, relationName);
      const probeId = input.scope.allocate(`${childName}.find`);
      const guardId = input.scope.allocate(`${childName}.guard.exists`);
      const guardField = edge.referencedField;
      const select = { [guardField]: true };
      const probe: ReadStep = {
        id: probeId,
        kind: "read",
        statement: buildFindUnique(childScope, {
          where: spec.where,
          select,
          forUpdate: input.txMode,
        }),
        outputs: { rows: { kind: "rows" } },
      };
      input.parentHeldTargets.push({
        kind: "polymorphicConnectOrCreate",
        relationInfo: edge.relationInfo,
        probeId,
        guardId,
        guardField,
        where: spec.where,
        probe,
        before,
        foundAssignment: linkedPolymorphicStorage(edge, {
          kind: "planningField",
          step: probeId,
        }),
        missingAssignment: linkedPolymorphicStorage(edge, source),
      });
      return;
    }
    if (entry.kind === "update") {
      const item = entry.items[0];
      if (!(item && item.target.kind === "correlated")) {
        throw new QueryEngineError(
          `query-engine internal: polymorphic update on relation '${relationName}' requires one correlated target.`
        );
      }
      const target = this.buildPolymorphicSelectedTarget(
        input.scope,
        edge,
        childScope,
        item.data,
        item.target.filter,
        input.txMode
      );
      if (target) input.parentHeldTargets.push(target);
      return;
    }
    if (entry.kind === "delete") {
      input.parentHeldTargets.push({
        kind: "polymorphicDelete",
        edge,
        childScope,
        deleteWriteId: input.scope.allocate(
          `${getStepModelName(edge.targetModel, relationName)}.delete`
        ),
      });
      return;
    }
    if (entry.kind === "upsert") {
      const spec = entry.items[0];
      if (!(spec && spec.target.kind === "correlated")) {
        throw new QueryEngineError(
          `query-engine internal: polymorphic upsert on relation '${relationName}' requires one correlated target.`
        );
      }
      input.parentHeldTargets.push(
        this.buildPolymorphicUpsert(
          input.scope,
          edge,
          childScope,
          spec.create,
          spec.update,
          input.txMode
        )
      );
      return;
    }
    if (entry.kind !== "connect") {
      throw new QueryEngineError(
        `query-engine internal: unsupported direct polymorphic mutation '${entry.kind}' on relation '${relationName}'.`
      );
    }
    const where = entry.targets[0];
    if (!where) {
      throw new QueryEngineError(
        `query-engine internal: polymorphic connect on relation '${relationName}' has no target.`
      );
    }
    const childName = getStepModelName(edge.targetModel, relationName);
    const probeId = input.scope.allocate(`${childName}.find`);
    const guardId = input.scope.allocate(`${childName}.guard.exists`);
    const id: FinalReferenceSource = {
      kind: "planningField",
      step: probeId,
    };
    input.polymorphicStorage.push({
      kind: "linked",
      storage: edge.storage,
      storedType: edge.storedType,
      referencedField: edge.referencedField,
      id,
    });

    const capturedGuardField = edge.referencedField;
    const select = { [capturedGuardField]: true };
    input.toOneLinks.push({
      relationInfo: edge.relationInfo,
      referencedFields: [edge.referencedField],
      assignment: {},
      connect: {
        probeId,
        guardId,
        where,
        capturedGuardField,
        probe: {
          id: probeId,
          kind: "read",
          statement: buildFindUnique(childScope, {
            where,
            select,
            forUpdate: input.txMode,
          }),
          outputs: { rows: { kind: "rows" } },
        },
      },
    });
  }

  private buildPolymorphicSelectedTarget(
    scope: StepScope,
    edge: ResolvedPolymorphicEdge,
    childScope: QueryScope,
    data: Record<string, unknown>,
    filter: Record<string, unknown> | undefined,
    txMode: boolean
  ): Extract<ParentHeldTarget, { kind: "polymorphicUpdate" }> | undefined {
    const relationName = edge.relationInfo.name;
    const parsed = buildParsedRelationPrograms(childScope, data);
    assertPortablePrimaryKeyUpdateInput(childScope.model, "update", {
      data: parsed.scalarData,
    });
    assertRelationKeyUpdatesAreCompilable(
      childScope,
      parsed.scalarData,
      parsed.relations
    );
    assertSelectedUpdateManyDataIsScalar(childScope, parsed.relations);
    const childName = getStepModelName(edge.targetModel, relationName);
    const compiler = this.recordCompilers.updateSelected({
      scope,
      engine: this.engine,
      targetScope: childScope,
      scalarData: parsed.scalarData,
      relations: parsed.relations,
      polymorphic: parsed.polymorphic,
      targetRead: { label: `${childName}.find` },
      rootWrite: { label: `${childName}.update` },
      relationName,
    });
    if (!compiler) return undefined;
    const childPrimaryKeys = getPrimaryKeyFields(childScope.model);
    if (childPrimaryKeys.length !== 1) {
      throw new QueryEngineError(
        `query-engine update requires a target with one primary key for polymorphic relation '${relationName}'.`
      );
    }
    const childPrimaryKey = childPrimaryKeys[0]!;
    const probe = this.buildPolymorphicTargetProbe(
      compiler.targetReadId,
      edge,
      childScope,
      compiler.targetProjection,
      filter,
      txMode,
      false
    );
    return {
      kind: "polymorphicUpdate",
      edge,
      childScope,
      childPrimaryKey,
      probeId: compiler.targetReadId,
      guardId: scope.allocate(`${childName}.guard.exists`),
      probe,
      ...(filter ? { filter } : {}),
      compiler,
    };
  }

  private buildPolymorphicUpsert(
    scope: StepScope,
    edge: ResolvedPolymorphicEdge,
    childScope: QueryScope,
    create: Record<string, unknown>,
    update: Record<string, unknown>,
    txMode: boolean
  ): Extract<ParentHeldTarget, { kind: "polymorphicUpsert" }> {
    const relationName = edge.relationInfo.name;
    const before = this.buildBeforeTarget(childScope, create);
    const source = before.subtree.rootReferenced(edge.referencedField);
    if (!source) {
      throw new QueryEngineError(
        `query-engine update cannot resolve referenced field '${edge.referencedField}' for relation '${relationName}'.`
      );
    }
    const parsed = buildParsedRelationPrograms(childScope, update);
    const hasUpdate =
      Object.keys(parsed.scalarData).length > 0 ||
      Object.keys(parsed.relations).length > 0 ||
      Object.keys(parsed.polymorphic).length > 0;
    const childName = getStepModelName(edge.targetModel, relationName);
    const compiler = hasUpdate
      ? this.recordCompilers.updateSelected({
          scope,
          engine: this.engine,
          targetScope: childScope,
          scalarData: parsed.scalarData,
          relations: parsed.relations,
          polymorphic: parsed.polymorphic,
          targetRead: { label: `${childName}.find` },
          rootWrite: { label: `${childName}.update` },
          relationName,
        })
      : undefined;
    const probeId =
      compiler?.targetReadId ?? scope.allocate(`${childName}.find`);
    const childPrimaryKeys = getPrimaryKeyFields(childScope.model);
    if (childPrimaryKeys.length !== 1) {
      throw new QueryEngineError(
        `query-engine update requires a target with one primary key for polymorphic relation '${relationName}'.`
      );
    }
    return {
      kind: "polymorphicUpsert",
      edge,
      childScope,
      childPrimaryKey: childPrimaryKeys[0]!,
      probeId,
      guardId: scope.allocate(`${childName}.guard.exists`),
      probe: this.buildPolymorphicTargetProbe(
        probeId,
        edge,
        childScope,
        compiler?.targetProjection ??
          buildTargetProjection([childPrimaryKeys[0]!]),
        undefined,
        txMode,
        true
      ),
      compiler,
      before,
      missingAssignment: linkedPolymorphicStorage(edge, source),
    };
  }

  private buildPolymorphicTargetProbe(
    id: string,
    edge: ResolvedPolymorphicEdge,
    childScope: QueryScope,
    projection: TargetProjection,
    filter: Record<string, unknown> | undefined,
    txMode: boolean,
    optional: boolean
  ): ReadStep {
    const { fields } = projection;
    const columns = targetProjectionColumns(childScope, projection);
    const identity = referenceScalarSql(
      this.engine,
      edge.storage.idColumn.scalar,
      edge.storage.idColumn.name,
      ref(this.targetReadId, edge.storage.idColumn.name)
    );
    return {
      id,
      kind: "read",
      statement: buildFind(
        childScope,
        {
          where: {
            AND: [
              { [edge.referencedField]: { equals: identity } },
              ...(filter ? [filter] : []),
            ],
          },
          select: Object.fromEntries(fields.map((field) => [field, true])),
          forUpdate: txMode,
        },
        {
          limit: 1,
          ...(columns.length
            ? { additionalColumns: columns.map((column) => column.sql) }
            : {}),
        }
      ),
      outputs: {
        rows: { kind: "rows" },
        ...targetProjectionOutputs(projection, optional),
      },
    };
  }

  private interpretRelation(input: {
    scope: StepScope;
    parent: QueryScope;
    program: RelationMutationProgram;
    parentIdSource: ReturnType<typeof plannedParentId>;
    txMode: boolean;
    childParts: Part[];
    afterRootParts: Part[];
    toOneLinks: ToOneLink[];
    parentHeldTargets: ParentHeldTarget[];
    /** CLASS IV (T4c) — collected occupied guards for a non-cascade child-held
     *  relation whose referenced PK the root update transitions. */
    relationKeyGuards: RelationKeyGuard[];
    locateFields: Set<string>;
    /** Parent-held FK columns a family-A arm correlates on — selected but NOT
     *  reorder-relevant (see the constructor's `parentFkLocateFields`). */
    parentFkLocateFields: Set<string>;
    /** The root update's validated scalar writes — used to detect a concurrent
     *  referenced-key transition (a write to a parent column a child FK references)
     *  that puts a nested arm on V1's referential-legality path (§7.2). */
    rootScalarData: Record<string, unknown>;
  }): void {
    const { program } = input;
    const relationInfo = program.relationInfo;
    const relationName = relationInfo.name;
    const relation = bindRelation(input.parent, relationInfo);
    const entries = program.entries;
    const kinds = entries.map((entry) => entry.kind);

    if (kinds.length === 0) {
      // A relation payload that asks for nothing: `{}`, or one whose only arms were
      // Prisma's boolean no-op (`disconnect: false` / `delete: false`, stripped by
      // canonical program construction). Prisma 7.9.1, measured: `data: { profile: {} }` and
      // `data: { posts: {} }` both return the parent unchanged. Nothing to build, and in
      // particular NOT the "one mutation kind" refusal below, whose subject is a payload
      // naming two conflicting intents.
      return;
    }

    if (relation.kind === "junction") {
      // A junction composes as ordinary Parts. Each
      // membership kind is a leaf feeding the same step vocabulary; the whole
      // family lives in one file, never an `M2M*` subsystem.
      const engine = this.engine;
      const scope = input.scope;
      input.childParts.push(
        ...buildJunctionParts({
          scope,
          engine,
          parentScope: input.parent,
          relation,
          program,
          parentId: input.parentIdSource,
          txMode: input.txMode,
          recordCompilers: this.recordCompilers,
          // T3b-2 (family C): a junction create/update/upsert target whose data
          // carries its own relations folds them one level deeper through the same
          // literal-parent builder the child-held families use (mechanism 1 reuse for
          // located update targets; mechanism 2 fresh-parent elision for create arms).
          nestedBuilder: (
            targetScope,
            parentId,
            relations,
            nestedTxMode,
            membershipReadSource
          ) =>
            buildJunctionTargetRelationParts(
              scope,
              engine,
              targetScope,
              relations,
              parentId,
              nestedTxMode,
              this.recordCompilers,
              membershipReadSource
            ),
        })
      );
      return;
    }

    if (relation.kind === "parentHeldToOne") {
      // A parent-held FK is a same-row change. `connect`/`disconnect` fold their
      // (construction-known) FK literal into the root SET; `create`/`connectOrCreate`
      // write the target before the root UPDATE and reference its identity from the
      // UPDATE's SET. Only one kind is valid per to-one relation.
      //
      // E6.5 RE-JUSTIFIED, MEASURED. The vacate+supply pairs the inverse-side twin
      // below absorbs do NOT compose here, and the reason is this direction's own
      // write shape rather than the payload. `delete` is not one write but two — an
      // UPDATE that NULLs the parent's own foreign key and a correlated DELETE of the
      // old target — and the FK-null lands in the post-root write bucket, AFTER the
      // supplier's rebind has already been folded into the root SET. Driving
      // `{ delete: true, create: {...} }` through with only this guard lifted was
      // measured at 8c2908d: the fresh row is inserted and then ORPHANED —
      // `station.depotId = null`, `depots = [d-alt, d-new]` — the supplier's whole
      // point undone by the vacate that was supposed to precede it. Making the pair
      // mean what it says here is an ORDERING change (elide the FK-null when a
      // sibling supplier rebinds the same column in the same payload), not a lifted
      // guard, so the guard stays and the pair stays refused. `disconnect` + a
      // supplier measured CORRECT in the same run, but only because both spellings
      // collide on one key of the root SET and the later one wins by object-assign
      // order — an implicit contract with no test of its own; absorbing it means
      // owning that ordering deliberately, which is the same unit.
      if (kinds.length !== 1) {
        throw new UnsupportedOperationError(
          `query-engine-v2 update supports one mutation kind on the to-one relation '${relationName}'; it has ${kinds.join(", ") || "none"}.`
        );
      }
      this.interpretParentHeldToOne(input, relation, entries[0]!);
      return;
    }

    if (
      relation.kind === "polymorphicChildHeldToOne" ||
      relation.kind === "polymorphicChildHeldToMany"
    ) {
      this.interpretPolymorphicChildHeld(input, relation, entries);
      return;
    }

    // Child-held direction (the target holds the FK). One-to-many is the plural
    // case; the inverse-side one-to-one is its arity-1 case
    // — the same correlated/global-adopt child writes, differing only in the to-one
    // payload spelling (`update: <data>` with no selector, `disconnect: true`).
    // The parent exists, so no fresh-parent elision: every probe reads committed
    // state, exactly as the to-many family already does under update.
    const isInverseToOne = relation.kind === "childHeldToOne";
    // The twin of the parent-held gate above, on the dispatch that reaches the child-held
    // direction: a to-one slot holds ONE row, so two kinds name two intents for one slot.
    // Its unique coverage is this DISPATCH position (with `CreateOperation`'s
    // `interpretChildHeld`); the census's to-one two-kinds family covers only the ARM
    // positions. Without it the per-kind loop below built every arm, and the outcome
    // depended on whether the child's foreign key carried a unique — a database
    // `UniqueConstraintError` on a 1:1 leg, TWO ROWS in the to-one slot and no diagnostic
    // at all on a fields-less `manyToOne` inverse, whose FK is not unique.
    //
    // E6.5 — except for a VACATE followed by a SUPPLY ({@link isVacateThenSupply}),
    // which is the one two-kind shape that leaves the slot holding exactly ONE row.
    // Two kinds, but ONE identity: the vacate names the row that is there now, the
    // supplier names the row that will be. On this direction they touch DIFFERENT rows
    // of the child table (the incumbent's foreign key, then the newcomer's), so the
    // per-kind loop's `RELATION_MUTATION_KEYS` order is the whole mechanism — nothing
    // is folded into a shared SET and no ordering has to be invented. Measured at
    // 8c2908d over all six pairs: the incumbent ends orphaned under `disconnect` and
    // GONE under `delete`, the supplied row ends connected, and the untouched decoy
    // stays untouched. (`delete` + `connectOrCreate` is refused one layer up, by the
    // own-write legality walk, and keeps that refusal.)
    if (isInverseToOne) assertToOneMutationArity(relationName, kinds);
    // Compound foreign keys are per-field (ATOM “Field-bound foreign-key provenance”): every referenced parent
    // column — the PK, a subset of it, or a non-PK unique (D4-style) — is added
    // to the locate read's select/outputs so a per-field child part reads or refs
    // each one. The whole family (link/adopt/write/set) generalizes together; no
    // shape needs a separate path solely because the edge is compound.
    //
    // T3b-2 (family E): a nested `create`/`createMany` resolves its FK from the
    // update's own inputs (the referenced column pinned by the unique `where`, or
    // rewritten by the root SET — D4), NOT from the located row, so a create-ONLY
    // relation adds no referenced column to `locateFields`. This keeps the D4 order
    // correct: the root UPDATE stays reorder-FALSE (before the child INSERT), so the
    // fresh row references the post-transition value that already exists.
    const needsLocatedReference = kinds.some(
      (mutationKind) =>
        mutationKind !== "create" && mutationKind !== "createMany"
    );
    if (needsLocatedReference) {
      for (const field of relation.referencedFields) {
        input.locateFields.add(field);
      }
    }
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const childPrimaryKeys = getPrimaryKeyFields(childScope.model);
    if (childPrimaryKeys.length !== 1) {
      throw new UnsupportedOperationError(
        `query-engine-v2 update requires a child with one primary key for relation '${relationName}'.`
      );
    }
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    // CLASS IV (T4c-fix) — V1's relation-level occupied guard for a non-cascade
    // referenced-PK transition, emitted ONCE for the relation before the per-kind
    // dispatch. It rejects an occupied old slot for any nested mutation and tells
    // the to-one upsert where its create arm belongs.
    const keyTransition = this.interpretReferencedKeyTransition({
      input,
      relation,
      childScope,
      childName,
    });
    if (keyTransition.regime === "pastSurface") {
      // A real transition past the reproduced single-PK surface (a compound / non-PK /
      // unpinned reference). Only nested `create` / `createMany` proceed — their FK
      // literal (incl. a non-PK D4 rewrite) is resolved by `resolveLiteralCreateParent`
      // against the empty-slot accept. Every other kind needs an occupied guard on a
      // pre-transition value this compiler cannot correlate, so it fails typed.
      for (const kind of kinds) {
        if (kind !== "create" && kind !== "createMany") {
          throw new UnsupportedOperationError(
            `query-engine-v2 update does not support a nested '${kind}' on the child-held relation '${relationName}' while the root update transitions a compound / non-PK / unpinned referenced column.`
          );
        }
      }
    }
    // N5-U1 — the ADOPT family under a guarded non-cascade transition. The occupied
    // guard just emitted proves the OLD slot is empty, so an adopt edge has exactly
    // one correct target: the parent's POST-transition referenced value. That value is
    // compile-known here (`after`, derived by `getUpdatedPrimaryKeyValue` from the
    // where-pinned pre-value and the root SET's operand — the same derivation the T4b
    // create leaf and the to-one upsert create-arm reroute already trust), and the
    // WRITE is deferred until after the root UPDATE, which is what makes the row it
    // points at exist. Ordering closes this family; no new expressiveness was needed.
    const adopt: PostTransitionAdopt | undefined =
      keyTransition.regime === "guarded"
        ? {
            parentId: literalParentId(keyTransition.after),
            membershipReadSource: input.parentIdSource,
            target: input.afterRootParts,
          }
        : undefined;
    const engine = this.engine;
    const writeBase: Parameters<typeof buildToManyUpdateParts>[0] = {
      scope: input.scope,
      engine,
      relation,
      childName,
      childScope,
      childPrimaryKey: childPrimaryKeys[0]!,
      parentId: input.parentIdSource,
      txMode: input.txMode,
      recordCompilers: this.recordCompilers,
    };

    // Multiple mutation kinds may coexist on one relation (V1's `{ delete,
    // deleteMany }`, `{ update, updateMany }`, …). Each present kind contributes
    // its own Part(s); they compose into the one linear fragment in a stable,
    // V1-mirroring order (link/adopt, then removals, then updates).
    for (const entry of entries) {
      if (isInverseToOne) {
        this.interpretInverseToOneKind({
          entry,
          relation,
          childScope,
          childName,
          childPrimaryKey: childPrimaryKeys[0]!,
          writeBase,
          input,
          keyTransition,
          adopt,
        });
        continue;
      }
      // T3b-2 (family E): a nested `create`/`createMany` under the update root on a
      // child-held to-many. The located parent's FK is a construction-time literal
      // (the referenced column pinned by the unique `where`, or rewritten by the root
      // SET — D4's "thread the new value"), so it reuses the same literal-parent create
      // leaf the child-held recursion uses.
      if (entry.kind === "create" || entry.kind === "createMany") {
        this.interpretChildHeldCreate({
          entry,
          relation,
          childScope,
          childName,
          input,
        });
        continue;
      }
      this.interpretToManyKind({
        entry,
        relation,
        childScope,
        childName,
        childPrimaryKey: childPrimaryKeys[0]!,
        writeBase,
        input,
        adopt,
      });
    }
  }

  private interpretPolymorphicChildHeld(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: PolymorphicChildHeldToOne | PolymorphicChildHeldToMany,
    entries: readonly RelationMutationEntry[]
  ): void {
    const relationName = relation.relationInfo.name;
    const isInverseToOne = relation.kind === "polymorphicChildHeldToOne";
    const kinds = entries.map((entry) => entry.kind);
    if (isInverseToOne) assertToOneMutationArity(relationName, kinds);
    const childScope = createQueryScope(
      this.engine.adapter,
      relation.relationInfo.targetModel
    );
    const childName = getStepModelName(
      relation.relationInfo.targetModel,
      relationName
    );
    const parent = this.resolvePolymorphicParent(input, relation);
    const target = parent.afterRoot ? input.afterRootParts : input.childParts;
    const push = (parts: readonly Part[]) => target.push(...parts);
    const pushFresh = (
      entry: Extract<RelationMutationEntry, { kind: "create" | "createMany" }>
    ): void => {
      if (entry.kind === "create") {
        push(
          entry.items.map((data) =>
            this.createFresh({
              childScope,
              data,
              incomingMembership: bindRelationMembership(
                relation,
                parent.write
              ),
              relationName,
            })
          )
        );
        return;
      }
      push([
        buildPolymorphicParentCreateManyPart({
          scope: input.scope,
          engine: this.engine,
          childScope,
          childName,
          relation,
          parentId: parent.write,
          createManyEntry: entry,
        }),
      ]);
    };
    const needsTargetIdentity = entries.some(
      (entry) => entry.kind !== "create" && entry.kind !== "createMany"
    );
    if (!needsTargetIdentity) {
      for (const entry of entries) {
        if (entry.kind === "create" || entry.kind === "createMany") {
          pushFresh(entry);
        }
      }
      return;
    }

    const childPrimaryKeys = getPrimaryKeyFields(childScope.model);
    const [childPrimaryKey] = childPrimaryKeys;
    if (childPrimaryKeys.length !== 1 || childPrimaryKey === undefined) {
      throw new UnsupportedOperationError(
        `query-engine-v2 update requires a child with one primary key for relation '${relationName}'.`
      );
    }
    const writeBase = {
      scope: input.scope,
      engine: this.engine,
      relation,
      childName,
      childScope,
      childPrimaryKey,
      parentId: parent.write,
      membershipReadSource: parent.read,
      txMode: input.txMode,
      recordCompilers: this.recordCompilers,
    } as const;

    for (const entry of entries) {
      // biome-ignore lint/style/useDefaultSwitchClause: RelationMutationEntry is exhaustively discriminated.
      switch (entry.kind) {
        case "create":
          pushFresh(entry);
          break;
        case "createMany":
          pushFresh(entry);
          break;
        case "connect":
          push(
            buildToManyLinkParts(
              input.scope,
              this.engine,
              relation,
              childName,
              childScope,
              childPrimaryKey,
              entry,
              parent.write,
              input.txMode
            )
          );
          break;
        case "disconnect":
          assertRelationCanDisconnect(relation);
          push(
            buildToManyLinkParts(
              input.scope,
              this.engine,
              relation,
              childName,
              childScope,
              childPrimaryKey,
              entry,
              parent.read,
              input.txMode
            )
          );
          break;
        case "connectOrCreate":
          push(
            buildConnectOrCreateParts(
              input.scope,
              this.engine,
              entry.items,
              bindRelationMembership(relation, parent.write),
              input.txMode,
              this.recordCompilers
            )
          );
          break;
        case "upsert":
          if (isInverseToOne) {
            const item = entry.items[0];
            if (!item) {
              throw new QueryEngineError(
                `query-engine-v2 internal: inverse to-one upsert on relation '${relationName}' has no item.`
              );
            }
            push([buildInverseToOneUpsertPart(writeBase, item)]);
            break;
          }
          push(
            buildCorrelatedToManyUpsertParts(
              input.scope,
              this.engine,
              entry.items,
              bindCorrelatedRelationMembership(
                relation,
                planningSourceFromFinal(parent.read, relationName, "upsert"),
                parent.write
              ),
              input.txMode,
              this.recordCompilers
            )
          );
          break;
        case "update":
          push(
            isInverseToOne
              ? [buildToOneUpdatePart(writeBase, entry)]
              : buildToManyUpdateParts(writeBase, entry)
          );
          break;
        case "updateMany":
          if (!updateManyCarriesRelations(childScope, entry.items)) {
            push(buildToManyUpdateManyParts(writeBase, entry));
          }
          break;
        case "delete":
          push(
            isInverseToOne
              ? buildToManyDeleteManyParts(writeBase, {
                  kind: "deleteMany",
                  filters: [{}],
                })
              : buildToManyDeleteParts(writeBase, entry)
          );
          break;
        case "deleteMany":
          push(buildToManyDeleteManyParts(writeBase, entry));
          break;
        case "set":
          assertRelationCanDisconnect(relation);
          push([
            buildToManySetPart(
              { ...writeBase, parentId: parent.write },
              entry,
              parent.read
            ),
          ]);
          break;
      }
    }
  }

  private resolvePolymorphicParent(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: BoundPolymorphicChildHeldRelation
  ): {
    readonly read: FinalReferenceSource;
    readonly write: FinalReferenceSource;
    readonly afterRoot: boolean;
  } {
    const field = relation.referencedFields[0];
    const pinned = this.pinnedTargetValue(field);
    const read = pinned
      ? literalParentId(pinned.value)
      : plannedParentId(this.targetReadId);
    if (!pinned) input.parentFkLocateFields.add(field);
    if (!Object.hasOwn(input.rootScalarData, field)) {
      return { read, write: read, afterRoot: false };
    }

    if (pinned) {
      return {
        read,
        write: literalParentId(
          getUpdatedPrimaryKeyValue(
            this.model,
            field,
            pinned.value,
            input.rootScalarData[field],
            getStepModelName(this.model, "record")
          )
        ),
        afterRoot: true,
      };
    }

    const model = this.model;
    const operand = input.rootScalarData[field];
    return {
      read,
      write: transitionedParentId(this.targetReadId, field, (before) => {
        const classified = classifyRelationKeyScalarUpdate(operand);
        const literal = classified.resolved ? classified.value : operand;
        if (literal === null || isSql(literal)) {
          throw new UnsupportedOperationError(
            `query-engine update nested create on relation '${relation.relationInfo.name}' references a non-literal rewritten column '${field}'.`
          );
        }
        return getUpdatedPrimaryKeyValue(
          model,
          field,
          before,
          operand,
          getStepModelName(model, "record")
        );
      }),
      afterRoot: true,
    };
  }

  /**
   * A child-held nested `create`/`createMany` under the update root (T3b-2 family E,
   * generalized by N1-U1). The fresh child's foreign key is the located parent's
   * referenced column, resolved by {@link resolveCreateParent} to either a
   * construction-time literal (the `where` pins it, or the root SET rewrites it) or a
   * `planned` read of the LOCATE step — the located-parent Ref. Both provenances feed
   * the same leaf builders and compile to the same statements; only where the value
   * comes from differs.
   */
  private interpretChildHeldCreate(args: {
    entry: Extract<RelationMutationEntry, { kind: "create" | "createMany" }>;
    relation: OrdinaryChildHeldRelation;
    childScope: QueryScope;
    childName: string;
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0];
  }): void {
    const { entry, relation, childScope, childName, input } = args;
    const relationName = relation.relationInfo.name;
    const { members, afterRoot } = this.resolveCreateParent(input, relation);
    const isLiteralParent = members.every((member) =>
      literalReferenceSource(member.writeSource)
    );
    // A transitioned-PK parent (T4b CLASS III) orders its fresh INSERT AFTER the root
    // UPDATE; every other create — literal or located-parent Ref — rides the normal
    // child-part order (its referenced column is not rewritten, so the value the fresh
    // row references already exists before the root UPDATE runs).
    const target = afterRoot ? input.afterRootParts : input.childParts;
    const leaf = {
      scope: input.scope,
      engine: this.engine,
      childScope,
      childName,
      relationName,
      members,
    } as const;
    if (entry.kind === "create") {
      target.push(
        ...entry.items.map((data) =>
          this.createFresh({
            childScope: leaf.childScope,
            data,
            incomingMembership: {
              kind: "foreignKey",
              relation,
              members: leaf.members,
            },
            relationName: leaf.relationName,
          })
        )
      );
      return;
    }
    target.push(
      isLiteralParent
        ? buildLiteralParentCreateManyPart({
            ...leaf,
            createManyEntry: entry,
          })
        : buildPlannedParentCreateManyPart({
            ...leaf,
            createManyEntry: entry,
          })
    );
  }

  /** Where a child-held nested create's foreign key comes from, and where the fresh
   *  INSERT is ordered (`afterRoot`).
   *
   *  **No referenced column is rewritten by the root SET** (the ordinary case):
   *   - a SINGLE referenced column the unique `where` PINS → a construction-time literal,
   *     `afterRoot: false`. Byte-identical to the pre-N1 plan: no extra locate column, no
   *     extra statement, no compile-time resolution;
   *   - anything else — the `where: { email }` spelling, whose discriminator names a
   *     DIFFERENT column than the one the child FK references, or a COMPOUND reference
   *     (N1-U2) — → the **located-parent Ref**: every referenced column joins the locate
   *     read's select/outputs, and the fresh row's FK is resolved PER FIELD at compile from
   *     the row the locate ACTED ON (the wrong-row doctrine: never from re-consulting the
   *     `where`). Compound needs no new mechanism — a compound foreign key is per-field
   *     (ATOM “Field-bound foreign-key provenance”), and the leaf's inject already loops the FK
   *     columns index-aligned with the referenced ones. Still `afterRoot: false` — no
   *     referenced value is being rewritten, so all of them already exist before the root
   *     UPDATE runs.
   *
   *  **A referenced column IS rewritten** (a transition). The referential ACTION decides,
   *  because it decides whether a post-transition value is needed at all:
   *   - `ON UPDATE CASCADE`, any arity, pinned or not (N5-U2) → the LOCATED pre-transition
   *     values, `afterRoot: false`. The INSERT lands before the root UPDATE and the cascade
   *     carries the fresh row's foreign key new — the ordering a reparent already gets;
   *   - a NON-cascading **transitioned PRIMARY KEY** whose pre-transition value the `where`
   *     pins (T4b CLASS III) → the POST-transition id, derived by
   *     `getUpdatedPrimaryKeyValue` (the same JS==SQL derivation the terminal read already
   *     trusts, portability guaranteed by `assertPortablePrimaryKeyUpdateInput` on the root
   *     SET) → `afterRoot: true`, so the INSERT lands after the root UPDATE creates the row;
   *   - a non-cascading non-PK referenced column rewritten to a literal → that literal,
   *     `afterRoot: false`.
   *
   *  The three survivors are typed refusals, not oversights — see each throw. */
  private resolveCreateParent(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: OrdinaryChildHeldRelation
  ): { members: ForeignKeyMember[]; afterRoot: boolean } {
    const relationName = relation.relationInfo.name;
    const referencedFields = relation.referencedFields;
    const rewritten = referencedFields.filter((field) =>
      Object.hasOwn(input.rootScalarData, field)
    );
    if (rewritten.length === 0) {
      return this.locatedCreateParent(input, relation);
    }
    // N5-U2 — a rewritten reference on an `ON UPDATE CASCADE` edge needs NO
    // post-transition derivation at all, whatever its arity and wherever its
    // pre-transition value lives. Write the fresh row against the LOCATED (pre-transition)
    // values, before the root UPDATE, and the cascade carries it new — the same ordering
    // `reorderRootUpdateAfterChildren` already applies to a reparent, applied to an
    // INSERT. `locatedCreateParent` is entered unchanged, so a compound reference rides
    // it per field exactly as N1-U2 made it. This is checked BEFORE the arity and
    // pinned-value branches below, because both of those exist only to derive a
    // POST-transition value, and a cascading edge never needs one.
    if (relation.onUpdate === "cascade") {
      return this.locatedCreateParent(input, relation);
    }
    if (referencedFields.length !== 1) {
      // E6.7 — a NON-cascade COMPOUND reference the root SET rewrites. The located row
      // carries the pre-transition members, but a NO-ACTION foreign key does not follow
      // them, so the fresh row must reference the POST-transition TUPLE — per member:
      // `getUpdatedPrimaryKeyValue` over each located value and its operand, at COMPILE
      // (the locate has run) rather than at construction. That is exactly what
      // {@link transitionedParentId} names, and building it is this branch's whole work.
      // A member the SET leaves alone comes back verbatim, so a partially rewritten tuple
      // needs no second source.
      return this.transitionedCreateParent(input, relation);
    }
    const referencedField = referencedFields[0]!;
    // A rewritten PRIMARY KEY is a transition: the fresh child references the new PK.
    // T4b CLASS III — the post-transition value is COMPILE-known, derived from the
    // where-pinned pre-transition value by `getUpdatedPrimaryKeyValue` (the same exact
    // JS==SQL arithmetic the terminal read trusts; the root SET already passed
    // `assertPortablePrimaryKeyUpdateInput`, so a non-portable op is impossible here).
    // The INSERT is ordered AFTER the root UPDATE (`afterRoot: true`) because a
    // NO-ACTION FK does not cascade a fresh row: the new parent must exist first.
    if (this.parentPrimaryKeys.includes(referencedField)) {
      const pinnedBefore = this.pinnedTargetValue(referencedField);
      if (!pinnedBefore) {
        // E6.7 — the `where` pins some OTHER unique, so the pre-transition value lives
        // only in the located row. N5-U2 measured that the Ref reaches it; what a
        // NO-ACTION foreign key needs is the POST-transition value, and
        // `getUpdatedPrimaryKeyValue(before, operand)` can only run once `before` is
        // known, i.e. at COMPILE. That is the one thing every construction-fixed source
        // could not do, and {@link transitionedParentId} is it — the SAME per-member
        // source mechanism the compound branch above takes, which is why one mechanism
        // closed both.
        return this.transitionedCreateParent(input, relation);
      }
      const transitioned = getUpdatedPrimaryKeyValue(
        this.model,
        referencedField,
        pinnedBefore.value,
        input.rootScalarData[referencedField],
        getStepModelName(this.model, "record")
      );
      return {
        members: pairForeignKeyMembers(
          relation.foreignFields,
          referencedFields,
          [literalParentId(transitioned)]
        ),
        afterRoot: true,
      };
    }
    // N7-U-B — `{ set: v }` is the SAME assignment as the bare `v`, spelled with the
    // envelope Prisma's scalar update input allows. `classifyRelationKeyScalarUpdate`
    // is the engine's one reader of that envelope (the own-write legality walk and
    // `TargetConstraint` already ask it the same question), so the normalization is
    // borrowed, not invented: an operand it calls RESOLVED is the value the SET writes.
    // What stays refused is the shape that HAS no construction-time value — `Sql`, a
    // `{ increment }` / `{ multiply }` arithmetic op, a batch-value `Ref`, and `null`
    // (which references no row) — see the throw's own record.
    const operand = input.rootScalarData[referencedField];
    const resolved = classifyRelationKeyScalarUpdate(operand);
    const literal = resolved.resolved ? resolved.value : operand;
    if (!isConstructionLiteral(literal)) {
      // MEASURED (N7-U-B): what reaches here after the `{ set: v }` unwrapping above is
      // an operand with NO value at construction. `INSERT … VALUES (<the post-SET
      // value>)` is trivial SQL; what the engine cannot spell is the value itself. An
      // `Sql` operand re-evaluated for the FK is a SECOND provenance
      // (`gen_random_uuid()` twice is two values, the N4-U4 measurement); `null`
      // references no row at all. Arithmetic (`{ increment }` / `{ multiply }`) never
      // arrives: the CLASS IV relation-key legality guard pre-empts it with its own
      // message ("Use a literal value or '{ set: ... }'") — measured, N7 verify. The
      // missing mechanism is the same either way: a `planned` source carrying the SET
      // operand, which the two branches above also name.
      throw new UnsupportedOperationError(
        `query-engine-v2 update nested create on relation '${relationName}' references a non-literal rewritten column '${referencedField}'.`
      );
    }
    return {
      members: pairForeignKeyMembers(relation.foreignFields, referencedFields, [
        literalParentId(literal),
      ]),
      afterRoot: false,
    };
  }

  /**
   * E6.7 — the parent id for a nested create under a NON-CASCADE transition whose
   * post-transition value has no construction-time spelling: a compound reference, or a
   * single primary key the unique `where` does not pin.
   *
   * The derivation is the pinned sibling's, moved one phase later. `getUpdatedPrimaryKeyValue`
   * is the same JS==SQL arithmetic the terminal read and the T4b create leaf already
   * trust; the only change is WHERE `before` comes from — the located row instead of the
   * `where` — and therefore WHEN it can run. The referenced columns join
   * `parentFkLocateFields`, not `locateFields`: they must appear in the locate's SELECT
   * and `firstRowField` outputs, and they must NOT drive `reorderRootUpdateAfterChildren`,
   * because the fresh INSERT is deliberately ordered AFTER the root UPDATE
   * (`afterRoot: true`) — a NO-ACTION foreign key does not cascade a fresh row, so the
   * new parent has to exist first. Reordering the root UPDATE behind the children would
   * invert exactly that.
   *
   * The operand classes are already bounded when this runs, which is what makes the
   * derivation total rather than a guess:
   *
   *  · a NON-primary-key referenced column reaches here only construction-resolved —
   *    `assertRelationKeyUpdatesAreCompilable` refuses every other operand on a column an
   *    edge references, with CLASS IV's own message ("Use a literal value or
   *    '{ set: ... }'"), and it exempts primary keys explicitly;
   *  · a PRIMARY-KEY column has passed `assertPortablePrimaryKeyUpdateInput`, so exactly
   *    one operation is spelled and arithmetic on a float/decimal key is already gone.
   *    What remains — a bare value, `{ set }`, and PORTABLE arithmetic — is precisely the
   *    domain `getUpdatedPrimaryKeyValue` computes, JS==SQL, as the terminal read already
   *    trusts it to.
   *
   * The two operands with no derivable post value keep a TYPED refusal here rather than
   * falling into the internal error `getUpdatedPrimaryKeyValue` raises for them: `Sql`
   * (whose value exists only once the database evaluates it) and `null` (which references
   * no row at all). E6.6 measured that only the `null` arm is reachable from the public
   * client — the parse boundary has no `Sql` member in write data — and the message is
   * the one that family already owns.
   */
  private transitionedCreateParent(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: OrdinaryChildHeldRelation
  ): { members: ForeignKeyMember[]; afterRoot: boolean } {
    const relationName = relation.relationInfo.name;
    const referencedFields = relation.referencedFields;
    for (const field of referencedFields) {
      input.parentFkLocateFields.add(field);
    }
    const model = this.model;
    const rootScalarData = input.rootScalarData;
    const stepModelName = getStepModelName(model, "record");
    return {
      members: pairForeignKeyMembers(
        relation.foreignFields,
        referencedFields,
        referencedFields.map((field) =>
          transitionedParentId(
            this.targetReadId,
            field,
            (before, boundField) => {
              // A member the SET leaves alone is not in transition: the located value IS
              // the value the fresh row must reference.
              if (!Object.hasOwn(rootScalarData, boundField)) return before;
              const operand = classifyRelationKeyScalarUpdate(
                rootScalarData[boundField]
              );
              const literal = operand.resolved
                ? operand.value
                : rootScalarData[boundField];
              if (literal === null || isSql(literal)) {
                throw new UnsupportedOperationError(
                  `query-engine-v2 update nested create on relation '${relationName}' references a non-literal rewritten column '${boundField}'.`
                );
              }
              return getUpdatedPrimaryKeyValue(
                model,
                boundField,
                before,
                rootScalarData[boundField],
                stepModelName
              );
            }
          )
        )
      ),
      afterRoot: true,
    };
  }

  /**
   * N1-U1/U2 — the parent id for a nested create whose referenced columns the root SET
   * leaves alone. A SINGLE referenced column the unique `where` PINS keeps its
   * construction-time literal (the pre-N1 plan, byte for byte). Everything else — an
   * unpinned reference (`where: { email }` while the child FK references `id`) or a
   * COMPOUND one — takes THE LOCATED-PARENT REF.
   *
   * It was never an unknowable value: the locate read already reads this row. Registering
   * each referenced field in `locateFields` is what makes the locate expose it (its SELECT
   * plus a `firstRowField` output); `plannedParentId` is what makes the create leaf read it
   * from the LOCATED ROW rather than re-deriving it from the `where` (ATOM “Wrong-row protection,” and
   * the wrong-row doctrine's requirement). Compound rides the same call: the leaf's inject
   * loops the FK columns index-aligned with the referenced ones and resolves each by NAME
   * from that row, so the parent-id source names the readStep and the per-field lookup does
   * the rest. Under a transaction the locate holds `FOR UPDATE`, so no value can move
   * between read and write; under an atomic batch the root-presence guard pins the row
   * inside the unit.
   */
  private locatedCreateParent(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: OrdinaryChildHeldRelation
  ): { members: ForeignKeyMember[]; afterRoot: boolean } {
    const referencedFields = relation.referencedFields;
    // The shortcut asks the CALLER'S unique `where` whether it pins this column to a
    // literal. A nested target located by correlation alone has no such `where` (`{}`
    // — see `parentWhere`), so there is no asker and nothing to pin; reached through
    // E1 U4's delegated upsert arm, which is the first shape to bring a child-held
    // create under a selector-less target. Falling through takes the located-row
    // `Ref`, which is the provenance the wrong-row doctrine wants regardless.
    if (referencedFields.length === 1) {
      const pinned = this.pinnedTargetValue(referencedFields[0]!);
      if (pinned) {
        return {
          members: pairForeignKeyMembers(
            relation.foreignFields,
            referencedFields,
            [literalParentId(pinned.value)]
          ),
          afterRoot: false,
        };
      }
    }
    for (const field of referencedFields) input.locateFields.add(field);
    return {
      members: pairForeignKeyMembers(
        relation.foreignFields,
        referencedFields,
        referencedFields.map(() => plannedParentId(this.targetReadId))
      ),
      afterRoot: false,
    };
  }

  private interpretToManyKind(args: {
    entry: RelationMutationEntry;
    relation: ChildHeldToMany;
    childScope: QueryScope;
    childName: string;
    childPrimaryKey: string;
    writeBase: Parameters<typeof buildToManyUpdateParts>[0];
    input: {
      scope: StepScope;
      parent: QueryScope;
      parentIdSource: ReturnType<typeof plannedParentId>;
      txMode: boolean;
      childParts: Part[];
    };
    /** N5-U1 — present only under a guarded non-cascade referenced-PK transition. */
    adopt?: PostTransitionAdopt;
  }): void {
    const {
      entry,
      relation,
      childScope,
      childName,
      childPrimaryKey,
      writeBase,
      input,
      adopt,
    } = args;
    const { relationInfo, foreignFields, referencedFields } = relation;
    const relationName = relationInfo.name;
    const push = (parts: readonly Part[]) => input.childParts.push(...parts);
    // N5-U1: an adopt kind writes the POST-transition value and is held back until
    // after the root UPDATE; without a transition both fall back to the pre-N5
    // located-parent source and the ordinary child-part list, byte for byte.
    const adoptParentId = adopt?.parentId ?? input.parentIdSource;
    const pushAdopt = (parts: readonly Part[]) =>
      (adopt?.target ?? input.childParts).push(...parts);

    switch (entry.kind) {
      case "upsert": {
        const readSources = referencedFields.map(() =>
          planningSourceFromFinal(input.parentIdSource, relationName, "upsert")
        );
        const writeSources = referencedFields.map(() => adoptParentId);
        const members = pairCorrelatedForeignKeyMembers(
          foreignFields,
          referencedFields,
          readSources,
          writeSources
        );
        pushAdopt(
          buildCorrelatedToManyUpsertParts(
            input.scope,
            this.engine,
            entry.items,
            {
              kind: "foreignKey",
              relation,
              members,
            },
            input.txMode,
            this.recordCompilers
          )
        );
        return;
      }
      case "connectOrCreate":
        // Still a GLOBAL lookup-and-adopt under update (found → reparent, absent
        // → create), never correlated — composed like the upsert part.
        pushAdopt(
          buildConnectOrCreateParts(
            input.scope,
            this.engine,
            entry.items,
            {
              kind: "foreignKey",
              relation,
              members: pairForeignKeyMembers(
                foreignFields,
                referencedFields,
                referencedFields.map(() => adoptParentId)
              ),
            },
            input.txMode,
            this.recordCompilers
          )
        );
        return;
      case "connect":
      case "disconnect": {
        if (entry.kind === "disconnect") {
          // A required child FK cannot be nulled — V1's verbatim typed rejection.
          assertRelationCanDisconnect(relation);
        }
        // `connect` adopts (post-transition value, after the root UPDATE); `disconnect`
        // releases rows that carry the parent's CURRENT value and its probe correlates
        // on the located row in SQL, so it keeps the planned source and its place among
        // the ordinary child parts.
        const isAdopt = entry.kind === "connect";
        const parts = buildToManyLinkParts(
          input.scope,
          this.engine,
          relation,
          childName,
          childScope,
          childPrimaryKey,
          entry,
          isAdopt ? adoptParentId : input.parentIdSource,
          input.txMode
        );
        if (isAdopt) pushAdopt(parts);
        else push(parts);
        return;
      }
      case "update":
        push(buildToManyUpdateParts(writeBase, entry));
        return;
      case "updateMany":
        // CLASS V (T4c): a relation-carrying updateMany is rejected by the legality
        // check (immediate at construction for a plain update, or deferred to the taken
        // upsert branch). Skip building the Part so its construction does not throw
        // ahead of that runtime-branch-gated verdict (an untaken upsert update arm
        // whose invalid updateMany never runs must not reject the whole tree).
        if (updateManyCarriesRelations(childScope, entry.items)) {
          return;
        }
        push(buildToManyUpdateManyParts(writeBase, entry));
        return;
      case "delete":
        push(buildToManyDeleteParts(writeBase, entry));
        return;
      case "deleteMany":
        push(buildToManyDeleteManyParts(writeBase, entry));
        return;
      case "set":
        // `set` is BOTH halves at once: it reparents its targets (the adopt half —
        // post-transition value, after the root UPDATE) and releases the departing
        // rows, which still carry the PRE-transition value. `membershipReadSource`
        // keeps those two apart; without a transition they are the same source.
        pushAdopt([
          buildToManySetPart(
            adopt ? { ...writeBase, parentId: adopt.parentId } : writeBase,
            entry,
            adopt?.membershipReadSource
          ),
        ]);
        return;
      default:
        // Unreachable by construction (N7-U-A, the X1c disposition). The claim this
        // comment used to make — "create / createMany nested under update are V1's
        // surface" — has been false since T3b-2: both are handled UPSTREAM at
        // `interpretChildHeldCreate`, and the nine cases above cover the rest of
        // `toManyUpdateFactory`'s key set. Measured: all ELEVEN to-many keys construct on
        // this path, so nothing falls through here. An engine invariant, not a route.
        throw new QueryEngineError(
          `query-engine-v2 internal: unsupported entry reached the child-held update dispatch on relation '${relationName}'; the parse boundary admits only the eleven to-many kinds, all of which are handled above.`
        );
    }
  }

  /**
   * Compile one child-held to-one mutation. This is the arity-one child-held
   * family: correlation is the locator, and the parse boundary limits the dispatch
   * to create/connect/connectOrCreate/update/upsert plus optional disconnect/delete.
   */
  private interpretInverseToOneKind(args: {
    entry: RelationMutationEntry;
    relation: ChildHeldToOne;
    childScope: QueryScope;
    childName: string;
    childPrimaryKey: string;
    writeBase: Parameters<typeof buildToManyUpdateParts>[0];
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0];
    keyTransition: ReturnType<
      RecordUpdateCompilerState["interpretReferencedKeyTransition"]
    >;
    /** N5-U1 — present only under a guarded non-cascade referenced-PK transition. */
    adopt?: PostTransitionAdopt;
  }): void {
    const {
      entry,
      relation,
      childScope,
      childName,
      childPrimaryKey,
      writeBase,
      input,
      keyTransition,
      adopt,
    } = args;
    const { relationInfo, foreignFields, referencedFields } = relation;
    const relationName = relationInfo.name;
    const push = (parts: readonly Part[]) => input.childParts.push(...parts);
    // N5-U1 — the arity-1 case of the to-many adopt ordering (see interpretToManyKind).
    const adoptParentId = adopt?.parentId ?? input.parentIdSource;
    const pushAdopt = (parts: readonly Part[]) =>
      (adopt?.target ?? input.childParts).push(...parts);

    switch (entry.kind) {
      case "create":
        // The database's unique child FK is the sole occupied-slot guard. This
        // unconditional create has no racePin: a collision is a genuine conflict,
        // not a missing-arm race to retry.
        this.interpretChildHeldCreate({
          entry,
          relation,
          childScope,
          childName,
          input,
        });
        return;
      case "connect":
        // Global lookup-and-adopt. The unique child FK enforces the one-row slot.
        pushAdopt(
          buildToManyLinkParts(
            input.scope,
            this.engine,
            relation,
            childName,
            childScope,
            childPrimaryKey,
            entry,
            adoptParentId,
            input.txMode
          )
        );
        return;
      case "connectOrCreate":
        pushAdopt(
          buildConnectOrCreateParts(
            input.scope,
            this.engine,
            entry.items,
            {
              kind: "foreignKey",
              relation,
              members: pairForeignKeyMembers(
                foreignFields,
                referencedFields,
                referencedFields.map(() => adoptParentId)
              ),
            },
            input.txMode,
            this.recordCompilers
          )
        );
        return;
      case "update":
        // Correlation is the whole locator. The optional
        // `{ where, data }` wrapper arrives already told apart from bare data by the
        // relation schema, as its canonical envelope; the filter narrows that
        // locator. See `splitToOneUpdateTarget`.
        input.childParts.push(buildToOneUpdatePart(writeBase, entry));
        return;
      case "upsert": {
        // The correlated probe
        // decides found → update / absent → create (fk = parent), no unique `where`.
        // The same correlated locator as the `update` arm, with a create branch.
        //
        // CLASS IV (T4c): when the SAME root update TRANSITIONS a parent PK this child
        // FK references, the relation-level {@link interpretReferencedKeyTransition} has
        // already emitted the occupied guard; here the
        // empty-slot accept-shape reroutes the CREATE arm to a POST-transition-FK leaf
        // ordered after the root UPDATE (the update arm is unreachable: occupied rejects,
        // empty creates). A cascade / no-op / non-transition keeps the ordinary part.
        const item = entry.items[0];
        if (!item) {
          throw new QueryEngineError(
            `query-engine-v2 internal: inverse to-one upsert on relation '${relationName}' has no item.`
          );
        }
        if (keyTransition.regime === "guarded") {
          this.rerouteTransitionedUpsertCreateArm({
            input,
            relation,
            childScope,
            childName,
            upsertInput: item,
            after: keyTransition.after,
          });
          return;
        }
        input.childParts.push(buildInverseToOneUpsertPart(writeBase, item));
        return;
      }
      case "disconnect": {
        // A required child FK cannot be nulled — V1's verbatim typed rejection.
        assertRelationCanDisconnect(relation);
        // The arm's value is `true` by construction: the parse boundary types an
        // inverse-side to-one `disconnect` as `v.boolean()`, and `false` is Prisma's
        // no-op, dropped from the kind list (N7-U-B).
        push(
          buildToManyLinkParts(
            input.scope,
            this.engine,
            relation,
            childName,
            childScope,
            childPrimaryKey,
            entry,
            input.parentIdSource,
            input.txMode
          )
        );
        return;
      }
      case "delete":
        // `delete: true` is a correlated bulk delete — DELETE child WHERE fk = parent
        // (V1's `RelationRemovals.delete` input===true, child-held arm). `true` is the
        // arm's only reachable value: the parse boundary types it `v.boolean()` and
        // `false` is Prisma's no-op, dropped from the kind list (N7-U-B).
        push(
          buildToManyDeleteManyParts(writeBase, {
            kind: "deleteMany",
            filters: [{}],
          })
        );
        return;
      default:
        // Unreachable: the seven keys the to-one relation schema can deliver each have a
        // case above (see this method's doc). A `createMany` / `deleteMany` / `set` /
        // `updateMany` here would mean the parse boundary let through a key it does not
        // define — an engine invariant break, not a shape we decline, so it is a
        // `QueryEngineError` and NOT an `UnsupportedOperationError` route (the X1c
        // precedent for a branch made unreachable by construction). Fail closed rather
        // than fall through and silently drop the mutation.
        throw new QueryEngineError(
          `query-engine-v2 update reached an unknown nested entry on the inverse-side to-one relation '${relationName}'.`
        );
    }
  }

  /**
   * CLASS IV (T4c / T4c-fix) — V1's `RelationUpdates.compileRelationKeyGuards`,
   * reproduced at the RELATION level (kind- AND cardinality-agnostic, exactly as V1
   * loops `relations` independent of the mutation planning). A child-held, non-cascade
   * relation whose referenced key the SAME root update TRANSITIONS may not leave the OLD
   * slot occupied: V1 rejects `Cannot update relation '…' with onUpdate('…') while the
   * current relation is occupied.` for ANY nested mutation on it (upsert / update /
   * delete / disconnect / create / …) and either cardinality. Called once per relation
   * before the per-kind dispatch, and kind-BLIND in its body since N5-U1 removed the one
   * per-kind branch it had (the adopt refusal): the guard belongs to the relation, the
   * ordering to the kind. Returns which regime applies:
   *   · **`"none"`** — parent-held / `ON UPDATE CASCADE`, no referenced column written,
   *     or a no-op (`increment: 0` / `set` same, before == after). The ordinary parts
   *     are byte-identical; no guard.
   *   · **`"guarded"`** — a real non-cascade transition of a SINGLE PRIMARY KEY pinned by
   *     the unique `where` (before is a compile literal). V1's occupied guard is emitted
   *     (reject an occupied OLD slot); the correlated / literal-parent-create kinds keep
   *     their ordinary part (empty-slot native), the to-one upsert reroutes its create
   *     arm off `after`. The ADOPT kinds (`connect` / `connectOrCreate` / `set`, and a
   *     to-many `upsert`) take `after` as their parent value and are ORDERED after the
   *     root UPDATE — N5-U1's {@link PostTransitionAdopt}, which is why `after` is
   *     returned rather than consumed here.
   *   · **`"pastSurface"`** — a real transition past the reproduced surface (a compound
   *     edge, a non-PK referenced unique — the D4 case, or a pre-value the `where` does
   *     not pin). V2 cannot compile-correlate the occupied guard, so only nested
   *     `create` / `createMany` proceed (their FK literal, incl. a non-PK D4 rewrite, is
   *     resolved by {@link resolveLiteralCreateParent} against the empty-slot accept); any
   *     other kind is refused because {@link interpretRelation} cannot pin that
   *     pre-transition identity.
   */
  private interpretReferencedKeyTransition(args: {
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0];
    relation: ChildHeldRelation;
    childScope: QueryScope;
    childName: string;
  }):
    | { regime: "none" }
    | { regime: "guarded"; after: unknown }
    | {
        regime: "pastSurface";
      } {
    const { input, relation, childScope, childName } = args;
    const { foreignFields, referencedFields } = relation;
    if (relation.onUpdate === "cascade") return { regime: "none" };
    // Does the root SET rewrite a referenced parent column?
    const changed = referencedFields.filter((field) =>
      Object.hasOwn(input.rootScalarData, field)
    );
    if (changed.length === 0) return { regime: "none" };
    // The occupied guard is reproduced natively only for a single primary-key reference
    // pinned by the unique `where` (before is a compile literal). A compound edge, a
    // non-PK referenced unique (D4), or an unpinned pre-value is past that surface.
    if (
      referencedFields.length !== 1 ||
      foreignFields.length !== 1 ||
      !this.parentPrimaryKeys.includes(referencedFields[0]!)
    ) {
      return { regime: "pastSurface" };
    }
    const referencedField = referencedFields[0]!;
    const foreignField = foreignFields[0]!;
    const pinned = this.pinnedTargetValue(referencedField);
    if (!pinned) {
      return { regime: "pastSurface" };
    }
    const before = pinned.value;
    const after = getUpdatedPrimaryKeyValue(
      this.model,
      referencedField,
      before,
      input.rootScalarData[referencedField],
      getStepModelName(this.model, "record")
    );
    // No-op transition (increment 0 / set same): the slot stays; ordinary parts hold.
    if (sameScalarValue(before, after)) return { regime: "none" };
    // Emit V1's occupied guard (reject when the OLD slot, a child correlated on the
    // pre-transition parent value, is occupied). Hoisted ahead of every write, so the
    // rejection lands before the ordinary correlated / literal-parent-create part runs.
    this.pushOccupiedGuard({
      input,
      relation,
      childScope,
      childName,
      before,
      foreignField,
    });
    return { regime: "guarded", after };
  }

  /** CLASS IV (T4c) — emit V1's occupied guard onto `relationKeyGuards`: a read of the
   *  OLD slot (a child correlated on the pre-transition parent value), locked in tx mode.
   *  The probe reads at planning; the verdict fires at compile ({@link compileRelationKeyGuards}),
   *  independent of the nested mutation kind — tx throws V1's byte-identical
   *  `NestedWriteError` before any write, batch pins the empty-slot race with an absence
   *  guard. */
  private pushOccupiedGuard(args: {
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0];
    relation: ChildHeldRelation;
    childScope: QueryScope;
    childName: string;
    before: unknown;
    foreignField: string;
  }): void {
    const { input, relation, childScope, childName, before, foreignField } =
      args;
    const childPk = getPrimaryKeyFields(childScope.model)[0]!;
    const probeId = input.scope.allocate(`${childName}.transition.find`);
    input.relationKeyGuards.push({
      relation,
      probeId,
      guardId: input.scope.allocate(`${childName}.guard.occupied`),
      probe: {
        id: probeId,
        kind: "read",
        statement: buildFind(
          childScope,
          {
            where: { [foreignField]: { equals: before } },
            select: { [childPk]: true },
            forUpdate: input.txMode,
          },
          { limit: 1 }
        ),
        outputs: { rows: { kind: "rows" } },
      },
    });
  }

  /** CLASS IV (T4c) — the to-one upsert's empty-slot accept-shape under a real
   *  non-cascade referenced-PK transition: its CREATE arm runs with the POST-transition
   *  FK, ordered AFTER the root UPDATE (a NO-ACTION FK does not cascade a fresh row — the
   *  new parent must exist first), exactly the T4b transitioned-PK create leaf. The
   *  update arm never runs (the occupied guard rejects an occupied slot; an empty slot
   *  creates). The relation-level occupied guard is already emitted
   *  ({@link interpretReferencedKeyTransition}). */
  private rerouteTransitionedUpsertCreateArm(args: {
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0];
    relation: ChildHeldToOne;
    childScope: QueryScope;
    childName: string;
    upsertInput: NormalizedRelationUpsert;
    after: unknown;
  }): void {
    const { input, relation, childScope, upsertInput, after } = args;
    const relationName = relation.relationInfo.name;
    const createData = upsertInput.create;
    const members = pairForeignKeyMembers(
      relation.foreignFields,
      relation.referencedFields,
      relation.referencedFields.map(() => literalParentId(after))
    );
    input.afterRootParts.push(
      this.createFresh({
        childScope,
        data: createData,
        incomingMembership: { kind: "foreignKey", relation, members },
        relationName,
      })
    );
  }

  /** Compile one parent-held to-one mutation at its required position. */
  private interpretParentHeldToOne(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: ParentHeldToOne,
    entry: RelationMutationEntry
  ): void {
    const { relationInfo } = relation;
    const relationName = relationInfo.name;
    switch (entry.kind) {
      case "connect":
      case "disconnect":
        input.toOneLinks.push(
          this.interpretToOneLink(input.scope, relation, entry)
        );
        return;
      case "create":
        input.parentHeldTargets.push(
          this.interpretParentHeldCreate(relation, entry)
        );
        return;
      case "connectOrCreate":
        input.parentHeldTargets.push(
          this.interpretParentHeldConnectOrCreate(input, relation, entry)
        );
        return;
      case "update": {
        // W4-U3: the to-one `update` payload reaches here as the relation schema's
        // canonical envelope — bare data and Prisma's `{ where?, data }` wrapper are
        // told apart ONCE, at the parse, off the user's own payload (a schema output
        // rewrites scalar shorthands and is not a faithful witness of the form). The
        // wrapper's `where` is a NON-unique filter on the currently connected record;
        // it rides the locate, never the write. The bare form yields no filter and is
        // byte-identical to pre-W4-U3.
        const item = entry.items[0];
        if (!(item && item.target.kind === "correlated")) {
          throw new QueryEngineError(
            `query-engine-v2 internal: parent-held to-one update on relation '${relationName}' requires one correlated target.`
          );
        }
        const target: ToOneUpdateTarget = {
          data: item.data,
          ...(item.target.filter ? { filter: item.target.filter } : {}),
        };
        const compiled = this.interpretParentHeldUpdate(
          input,
          relation,
          target
        );
        if (compiled) input.parentHeldTargets.push(compiled);
        return;
      }
      case "delete":
        input.parentHeldTargets.push(
          this.interpretParentHeldDelete(input, relation)
        );
        return;
      case "upsert":
        input.parentHeldTargets.push(
          this.interpretParentHeldUpsert(input, relation, entry)
        );
        return;
      default:
        // Unreachable by construction (N7-U-A, the X1c disposition): `toOneUpdateFactory`
        // offers exactly create / connect / connectOrCreate / update / upsert (+ disconnect
        // and delete when the relation is optional). `connect` and `disconnect` are
        // dispatched to `interpretToOneLink` above this switch and the rest have arms; a
        // to-many-only key such as `set` / `createMany` / `updateMany` / `deleteMany` is
        // answered by the parse boundary first (`ValidationError: Unknown key: <kind>`).
        throw new QueryEngineError(
          `query-engine-v2 internal: an unsupported entry reached the parent-held to-one update dispatch on relation '${relationName}'; the parse boundary admits no such key there.`
        );
    }
  }

  /**
   * Build the family-A correlation ledger for a parent-held to-one arm: the child
   * is located by `child.<referenced> = parent.<fk>` where the parent's FK value is
   * its FINAL value (V1 correlates parent-held relations on post-update parentValues).
   * A column the same root update rebinds resolves to a construction-time literal;
   * an untouched column reads the located parent row.
   *
   * E1 U6 — the referenced column need not be the child's PRIMARY key. The two jobs
   * this ledger does are separate and were conflated: the CORRELATION is
   * `child.<referenced> = <finalFk>`, which any single referenced column answers,
   * and the child's own single primary key is what the probe captures and the arm's
   * write addresses — the immutable handle, exactly as the root update's own locate
   * uses it. So a foreign key that references some OTHER unique of the child is a
   * shape this ledger already expresses; only the ARITY was ever load-bearing.
   *
   * E6.4 — the ARITY OF THE EDGE was never load-bearing either, and the old refusal
   * conflated it with the arity of the child's own key. The ledger's two jobs stay
   * separate: {@link parentHeldCorrelationFilters} already emits ONE conjunct per
   * referenced column, index-aligned with the parent FK column it reads (the same
   * per-field loop `connect` / `disconnect` / `create` on the very same compound edge
   * have always used — measured: those three kinds execute today while these three
   * threw), so a compound edge needs no new mechanism here. What the probe CAPTURES
   * and the arm's write ADDRESSES is the child's own primary key, and that is a
   * single value exactly when the CHILD has one primary key — the one fact this guard
   * still asserts, and the only half of the compound-identity family this unit leaves
   * for the rest of E6.4.
   */
  private parentHeldCorrelation(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: ParentHeldToOne,
    childScope: QueryScope,
    kind: string
  ): { correlation: ParentHeldCorrelation; childPrimaryKey: string } {
    const { relationInfo, foreignFields, referencedFields } = relation;
    const relationName = relationInfo.name;
    const childPrimaryKeys = getPrimaryKeyFields(childScope.model);
    if (childPrimaryKeys.length !== 1) {
      throw new UnsupportedOperationError(
        `query-engine-v2 update requires a child with one primary key for '${kind}' on the parent-held to-one relation '${relationName}'.`
      );
    }
    // Every parent FK column must be a firstRowField output of the locate read so
    // the untouched-column path can ref/read it. Held in the parent-FK set (NOT
    // `locateFields`): these are the parent's own columns, not child-referenced, so
    // a same-root rebind of one must not trigger the child-edge reorder.
    for (const field of foreignFields) input.parentFkLocateFields.add(field);
    return {
      correlation: {
        childReferencedFields: referencedFields,
        parentFkFields: foreignFields,
        override: resolveParentFkRebinds(input.rootScalarData, foreignFields),
      },
      childPrimaryKey: childPrimaryKeys[0]!,
    };
  }

  /** A parent-held to-one `update`: locate the referenced target by the parent's
   *  final FK value, then compile its scalar and descendant mutations against the
   *  captured primary key. */
  private interpretParentHeldUpdate(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: ParentHeldToOne,
    target: ToOneUpdateTarget
  ): ParentHeldTarget | undefined {
    const { relationInfo } = relation;
    const relationName = relationInfo.name;
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const { correlation, childPrimaryKey } = this.parentHeldCorrelation(
      input,
      relation,
      childScope,
      "update"
    );
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    const childUpdate = buildParsedRelationPrograms(childScope, target.data);
    assertPinnedTransitionIsCompilable(
      childScope,
      childUpdate.scalarData,
      childUpdate.relations,
      relationName,
      {}
    );
    assertPortablePrimaryKeyUpdateInput(childScope.model, "update", {
      data: childUpdate.scalarData,
    });
    assertRelationKeyUpdatesAreCompilable(
      childScope,
      childUpdate.scalarData,
      childUpdate.relations
    );
    assertSelectedUpdateManyDataIsScalar(childScope, childUpdate.relations);
    const compiler = this.recordCompilers.updateSelected({
      scope: input.scope,
      engine: this.engine,
      targetScope: childScope,
      scalarData: childUpdate.scalarData,
      relations: childUpdate.relations,
      polymorphic: childUpdate.polymorphic,
      targetRead: { label: `${childName}.find` },
      rootWrite: { label: `${childName}.update` },
      relationName,
    });
    if (!compiler) return undefined;
    const probeId = compiler.targetReadId;
    const hasDescendantPlanning = compiler.planning().length > 0;
    const probe: ReadStep = {
      id: probeId,
      kind: "read",
      statement: this.parentHeldProbeStatement(
        childScope,
        childPrimaryKey,
        correlation,
        undefined,
        true,
        undefined,
        target.filter,
        compiler.targetProjection
      ),
      outputs: hasDescendantPlanning
        ? {
            rows: { kind: "rows" },
            ...targetProjectionOutputs(compiler.targetProjection),
          }
        : { rows: { kind: "rows" } },
      ...(hasDescendantPlanning
        ? {
            expects: exactlyOneRow(
              nestedWriteFailure(
                relationTargetNotFound(relationInfo, "update"),
                relationName,
                false
              )
            ),
          }
        : {}),
    };
    return {
      kind: "update",
      relation,
      childScope,
      childPrimaryKey,
      probeId,
      guardId: input.scope.allocate(`${childName}.guard.exists`),
      correlation,
      probe,
      ...(target.filter ? { filter: target.filter } : {}),
      compiler,
    };
  }

  /** A parent-held to-one `delete: true`: NULL the parent FK (a required FK is V1's
   *  typed reject), then correlated bulk-delete the referenced target. `true` is the
   *  arm's only reachable value — the parse boundary types it `v.boolean()` and `false`
   *  is Prisma's no-op, dropped from the kind list (N7-U-B). */
  private interpretParentHeldDelete(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: ParentHeldToOne
  ): ParentHeldTarget {
    const { relationInfo } = relation;
    const relationName = relationInfo.name;
    // A required (non-nullable) FK cannot be nulled — V1's verbatim typed rejection.
    assertRelationCanDisconnect(relation);
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const { correlation } = this.parentHeldCorrelation(
      input,
      relation,
      childScope,
      "delete"
    );
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    return {
      kind: "delete",
      relation,
      childScope,
      nullWriteId: input.scope.allocate("parent.fknull"),
      deleteWriteId: input.scope.allocate(`${childName}.delete`),
      correlation,
    };
  }

  /** A parent-held to-one `upsert`: found → UPDATE the located target; absent →
   *  INSERT it (before root) and rebind the parent FK to the created identity. */
  private interpretParentHeldUpsert(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: ParentHeldToOne,
    entry: Extract<RelationMutationEntry, { kind: "upsert" }>
  ): ParentHeldTarget {
    const { relationInfo } = relation;
    const relationName = relationInfo.name;
    this.assertNotSharedPk(relation, "upsert");
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const { correlation, childPrimaryKey } = this.parentHeldCorrelation(
      input,
      relation,
      childScope,
      "upsert"
    );
    const spec = entry.items[0];
    if (!(spec && spec.target.kind === "correlated")) {
      throw new QueryEngineError(
        `query-engine-v2 internal: parent-held to-one upsert on relation '${relationName}' requires one correlated target.`
      );
    }
    const before = this.buildBeforeTarget(childScope, spec.create);
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    const childUpdate = buildParsedRelationPrograms(childScope, spec.update);
    const hasUpdate =
      Object.keys(childUpdate.scalarData).length > 0 ||
      Object.keys(childUpdate.relations).length > 0 ||
      Object.keys(childUpdate.polymorphic).length > 0;
    if (hasUpdate) {
      assertPinnedTransitionIsCompilable(
        childScope,
        childUpdate.scalarData,
        childUpdate.relations,
        relationName,
        {}
      );
    }
    const compiler = hasUpdate
      ? this.recordCompilers.updateSelected({
          scope: input.scope,
          engine: this.engine,
          targetScope: childScope,
          scalarData: childUpdate.scalarData,
          relations: childUpdate.relations,
          polymorphic: childUpdate.polymorphic,
          targetRead: { label: `${childName}.find` },
          rootWrite: { label: `${childName}.update` },
          relationName,
        })
      : undefined;
    const updateLegality = compiler
      ? () => {
          assertPortablePrimaryKeyUpdateInput(childScope.model, "update", {
            data: childUpdate.scalarData,
          });
          assertRelationKeyUpdatesAreCompilable(
            childScope,
            childUpdate.scalarData,
            childUpdate.relations
          );
          assertSelectedUpdateManyDataIsScalar(
            childScope,
            childUpdate.relations
          );
        }
      : undefined;
    const probeId =
      compiler?.targetReadId ?? input.scope.allocate(`${childName}.find`);
    return {
      kind: "upsert",
      relation,
      childScope,
      childPrimaryKey,
      probeId,
      guardId: input.scope.allocate(`${childName}.guard.exists`),
      parentSetId: input.scope.allocate("parent.fkset"),
      correlation,
      probe: {
        id: probeId,
        kind: "read",
        statement: this.parentHeldProbeStatement(
          childScope,
          childPrimaryKey,
          correlation,
          undefined,
          true,
          undefined,
          undefined,
          compiler?.targetProjection
        ),
        outputs: compiler
          ? {
              rows: { kind: "rows" },
              ...targetProjectionOutputs(compiler.targetProjection, true),
            }
          : { rows: { kind: "rows" } },
      },
      compiler,
      updateLegality,
      before,
      missingFkAssign: this.beforeTargetFkAssign(relation, before),
    };
  }

  /** `child.<referenced> = <finalFk>` — a SQL `Ref` to the located parent at
   *  planning (technique #1) for an untouched FK column, the rebound literal for a
   *  same-root-rewritten one; the inlined literal at compile. */
  private parentHeldCorrelationFilters(
    correlation: ParentHeldCorrelation,
    relationName: string,
    kind: string,
    known: Readonly<Record<string, unknown>> | undefined,
    useRef: boolean
  ): Record<string, unknown>[] {
    return correlation.childReferencedFields.map((childField, index) => {
      const fkField = correlation.parentFkFields[index]!;
      if (Object.hasOwn(correlation.override, fkField)) {
        return { [childField]: { equals: correlation.override[fkField] } };
      }
      const member = {
        foreignField: childField,
        referencedField: fkField,
        writeSource: this.parentIdSource,
        readSource: planningSourceFromFinal(
          this.parentIdSource,
          relationName,
          kind
        ),
      };
      return {
        [childField]: {
          equals: useRef
            ? foreignKeyCorrelationValue(member)
            : foreignKeyWriteValue(member, known, relationName, kind),
        },
      };
    });
  }

  /** The correlated locate probe for a parent-held `update`/`upsert`: `WHERE
   *  <referenced> = <finalFk> [AND <filter>] [AND <pk> = <capturedPk>]`, one row, FOR
   *  UPDATE in tx. `filter` is W4-U3's non-unique `update: { where, data }` term on the
   *  currently connected record — a plain `WhereInput` handed to the find builder whole;
   *  a connected row that fails it leaves the probe empty, which is already this
   *  family's target-not-found abort (`parentHeldCapturedPk`). */
  private parentHeldProbeStatement(
    childScope: QueryScope,
    childPrimaryKey: string,
    correlation: ParentHeldCorrelation,
    capturedPk: unknown,
    useRef: boolean,
    known?: Readonly<Record<string, unknown>>,
    filter?: Record<string, unknown>,
    projection: TargetProjection = buildTargetProjection([childPrimaryKey])
  ): Sql {
    const selectedFields = projection.fields;
    const selectedColumns = targetProjectionColumns(childScope, projection);
    return buildFind(
      childScope,
      {
        where: {
          AND: [
            ...this.parentHeldCorrelationFilters(
              correlation,
              "parent-held",
              "update",
              known,
              useRef
            ),
            ...(filter && Object.keys(filter).length > 0 ? [filter] : []),
            ...(capturedPk === undefined
              ? []
              : [{ [childPrimaryKey]: { equals: capturedPk } }]),
          ],
        },
        select: Object.fromEntries(
          selectedFields.map((field) => [field, true])
        ),
        forUpdate: this.mode === "transaction",
      },
      {
        limit: 1,
        ...(selectedColumns.length
          ? { additionalColumns: selectedColumns.map((column) => column.sql) }
          : {}),
      }
    );
  }

  /** A parent-held `create` under update: an unconditional before-root target
   *  INSERT, the root UPDATE's FK column referencing its identity by a `Ref`. */
  private interpretParentHeldCreate(
    relation: ParentHeldToOne,
    entry: Extract<RelationMutationEntry, { kind: "create" }>
  ): ParentHeldTarget {
    const { relationInfo } = relation;
    const relationName = relationInfo.name;
    this.assertNotSharedPk(relation, "create");
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const createData = entry.items[0];
    if (!createData) {
      throw new QueryEngineError(
        `query-engine-v2 internal: parent-held to-one create on relation '${relationName}' has no item.`
      );
    }
    const before = this.buildBeforeTarget(childScope, createData);
    return {
      kind: "create",
      relation,
      before,
      fkAssign: this.beforeTargetFkAssign(relation, before),
    };
  }

  /** A parent-held `connectOrCreate` under update: a global probe decides at
   *  compile — found → FK ← the where's referenced literal (+ batch exists guard);
   *  missing → before-root target INSERT (racePin) + FK ← its `Ref`. */
  private interpretParentHeldConnectOrCreate(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: ParentHeldToOne,
    entry: Extract<RelationMutationEntry, { kind: "connectOrCreate" }>
  ): ParentHeldTarget {
    const { relationInfo, referencedFields } = relation;
    const relationName = relationInfo.name;
    this.assertNotSharedPk(relation, "connectOrCreate");
    const spec = entry.items[0];
    if (!spec) {
      throw new QueryEngineError(
        `query-engine-v2 internal: parent-held to-one connectOrCreate on relation '${relationName}' has no item.`
      );
    }
    const { where, create: createData } = spec;
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const before = this.buildBeforeTarget(
      childScope,
      createData,
      childRacePin(childScope, where)
    );
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    const probeId = input.scope.allocate(`${childName}.find`);
    const guardId = input.scope.allocate(`${childName}.guard.exists`);
    const pkSelect = Object.fromEntries(
      referencedFields.map((field) => [field, true])
    );
    return {
      kind: "connectOrCreate",
      relation,
      probeId,
      guardId,
      guardProbe: buildFindUnique(childScope, { where, select: pkSelect }),
      probe: {
        id: probeId,
        kind: "read",
        statement: buildFindUnique(childScope, {
          where,
          select: pkSelect,
          forUpdate: input.txMode,
        }),
        outputs: { rows: { kind: "rows" } },
      },
      foundFkAssign: this.toOneFkAssign(relation, where),
      where,
      before,
      missingFkAssign: this.beforeTargetFkAssign(relation, before),
    };
  }

  /**
   * A shared-primary-key parent-held edge (the FK IS this record's PK) under
   * `create` / `connectOrCreate` / `upsert` at the update ROOT.
   *
   * MEASURED (E0 probe M3, Prisma 7.9.1): this is not a shape without semantics —
   * Prisma ACCEPTS it, and what it means is a **PK TRANSITION OF THE RECORD BEING
   * UPDATED**. The arm writes (or finds) the target, and the record's own primary
   * key then moves to that target's key; a destination key already taken is
   * Prisma's P2014. The alternative reading — the child ADOPTS the record's
   * existing key — is not merely unimplemented, it is unsatisfiable: the record is
   * alive and holds that key, so the target's INSERT always collides.
   *
   * So the refusal stays, with the reason corrected. What it is waiting for is not
   * this arm but the TRANSITION machinery: the operand-applying planned source that
   * carries a pre-value through the locate into the new key, which is the family
   * `:1375` / `:1621` / `:1651` and `RelationWritePart.ts:812` are waiting for too.
   * The site is re-filed with them (E6.7) rather than kept as its own boundary. The
   * message is unchanged, deliberately: nothing about the shape moved.
   */
  private assertNotSharedPk(relation: ParentHeldToOne, kind: string): void {
    const recordPk = getPrimaryKeyFields(this.model);
    if (
      relation.foreignFields.some((foreignField) =>
        recordPk.includes(foreignField)
      )
    ) {
      throw new UnsupportedOperationError(
        `query-engine-v2 update does not support a shared-primary-key ${kind} on relation '${relation.relationInfo.name}' (the foreign key '${relation.foreignFields.join(", ")}' is this record's primary key).`
      );
    }
  }

  /**
   * Build a before-root target as a create SUBTREE (E1 U3): the whole `create`
   * payload — its scalars AND every relation it carries, at any depth — is a
   * {@link CreateOperation} in `nestedFresh` mode, sharing this operation's step
   * scope. The subtree holds NO foreign key back to the enclosing record (the
   * enclosing record holds the key, and the root UPDATE's SET is where it lands),
   * so its root FK inject is empty.
   *
   * `rootRacePin` is the enclosing arm's raceable missing premise, carried by the
   * subtree's ROOT INSERT — the statement that was this arm's whole create leaf
   * before the arm became a subtree.
   */
  private buildBeforeTarget(
    childScope: QueryScope,
    createData: Record<string, unknown>,
    rootRacePin?: TargetConstraintPin
  ): BeforeTarget {
    return {
      subtree: this.createFresh({
        childScope,
        data: createData,
        relationName: "",
        ...(rootRacePin ? { racePin: rootRacePin } : {}),
      }),
    };
  }

  /** The record FK columns ← a before-root target's referenced values (a `Ref` to
   *  a captured generated id, or a known literal) — for the root UPDATE's SET. */
  private beforeTargetFkAssign(
    relation: ParentHeldToOne,
    before: BeforeTarget
  ): Record<string, unknown> {
    const { relationInfo, foreignFields, referencedFields } = relation;
    const fkAssign: Record<string, unknown> = {};
    for (let index = 0; index < foreignFields.length; index += 1) {
      fkAssign[foreignFields[index]!] = referenceSql(
        this.engine,
        this.model,
        foreignFields[index]!,
        this.beforeTargetReferencedValue(
          before,
          foreignFields[index]!,
          referencedFields[index]!,
          relationInfo.name
        )
      );
    }
    return fkAssign;
  }

  /**
   * The value a before-root target produces for one referenced field. The SUBTREE
   * answers it (E1 U3): a `Ref` to the key its own root INSERT generates, a key
   * already resolved into that record's identity, or — the widening this unit gets
   * for free — a NON-primary-key referenced column the subtree's own create data
   * SPELLS. Three provenances, all of them the row that INSERT writes.
   *
   * What stays refused is what the create root refuses for the same reason: an
   * `Sql` operand (evaluated a second time for the foreign key, and two evaluations
   * of one expression are two values) and a null/absent value (a foreign key equal
   * to NULL references no row).
   */
  private beforeTargetReferencedValue(
    before: BeforeTarget,
    foreignField: string,
    referencedField: string,
    relationName: string
  ): unknown {
    const resolved = before.subtree.rootReferenced(referencedField);
    if (resolved === undefined) {
      throw new UnsupportedOperationError(
        `query-engine-v2 update cannot resolve referenced field '${referencedField}' for the before-root target of relation '${relationName}': it is neither that record's primary key nor a knowable value in its own create data.`
      );
    }
    return foreignKeyWriteValue(
      { foreignField, referencedField, writeSource: resolved },
      undefined,
      relationName,
      "update"
    );
  }

  /**
   * The record FK columns ← the connect target's referenced values, for BOTH arms
   * that fold a located to-one target into the root UPDATE's SET: a bare `connect`
   * ({@link interpretToOneLink}) and a `connectOrCreate`'s found arm. A directly
   * referenced unique (`where` carries the referenced column) is a compile-time
   * literal; a **NON-referenced unique** — `connect: { email }` when the FK
   * references `id` — resolves through the correlated lookup subquery `(SELECT
   * referenced FROM target WHERE …)`, `CreateOperation.toOneFkAssign`'s donor at
   * the update root (E1 U1/U2). One home for the two arms: absorbing only one of
   * them would leave the connectOrCreate racePin's retry re-planning into the
   * other's refusal.
   *
   * The scope declares `mutationTable`, so a SELF relation's lookup — which reads
   * the very table this UPDATE writes — hides behind a derived table on MySQL
   * (ERROR 1093, rule 11). PostgreSQL and SQLite never wrap.
   *
   * The existence premise is unaffected: both arms probe the target by the SAME
   * `where`, so a missing target is answered exactly as the directly-referenced
   * case is — the `connect` arm by `relationTargetNotFound`, the connectOrCreate
   * arm by taking its create arm.
   */
  private toOneFkAssign(
    relation: ParentHeldToOne,
    where: Record<string, unknown>
  ): Record<string, unknown> {
    const { relationInfo, foreignFields, referencedFields } = relation;
    const recordScope = {
      ...createQueryScope(this.engine.adapter, this.model),
      mutationTable: getTableName(this.model),
    };
    const fkAssign: Record<string, unknown> = {};
    for (let index = 0; index < foreignFields.length; index += 1) {
      const referenced = referencedFields[index]!;
      const fkField = foreignFields[index]!;
      const member: ForeignKeyMember = {
        foreignField: fkField,
        referencedField: referenced,
        writeSource: Object.hasOwn(where, referenced)
          ? { kind: "literal", value: where[referenced] }
          : {
              kind: "lookup",
              statement: buildConnectSubqueryForField(
                recordScope,
                relationInfo,
                where,
                referenced
              ),
            },
      };
      fkAssign[fkField] = referenceSql(
        this.engine,
        this.model,
        fkField,
        foreignKeyWriteValue(member, undefined, relationInfo.name, "connect")
      );
    }
    return fkAssign;
  }

  /**
   * The lookup's key must EXIST on the row the probe found. A referenced column
   * the payload did not spell is read out of the target row, and a NULLABLE unique
   * can hold NULL there — writing that NULL would not connect the relation, it
   * would silently DISCONNECT it. The probe row is the one provenance for the
   * verdict (tx mode locks it `FOR UPDATE`; batch mode pins its presence with the
   * arm's own guard), and the refusal is typed and named, never a NULL write.
   *
   * Spelled referenced columns are not asked: their value is the caller's literal,
   * and a `where` naming a unique column NULL matches no row at all — that is the
   * not-found premise each arm already answers.
   */
  private assertLookupKeyPresent(
    rows: readonly unknown[],
    relationInfo: RelationInfo,
    referencedFields: readonly string[],
    where: Record<string, unknown>
  ): void {
    const found = rows[0];
    if (!isRecord(found)) return;
    for (const referenced of referencedFields) {
      if (Object.hasOwn(where, referenced)) continue;
      if (found[referenced] === null || found[referenced] === undefined) {
        throw new NestedWriteError(
          lookupKeyIsNull(relationInfo.name, referenced),
          relationInfo.name
        );
      }
    }
  }

  /**
   * Emit a before-root target's create SUBTREE into the taken arm (E1 U3). The
   * subtree's own root INSERT leads, its deeper writes follow in ATOM “Fresh-record compiler” order,
   * and its guards hoist ahead of every write exactly as a child Part's do. Called
   * ONLY from the arm the compile-time branch takes, which is what keeps an
   * untaken `connectOrCreate`/`upsert` create arm from writing an orphan row.
   */
  private emitBeforeTarget(
    before: BeforeTarget,
    known: Readonly<Record<string, unknown>>,
    guards: OperationStep[],
    beforeRootWrites: OperationStep[]
  ): void {
    bucketOperationSteps(
      before.subtree.compile(this.scope, known),
      guards,
      beforeRootWrites
    );
  }

  /**
   * Resolve parent-held targets. Create arms feed the root SET from a before-root
   * INSERT. Update/delete/upsert arms emit correlated writes after the root and use
   * a dedicated parent-FK write when the branch changes membership.
   */
  private compileParentHeldTargets(
    known: Readonly<Record<string, unknown>>,
    locatedRow: Record<string, unknown>,
    guards: OperationStep[],
    beforeRootWrites: OperationStep[],
    writes: OperationStep[]
  ): {
    readonly data: Record<string, unknown>;
    readonly polymorphicStorage: PolymorphicStorageValue<unknown>[];
  } {
    const extraSet: Record<string, unknown> = {};
    const polymorphicStorage: PolymorphicStorageValue<unknown>[] = [];
    for (const target of this.parentHeldTargets) {
      switch (target.kind) {
        case "create":
          this.emitBeforeTarget(target.before, known, guards, beforeRootWrites);
          Object.assign(extraSet, target.fkAssign);
          break;
        case "connectOrCreate":
          this.compileParentHeldConnectOrCreate(
            target,
            known,
            guards,
            beforeRootWrites,
            extraSet
          );
          break;
        case "update":
          this.compileParentHeldUpdate(target, known, guards, writes);
          break;
        case "delete":
          this.compileParentHeldDelete(target, known, locatedRow, writes);
          break;
        case "polymorphicCreate":
          this.emitBeforeTarget(target.before, known, guards, beforeRootWrites);
          polymorphicStorage.push(
            resolvePolymorphicStorageValue(
              this.engine,
              target.assignment,
              known,
              "create"
            )
          );
          break;
        case "polymorphicConnectOrCreate": {
          const rows = known[planningKey(target.probeId, "rows")];
          const found = Array.isArray(rows) && rows.length > 0;
          if (found) {
            polymorphicStorage.push(
              resolvePolymorphicStorageValue(
                this.engine,
                target.foundAssignment,
                known,
                "connectOrCreate"
              )
            );
            if (this.mode === "batch") {
              const childScope = createQueryScope(
                this.engine.adapter,
                target.relationInfo.targetModel
              );
              const guardWhere = this.capturedConnectWhere(
                childScope,
                rows,
                target.guardField,
                target.relationInfo.name,
                target.where
              );
              guards.push(
                presenceGuard(
                  target.guardId,
                  buildFind(
                    childScope,
                    {
                      where: guardWhere,
                      select: { [target.guardField]: true },
                    },
                    { limit: 1 }
                  ),
                  nestedWriteFailure(
                    nestedReplacement("connectOrCreate"),
                    target.relationInfo.name,
                    false
                  )
                )
              );
            }
          } else {
            this.emitBeforeTarget(
              target.before,
              known,
              guards,
              beforeRootWrites
            );
            polymorphicStorage.push(
              resolvePolymorphicStorageValue(
                this.engine,
                target.missingAssignment,
                known,
                "connectOrCreate"
              )
            );
          }
          break;
        }
        case "polymorphicUpdate": {
          this.assertPolymorphicCurrentTarget(
            locatedRow,
            target.edge,
            "update"
          );
          const rows = known[planningKey(target.probeId, "rows")];
          const found = Array.isArray(rows) && isRecord(rows[0]);
          if (!found) {
            throw new NestedWriteError(
              relationTargetNotFound(target.edge.relationInfo, "update"),
              target.edge.relationInfo.name
            );
          }
          if (this.mode === "batch") {
            const captured = rows[0]!;
            const capturedColumns = capturedTargetColumnPredicate(
              target.childScope,
              target.compiler.targetProjection,
              captured
            );
            guards.push(
              presenceGuard(
                target.guardId,
                buildFind(
                  target.childScope,
                  {
                    where: {
                      AND: [
                        {
                          [target.childPrimaryKey]: {
                            equals: captured[target.childPrimaryKey],
                          },
                        },
                        ...(target.filter ? [target.filter] : []),
                      ],
                    },
                    select: { [target.childPrimaryKey]: true },
                  },
                  {
                    limit: 1,
                    ...(capturedColumns ? { predicate: capturedColumns } : {}),
                  }
                ),
                nestedWriteFailure(
                  relationTargetNotFound(target.edge.relationInfo, "update"),
                  target.edge.relationInfo.name,
                  false
                )
              )
            );
          }
          bucketOperationSteps(target.compiler.compile(known), guards, writes);
          break;
        }
        case "polymorphicDelete": {
          const identity = this.assertPolymorphicCurrentTarget(
            locatedRow,
            target.edge,
            "delete"
          );
          polymorphicStorage.push({
            kind: "empty",
            storage: target.edge.storage,
          });
          writes.push({
            id: target.deleteWriteId,
            kind: "write",
            statement: buildDeleteMany(target.childScope, {
              where: {
                [target.edge.referencedField]: { equals: identity },
              },
            }),
            outputs: {},
          });
          break;
        }
        case "polymorphicUpsert": {
          const current = this.readPolymorphicCurrentTarget(
            locatedRow,
            target.edge
          );
          const rows = known[planningKey(target.probeId, "rows")];
          const found =
            current.kind === "same" && Array.isArray(rows) && isRecord(rows[0]);
          if (found) {
            if (target.compiler) {
              if (this.mode === "batch") {
                const captured = rows[0]!;
                const capturedColumns = capturedTargetColumnPredicate(
                  target.childScope,
                  target.compiler.targetProjection,
                  captured
                );
                guards.push(
                  presenceGuard(
                    target.guardId,
                    buildFind(
                      target.childScope,
                      {
                        where: {
                          AND: [
                            {
                              [target.childPrimaryKey]: {
                                equals: captured[target.childPrimaryKey],
                              },
                            },
                          ],
                        },
                        select: { [target.childPrimaryKey]: true },
                      },
                      {
                        limit: 1,
                        ...(capturedColumns
                          ? { predicate: capturedColumns }
                          : {}),
                      }
                    ),
                    nestedWriteFailure(
                      nestedReplacement("upsert"),
                      target.edge.relationInfo.name,
                      false
                    )
                  )
                );
              }
              bucketOperationSteps(
                target.compiler.compile(known),
                guards,
                writes
              );
            }
          } else {
            this.emitBeforeTarget(
              target.before,
              known,
              guards,
              beforeRootWrites
            );
            polymorphicStorage.push(
              resolvePolymorphicStorageValue(
                this.engine,
                target.missingAssignment,
                known,
                "upsert"
              )
            );
          }
          break;
        }
        default:
          this.compileParentHeldUpsert(
            target,
            known,
            locatedRow,
            guards,
            beforeRootWrites,
            writes
          );
          break;
      }
    }
    return { data: extraSet, polymorphicStorage };
  }

  private readPolymorphicCurrentTarget(
    locatedRow: Readonly<Record<string, unknown>>,
    edge: ResolvedPolymorphicEdge
  ):
    | { readonly kind: "empty" }
    | { readonly kind: "same"; readonly identity: unknown }
    | { readonly kind: "different"; readonly identity: unknown } {
    const storedType = locatedRow[edge.storage.typeColumn.name];
    const identity = locatedRow[edge.storage.idColumn.name];
    if (storedType === null && identity === null) return { kind: "empty" };
    if (
      typeof storedType !== "string" ||
      identity === null ||
      identity === undefined
    ) {
      throw new QueryEngineError(
        `Polymorphic relation '${edge.relationInfo.name}' contains malformed storage.`
      );
    }
    const knownType = [...edge.storage.members.values()].some(
      (member) => member.storedType === storedType
    );
    if (!knownType) {
      throw new QueryEngineError(
        `Polymorphic relation '${edge.relationInfo.name}' contains unknown discriminator '${storedType}'.`
      );
    }
    return storedType === edge.storedType
      ? { kind: "same", identity }
      : { kind: "different", identity };
  }

  private assertPolymorphicCurrentTarget(
    locatedRow: Readonly<Record<string, unknown>>,
    edge: ResolvedPolymorphicEdge,
    operation: "update" | "delete"
  ): unknown {
    const current = this.readPolymorphicCurrentTarget(locatedRow, edge);
    if (current.kind !== "same") {
      throw new NestedWriteError(
        relationTargetNotFound(edge.relationInfo, operation),
        edge.relationInfo.name
      );
    }
    return current.identity;
  }

  private compileParentHeldConnectOrCreate(
    target: Extract<ParentHeldTarget, { kind: "connectOrCreate" }>,
    known: Readonly<Record<string, unknown>>,
    guards: OperationStep[],
    beforeRootWrites: OperationStep[],
    extraSet: Record<string, unknown>
  ): void {
    const { relationInfo } = target.relation;
    const relationName = relationInfo.name;
    const rows = known[planningKey(target.probeId, "rows")];
    // Zero rows is the ARM DECISION here, not an error: the probe's empty read is
    // exactly what makes this a create.
    const found = Array.isArray(rows) && rows.length > 0;
    if (found) {
      this.assertLookupKeyPresent(
        rows,
        relationInfo,
        target.relation.referencedFields,
        target.where
      );
      Object.assign(extraSet, target.foundFkAssign);
      if (this.mode === "batch") {
        guards.push(
          presenceGuard(
            target.guardId,
            target.guardProbe,
            nestedWriteFailure(
              // V1's found-arm captured guard: the planning-seen target vanished
              // before the batch — a replacement race, not a plain not-found
              // (RelationBranches replacementFailure; byte-identical message).
              nestedReplacement("connectOrCreate"),
              relationName,
              false
            )
          )
        );
      }
      return;
    }
    // The arm's raceable missing premise rides the SUBTREE's root INSERT, threaded
    // through `nestedFresh.rootRacePin` at construction (N4-U2's seam).
    this.emitBeforeTarget(target.before, known, guards, beforeRootWrites);
    Object.assign(extraSet, target.missingFkAssign);
  }

  /** Compile a family-A parent-held `update`: the captured PK addresses the located
   *  target's UPDATE (empty capture is V1's "target record was not found for this
   *  parent"); the batch split-witness guard pins the correlation. */
  private compileParentHeldUpdate(
    target: Extract<ParentHeldTarget, { kind: "update" }>,
    known: Readonly<Record<string, unknown>>,
    guards: OperationStep[],
    writes: OperationStep[]
  ): void {
    const { relationInfo } = target.relation;
    const relationName = relationInfo.name;
    const capturedPk = this.parentHeldCapturedPk(
      known,
      target.probeId,
      target.childPrimaryKey,
      relationInfo,
      "update"
    );
    if (this.mode === "batch") {
      guards.push(
        presenceGuard(
          target.guardId,
          this.parentHeldProbeStatement(
            target.childScope,
            target.childPrimaryKey,
            target.correlation,
            capturedPk,
            false,
            known,
            // W4-U3: the batch guard re-asserts the wrapper's filter alongside the
            // correlation and the captured PK — a concurrent write that makes the
            // connected row fail the filter aborts the batch typed, exactly as the
            // tx path's locked probe would have.
            target.filter
          ),
          nestedWriteFailure(
            relationTargetNotFound(relationInfo, "update"),
            relationName,
            false
          )
        )
      );
    }
    bucketOperationSteps(target.compiler.compile(known), guards, writes);
  }

  /** Compile a family-A parent-held `delete: true`: NULL the parent FK (V1's
   *  `RelationRemovals.delete` parent-held arm), then correlated bulk-delete the
   *  referenced target by its (pre-null) FK value. Zero matches is silent success. */
  private compileParentHeldDelete(
    target: Extract<ParentHeldTarget, { kind: "delete" }>,
    known: Readonly<Record<string, unknown>>,
    locatedRow: Record<string, unknown>,
    writes: OperationStep[]
  ): void {
    const relationName = target.relation.relationInfo.name;
    writes.push({
      id: target.nullWriteId,
      kind: "write",
      statement: buildUpdate(
        createQueryScope(this.engine.adapter, this.model),
        {
          where: this.parentPrimaryKeyWhere(locatedRow),
          data: Object.fromEntries(
            target.relation.foreignFields.map((field) => [field, { set: null }])
          ),
          select: this.pkSelect(),
        }
      ),
      outputs: {},
    });
    writes.push({
      id: target.deleteWriteId,
      kind: "write",
      statement: buildDeleteMany(target.childScope, {
        where: this.parentHeldCorrelationWhere(
          target.correlation,
          relationName,
          "delete",
          known
        ),
      }),
      outputs: {},
    });
  }

  /** Compile a family-A parent-held `upsert`: found → UPDATE the located target
   *  (the parent FK already equals the located value; V1's no-op re-write is
   *  elided); absent → INSERT the target (before root) and set the parent FK to the
   *  created identity. */
  private compileParentHeldUpsert(
    target: Extract<ParentHeldTarget, { kind: "upsert" }>,
    known: Readonly<Record<string, unknown>>,
    locatedRow: Record<string, unknown>,
    guards: OperationStep[],
    beforeRootWrites: OperationStep[],
    writes: OperationStep[]
  ): void {
    const { relationInfo } = target.relation;
    const relationName = relationInfo.name;
    const rows = known[planningKey(target.probeId, "rows")];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 upsert probe for relation '${relationName}' did not expose rows.`,
        relationName
      );
    }
    if (rows.length === 0) {
      // Absent arm: INSERT the target before the root, then rebind the parent's FK
      // to its (possibly generated) identity — V1's `updateParentForeignKey`.
      this.emitBeforeTarget(target.before, known, guards, beforeRootWrites);
      writes.push({
        id: target.parentSetId,
        kind: "write",
        statement: buildUpdate(
          createQueryScope(this.engine.adapter, this.model),
          {
            where: this.parentPrimaryKeyWhere(locatedRow),
            data: target.missingFkAssign,
            select: this.pkSelect(),
          }
        ),
        outputs: {},
      });
      return;
    }
    if (!target.compiler) return;
    const capturedPk = this.parentHeldCapturedPk(
      known,
      target.probeId,
      target.childPrimaryKey,
      relationInfo,
      "update"
    );
    if (this.mode === "batch") {
      guards.push(
        presenceGuard(
          target.guardId,
          this.parentHeldProbeStatement(
            target.childScope,
            target.childPrimaryKey,
            target.correlation,
            capturedPk,
            false,
            known
          ),
          nestedWriteFailure(
            upsertPremiseChanged(relationName),
            relationName,
            false
          )
        )
      );
    }
    target.updateLegality?.();
    bucketOperationSteps(target.compiler.compile(known), guards, writes);
  }

  /** The parent's primary-key where-unique for a dedicated parent-FK write. */
  private parentPrimaryKeyWhere(
    locatedRow: Record<string, unknown>
  ): Record<string, unknown> {
    return buildPrimaryKeyWhereUnique(
      this.model,
      Object.fromEntries(
        this.parentPrimaryKeys.map((pk) => [pk, locatedRow[pk]])
      )
    );
  }

  /** The compile-time correlated `WHERE <referenced> = <finalFk>` for a bulk
   *  parent-held write (the `delete` arm). */
  private parentHeldCorrelationWhere(
    correlation: ParentHeldCorrelation,
    relationName: string,
    kind: string,
    known: Readonly<Record<string, unknown>>
  ): Record<string, unknown> {
    const filters = this.parentHeldCorrelationFilters(
      correlation,
      relationName,
      kind,
      known,
      false
    );
    return filters.length === 1 ? filters[0]! : { AND: filters };
  }

  /** The PK the parent-held probe captured at planning — the located target this
   *  arm mutates. An empty capture is V1's verbatim "target record was not found
   *  for this parent" (the parent's FK pointed at nothing / a vanished row). */
  private parentHeldCapturedPk(
    known: Readonly<Record<string, unknown>>,
    probeId: string,
    childPrimaryKey: string,
    relationInfo: RelationInfo,
    op: "update"
  ): unknown {
    const rows = known[planningKey(probeId, "rows")];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 update probe for relation '${relationInfo.name}' did not expose rows.`,
        relationInfo.name
      );
    }
    if (rows.length === 0) {
      throw new NestedWriteError(
        relationTargetNotFound(relationInfo, op),
        relationInfo.name
      );
    }
    const first = rows[0];
    if (!(first && typeof first === "object")) {
      throw new NestedWriteError(
        `query-engine-v2 update probe for relation '${relationInfo.name}' captured no row shape.`,
        relationInfo.name
      );
    }
    return (first as Record<string, unknown>)[childPrimaryKey];
  }

  private interpretToOneLink(
    scope: StepScope,
    relation: ParentHeldToOne,
    entry: Extract<RelationMutationEntry, { kind: "connect" | "disconnect" }>
  ): ToOneLink {
    const { relationInfo, foreignFields, referencedFields } = relation;
    const relationName = relationInfo.name;
    if (entry.kind === "disconnect") {
      // V1-verbatim rejection when a required FK cannot be nulled.
      assertRelationCanDisconnect(relation);
      return {
        relationInfo,
        referencedFields,
        assignment: Object.fromEntries(
          foreignFields.map((field) => [field, { set: null }])
        ),
      };
    }
    const connect = entry.targets[0];
    if (!connect) {
      throw new QueryEngineError(
        `query-engine-v2 internal: parent-held to-one connect on relation '${relationName}' has no target.`
      );
    }
    // A directly-referenced unique folds its literal; a non-referenced one folds the
    // lookup subquery ({@link RecordUpdateCompilerState.toOneFkAssign}, E1 U1).
    const assignment = this.toOneFkAssign(relation, connect);
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    const probeId = scope.allocate(`${childName}.find`);
    const guardId = scope.allocate(`${childName}.guard.exists`);
    const probe: ReadStep = {
      id: probeId,
      kind: "read",
      statement: buildFindUnique(childScope, {
        where: connect,
        select: Object.fromEntries(
          referencedFields.map((field) => [field, true])
        ),
        forUpdate: this.mode === "transaction",
      }),
      outputs: { rows: { kind: "rows" } },
    };
    return {
      relationInfo,
      referencedFields,
      assignment,
      connect: { probeId, guardId, probe, where: connect },
    };
  }

  private compileToOneConnect(
    link: ToOneLink,
    known: Readonly<Record<string, unknown>>
  ): OperationStep[] {
    if (!link.connect) return [];
    const { relationInfo } = link;
    const relationName = relationInfo.name;
    const rows = known[planningKey(link.connect.probeId, "rows")];
    // Zero rows is the arm's own not-found premise, unchanged by the lookup fold:
    // the probe reads the target by the SAME `where` the fold resolves through, so
    // "no such target" is answered here, before anything is written.
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new NestedWriteError(
        relationTargetNotFound(relationInfo, "connect"),
        relationName
      );
    }
    this.assertLookupKeyPresent(
      rows,
      link.relationInfo,
      link.referencedFields,
      link.connect.where
    );
    if (this.mode === "transaction") return [];
    const guardScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const guardStatement = link.connect.capturedGuardField
      ? buildFind(
          guardScope,
          {
            where: this.capturedConnectWhere(
              guardScope,
              rows,
              link.connect.capturedGuardField,
              relationInfo.name,
              link.connect.where
            ),
            select: { [link.connect.capturedGuardField]: true },
            forUpdate: true,
          },
          { limit: 1 }
        )
      : link.connect.probe.statement;
    // Batch: pin the connect target's presence before the parent SET.
    return [
      presenceGuard(
        link.connect.guardId,
        guardStatement,
        nestedWriteFailure(
          relationTargetNotFound(relationInfo, "connect"),
          relationName,
          false
        )
      ),
    ];
  }

  private capturedConnectWhere(
    scope: QueryScope,
    rows: readonly unknown[],
    field: string,
    relationName: string,
    originalWhere: Record<string, unknown>
  ): Record<string, unknown> {
    const row = rows[0];
    if (!isRecord(row) || row[field] === undefined || row[field] === null) {
      throw new NestedWriteError(
        `query-engine update connect probe for relation '${relationName}' did not expose '${field}'.`,
        relationName
      );
    }
    return capturedSelectorWhere(scope, originalWhere, {
      [field]: row[field],
    });
  }

  private buildRootUpdate(
    locatedRow: Record<string, unknown>,
    extraSet: Record<string, unknown> = {},
    polymorphicStorage: readonly PolymorphicStorageValue<unknown>[] = []
  ): WriteStep {
    const parent = createQueryScope(this.engine.adapter, this.model);
    const txMode = this.mode === "transaction";
    const parentName = getStepModelName(this.model, "parent");
    // The exact-affected postcondition is a returning-driver check only. On a
    // non-returning driver V1 uses `affectedRows: unrestricted` (its
    // `compileMutationRefetch`): the locked locate already proved existence, so a
    // MySQL-style no-op UPDATE (0 rows changed because the value is unchanged) is
    // accepted, not a spurious NotFound. The terminal read confirms the final row.
    const enforceAffected =
      txMode && this.engine.adapter.capabilities.supportsReturning;
    return {
      id: this.writeId,
      kind: "write",
      statement: buildUpdate(parent, {
        // Address the row by the PK captured at the locate — V1's `WHERE id`
        // mechanic (locate by an alternate unique, mutate by the immutable
        // captured PK). Under a transaction the locate holds `FOR UPDATE`; under
        // an atomic batch the root-presence guard conjoins the same captured PK.
        // Unconditional — see {@link RecordUpdateCompilerState.writeWhere} for why the
        // selector never rides along, not even when it names the PK.
        where: this.writeWhere(locatedRow),
        // The construction-time SET (scalar ∪ connect/disconnect folds) unioned
        // with the compile-time parent-held create/connectOrCreate FK folds
        // (`extraSet`), which can reference a before-root target.
        data: { ...this.parentUpdateData, ...extraSet },
        polymorphicStorage,
        select: this.pkSelect(),
      }),
      outputs: {},
      ...(enforceAffected
        ? {
            expects: affectedRows(
              1,
              this.rootWriteFailure ??
                notFoundFailure(
                  `query-engine-v2 update located no '${parentName}' row for its unique where.`
                )
            ),
          }
        : {}),
    };
  }

  private pinnedTargetValue(
    field: string
  ): { readonly value: unknown } | undefined {
    return Object.hasOwn(this.pinnedTarget, field)
      ? { value: this.pinnedTarget[field] }
      : undefined;
  }

  private pkSelect(): Record<string, boolean> {
    return Object.fromEntries(
      this.parentPrimaryKeys.map((field) => [field, true])
    );
  }

  private writeWhere(
    locatedRow: Record<string, unknown>
  ): Record<string, unknown> {
    return buildPrimaryKeyWhereUnique(
      this.model,
      Object.fromEntries(
        this.parentPrimaryKeys.map((field) => [field, locatedRow[field]])
      )
    );
  }
}

function resolveParentFkRebinds(
  rootScalarData: Readonly<Record<string, unknown>>,
  foreignFields: readonly string[]
): Record<string, unknown> {
  const override: Record<string, unknown> = {};
  for (const foreignField of foreignFields) {
    if (!Object.hasOwn(rootScalarData, foreignField)) continue;
    const resolved = classifyRelationKeyScalarUpdate(
      rootScalarData[foreignField]
    );
    if (resolved.resolved) override[foreignField] = resolved.value;
  }
  return override;
}

const TO_ONE_VACATE_KINDS: ReadonlySet<string> = new Set([
  "disconnect",
  "delete",
]);

const TO_ONE_SUPPLY_KINDS: ReadonlySet<string> = new Set([
  "connectOrCreate",
  "connect",
  "create",
]);

function isVacateThenSupply(kinds: readonly string[]): boolean {
  return (
    kinds.length === 2 &&
    TO_ONE_VACATE_KINDS.has(kinds[0]!) &&
    TO_ONE_SUPPLY_KINDS.has(kinds[1]!)
  );
}

function assertToOneMutationArity(
  relationName: string,
  kinds: readonly string[]
): void {
  if (kinds.length <= 1 || isVacateThenSupply(kinds)) return;
  throw new UnsupportedOperationError(
    `query-engine-v2 update supports one mutation kind on the to-one relation '${relationName}'; it has ${kinds.join(", ")}.`
  );
}

function isConstructionLiteral(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const valueType = typeof value;
  if (valueType === "object") return value instanceof Date;
  return (
    valueType === "string" ||
    valueType === "number" ||
    valueType === "bigint" ||
    valueType === "boolean"
  );
}
