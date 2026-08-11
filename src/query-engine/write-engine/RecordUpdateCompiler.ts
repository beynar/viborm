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
  bindRelation,
  buildConnectSubqueryForField,
  type ChildHeldRelation,
  hasPolymorphicMembership,
  type OrdinaryChildHeldRelation,
  type ParentHeldRelation,
  type PolymorphicChildHeldRelation,
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
  getUpdatedPrimaryKeyValues,
} from "../operations/mutation-identity";
import type { QueryEngine } from "../query-engine";
import {
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
  isOperationValueReference,
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
  type CorrelatedRelationMembershipBinding,
  type FinalReferenceSource,
  type ForeignKeyMember,
  finalMembershipCondition,
  fkEquals,
  foreignKeyCorrelationValue,
  foreignKeyResolvedReadValue,
  foreignKeyWriteValue,
  linkedPolymorphicStorage,
  literalParentId,
  literalReferenceSource,
  lowerMembershipWrite,
  type PlanningReferenceSource,
  pairCorrelatedForeignKeyMembers,
  pairForeignKeyMembers,
  plannedParentId,
  planningMembershipCondition,
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
  uniqueSelectorConjuncts,
} from "./shared";
import {
  buildTargetProjection,
  capturedTargetColumnPredicate,
  capturedTargetFilters,
  type TargetProjection,
  targetProjectionColumns,
  targetProjectionOutputs,
  targetProjectionRowKeySelect,
  targetProjectionSelect,
} from "./target-projection";

type ExecutionMode = "transaction" | "batch";

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
      readonly relation: ParentHeldRelation;
      readonly before: BeforeTarget;
      readonly fkAssign: Record<string, unknown>;
    }
  | {
      readonly kind: "connectOrCreate";
      readonly relation: ParentHeldRelation;
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
      readonly relation: ParentHeldRelation;
      readonly childScope: QueryScope;
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
      readonly relation: ParentHeldRelation;
      readonly childScope: QueryScope;
      /**
       * H3/R2 — ABSENT when a sibling supplier in the same payload rebinds every one
       * of this edge's foreign-key columns. The vacate's whole parent-side effect is
       * to make the slot empty; a supplier that assigns the same columns in the same
       * root UPDATE already makes the FINAL assignment non-null, so a second UPDATE
       * that nulls them can only undo the supplier (measured at 8c2908d: the fresh row
       * is inserted and then orphaned). Eliding it is the composition, not an
       * optimization — and a true no-op allocates no step id, so the id is not burned
       * either. The correlated DELETE below is unaffected: it addresses the OLD
       * foreign-key value, inlined at compile from the located parent row.
       */
      readonly nullWriteId?: string;
      readonly deleteWriteId: string;
      readonly correlation: ParentHeldCorrelation;
    }
  // A parent-held upsert uses a correlated probe: found updates the located
  // target; absent creates it and rebinds the parent FK.
  | {
      readonly kind: "upsert";
      readonly relation: ParentHeldRelation;
      readonly childScope: QueryScope;
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
  /**
   * H3/R2 — the SUPPLIER's own selector, present only when this arm's payload also
   * carries the supplier that rebinds the edge in the same root UPDATE (parent-held
   * `connect` + `update`). It REPLACES the foreign-key correlation: the modify must
   * address the INCOMING member, and the parent's foreign-key column still holds the
   * outgoing one everywhere this correlation is read (the locate row at planning, the
   * same row's literal at compile — the root UPDATE that rebinds it has not run).
   *
   * MEASURED, and it is why the obvious spelling is not used: reading the supplier's
   * folded assignment back out ({@link RecordUpdateCompilerState.toOneFkAssign}) cannot
   * work — every one of those values is an `Sql` produced by {@link referenceSql}, and
   * {@link classifyRelationKeyScalarUpdate} answers `resolved: false` for `isSql`, so an
   * assignment-reading override would come back EMPTY and the modify would silently
   * correlate on the OLD foreign key. The selector is the one spelling of the incoming
   * member that is a construction literal in both directions, including the
   * non-referenced-unique `connect` whose assignment is only ever a lookup subquery.
   */
  readonly suppliedFilters?: readonly Record<string, unknown>[];
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
  /**
   * The BATCH premise: the same predicate with every located pre-value RESOLVED. It
   * cannot simply reuse `probe.statement`, because since D2 that statement may carry a
   * planning `Ref` to the located row — legal inside the planning fragment that read
   * it, and rejected by the fragment validator inside the atomic unit, which has no
   * such step to point at. This is the same planning/final split
   * `RelationSetPart.departingStatement` already makes for the departing probe.
   */
  readonly premise: (known: PlanningKnown) => Sql;
  /**
   * Does the OLD reference tuple address any row at all? A tuple with a NULL member
   * addresses none: a foreign key compares under MATCH SIMPLE, so no child is bound to
   * the parent through it, the transition strands nothing, and the guard has nothing to
   * reject. Asked ONCE, ahead of both carriers, because the two lower a null pre-value
   * DIFFERENTLY — the planning probe binds it as a parameter (`= $n`, never true of
   * NULL) while the batch premise resolves it to a literal (`IS NULL`, true of NULL) —
   * and one payload must not get two verdicts for the substrate it ran on. Reachable
   * only since D2 widened the regime to compound and non-primary-key references; a
   * primary key has no null member.
   */
  readonly oldReferenceIsAddressable: (known: PlanningKnown) => boolean;
}

/**
 * N5-U1 — how the ADOPT family (`connect` / `connectOrCreate` / `set` / a to-many
 * `upsert`) is built under a `guarded` non-cascade referenced-PK transition. The
 * refusal this replaced said an adopt "writes a fresh FK on the pre-transition value,
 * orphaned by the referential action" — true of the ordering it had, and only of that.
 * Two facts make the shape ordinary:
 *   1. the OLD slot is proven EMPTY by the occupied guard the same relation just
 *      emitted, so nothing is being moved off a value the transition vacates; and
 *   2. the POST-transition value has a source — a construction literal where the
 *      locator pins the reference, a per-member compile-time derivation otherwise (D2).
 * So the edge is written against that source, AFTER the root UPDATE that creates the
 * key it names.
 */
interface PostTransitionAdopt {
  /**
   * The value an adopt edge WRITES — the parent's post-transition referenced column,
   * for every member of the reference key. It OVERRIDES `WritePartBase.parentId` and
   * deliberately leaves `WritePartBase.membershipReadSource` alone: that split, one
   * field against the other, IS the old-read / new-write rule, and `set` — the one
   * kind that does both at once — needs no third source to express it.
   */
  readonly parentId: FinalReferenceSource;
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
  private readonly parentIdSource: ReturnType<typeof plannedParentId>;
  private readonly childParts: readonly Part[];
  private readonly afterRootParts: readonly Part[];
  private readonly toOneLinks: readonly ToOneLink[];
  private readonly parentHeldTargets: readonly ParentHeldTarget[];
  private readonly relationKeyGuards: readonly RelationKeyGuard[];
  private readonly parentUpdateData: Record<string, unknown>;
  /**
   * E1 — which members of THIS record's row key a parent-held shared-primary-key arm
   * rewrites. Topological and payload-only (relation direction, entry kind, the
   * foreign/row-key overlap), so it is decided BEFORE the relation loop and every
   * relation can ask it whatever order the payload lists them in. It is the answer to
   * "does this update move the record's own key" for the half of that question the
   * scalar SET does not carry ({@link RecordUpdateCompilerState.sharedKeyFinal} carries
   * the value).
   */
  private readonly sharedKeyMembers: ReadonlySet<string>;
  /**
   * E1 — the FINAL value each of those members takes: the literal the arm spells, or
   * the `Ref` the before-root target's own INSERT publishes (Package F's channel). The
   * arms fill it while the relation loop runs and every reader consults it at COMPILE —
   * the terminal read's where, and the post-transition source a child-held edge writes
   * — so no reader depends on the order the payload happened to list relations in.
   */
  private readonly sharedKeyFinal: Record<string, unknown> = {};
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

    // The selected record's own ROW KEY. It seeds the locate demand, so the probe
    // publishes every member; the projection built from it at the end of this
    // constructor is then the ONE thing every write, guard and re-address reads the
    // key back from (ATOM "Wrong-row protection"). No field survives beside it.
    //
    // An `parentPrimaryKeys.length === 0` refusal stood here and is DELETED
    // (Package O): `getPrimaryKeyFields` is total — a model with no declared id
    // answers `["id"]` — so the empty list was unreachable. Same dead shape as
    // `ManyAndReturnOperation.pkSelect`'s, deleted with it.
    const parentPrimaryKeys = getPrimaryKeyFields(this.model);
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
    this.sharedKeyMembers = resolveSharedKeyMembers(
      input.targetScope,
      parentPrimaryKeys,
      input.relations,
      input.polymorphic
    );
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
    // E1 — a shared-primary-key fold writes the record's own row key from a RELATION
    // arm, so it never appears in `parentSet`. It is the same reorder question the
    // scalar SET asks, asked of the other half of the same column.
    this.reorderRootUpdateAfterChildren =
      childParts.length > 0 &&
      [...locateFields].some(
        (field) =>
          Object.hasOwn(parentSet, field) || this.sharedKeyMembers.has(field)
      );
    this.targetProjection = buildTargetProjection(
      this.model,
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
    const modelName = getStepModelName(
      this.model,
      this.relationName || "record"
    );
    const folded = Object.entries(this.sharedKeyFinal);
    // E1 — a shared-primary-key member is answered by the FOLD, not by the scalar
    // derivation: the scalar channel carries either nothing for it (a `create` /
    // `connectOrCreate` arm folds through `extraSet`) or the lowered `Sql` a `connect`
    // assignment already wrapped, which `getUpdatedPrimaryKeyValue` correctly calls an
    // unsupported operand. Withholding those members leaves that refusal owning exactly
    // the operands it is about, and the fold owns its own.
    //
    // With an EMPTY fold this is `getUpdatedPrimaryKeyWhere` spelled out — that function
    // IS `buildPrimaryKeyWhereUnique(model, getUpdatedPrimaryKeyValues(…))`, the filter
    // is an identity and the merge loop is empty — so there is no fast path here to
    // short-circuit it with. One spelling, one owner.
    const derived = getUpdatedPrimaryKeyValues(
      target,
      locatedRow,
      Object.fromEntries(
        Object.entries(this.parentUpdateData).filter(
          ([field]) => !Object.hasOwn(this.sharedKeyFinal, field)
        )
      ),
      modelName
    );
    for (const [field, value] of folded) {
      // A produced key is a `Ref` to the INSERT that publishes it, lowered exactly as
      // the create root's own shared-key terminal lowers it
      // (`CreateOperation.terminalIdentity`) — one deferred value, one caster.
      derived[field] = isOperationValueReference(value)
        ? referenceSql(this.engine, this.model, field, value)
        : value;
    }
    return buildPrimaryKeyWhereUnique(this.model, derived);
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
      if (!guard.oldReferenceIsAddressable(known)) continue;
      const relationName = guard.relation.relationInfo.name;
      const message = relationKeyOccupiedMessage(
        relationName,
        guard.relation.membership.onUpdate ?? "restrict"
      );
      if (this.mode === "batch") {
        // V1's `notExistsWhenChanged` premise: assert the OLD slot is EMPTY; the batch
        // aborts (rejects "occupied") if a row exists — a `notExists` guard whose
        // materialized condition a concurrent plant can invalidate, so `raceable: true`
        // (the empty-slot race; the validator requires it of every notExists guard).
        guards.push(
          absenceGuard(
            guard.guardId,
            guard.premise(known),
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
    return {
      kind: "polymorphicUpsert",
      edge,
      childScope,
      probeId,
      guardId: scope.allocate(`${childName}.guard.exists`),
      probe: this.buildPolymorphicTargetProbe(
        probeId,
        edge,
        childScope,
        compiler?.targetProjection ?? buildTargetProjection(childScope.model),
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
          select: targetProjectionSelect(projection),
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

    if (relation.position === "junction") {
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
          // D1 — a junction edge reads its EXISTING join rows by the located key.
          // `interpretRelation` returns for a junction before it classifies a
          // referenced-key transition, so `parentId` is the located source here too
          // and the two agree; naming the read source anyway is what stops that
          // agreement from being an unstated coincidence. Junction transitions stay
          // owned by the database's `ON UPDATE CASCADE` (both sides default to it),
          // and an opt-out pair fails closed at the constraint — measured, and left
          // exactly as measured, in `nested-arm-dispatch`'s B1 RESIDUE block.
          membershipReadSource: input.parentIdSource,
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

    if (relation.position === "parentHeld") {
      // A parent-held FK is a same-row change. `connect`/`disconnect` fold their
      // (construction-known) FK literal into the root SET; `create`/`connectOrCreate`
      // write the target before the root UPDATE and reference its identity from the
      // UPDATE's SET.
      //
      // H3/R2 — this dispatch is now TOTAL over the parent-held half of the to-one
      // composition lattice, not one arm behind an arity refusal. What E6.5 measured at
      // 8c2908d and declined to own is exactly what {@link interpretParentHeldComposition}
      // now owns: the FK-null of a `delete` is elided when a sibling supplier rebinds the
      // same columns (without the elision the fresh row was inserted and then ORPHANED —
      // `station.depotId = null`, `depots = [d-alt, d-new]`), and `disconnect` + supplier
      // no longer depends on which of two spellings object-assign order happened to leave
      // last in the root SET: the supplier is the only writer of those columns and says so.
      this.interpretParentHeldComposition(input, relation, entries);
      return;
    }

    if (hasPolymorphicMembership(relation)) {
      this.interpretPolymorphicChildHeld(input, relation, entries);
      return;
    }

    // Child-held direction (the target holds the FK). One-to-many is the plural
    // case; the inverse-side one-to-one is its arity-1 case
    // — the same correlated/global-adopt child writes, differing only in the to-one
    // payload spelling (`update: <data>` with no selector, `disconnect: true`).
    // The parent exists, so no fresh-parent elision: every probe reads committed
    // state, exactly as the to-many family already does under update.
    const isInverseToOne = relation.cardinality === "one";
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
      for (const field of relation.membership.referencedFields) {
        input.locateFields.add(field);
      }
    }
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
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
    // N5-U1 — the ADOPT family under a guarded non-cascade transition. The occupied
    // guard just emitted proves the OLD slot is empty, so an adopt edge has exactly
    // one correct target: the parent's POST-transition referenced value, and the WRITE
    // is deferred until after the root UPDATE, which is what makes the row it points at
    // exist. Ordering closes this family; no new expressiveness was needed.
    //
    // D2 — the value is a construction literal where the locator pins the reference and
    // a per-member compile-time source otherwise; both are one `FinalReferenceSource`,
    // so nothing downstream distinguishes them. What used to be refused here (a
    // compound, non-PK, or unpinned reference under any kind but `create`) now takes
    // the second spelling and compiles.
    const adopt: PostTransitionAdopt | undefined =
      keyTransition.regime === "guarded"
        ? { parentId: keyTransition.write, target: input.afterRootParts }
        : undefined;
    const engine = this.engine;
    const writeBase: Parameters<typeof buildToManyUpdateParts>[0] = {
      scope: input.scope,
      engine,
      relation,
      childName,
      childScope,
      targetProjection: buildTargetProjection(childScope.model),
      parentId: input.parentIdSource,
      // Existing members are read by the located (pre-transition) value on every kind.
      // The ADOPT kinds override `parentId` with the post-transition source and leave
      // this one alone — that override IS the old-read / new-write split.
      membershipReadSource: input.parentIdSource,
      txMode: input.txMode,
      recordCompilers: this.recordCompilers,
    };

    // Multiple mutation kinds may coexist on one relation (V1's `{ delete,
    // deleteMany }`, `{ update, updateMany }`, …). Each present kind contributes
    // its own Part(s); they compose into the one linear fragment in a stable,
    // V1-mirroring order (link/adopt, then removals, then updates).
    if (isInverseToOne) {
      this.interpretInverseToOneComposition({
        entries,
        relation,
        childScope,
        childName,
        writeBase,
        input,
        keyTransition,
        adopt,
      });
      return;
    }
    for (const entry of entries) {
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
        writeBase,
        input,
        adopt,
      });
    }
  }

  private interpretPolymorphicChildHeld(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: PolymorphicChildHeldRelation,
    entries: readonly RelationMutationEntry[]
  ): void {
    const relationName = relation.relationInfo.name;
    const isInverseToOne = relation.cardinality === "one";
    // H3 — the fixed inverse topology takes the SAME composition as the ordinary
    // child-held to-one: it is the same lattice owner (`to-one-mutation-schema.ts` via
    // the polymorphic relation input), the same `buildToOneUpdatePart` leaf, and the same
    // reason a composed modify cannot correlate. The discriminator is a qualifier of the
    // MEMBERSHIP key, never of the target's row key, so the supplied selector locates the
    // incoming row here exactly as it does there.
    const composition = isInverseToOne
      ? composeToOneEntries(relationName, entries)
      : { entries };
    const composed = composition.entries;
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
    const needsTargetIdentity = composed.some(
      (entry) => entry.kind !== "create" && entry.kind !== "createMany"
    );
    if (!needsTargetIdentity) {
      for (const entry of composed) {
        if (entry.kind === "create" || entry.kind === "createMany") {
          pushFresh(entry);
        }
      }
      return;
    }

    // The inverse topology's discriminator is a fixed qualifier of the MEMBERSHIP
    // key, never a member of the target's row key: it is bound by
    // `bindRelationMembership` beside `parent.write`, and the projection below
    // publishes only the target's own row key. So a compound-keyed polymorphic
    // target needs nothing here that an ordinary child-held one does not.
    const targetProjection = buildTargetProjection(childScope.model);
    const writeBase = {
      scope: input.scope,
      engine: this.engine,
      relation,
      childName,
      childScope,
      targetProjection,
      parentId: parent.write,
      membershipReadSource: parent.read,
      txMode: input.txMode,
      recordCompilers: this.recordCompilers,
    } as const;

    for (const entry of composed) {
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
              targetProjection,
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
              targetProjection,
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
              ? [
                  buildToOneUpdatePart(
                    writeBase,
                    entry,
                    entry === composition.modify
                      ? composition.suppliedWhere
                      : undefined
                  ),
                ]
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
          push([
            buildToManySetPart({ ...writeBase, parentId: parent.write }, entry),
          ]);
          break;
      }
    }
  }

  private resolvePolymorphicParent(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: PolymorphicChildHeldRelation
  ): {
    readonly read: FinalReferenceSource;
    readonly write: FinalReferenceSource;
    readonly afterRoot: boolean;
  } {
    const field = relation.membership.referencedFields[0];
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

    return {
      read,
      write: this.postTransitionReference(
        input.rootScalarData,
        relation.relationInfo.name,
        "nested create"
      ),
      afterRoot: true,
    };
  }

  /**
   * D1 — the ONE post-transition reference-value derivation, for every member of a
   * reference key, in every position that needs it: the transitioned create leaf
   * ({@link transitionedCreateParent}), the polymorphic inverse
   * ({@link resolvePolymorphicParent}), and the child-held adopt/occupied family
   * ({@link interpretReferencedKeyTransition}). It had been written out three times
   * with three subtly different closures; a single field-agnostic source, resolved
   * against the member it is bound to, is what let the three collapse into one.
   *
   * `before` arrives from the located row at COMPILE, so this covers exactly the
   * cases a construction-time literal cannot spell: a compound reference, and a
   * single member the unique `where` does not pin. A member the root SET leaves
   * alone comes back verbatim, so a partially rewritten tuple needs no second
   * source.
   *
   * The operand classes are bounded before this runs, which is what makes the
   * derivation total rather than a guess: a NON-primary-key referenced column
   * reaches it only construction-resolved (`assertRelationKeyUpdatesAreCompilable`
   * refuses every other operand on a column an edge references and exempts primary
   * keys explicitly), and a PRIMARY-KEY column has passed
   * `assertPortablePrimaryKeyUpdateInput`, leaving a bare value, `{ set }`, and
   * PORTABLE arithmetic — precisely what `getUpdatedPrimaryKeyValue` computes,
   * JS==SQL, as the terminal read already trusts it to. The two operands with no
   * derivable post value (`Sql`, whose value exists only once the database
   * evaluates it, and `null`, which references no row) keep the typed refusal
   * rather than falling into that helper's internal error.
   */
  private postTransitionReference(
    rootScalarData: Record<string, unknown>,
    relationName: string,
    position: "nested create" | "membership"
  ): FinalReferenceSource {
    const model = this.model;
    const stepModelName = getStepModelName(model, "record");
    return transitionedParentId(this.targetReadId, (before, field) => {
      // E1 — a member a shared-primary-key arm MOVES takes the fold's own final value:
      // the literal the arm spells, or the `Ref` the before-root INSERT publishes. Read
      // HERE, at compile, which is why the arms may fill the map in any order.
      //
      // Asked of the MEMBERSHIP map, not the value map, so that "does this member move"
      // has one answer everywhere: `sharedKeyFinal` also carries the `upsert` arm, whose
      // two arms are accepted only when they agree on the key the record already holds —
      // no move, and so no business substituting a construction literal for the located
      // row's own reference here. A member in `sharedKeyMembers` always has its value by
      // the time this closure runs: the arm either filled the map or threw.
      if (this.sharedKeyMembers.has(field)) {
        return this.sharedKeyFinal[field];
      }
      // A member the SET leaves alone is not in transition: the located value IS the
      // value the membership must reference.
      if (!Object.hasOwn(rootScalarData, field)) return before;
      const operand = rootScalarData[field];
      const classified = classifyRelationKeyScalarUpdate(operand);
      const literal = classified.resolved ? classified.value : operand;
      if (literal === null || isSql(literal)) {
        throw new UnsupportedOperationError(
          `query-engine-v2 update ${position} on relation '${relationName}' references a non-literal rewritten column '${field}'.`
        );
      }
      return getUpdatedPrimaryKeyValue(
        model,
        field,
        before,
        operand,
        stepModelName
      );
    });
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
    const referencedFields = relation.membership.referencedFields;
    // E1 — a shared-primary-key fold rewrites a referenced column exactly as the scalar
    // SET does; only the channel differs. Asking one and not the other is what would
    // let a fresh child reference the key the fold has just vacated.
    const rewritten = referencedFields.filter(
      (field) =>
        Object.hasOwn(input.rootScalarData, field) ||
        this.sharedKeyMembers.has(field)
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
    if (relation.membership.onUpdate === "cascade") {
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
    // Asked of the SCHEMA, not of a projection: this runs while the relation loop is
    // still collecting what the probe will publish, and the question is topological
    // ("is this referenced field a member of the selected model's row key?"), not
    // "what did the probe capture".
    if (getPrimaryKeyFields(this.model).includes(referencedField)) {
      const pinnedBefore = this.pinnedTargetValue(referencedField);
      // E1 — a member the fold rewrites has no scalar operand for
      // `getUpdatedPrimaryKeyValue` to apply, whatever the `where` pins; its post value
      // is the fold's, read per member at compile.
      if (!pinnedBefore || this.sharedKeyMembers.has(referencedField)) {
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
          relation.membership.foreignFields,
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
      members: pairForeignKeyMembers(
        relation.membership.foreignFields,
        referencedFields,
        [literalParentId(literal)]
      ),
      afterRoot: false,
    };
  }

  /**
   * E6.7 — the parent id for a nested create under a NON-CASCADE transition whose
   * post-transition value has no construction-time spelling: a compound reference, or a
   * single primary key the unique `where` does not pin.
   *
   * The derivation is the pinned sibling's, moved one phase later, and it is
   * {@link postTransitionReference}'s — one owner for every position that needs a
   * post-transition reference value. The referenced columns join
   * `parentFkLocateFields`, not `locateFields`: they must appear in the locate's SELECT
   * and `firstRowField` outputs, and they must NOT drive `reorderRootUpdateAfterChildren`,
   * because the fresh INSERT is deliberately ordered AFTER the root UPDATE
   * (`afterRoot: true`) — a NO-ACTION foreign key does not cascade a fresh row, so the
   * new parent has to exist first. Reordering the root UPDATE behind the children would
   * invert exactly that.
   *
   * E6.6 measured that only the `null` arm of the shared refusal is reachable from the
   * public client — the parse boundary has no `Sql` member in write data.
   */
  private transitionedCreateParent(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: OrdinaryChildHeldRelation
  ): { members: ForeignKeyMember[]; afterRoot: boolean } {
    const referencedFields = relation.membership.referencedFields;
    for (const field of referencedFields) {
      input.parentFkLocateFields.add(field);
    }
    const write = this.postTransitionReference(
      input.rootScalarData,
      relation.relationInfo.name,
      "nested create"
    );
    return {
      members: pairForeignKeyMembers(
        relation.membership.foreignFields,
        referencedFields,
        referencedFields.map(() => write)
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
    const referencedFields = relation.membership.referencedFields;
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
            relation.membership.foreignFields,
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
        relation.membership.foreignFields,
        referencedFields,
        referencedFields.map(() => plannedParentId(this.targetReadId))
      ),
      afterRoot: false,
    };
  }

  private interpretToManyKind(args: {
    entry: RelationMutationEntry;
    relation: OrdinaryChildHeldRelation;
    childScope: QueryScope;
    childName: string;
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
    const { entry, relation, childScope, childName, writeBase, input, adopt } =
      args;
    const { relationInfo } = relation;
    const { foreignFields, referencedFields } = relation.membership;
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
          writeBase.targetProjection,
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
            entry
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
   * H3 — compose the child-held half of the to-one lattice. THE RELATION OWNER, not
   * `RELATION_MUTATION_KEYS`, decides the order: vacate the prior member, supply the
   * new one, then modify it. Before H the accepted pairs were correct only because
   * that constant happened to list `disconnect`/`delete` ahead of the suppliers —
   * `isVacateThenSupply` read `kinds[0]`/`kinds[1]` POSITIONALLY, which
   * `parity-h-to-one-lattice` falsified by reordering the constant and turning all five
   * pairs red. The order is now stated here and the constant decides nothing.
   *
   * THE MODIFY'S LOCATOR is the composition's whole difficulty. A lone `update` on this
   * direction is located by correlation alone (`WHERE fk = parent`), and correlation at
   * PLANNING time — before any write — names the OUTGOING member, or nothing at all on
   * an empty slot. So a modify composed with a supplier is located by the SUPPLIER's
   * identity instead ({@link buildToOneUpdatePart}'s `suppliedWhere`), which is what
   * §6 H3 steps 3-4 ("capture or publish the supplied target's complete identity, then
   * pass that identity to `RecordUpdateCompiler`") mean on this direction.
   *
   * `connect` is the supplier that HAS such an identity at construction: its unique
   * selector. `create` has none — its row does not exist when every probe runs — and
   * `connectOrCreate`'s missing arm is the same row. Those two are refused below, at
   * their own site and with their own sentence, rather than composed wrongly.
   */
  private interpretInverseToOneComposition(args: {
    entries: readonly RelationMutationEntry[];
    relation: OrdinaryChildHeldRelation;
    childScope: QueryScope;
    childName: string;
    writeBase: Parameters<typeof buildToManyUpdateParts>[0];
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0];
    keyTransition: ReturnType<
      RecordUpdateCompilerState["interpretReferencedKeyTransition"]
    >;
    adopt?: PostTransitionAdopt;
  }): void {
    const { relation, writeBase, input } = args;
    const composition = composeToOneEntries(
      relation.relationInfo.name,
      args.entries
    );
    for (const entry of composition.entries) {
      if (
        entry.kind === "update" &&
        entry === composition.modify &&
        composition.suppliedWhere
      ) {
        input.childParts.push(
          buildToOneUpdatePart(writeBase, entry, composition.suppliedWhere)
        );
        continue;
      }
      this.interpretInverseToOneKind({ ...args, entry });
    }
  }

  /**
   * Compile ONE child-held to-one entry, at the position
   * {@link RecordUpdateCompilerState.interpretInverseToOneComposition} gives it. Every
   * arm here addresses the slot's current member, so correlation is the locator; the one
   * entry that may address a different row — a modify composed with a supplier — is
   * built by the composition owner instead and never reaches this dispatch. The parse
   * boundary limits it to create/connect/connectOrCreate/update/upsert plus optional
   * disconnect/delete.
   */
  private interpretInverseToOneKind(args: {
    entry: RelationMutationEntry;
    relation: OrdinaryChildHeldRelation;
    childScope: QueryScope;
    childName: string;
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
      writeBase,
      input,
      keyTransition,
      adopt,
    } = args;
    const { relationInfo } = relation;
    const { foreignFields, referencedFields } = relation.membership;
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
            writeBase.targetProjection,
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
            upsertInput: item,
            write: keyTransition.write,
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
            writeBase.targetProjection,
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
   *   · **`"guarded"`** — a real non-cascade transition. V1's occupied guard is emitted
   *     (reject an occupied OLD slot); the correlated / literal-parent-create kinds keep
   *     their ordinary part (empty-slot native), the to-one upsert reroutes its create
   *     arm onto the returned write source. The ADOPT kinds (`connect` /
   *     `connectOrCreate` / `set`, and a to-many `upsert`) take that source as their
   *     parent value and are ORDERED after the root UPDATE — N5-U1's
   *     {@link PostTransitionAdopt}, which is why the source is returned rather than
   *     consumed here.
   *
   * D2 — there is no `pastSurface` third answer any more. What used to be past the
   * surface — a COMPOUND reference, a NON-PK referenced unique (the D4 case), and a
   * pre-value the unique `where` does not pin — is now compiled by the same two
   * mechanisms the create leaf already had: the OLD value of every member is read from
   * the LOCATED ROW (the target projection publishes it; no extra planning read), and
   * the NEW value of every member is {@link postTransitionReference}, resolved per
   * member at compile. The single-member pinned shape keeps its construction-time
   * literal so its statements and parameters are byte-identical.
   *
   * WHAT THE GUARD NEWLY REFUSES, stated as a refusal rather than as a lift. Deleting
   * `pastSurface` did not only widen an accept: that branch returned BEFORE
   * {@link pushOccupiedGuard} could run, and its caller let nested `create` /
   * `createMany` through untouched. So a compound / non-primary-key / unpinned
   * reference carrying create-only relations used to compile with NO occupied guard and
   * NO transition probe, whatever sat in the old slot, while the PINNED single-member
   * twin of the same payload was refused with the occupied message. The guard is
   * kind-blind and relation-level, so making the two spellings one shape necessarily
   * costs the accept: that payload now takes a planning probe and refuses when the slot
   * is occupied. Measured on every driver leg in `compiled-key-transition-behavior`
   * ("an OCCUPIED old slot refuses the same nested create the empty slot accepts").
   *
   * RESIDUE, deliberate: the NO-OP short circuit (`increment: 0`, `set` to the value the
   * row already holds) is decidable only where `before` is a construction literal —
   * which needs BOTH a single-member reference and a locator that pins it, since a
   * compound reference has no construction-time `after` even when the locator pins
   * every member. Past that, a same-value write is treated as a real transition and the
   * occupied guard governs it, so such a payload is refused with the occupied message
   * when the old slot is occupied where a pinning single-member locator would accept.
   * It cannot be deferred to compile with the guard's own verdict, because the two
   * things the regime decides — `afterRootParts` ordering and the to-one upsert's
   * create-arm reroute — are construction-time structure, and only the reroute's
   * premise (the old slot is empty) would still hold. For every nested kind but
   * `create` / `createMany` this narrows a refusal that used to cover the whole shape;
   * for those two it is the new refusal described above.
   */
  private interpretReferencedKeyTransition(args: {
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0];
    relation: OrdinaryChildHeldRelation;
    childScope: QueryScope;
    childName: string;
  }): { regime: "none" } | { regime: "guarded"; write: FinalReferenceSource } {
    const { input, relation, childScope, childName } = args;
    const { foreignFields, referencedFields } = relation.membership;
    const relationName = relation.relationInfo.name;
    if (relation.membership.onUpdate === "cascade") return { regime: "none" };
    // Does the root SET rewrite a referenced parent column — or, E1, does a
    // shared-primary-key arm fold a new value into one? Both are the same fact about
    // the same column, and a transition that only ONE of them can see is the silent
    // orphan D2 closed for the scalar half.
    const changed = referencedFields.filter(
      (field) =>
        Object.hasOwn(input.rootScalarData, field) ||
        this.sharedKeyMembers.has(field)
    );
    if (changed.length === 0) return { regime: "none" };
    // The OLD value of each member, in schema order: the locator's literal where it pins
    // one, the located row otherwise. Both are pre-transition — the root UPDATE has not
    // run when this probe reads, and the located row is the row the update ACTED ON
    // (never the `where` re-consulted). An unpinned member joins `parentFkLocateFields`
    // so the locate publishes it; the row key is already seeded there, so a primary-key
    // reference adds no column at all. Never `locateFields`: these must not flip
    // `reorderRootUpdateAfterChildren`, which would invert the after-root ordering the
    // adopt family depends on.
    const readSources: PlanningReferenceSource[] = referencedFields.map(
      (field) => {
        const pinned = this.pinnedTargetValue(field);
        if (pinned) return { kind: "literal", value: pinned.value };
        input.parentFkLocateFields.add(field);
        return { kind: "planningField", step: this.targetReadId };
      }
    );
    // The post-transition value as a CONSTRUCTION literal, for the one shape that has
    // one: a single referenced member whose pre-value the locator pins. Keeping it is
    // what makes the guarded family's statements and parameters byte-identical to the
    // pre-D2 plan, and it is the only place the no-op question can be answered before
    // the locate runs. `length === 1` is not a first-member read: it IS the whole
    // reference key, and a compound one falls through to the per-member compile-time
    // source rather than borrowing member zero's answer.
    let write: FinalReferenceSource | undefined;
    if (
      referencedFields.length === 1 &&
      readSources[0]!.kind === "literal" &&
      // E1 — a member only a shared-primary-key fold rewrites has no scalar operand to
      // apply, so there is no construction-time `after` to compare; it takes the
      // per-member compile-time source below, which reads the fold's own value.
      Object.hasOwn(input.rootScalarData, referencedFields[0]!)
    ) {
      const before = readSources[0]!.value;
      const after = getUpdatedPrimaryKeyValue(
        this.model,
        referencedFields[0]!,
        before,
        input.rootScalarData[referencedFields[0]!],
        getStepModelName(this.model, "record")
      );
      // No-op transition (increment 0 / set same): the slot stays; ordinary parts hold.
      if (sameScalarValue(before, after)) return { regime: "none" };
      write = literalParentId(after);
    }
    write ??= this.postTransitionReference(
      input.rootScalarData,
      relationName,
      "membership"
    );
    // Emit V1's occupied guard (reject when the OLD slot, a child correlated on the
    // pre-transition parent values, is occupied). Hoisted ahead of every write, so the
    // rejection lands before the ordinary correlated / literal-parent-create part runs.
    this.pushOccupiedGuard({
      input,
      relation,
      childScope,
      childName,
      membership: {
        kind: "foreignKey",
        relation,
        members: pairCorrelatedForeignKeyMembers(
          foreignFields,
          referencedFields,
          readSources,
          referencedFields.map(() => write)
        ),
      },
    });
    return { regime: "guarded", write };
  }

  /** CLASS IV (T4c) — emit V1's occupied guard onto `relationKeyGuards`: a read of the
   *  OLD slot (a child correlated on the pre-transition parent values), locked in tx
   *  mode. D3: the correlation is lowered from the COMPLETE correlated binding through
   *  the membership owner, so every referenced member contributes its conjunct in schema
   *  order — a compound edge names all of them where a pinned-selector special case
   *  named one. A single-member edge collapses to the same one-conjunct `where` with the
   *  same single parameter it had before.
   *  The probe reads at planning; the verdict fires at compile
   *  ({@link compileRelationKeyGuards}), independent of the nested mutation kind — tx
   *  throws V1's byte-identical `NestedWriteError` before any write, batch pins the
   *  empty-slot race with an absence guard. */
  private pushOccupiedGuard(args: {
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0];
    relation: OrdinaryChildHeldRelation;
    childScope: QueryScope;
    childName: string;
    /**
     * The FOREIGN-KEY arm specifically, not the whole correlated union: the membership
     * owner answers a polymorphic binding in `predicate` with an EMPTY `filters`, and
     * `occupiedFind` reads `filters`. Naming the arm in the type is what keeps that a
     * compile error for whoever first gives a polymorphic relation an `onUpdate`
     * action, rather than a `WHERE (AND of nothing)` that reports every relation
     * occupied.
     */
    membership: Extract<
      CorrelatedRelationMembershipBinding,
      { kind: "foreignKey" }
    >;
  }): void {
    const { input, relation, childScope, childName, membership } = args;
    // Occupancy is decided by row COUNT, so this read selects the occupant's row
    // key purely to have a legal select list — through the projection owner, so a
    // compound-keyed child names every member instead of an arbitrary first one.
    const select = targetProjectionRowKeySelect(
      buildTargetProjection(childScope.model)
    );
    const occupiedFind = (filters: readonly Record<string, unknown>[]): Sql =>
      buildFind(
        childScope,
        {
          where: filters.length === 1 ? filters[0]! : { AND: filters },
          select,
          forUpdate: input.txMode,
        },
        { limit: 1 }
      );
    const probeId = input.scope.allocate(`${childName}.transition.find`);
    input.relationKeyGuards.push({
      relation,
      probeId,
      guardId: input.scope.allocate(`${childName}.guard.occupied`),
      probe: {
        id: probeId,
        kind: "read",
        statement: occupiedFind(
          planningMembershipCondition(
            this.engine,
            childScope,
            membership,
            childScope.rootAlias
          ).filters
        ),
        outputs: { rows: { kind: "rows" } },
      },
      premise: (known) =>
        occupiedFind(
          finalMembershipCondition(
            this.engine,
            childScope,
            membership,
            childScope.rootAlias,
            known,
            "update"
          ).filters
        ),
      oldReferenceIsAddressable: (known) =>
        membership.members.every(
          (member) =>
            foreignKeyResolvedReadValue(
              member,
              known,
              relation.relationInfo.name,
              "update"
            ) != null
        ),
    });
  }

  /** CLASS IV (T4c) — the to-one upsert's empty-slot accept-shape under a real
   *  non-cascade referenced-PK transition: its CREATE arm runs with the POST-transition
   *  FK, ordered AFTER the root UPDATE (a NO-ACTION FK does not cascade a fresh row — the
   *  new parent must exist first), exactly the T4b transitioned-PK create leaf. The
   *  update arm never runs (the occupied guard rejects an occupied slot; an empty slot
   *  creates). The relation-level occupied guard is already emitted
   *  ({@link interpretReferencedKeyTransition}).
   *
   *  H7, RAISED AND SETTLED BY MEASUREMENT (Package G raised it, Package E closed it).
   *  The claim was that dropping `upsertInput.update` here loses a payload silently. It
   *  does not, because the arm and the guard are emitted from the SAME regime decision
   *  over the SAME population — the child correlated on the parent's PRE-transition
   *  values — and {@link compileRelationKeyGuards} runs FIRST in
   *  {@link compileLocatedRecord}, so an occupied slot has already refused the whole
   *  operation before this arm can be reached. What is left for the arm to see is an
   *  EMPTY slot, where `create` is the only correct branch and an update payload has no
   *  row to apply to. Both halves are pinned, dual-substrate, in
   *  `tests/contracts/engine/query/relation-key-update-legality.test.ts`: :519 (occupied
   *  → the occupied refusal, state unchanged), :630 and :664 (empty → the child is
   *  created, and the fixture SPELLS the ignored `update` payload as `label: "Untaken"`
   *  while asserting `label: "Created"`), :698 (the batch race that plants a child
   *  between planning and the atomic unit → refused, nothing written).
   *
   *  RESIDUE, unpinned and deliberately unguarded: the guard's one skip path — a NULL
   *  member in the pre-transition reference tuple, {@link RelationKeyGuard.oldReferenceIsAddressable}
   *  — lets this reroute fire with no occupied verdict behind it. It is benign for the
   *  same reason the skip exists (a tuple with a NULL member addresses no child under
   *  MATCH SIMPLE, so the slot IS empty), and adding a check here would be a second owner
   *  for an invariant that already has one. */
  private rerouteTransitionedUpsertCreateArm(args: {
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0];
    relation: OrdinaryChildHeldRelation;
    childScope: QueryScope;
    upsertInput: NormalizedRelationUpsert;
    write: FinalReferenceSource;
  }): void {
    const { input, relation, childScope, upsertInput, write } = args;
    const relationName = relation.relationInfo.name;
    const createData = upsertInput.create;
    const { foreignFields, referencedFields } = relation.membership;
    const members = pairForeignKeyMembers(
      foreignFields,
      referencedFields,
      referencedFields.map(() => write)
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

  /**
   * H3 — compose the parent-held half of the to-one lattice: at most one intent, the
   * five replacements (a vacate beside a supplier), and `connect` + `update`. The
   * relation owner decides the composition; `RELATION_MUTATION_KEYS`'s order decides
   * nothing here, which is the coupling §6 H3 removes.
   *
   * PER-COLUMN FINAL ASSIGNMENT, decided here rather than at assembly. A parent-held
   * vacate and a parent-held supplier write the SAME foreign-key columns of the SAME
   * root UPDATE, so the pair has one final value per column and the supplier owns it —
   * the payload asks for a REPLACEMENT, and "replace" is what a non-null final
   * assignment means. Before H that value was whichever assignment
   * `Object.assign(parentSet, link.assignment)` happened to apply last
   * ({@link RecordUpdateCompilerState} constructor), an accident of `toOneLinks` order
   * with no test of its own. Now the vacate contributes no assignment at all when a
   * supplier is present, so the constructor's fold never sees two writers for one
   * column and the outcome does not depend on its order.
   *
   * Two consequences follow from the same fact and are spelled at their own sites:
   * {@link interpretParentHeldDelete} elides the FK-null UPDATE (its correlated DELETE
   * still addresses the OLD value), and `assertRelationCanDisconnect` is not consulted
   * — it answers "may this slot become EMPTY", and a replaced slot never does.
   */
  private interpretParentHeldComposition(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: ParentHeldRelation,
    entries: readonly RelationMutationEntry[]
  ): void {
    const relationName = relation.relationInfo.name;
    if (entries.length === 1) {
      this.interpretParentHeldToOne(input, relation, entries[0]!);
      return;
    }
    const vacate = entries.find(
      (entry) => entry.kind === "disconnect" || entry.kind === "delete"
    );
    const supplier = entries.find(
      (entry) =>
        entry.kind === "connect" ||
        entry.kind === "create" ||
        entry.kind === "connectOrCreate"
    );
    const modify = entries.find((entry) => entry.kind === "update");
    if (entries.length === 2 && supplier && vacate) {
      // The supplier is interpreted FIRST so its assignment is the only one on the
      // edge's columns, whichever key the payload spelled first. It goes through the
      // ordinary single-intent dispatch: a supplier means the same thing composed as it
      // does alone, and a second spelling of those three arms would be a second owner.
      this.interpretParentHeldToOne(input, relation, supplier);
      if (vacate.kind === "delete") {
        input.parentHeldTargets.push(
          this.interpretParentHeldDelete(input, relation, true)
        );
      }
      // `disconnect` beside a supplier contributes NOTHING: its whole parent-side
      // effect is the null assignment the supplier just replaced, and it owns no
      // target write to keep (unlike `delete`).
      return;
    }
    if (entries.length === 2 && supplier?.kind === "connect" && modify) {
      // The supplier's selector is read BEFORE it is interpreted, from the one accessor
      // that answers the question, so the composed modify cannot silently fall back to
      // FK correlation (which addresses the OUTGOING member) if the parse ever hands
      // this dispatch a target-less `connect`.
      const suppliedWhere = requireToOneConnectTarget(supplier, relationName);
      this.interpretParentHeldToOne(input, relation, supplier);
      const compiled = this.interpretParentHeldUpdate(
        input,
        relation,
        parentHeldUpdateTarget(modify, relationName),
        suppliedWhere
      );
      if (compiled) input.parentHeldTargets.push(compiled);
      return;
    }
    // Unreachable by construction: `to-one-mutation-schema.ts` is the lattice's owner
    // and admits, on this direction, exactly one intent, the five replacements, and
    // `connect` + `update` — every one of which is answered above. Reaching here means
    // the schema and this dispatch disagree about what a parent-held to-one payload can
    // be, which is an engine fault and not a shape we decline (the X1c precedent).
    throw new QueryEngineError(
      `query-engine-v2 internal: an uncomposable parent-held to-one payload reached the update dispatch on relation '${relationName}'; it has ${entries.map((entry) => entry.kind).join(", ")}.`
    );
  }

  /** Compile one parent-held to-one mutation at its required position. */
  private interpretParentHeldToOne(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: ParentHeldRelation,
    entry: RelationMutationEntry
  ): void {
    const { relationInfo } = relation;
    const relationName = relationInfo.name;
    switch (entry.kind) {
      case "connect":
      case "disconnect":
        input.toOneLinks.push(this.interpretToOneLink(input, relation, entry));
        return;
      case "create":
        input.parentHeldTargets.push(
          this.interpretParentHeldCreate(input, relation, entry)
        );
        return;
      case "connectOrCreate":
        input.parentHeldTargets.push(
          this.interpretParentHeldConnectOrCreate(input, relation, entry)
        );
        return;
      case "update": {
        const compiled = this.interpretParentHeldUpdate(
          input,
          relation,
          parentHeldUpdateTarget(entry, relationName)
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
   * H3 — that is the locator for an arm that addresses the slot's CURRENT member. A
   * composed arm addresses a different row and says so through `suppliedTarget`, whose
   * branch below replaces the FK correlation entirely rather than refining it. The
   * elided `delete` is the other exception and the opposite one: it keeps this
   * correlation deliberately on the OLD foreign key, because its `override` reads
   * `rootScalarData`, which a sibling supplier's rebind never enters, so what the
   * DELETE inlines is the located row's pre-update value.
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
   * threw), so a compound edge needs no new mechanism here. The other half — the
   * arity of the CHILD's own row key, which the probe captures and the arm's write
   * addresses — is now answered by the target projection: every member is published
   * and every member is addressed ({@link parentHeldProbeStatement},
   * {@link parentHeldCapturedRow}), so neither arity is a refusal any more.
   */
  private parentHeldCorrelation(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: ParentHeldRelation,
    suppliedTarget?: Record<string, unknown>
  ): ParentHeldCorrelation {
    const { foreignFields, referencedFields } = relation.membership;
    if (suppliedTarget) {
      // H3/R2 — the incoming member is named by the supplier's own unique selector, so
      // this arm reads none of the parent's foreign-key columns: adding them to the
      // locate would publish a value nothing consumes.
      return {
        childReferencedFields: referencedFields,
        parentFkFields: foreignFields,
        override: {},
        suppliedFilters: uniqueSelectorConjuncts(
          { model: relation.relationInfo.targetModel },
          suppliedTarget
        ),
      };
    }
    // Every parent FK column must be a firstRowField output of the locate read so
    // the untouched-column path can ref/read it. Held in the parent-FK set (NOT
    // `locateFields`): these are the parent's own columns, not child-referenced, so
    // a same-root rebind of one must not trigger the child-edge reorder.
    for (const field of foreignFields) input.parentFkLocateFields.add(field);
    return {
      childReferencedFields: referencedFields,
      parentFkFields: foreignFields,
      override: resolveParentFkRebinds(input.rootScalarData, foreignFields),
    };
  }

  /** A parent-held to-one `update`: locate the referenced target by the parent's
   *  final FK value, then compile its scalar and descendant mutations against the
   *  captured primary key. */
  private interpretParentHeldUpdate(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: ParentHeldRelation,
    target: ToOneUpdateTarget,
    /** H3/R2 — the sibling supplier's selector, when this modify composes with one. */
    suppliedTarget?: Record<string, unknown>
  ): ParentHeldTarget | undefined {
    const { relationInfo } = relation;
    const relationName = relationInfo.name;
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const correlation = this.parentHeldCorrelation(
      input,
      relation,
      suppliedTarget
    );
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    const childUpdate = buildParsedRelationPrograms(childScope, target.data);
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
    relation: ParentHeldRelation,
    /**
     * H3/R2 — a sibling supplier rebinds this edge's foreign-key columns in the same
     * root UPDATE, so the slot's FINAL assignment is that supplier's value.
     */
    rebound = false
  ): ParentHeldTarget {
    const { relationInfo } = relation;
    const relationName = relationInfo.name;
    // A required (non-nullable) FK cannot be nulled — V1's verbatim typed rejection.
    // It answers "may this slot become EMPTY", so a rebound edge is not its question:
    // the pair is a replacement and the column ends holding the supplier's value.
    if (!rebound) assertRelationCanDisconnect(relation);
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const correlation = this.parentHeldCorrelation(input, relation);
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    return {
      kind: "delete",
      relation,
      childScope,
      ...(rebound
        ? {}
        : { nullWriteId: input.scope.allocate("parent.fknull") }),
      deleteWriteId: input.scope.allocate(`${childName}.delete`),
      correlation,
    };
  }

  /** A parent-held to-one `upsert`: found → UPDATE the located target; absent →
   *  INSERT it (before root) and rebind the parent FK to the created identity. */
  private interpretParentHeldUpsert(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: ParentHeldRelation,
    entry: Extract<RelationMutationEntry, { kind: "upsert" }>
  ): ParentHeldTarget {
    const { relationInfo } = relation;
    const relationName = relationInfo.name;
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const correlation = this.parentHeldCorrelation(input, relation);
    const spec = entry.items[0];
    if (!(spec && spec.target.kind === "correlated")) {
      throw new QueryEngineError(
        `query-engine-v2 internal: parent-held to-one upsert on relation '${relationName}' requires one correlated target.`
      );
    }
    const before = this.buildBeforeTarget(childScope, spec.create);
    // E1 — the probe correlates the target on this very column, so a FOUND target
    // already holds the record's current key and the arm moves nothing; the MISSING arm
    // moves the record to the created target's key. One row key, so the two must agree,
    // and the record's current value is a value only where the selector pins it. What is
    // recorded when they do agree is therefore the key the record already holds — no
    // move, which is why `upsert` contributes no member to {@link sharedKeyMembers} and
    // the transition machinery stays out of it, and one owner for the member's final
    // value whichever arm the probe takes.
    this.recordSharedKeyFold(
      input,
      relation,
      "upsert",
      (foreignField, referencedField) => {
        const pinned = this.pinnedTargetValue(foreignField);
        const missing = this.beforeTargetReferencedValue(
          before,
          foreignField,
          referencedField,
          relationName
        );
        return pinned && fkEquals(pinned.value, missing)
          ? pinned.value
          : undefined;
      }
    );
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    const childUpdate = buildParsedRelationPrograms(childScope, spec.update);
    const hasUpdate =
      Object.keys(childUpdate.scalarData).length > 0 ||
      Object.keys(childUpdate.relations).length > 0 ||
      Object.keys(childUpdate.polymorphic).length > 0;
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
      probeId,
      guardId: input.scope.allocate(`${childName}.guard.exists`),
      parentSetId: input.scope.allocate("parent.fkset"),
      correlation,
      probe: {
        id: probeId,
        kind: "read",
        statement: this.parentHeldProbeStatement(
          childScope,
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
    // H3/R2 — a composed supplier names the INCOMING member itself. Correlating on the
    // parent's foreign-key column here would address the OUTGOING one: the column still
    // holds the old value at planning (the root UPDATE has not run) and at compile (the
    // located row is what is inlined).
    if (correlation.suppliedFilters) return [...correlation.suppliedFilters];
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
   *  <referenced> = <finalFk> [AND <filter>] [AND <every row-key member> =
   *  <its captured value>]`, one row, FOR UPDATE in tx. `filter` is W4-U3's non-unique
   *  `update: { where, data }` term on the currently connected record — a plain
   *  `WhereInput` handed to the find builder whole; a connected row that fails it
   *  leaves the probe empty, which is already this family's target-not-found abort
   *  ({@link parentHeldCapturedRow}).
   *
   *  `captured` is the whole probed row, not one primary-key value: the batch guard
   *  re-addresses the target through EVERY member of the projection's row key, so a
   *  compound-keyed child is pinned as exactly as a scalar-keyed one. The projection
   *  is the only source of both the select list and those conjuncts — nothing is
   *  passed beside it. */
  private parentHeldProbeStatement(
    childScope: QueryScope,
    correlation: ParentHeldCorrelation,
    captured: Readonly<Record<string, unknown>> | undefined,
    useRef: boolean,
    known?: Readonly<Record<string, unknown>>,
    filter?: Record<string, unknown>,
    projection: TargetProjection = buildTargetProjection(childScope.model)
  ): Sql {
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
            ...(captured === undefined
              ? []
              : capturedTargetFilters(childScope.model, projection, captured)),
          ],
        },
        select: targetProjectionSelect(projection),
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
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: ParentHeldRelation,
    entry: Extract<RelationMutationEntry, { kind: "create" }>
  ): ParentHeldTarget {
    const { relationInfo } = relation;
    const relationName = relationInfo.name;
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
    // E1 — one unconditional arm, so its foreign-key value IS the record's final row
    // key: the literal the create data spells, or the `Ref` its INSERT publishes.
    this.recordSharedKeyFold(
      input,
      relation,
      "create",
      (foreignField, referencedField) =>
        this.beforeTargetReferencedValue(
          before,
          foreignField,
          referencedField,
          relationName
        )
    );
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
    relation: ParentHeldRelation,
    entry: Extract<RelationMutationEntry, { kind: "connectOrCreate" }>
  ): ParentHeldTarget {
    const { relationInfo } = relation;
    const { referencedFields } = relation.membership;
    const relationName = relationInfo.name;
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
    // E1 — two arms, and the record has ONE row key: the found arm's value is the
    // `where`'s own literal (a `where` naming some other unique resolves through a
    // lookup subquery, which is no value), the missing arm's is what the target's
    // INSERT will hold, and they must be the same key.
    this.recordSharedKeyFold(
      input,
      relation,
      "connectOrCreate",
      (foreignField, referencedField) => {
        const found = Object.hasOwn(where, referencedField)
          ? where[referencedField]
          : undefined;
        const missing = this.beforeTargetReferencedValue(
          before,
          foreignField,
          referencedField,
          relationName
        );
        return found !== undefined && fkEquals(found, missing)
          ? found
          : undefined;
      }
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
   * `create` / `connectOrCreate` / `upsert` / `connect` at a selected record.
   *
   * MEASURED (E0 probe M3, Prisma 7.9.1): this is not a shape without semantics —
   * Prisma ACCEPTS it, and what it means is a **PK TRANSITION OF THE RECORD BEING
   * UPDATED**. The arm writes (or finds) the target, and the record's own primary
   * key then moves to that target's key; a destination key already taken is
   * Prisma's P2014. The alternative reading — the child ADOPTS the record's
   * existing key — is not merely unimplemented, it is unsatisfiable: the record is
   * alive and holds that key, so the target's INSERT always collides.
   *
   * E1 lifts the shape and keeps exactly the boundary the plan names: "reject only
   * if the exact final value cannot be captured or derived". So this is no longer a
   * refusal of the SHAPE but of an ARM THAT NAMES NO ONE VALUE for a row-key member,
   * and it records the value it does find ({@link sharedKeyFinal}) for the readers
   * that need it — the terminal read's where, the child-held transition machinery,
   * and the reorder decision. Its unique coverage — each disjunct below has a witness,
   * and a disjunct whose coverage could not be named was deleted at the Package E gate
   * rather than kept for symmetry:
   *   · `undefined` — the arm answers with no value at all. Two spellings reach it:
   *     a `connect` / `connectOrCreate` through a NON-referenced unique, whose `where`
   *     does not spell the referenced column (its foreign key comes from a correlated
   *     lookup SUBQUERY, which is a value the database produces once, inside one
   *     statement, and the terminal read is a different statement); and two arms that
   *     name DIFFERENT rows — a `connectOrCreate` whose `where` and `create` disagree,
   *     or an `upsert` whose found arm (the record keeps the key it has) and missing
   *     arm (the record moves to the created target's key) do. `fkEquals` is the same
   *     comparator `CreateOperation`'s twin uses for the same question at the create
   *     root. Before E1 the subquery spelling was answered at COMPILE by
   *     `getUpdatedPrimaryKeyValue`'s `Sql` branch, after the planning locate had
   *     already been issued, in a sentence about "an unsupported operation" — a true
   *     statement about an operand, and a confusing one about a fold;
   *   · `null` — a NULLABLE referenced unique named NULL in the `where`. Measured at
   *     the gate, and the reason this disjunct survived: nothing upstream refuses it
   *     (the parse boundary admits NULL for a nullable unique, and the arm's own
   *     not-found premise is about the probe, not about this record's key), so without
   *     it a NULL would be written into a row-key column and the terminal would address
   *     it;
   *   · a root SET that spells the same row-key member the arm folds. Two writers, one
   *     column — the arm would win the SET by assignment order and the scalar value
   *     would vanish without a word. This conjunct compares the arm against the ROOT
   *     SET only; two ARMS over one row-key member is not reachable here. H made ONE
   *     relation carrying two entries reachable, so that unreachability now rests on
   *     two facts rather than on the old one-entry dispatch: WITHIN a relation, only a
   *     SUPPLIER folds ({@link SHARED_KEY_FOLD_KINDS}) and the lattice admits at most
   *     one of them per relation in both directions, while the two entries that may now
   *     sit beside it write this edge's columns not at all — a parent-held `update`
   *     addresses the target row and assigns no foreign key, and a vacate composed with
   *     a supplier contributes no assignment either (a `disconnect` beside a supplier is
   *     dropped and a `delete` beside one has its FK-null write elided, both at
   *     {@link RecordUpdateCompilerState.interpretParentHeldComposition}); ACROSS
   *     relations, two parent-held edges declaring the same foreign field do not
   *     survive the migrator's duplicate constraint — the same inherited limit
   *     `CreateOperation.resolveSharedPkIdentity` records for the create root.
   * A member whose value the create arm simply cannot name is NOT this guard's: it is
   * already {@link beforeTargetReferencedValue}'s, in its own sentence, for the shared
   * and non-shared record alike — which is also why an `Sql` never arrives here:
   * `freshReferenced` returns `undefined` for one, and every other resolver reads a
   * parsed `where` or the operation's own pinned selector.
   */
  private recordSharedKeyFold(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: ParentHeldRelation,
    kind: string,
    resolve: (foreignField: string, referencedField: string) => unknown
  ): void {
    const recordPk = getPrimaryKeyFields(this.model);
    const { foreignFields, referencedFields } = relation.membership;
    for (let index = 0; index < foreignFields.length; index += 1) {
      const foreignField = foreignFields[index]!;
      if (!recordPk.includes(foreignField)) continue;
      const value = resolve(foreignField, referencedFields[index]!);
      const spelled = Object.hasOwn(input.rootScalarData, foreignField)
        ? classifyRelationKeyScalarUpdate(input.rootScalarData[foreignField])
        : undefined;
      if (
        value === undefined ||
        value === null ||
        (spelled && !(spelled.resolved && fkEquals(spelled.value, value)))
      ) {
        throw new UnsupportedOperationError(
          `query-engine-v2 update does not support a shared-primary-key ${kind} on relation '${relation.relationInfo.name}' whose foreign key '${foreignField}' (this record's primary key) does not resolve to one final value.`
        );
      }
      this.sharedKeyFinal[foreignField] = value;
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
    relation: ParentHeldRelation,
    before: BeforeTarget
  ): Record<string, unknown> {
    const { relationInfo } = relation;
    const { foreignFields, referencedFields } = relation.membership;
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
    relation: ParentHeldRelation,
    where: Record<string, unknown>
  ): Record<string, unknown> {
    const { relationInfo } = relation;
    const { foreignFields, referencedFields } = relation.membership;
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
                        ...capturedTargetFilters(
                          target.childScope.model,
                          target.compiler.targetProjection,
                          captured
                        ),
                        ...(target.filter ? [target.filter] : []),
                      ],
                    },
                    select: targetProjectionRowKeySelect(
                      target.compiler.targetProjection
                    ),
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
                          AND: capturedTargetFilters(
                            target.childScope.model,
                            target.compiler.targetProjection,
                            captured
                          ),
                        },
                        select: targetProjectionRowKeySelect(
                          target.compiler.targetProjection
                        ),
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
        target.relation.membership.referencedFields,
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
    const captured = this.parentHeldCapturedRow(
      known,
      target.probeId,
      relationInfo,
      "update"
    );
    if (this.mode === "batch") {
      guards.push(
        presenceGuard(
          target.guardId,
          this.parentHeldProbeStatement(
            target.childScope,
            target.correlation,
            captured,
            false,
            known,
            // W4-U3: the batch guard re-asserts the wrapper's filter alongside the
            // correlation and the captured row key — a concurrent write that makes
            // the connected row fail the filter aborts the batch typed, exactly as
            // the tx path's locked probe would have.
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
    if (target.nullWriteId !== undefined) {
      writes.push({
        id: target.nullWriteId,
        kind: "write",
        statement: buildUpdate(
          createQueryScope(this.engine.adapter, this.model),
          {
            where: this.parentPrimaryKeyWhere(locatedRow),
            data: Object.fromEntries(
              target.relation.membership.foreignFields.map((field) => [
                field,
                { set: null },
              ])
            ),
            select: this.pkSelect(),
          }
        ),
        outputs: {},
      });
    }
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
    const captured = this.parentHeldCapturedRow(
      known,
      target.probeId,
      relationInfo,
      "update"
    );
    if (this.mode === "batch") {
      guards.push(
        presenceGuard(
          target.guardId,
          this.parentHeldProbeStatement(
            target.childScope,
            target.correlation,
            captured,
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

  /** The parent's row-key where-unique for a dedicated parent-FK write. */
  private parentPrimaryKeyWhere(
    locatedRow: Record<string, unknown>
  ): Record<string, unknown> {
    return buildPrimaryKeyWhereUnique(
      this.model,
      Object.fromEntries(
        this.targetProjection.identityFields.map((pk) => [pk, locatedRow[pk]])
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

  /** The row the parent-held probe captured at planning — the located target this
   *  arm mutates, whole, so the caller can address every row-key member through the
   *  projection instead of one field this function picked. An empty capture is V1's
   *  verbatim "target record was not found for this parent" (the parent's FK pointed
   *  at nothing / a vanished row). */
  private parentHeldCapturedRow(
    known: Readonly<Record<string, unknown>>,
    probeId: string,
    relationInfo: RelationInfo,
    op: "update"
  ): Record<string, unknown> {
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
    return first as Record<string, unknown>;
  }

  private interpretToOneLink(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: ParentHeldRelation,
    entry: Extract<RelationMutationEntry, { kind: "connect" | "disconnect" }>
  ): ToOneLink {
    const scope = input.scope;
    const { relationInfo } = relation;
    const { foreignFields, referencedFields } = relation.membership;
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
    const connect = requireToOneConnectTarget(entry, relationName);
    // A directly-referenced unique folds its literal; a non-referenced one folds the
    // lookup subquery ({@link RecordUpdateCompilerState.toOneFkAssign}, E1 U1).
    const assignment = this.toOneFkAssign(relation, connect);
    // E1 — one arm, so the `where`'s own literal for a referenced column IS the record's
    // final row key. A column the `where` does not spell has only the lookup subquery,
    // which is not a value this operation can name twice.
    this.recordSharedKeyFold(
      input,
      relation,
      "connect",
      (_fk, referencedField) =>
        Object.hasOwn(connect, referencedField)
          ? connect[referencedField]
          : undefined
    );
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
    return targetProjectionRowKeySelect(this.targetProjection);
  }

  private writeWhere(
    locatedRow: Record<string, unknown>
  ): Record<string, unknown> {
    return buildPrimaryKeyWhereUnique(
      this.model,
      Object.fromEntries(
        this.targetProjection.identityFields.map((field) => [
          field,
          locatedRow[field],
        ])
      )
    );
  }
}

/**
 * E1 — the kinds of parent-held to-one arm that WRITE the record's foreign key from a
 * value of their own, and therefore move a row key that is also that foreign key.
 * `update` and `delete` are absent because neither supplies a foreign key. An `update`
 * writes the TARGET row and assigns none of this edge's columns, however it is located
 * (correlation when it stands alone, the supplier's selector when it is composed). A
 * `delete` alone NULLs the column, which a row-key member refuses at
 * {@link assertRelationCanDisconnect} before this question arises; a `delete` beside a
 * supplier does not write the column at all, because that UPDATE is elided and the
 * supplier — a fold kind, counted here — owns the slot's final value. `upsert` is absent
 * because its two arms are accepted only when they agree on the key the record already
 * holds — no move.
 */
const SHARED_KEY_FOLD_KINDS: ReadonlySet<string> = new Set([
  "connect",
  "create",
  "connectOrCreate",
]);

/**
 * E1 — which members of the selected record's row key a shared-primary-key arm will
 * rewrite, decided from the payload's TOPOLOGY alone (relation direction, entry kind,
 * and the overlap between the edge's foreign fields and the row key). No value is read
 * and no step is allocated, which is what lets it run BEFORE the relation loop: the
 * child-held transition machinery asks this question while that loop is still running,
 * and the answer must not depend on the order the payload happened to list relations
 * in. The matching VALUES arrive later, on the same map every reader consults at
 * compile ({@link RecordUpdateCompilerState.sharedKeyFinal}).
 *
 * Deliberately OVER-INCLUSIVE in one direction: an arm that folds the value the record
 * already holds is counted as a move, because only the arm itself can compare them and
 * it has not run yet. Stated as its CONSEQUENCE rather than its mechanism, because the
 * mechanism alone reads as harmless: a no-move fold takes the occupied guard, so
 * `card.update({ account: { connect: { id: <the key it already holds> } }, notes: { create } })`
 * is REFUSED when the child-held old slot is occupied, while the scalar spelling of the
 * identical final state (`accountId: <same key>`) is ACCEPTED — the scalar half reaches
 * `sameScalarValue` in {@link RecordUpdateCompilerState.interpretReferencedKeyTransition}
 * and this half cannot, because the value is not there yet. Measured on both substrates
 * at the Package E gate and pinned in `shared-pk-update-root-behavior.ts`. Kept rather
 * than closed: closing it means deriving each arm's value a SECOND time here, in a
 * second enumeration of "what does this arm fold", and a fold the two enumerations
 * disagree about is the silent orphan D2 closed. Refusing a satisfiable payload is the
 * recoverable direction; under-counting is not.
 */
function resolveSharedKeyMembers(
  targetScope: QueryScope,
  recordPk: readonly string[],
  relations: Readonly<Record<string, RelationMutationProgram>>,
  polymorphic: Readonly<Record<string, ResolvedPolymorphicMutation>> | undefined
): ReadonlySet<string> {
  const members = new Set<string>();
  for (const [relationName, program] of Object.entries(relations)) {
    // A targeted polymorphic edge writes its `polymorphicStorage` columns, never the
    // relation's `foreignFields`, and a storage column is private to that edge — it is
    // not a declared scalar and so is never a row-key member. Both maps are blind to it
    // together, which is the only reason this skip is safe; the day a storage id column
    // becomes addressable as a row key, this function is one of the four readers that
    // has to learn about it (with the transition regime, the reorder, and
    // {@link RecordUpdateCompilerState.updatedPrimaryKeyWhere}).
    if (polymorphic?.[relationName]?.kind === "targeted") continue;
    const relation = bindRelation(targetScope, program.relationInfo);
    if (relation.position !== "parentHeld") continue;
    // H — the question is "does any entry FOLD", never "is there exactly one entry".
    // A multi-kind to-one payload used to be refused before any of this mattered, by
    // `interpretRelation`'s OWN parent-held dispatch guard (`kinds.length !== 1`), and
    // reading the entry count here was reading that guard's premise rather than this
    // map's question. Package H's lattice admits a supplier beside an `update` and
    // beside a vacate, so the old skip would have gone fail-OPEN: the supplier would
    // still fill `sharedKeyFinal` while this map stayed empty, moving the terminal
    // without the transition regime, the reorder, or the occupied guard.
    // The union is over every entry, and at most one of them can be a fold: two
    // suppliers on one relation are refused by `to-one-mutation-schema.ts` (the lattice
    // owner) in both directions, and neither `update` nor a vacate is a fold kind. The
    // members a fold contributes do not depend on WHICH entry carries it — they are the
    // edge's foreign fields that this record's row key also names.
    let foldsThisRecordsKey = false;
    for (const entry of program.entries) {
      if (SHARED_KEY_FOLD_KINDS.has(entry.kind)) {
        foldsThisRecordsKey = true;
        break;
      }
    }
    if (!foldsThisRecordsKey) continue;
    for (const foreignField of relation.membership.foreignFields) {
      if (recordPk.includes(foreignField)) members.add(foreignField);
    }
  }
  return members;
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

/**
 * H3 — the child-held composition, as ONE ordered list. §6 H3's steps 1-4 are an ORDER
 * claim ("vacate, supply, capture the supplied identity, modify"), and before H that
 * order was an accident of `RELATION_MUTATION_KEYS` — `isVacateThenSupply` read
 * `kinds[0]`/`kinds[1]` POSITIONALLY off that constant, which `parity-h-to-one-lattice`
 * falsified by reordering it and turning all five accepted pairs red. The relation owner
 * states the order here instead, so the constant decides nothing.
 *
 * `suppliedWhere` is the locator the modify half needs. See
 * {@link RecordUpdateCompilerState.interpretInverseToOneComposition} for why a modify
 * composed with a supplier cannot use FK correlation, and why `connect` is the only
 * supplier whose identity exists before the fragment's first write.
 */
interface ComposedToOnePayload {
  readonly entries: readonly RelationMutationEntry[];
  readonly modify?: RelationMutationEntry;
  readonly suppliedWhere?: Record<string, unknown>;
}

/**
 * The unique selector a to-one `connect` names, from the ONE place that answers it.
 * Three readers need it — the parent-held link, the parent-held composition and the
 * child-held composition — and two of those three would otherwise fall back to FK
 * correlation, which at planning time addresses the OUTGOING member: the exact wrong-row
 * outcome H3 exists to prevent, arrived at silently. An absent target is not a payload
 * this layer declines: a to-one arm parses to exactly one record, because its schema is
 * an object and `isRecord` refuses arrays, so zero means the parse and this dispatch
 * disagree (an engine fault, the X1c precedent).
 */
/**
 * The one correlated target a parent-held to-one `update` entry carries, in the envelope
 * {@link RecordUpdateCompilerState.interpretParentHeldUpdate} consumes. Both the lone
 * `update` and the one composed with a `connect` ask for it, and they must not ask
 * differently.
 *
 * W4-U3: the payload reaches here as the relation schema's canonical envelope — bare
 * data and Prisma's `{ where?, data }` wrapper are told apart ONCE, at the parse, off
 * the user's own payload (a schema output rewrites scalar shorthands and is not a
 * faithful witness of the form). The wrapper's `where` is a NON-unique filter on the
 * connected record; it rides the locate, never the write. The bare form yields no
 * filter and is byte-identical to pre-W4-U3.
 */
function parentHeldUpdateTarget(
  entry: RelationMutationEntry,
  relationName: string
): ToOneUpdateTarget {
  const item = entry.kind === "update" ? entry.items[0] : undefined;
  if (!(item && item.target.kind === "correlated")) {
    throw new QueryEngineError(
      `query-engine-v2 internal: parent-held to-one update on relation '${relationName}' requires one correlated target.`
    );
  }
  return {
    data: item.data,
    ...(item.target.filter ? { filter: item.target.filter } : {}),
  };
}

function requireToOneConnectTarget(
  entry: Extract<RelationMutationEntry, { kind: "connect" }>,
  relationName: string
): Record<string, unknown> {
  const target = entry.targets[0];
  if (!target) {
    throw new QueryEngineError(
      `query-engine-v2 internal: to-one connect on relation '${relationName}' has no target.`
    );
  }
  return target;
}

function composeToOneEntries(
  relationName: string,
  entries: readonly RelationMutationEntry[]
): ComposedToOnePayload {
  if (entries.length <= 1) return { entries };
  let vacate: RelationMutationEntry | undefined;
  let supplier: RelationMutationEntry | undefined;
  let modify: RelationMutationEntry | undefined;
  for (const entry of entries) {
    if (TO_ONE_VACATE_KINDS.has(entry.kind)) vacate = entry;
    else if (TO_ONE_SUPPLY_KINDS.has(entry.kind)) supplier = entry;
    else if (entry.kind === "update") modify = entry;
  }
  const composed: RelationMutationEntry[] = [];
  for (const entry of [vacate, supplier, modify]) {
    if (entry) composed.push(entry);
  }
  if (composed.length !== entries.length || !supplier) {
    // Unreachable by construction: `to-one-mutation-schema.ts` owns the lattice and
    // admits, on this direction, one intent, a vacate beside a supplier, a supplier
    // beside a modify, and those two composed — every one of which is
    // (vacate?, supplier, modify?). Arriving here means the schema and this dispatch
    // disagree about what a to-one payload can be: an engine fault, not a shape this
    // layer declines (the X1c precedent).
    throw new QueryEngineError(
      `query-engine-v2 internal: an uncomposable child-held to-one payload reached the update dispatch on relation '${relationName}'; it has ${entries.map((entry) => entry.kind).join(", ")}.`
    );
  }
  if (!modify) return { entries: composed };
  if (supplier.kind !== "connect") {
    // NOT an arity refusal, and deliberately not the fall-through above either: the
    // shape is coherent and the lattice admits it, but this engine has no channel that
    // carries a row's identity from an INSERT into the selected-record compiler that
    // must then modify it. `RecordUpdateCompiler` locates its record with a PLANNING
    // read, and planning precedes every write in the fragment, so a row the same
    // fragment is about to insert cannot be read by the step that would address it.
    // `pinnedTarget` is not that channel: it carries the values a unique selector
    // already pinned, not an identity a later statement will produce. Naming the
    // obstacle rather than the arity keeps this truthful the day the channel lands.
    throw new UnsupportedOperationError(
      `query-engine-v2 update cannot compose '${supplier.kind}' with 'update' on the to-one relation '${relationName}': the modify addresses the supplied row through a planning read, and a '${supplier.kind}' supplier only produces that row's identity when it inserts it.`
    );
  }
  return {
    entries: composed,
    modify,
    suppliedWhere: requireToOneConnectTarget(supplier, relationName),
  };
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
