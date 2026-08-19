// biome-ignore-all lint/style/useFilenamingConvention: RecordUpdateCompiler is the architecture name.
import { NestedWriteError, QueryEngineError } from "@errors";
import type { PolymorphicStorageColumn } from "@schema/relation";
import { isSql, type Sql } from "@sql";
import {
  buildPrimaryKeyWhereUnique,
  getPrimaryKeyFields,
} from "../builders/correlation-utils";
import type { PolymorphicStorageValue } from "../builders/polymorphic-mutation";
import { directPolymorphicMembership } from "../builders/polymorphic-relation";
import {
  bindRelation,
  buildConnectSubqueryForField,
  type ChildHeldRelation,
  type ForeignKeyMemberPair,
  hasPolymorphicMembership,
  type OrdinaryChildHeldRelation,
  type ParentHeldRelation,
  type PolymorphicChildHeldRelation,
} from "../builders/relation-data-builder";
import type {
  NormalizedRelationUpsert,
  ParsedRelationMutation,
  RecordMutationData,
  RelationMutationEntry,
  RelationMutationProgram,
} from "../builders/relation-mutation-parser";
import { buildParsedRelationPrograms } from "../builders/relation-mutation-parser";
import {
  classifyToOneComposition,
  requireToOneConnectTarget,
  type ToOneContinuation,
} from "../builders/to-one-composition";
import {
  createQueryScope,
  getColumnName,
  getTableName,
} from "../context/query-scope";
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
  getMembershipScope,
  getRelationMembershipScope,
  relationMembershipScopesEqual,
} from "../RelationMembership";
import { assertRelationKeyUpdatesAreCompilable } from "../relation-key-legality";
import { classifyRelationKeyScalarUpdate } from "../TargetConstraint";
import type {
  QueryScope,
  RelationInfo,
  ResolvedPolymorphicEdge,
} from "../types";
import type { FreshRecordBuilder, FreshRecordPart } from "./CreateOperation";
import { type CreateRacePin, createRacePin } from "./create-race-pin";
import {
  buildFreshRecordSeriesPart,
  createManyCarriesRelations,
} from "./FreshRecordSeriesPart";
import {
  assignmentIdentityFromFieldValue,
  assignmentIdentityFromScalar,
  type FinalAssignmentIdentity,
  FinalRootAssignmentTruth,
  type RecordedFinalAssignment,
  refuseFinalAssignment,
} from "./final-root-assignment";
import {
  absenceGuard,
  affectedRows,
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
  relationOwnsForeignKey,
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
  type WriteStep,
} from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { conditionalArmPlanning, planningKey } from "./Part";
import { buildPolymorphicCollectionPart } from "./PolymorphicCollectionPart";
import { buildJunctionParts } from "./RelationJunctionPart";
import {
  buildJunctionToOneParts,
  isSingularCollectionInverse,
} from "./RelationJunctionToOnePart";
import { buildToManyLinkParts } from "./RelationLinkPart";
import {
  buildConnectOrCreateParts,
  buildCorrelatedToManyUpsertParts,
  refuseIncomingParentMutation,
} from "./RelationUpsertPart";
import {
  buildInverseToOneUpsertPart,
  buildToManyDeleteManyParts,
  buildToManyDeleteParts,
  buildToManySetPart,
  buildToManyUpdateManyParts,
  buildToManyUpdateParts,
  buildToOneContinuationPart,
  buildToOneUpdatePart,
} from "./RelationWritePart";
import {
  bindCorrelatedRelationMembership,
  bindRelationMembership,
  type CorrelatedRelationMembershipBinding,
  type FinalReferenceSource,
  type FinalReferenceSources,
  type ForeignKeyMember,
  finalMembershipCondition,
  fkEquals,
  foreignKeyCorrelationValue,
  foreignKeyResolvedReadValue,
  foreignKeyWriteValue,
  linkedPolymorphicStorage,
  literalParentId,
  literalReferenceSource,
  type PlanningReferenceSource,
  pairCorrelatedForeignKeyMembers,
  pairForeignKeyMembers,
  plannedParentId,
  planningMembershipCondition,
  planningSourceFromFinal,
  type RelationMembershipBinding,
  type RootMembershipAssignment,
  resolveFinalReferenceRowKey,
  resolvePolymorphicStorageValue,
  selectedRowContinuity,
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
type SelectedRowPhase = "beforeRoot" | "afterRoot";
type SelectedRowPhaseOwner = SelectedRowPhase | (() => SelectedRowPhase);

export interface RecordUpdateCompiler {
  readonly targetReadId: string;
  readonly writeId: string;
  readonly targetProjection: TargetProjection;
  planning(): readonly StatementStep[];
  compile(known: PlanningKnown): readonly OperationStep[];
  updatedPrimaryKeyWhere(
    locatedRow: Record<string, unknown>
  ): Record<string, unknown>;
  /** Exact post-update scalar value for an enclosing selected relation fold. */
  updatedFieldValue(
    field: string,
    locatedRow: Record<string, unknown>
  ): unknown;
  /** Deferred because an enclosing upsert's create arm must leave it inert. */
  assertSelectedIncomingParentLegality(): void;
}

export type StepAddress = { readonly id: string } | { readonly label: string };

export interface RecordUpdateCompilerInput {
  readonly scope: StepScope;
  readonly engine: QueryEngine;
  readonly targetScope: QueryScope;
  readonly scalarData: Record<string, unknown>;
  readonly relations: readonly ParsedRelationMutation[];
  readonly targetRead: StepAddress;
  readonly rootWrite: StepAddress;
  readonly incomingMembership?: RelationMembershipBinding;
  readonly relationName: string;
  /** Returning-driver affected-row failure for this selected root write. */
  readonly rootWriteFailure?: Failure;
  /** Construction-known discriminator values only; never the selector itself. */
  readonly pinnedTarget?: Readonly<Record<string, unknown>>;
  /** Extra selected fields an enclosing relation needs after this compiler runs. */
  readonly requiredTargetFields?: readonly string[];
  /**
   * The exact incoming parent selected by an enclosing correlated upsert. This record
   * transports the fact until it reaches the matching parent-held relation; unrelated
   * relations never consume it.
   */
  readonly incomingParentContinuity?: SelectedIncomingParentContinuity;
  /**
   * This compiler itself re-enters that selected incoming parent. Its locate remains
   * on the captured key while execution addresses use the key valid at placement.
   */
  readonly selectedTargetContinuity?: SelectedIncomingParentContinuity;
}

export interface SelectedIncomingParentContinuity {
  readonly membership: RelationMembershipBinding;
  readonly planningRowKey: Readonly<Record<string, PlanningReferenceSource>>;
  readonly executionRowKey: FinalReferenceSources;
  readonly executionSource: FinalReferenceSource;
  readonly demandExecutionField: (field: string) => void;
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
  // Emptiness is ONE count now: the parsed collection carries a targetless
  // polymorphic disconnect as its own entry, so "this record has work" no longer
  // depends on remembering a second map (ATOM §20).
  if (
    Object.keys(input.scalarData).length === 0 &&
    input.relations.length === 0 &&
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
  readonly assignment?: FinalRootAssignment;
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
    /** Referenced tuple whose planning values become the selected shared row key. */
    readonly capturedSharedFields?: readonly string[];
  };
}

/** One selected record's physical root assignment before compile-time sources are
 * lowered. It refines the central storage union only with the foreign-key
 * provenance this compiler needs for equality; it does not restate that union. */
type FinalRootAssignment =
  | (Extract<RootMembershipAssignment, { kind: "foreignKey" }> & {
      readonly members: readonly ForeignKeyMember[];
    })
  | Extract<RootMembershipAssignment, { kind: "polymorphic" }>;

/** One fresh compile's root-column truth. Contributions are compared before their
 * destination casts are rendered, then lowered into the existing UPDATE inputs. */
class FinalAssignmentLedger {
  readonly data: Record<string, unknown> = {};
  readonly finalValues: Record<string, unknown> = {};
  readonly polymorphicStorage: PolymorphicStorageValue<unknown>[] = [];

  private readonly truth: FinalRootAssignmentTruth;
  private readonly polymorphicIndexes = new Map<string, number>();
  private readonly engine: QueryEngine;
  private readonly scope: QueryScope;
  private readonly known: PlanningKnown;
  private readonly relationName: string;

  constructor(
    engine: QueryEngine,
    scope: QueryScope,
    known: PlanningKnown,
    relationName: string,
    truth = new FinalRootAssignmentTruth()
  ) {
    this.engine = engine;
    this.scope = scope;
    this.known = known;
    this.relationName = relationName;
    this.truth = truth;
  }

  absorbDemandedMembershipScalars(
    scalarData: Record<string, unknown>,
    binding: RelationMembershipBinding | undefined
  ): Record<string, unknown> {
    this.addScalarData(scalarData);
    if (binding?.kind !== "foreignKey") return this.data;
    const failure = relationOwnsForeignKey(
      this.relationName,
      binding.members.map((member) => member.foreignField)
    );
    for (const member of binding.members) {
      if (!Object.hasOwn(scalarData, member.foreignField)) continue;
      this.absorbMembershipScalar(member, failure);
    }
    return this.data;
  }

  fork(known: PlanningKnown): FinalAssignmentLedger {
    const fork = new FinalAssignmentLedger(
      this.engine,
      this.scope,
      known,
      this.relationName,
      this.truth.fork()
    );
    Object.assign(fork.data, this.data);
    Object.assign(fork.finalValues, this.finalValues);
    fork.polymorphicStorage.push(...this.polymorphicStorage);
    for (const [key, index] of this.polymorphicIndexes) {
      fork.polymorphicIndexes.set(key, index);
    }
    return fork;
  }

  addScalarData(data: Readonly<Record<string, unknown>>): void {
    for (const [field, value] of Object.entries(data)) {
      this.addData(field, value, assignmentIdentityFromScalar(value), "scalar");
    }
  }

  demandFinalValue(field: string, value: unknown, failure: string): void {
    this.contribute(
      getColumnName(this.scope.model, field),
      assignmentIdentityFromFieldValue(field, value),
      "demand",
      failure,
      true
    );
  }

  addRootAssignment(assignment: FinalRootAssignment, operation: string): void {
    if (assignment.kind === "foreignKey") {
      for (const member of assignment.members) {
        const value = foreignKeyWriteValue(
          member,
          this.known,
          this.relationName,
          operation
        );
        this.addData(
          member.foreignField,
          assignment.data[member.foreignField],
          {
            kind: "source",
            source: member.writeSource,
            referencedField: member.referencedField,
          },
          "fold"
        );
        this.finalValues[member.foreignField] = value;
      }
      return;
    }
    this.addPolymorphicStorage(assignment.storage, operation);
  }

  /** Prove a relation-selected final value without emitting another physical SET. */
  demandRootAssignment(assignment: FinalRootAssignment): void {
    if (assignment.kind !== "foreignKey") return;
    for (const member of assignment.members) {
      const value = foreignKeyWriteValue(
        member,
        this.known,
        this.relationName,
        "update"
      );
      this.contribute(
        getColumnName(this.scope.model, member.foreignField),
        {
          kind: "source",
          source: member.writeSource,
          referencedField: member.referencedField,
        },
        "demand"
      );
      this.finalValues[member.foreignField] = value;
    }
  }

  addMembership(binding: RelationMembershipBinding, operation: string): void {
    if (binding.kind === "foreignKey") {
      const members = binding.members;
      const failure = relationOwnsForeignKey(
        binding.relation.relationInfo.name,
        members.map((member) => member.foreignField)
      );
      for (const member of members) {
        const finalValue = foreignKeyWriteValue(
          member,
          this.known,
          binding.relation.relationInfo.name,
          operation
        );
        const value = referenceSql(
          this.engine,
          this.scope.model,
          member.foreignField,
          finalValue
        );
        this.addData(
          member.foreignField,
          value,
          {
            kind: "source",
            source: member.writeSource,
            referencedField: member.referencedField,
          },
          "membership",
          failure,
          true
        );
        this.finalValues[member.foreignField] = finalValue;
      }
      return;
    }
    this.addPolymorphicStorage(
      linkedPolymorphicStorage(
        binding.relation.membership,
        binding.writeSource
      ),
      operation
    );
  }

  private absorbMembershipScalar(
    member: ForeignKeyMember,
    failure: string
  ): void {
    const field = member.foreignField;
    this.contribute(
      getColumnName(this.scope.model, field),
      {
        kind: "source",
        source: member.writeSource,
        referencedField: member.referencedField,
      },
      "membership",
      failure
    );
    delete this.data[field];
  }

  private addData(
    field: string,
    value: unknown,
    identity: FinalAssignmentIdentity,
    origin: RecordedFinalAssignment["origin"],
    failure?: string,
    moveAgreeingScalar = false
  ): void {
    const column = getColumnName(this.scope.model, field);
    const previous = this.truth.get(column);
    this.contribute(column, identity, origin, failure);
    if (moveAgreeingScalar && previous?.origin === "scalar") {
      delete this.data[field];
    }
    this.data[field] = value;
  }

  private addPolymorphicStorage(
    value: PolymorphicStorageValue<FinalReferenceSource>,
    operation: string
  ): void {
    const { storage } = value;
    const typeIdentity: FinalAssignmentIdentity = {
      kind: "literal",
      value: value.kind === "empty" ? null : value.storedType,
    };
    const idIdentity: FinalAssignmentIdentity =
      value.kind === "empty"
        ? { kind: "literal", value: null }
        : {
            kind: "source",
            source: value.id,
            referencedField: value.referencedField,
          };
    const typeColumn = storage.typeColumn.name;
    const idColumn = storage.idColumn.name;
    this.contribute(typeColumn, typeIdentity, "fold");
    this.contribute(idColumn, idIdentity, "fold");
    const storageKey = `${typeColumn}\u0000${idColumn}`;
    const resolved = resolvePolymorphicStorageValue(
      this.engine,
      value,
      this.known,
      operation
    );
    const previousIndex = this.polymorphicIndexes.get(storageKey);
    if (previousIndex === undefined) {
      this.polymorphicIndexes.set(storageKey, this.polymorphicStorage.length);
      this.polymorphicStorage.push(resolved);
    } else {
      this.polymorphicStorage[previousIndex] = resolved;
    }
  }

  private contribute(
    column: string,
    identity: FinalAssignmentIdentity,
    origin: RecordedFinalAssignment["origin"],
    failure?: string,
    preserveExistingOnEqual = false
  ): void {
    this.truth.contribute(
      column,
      identity,
      origin,
      failure ??
        `query-engine-v2 update has conflicting final assignments for column '${column}' on relation '${this.relationName}'.`,
      preserveExistingOnEqual
    );
  }

  static refuse(message: string): never {
    return refuseFinalAssignment(message);
  }
}

/**
 * A nested record created ahead of the root parent UPDATE, whose possibly
 * generated identity the parent's FK column
 * references. It is the arity-1 `create` payload of the parent-held direction, with
 * the parent INSERT replaced by the parent UPDATE.
 *
 * E1 U3 — the target is a create SUBTREE, not one INSERT: a whole
 * {@link FreshRecordPart} in its `nestedFresh` mode, so the
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
/**
 * How a parent-held probe's found row is checked, and how a batch re-guards it.
 *
 * `referencedKey` is the ordinary shape: the payload's selector is complete on its
 * own, so the guard statement is built once at construction, and the found row owes a
 * NULL check on any referenced column the selector did not name
 * ({@link RecordUpdateCompilerState.assertLookupKeyPresent}, E1 U2).
 * `capturedDiscriminator` is what a DIRECT POLYMORPHIC target needs: it is named by a
 * discriminator beside a referenced value, so the guard is rebuilt at emit from the
 * value the probe published. ONE kept difference as ONE field, never two arms.
 */
type ParentHeldLookup =
  | {
      readonly kind: "referencedKey";
      readonly relation: ParentHeldRelation;
      readonly where: Record<string, unknown>;
      readonly guardProbe: Sql;
      readonly capturedFields?: readonly string[];
    }
  | {
      readonly kind: "capturedDiscriminator";
      readonly guardField: string;
      readonly where: Record<string, unknown>;
    };

type ParentHeldTarget =
  | {
      readonly kind: "create";
      readonly before: BeforeTarget;
      readonly assignment: FinalRootAssignment;
    }
  | {
      readonly kind: "connectOrCreate";
      readonly relationInfo: RelationInfo;
      readonly probeId: string;
      readonly guardId: string;
      readonly lookup: ParentHeldLookup;
      readonly probe: ReadStep;
      readonly foundAssignment: FinalRootAssignment;
      readonly before: BeforeTarget;
      /** Ordinary missing assignments demand the fresh target only after MISSING wins. */
      readonly missingRelation?: ParentHeldRelation;
      /** Direct-polymorphic storage does not share the selected root's public row key. */
      readonly missingAssignment?: FinalRootAssignment;
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
      readonly targetProjection: TargetProjection;
      /** The `update: { where, data }` wrapper's NON-unique filter on the
       *  currently connected record, ANDed into the locate probe AND the batch
       *  split-witness guard (never the write, which addresses the captured PK).
       *  Absent for the bare `update: <data>` spelling. */
      readonly filter?: Record<string, unknown>;
      readonly compiler?: RecordUpdateCompiler;
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
      readonly targetProjection: TargetProjection;
      readonly compiler?: RecordUpdateCompiler;
      readonly updateLegality?: () => void;
      readonly before: BeforeTarget;
    }
  /*
   * NOT YET COLLAPSED, and the blocker is named rather than worked around. The
   * `create` and `connectOrCreate` arms above now serve BOTH memberships, because
   * their only differences were the storage they assign (a `RootMembershipAssignment`
   * field) and how the found row is re-guarded (a `ParentHeldLookup` field). These
   * three carry differences that are not fields of the same shape:
   *
   *  · the LOCATOR differs — an ordinary arm addresses its target through the parent's
   *    final foreign-key values (`ParentHeldCorrelation`), a direct polymorphic one
   *    through the discriminator premise on the located row
   *    ({@link RecordUpdateCompilerState.assertPolymorphicCurrentTarget});
   *  · `delete` also differs STRUCTURALLY: the ordinary arm vacates the slot with its
   *    own `nullWriteId` UPDATE (elidable beside a supplier), while the polymorphic one
   *    folds an empty private pair into the root UPDATE's storage;
   *  · `upsert` also differs by `parentSetId` and by the missing arm's rebind.
   *
   * Collapsing them needs ONE more union — a parent-held locator — threaded through
   * `compileParentHeldUpdate` / `-Delete` / `-Upsert`. That is a behavior-preserving
   * change only if every probe, guard and step id is reproduced exactly, so it is left
   * for its own unit rather than smuggled in behind an optional field.
   */
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
 * `child.<member.referencedField> = <the parent's member.foreignField value>` AFTER
 * any same-root scalar rebind (V1 correlates on the post-update `parentValues` for a
 * parent-held relation). A rebound column resolves to a construction-time literal
 * (`override`); an untouched column resolves to the located parent row's value (a SQL
 * `Ref` at planning, the literal at compile).
 */
interface ParentHeldCorrelation {
  /** The bound membership's pairs: `foreignField` is the PARENT's own FK column here. */
  readonly members: readonly ForeignKeyMemberPair[];
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
  /** Exact outer selected row, captured before the outer root transition. */
  readonly selectedTarget?: SelectedIncomingParentContinuity;
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
  readonly relation: OrdinaryChildHeldRelation;
  readonly probeId: string;
  readonly guardId: string;
  readonly probe: ReadStep;
  /**
   * The BATCH premise: the same predicate with every located pre-value RESOLVED. It
   * cannot simply reuse `probe.statement`, because that statement may carry a
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
   * only since the regime widened to compound and non-primary-key references; a
   * primary key has no null member.
   */
  readonly oldReferenceIsAddressable: (known: PlanningKnown) => boolean;
}

/**
 * ONE child-held relation's resolved dispatch — position, cardinality, membership and
 * sources all decided, so {@link RecordUpdateCompilerState.interpretChildHeldEntry}
 * asks none of them again. Every field is stated by both resolvers; none is optional,
 * because "absent" was how the old pair spelled "no transition" and that let a caller
 * forget to answer.
 */
interface ChildHeldDispatch {
  readonly input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0];
  /** Carries the relation, both scopes, the target projection and the read source. */
  readonly writeBase: Parameters<typeof buildToManyUpdateParts>[0];
  /** In dispatch order: the to-one lattice's composition, or the parsed order. */
  readonly entries: readonly RelationMutationEntry[];
  /** H3 — the composed modify, whose locator is never FK correlation. */
  readonly modify: RelationMutationEntry | undefined;
  /** How that modify reaches its row: the supplier's selector, or a post-supply
   *  membership capture inside a record series. */
  readonly continuation: ToOneContinuation | undefined;
  /** Where a part that addresses the CURRENT membership lands. */
  readonly parts: Part[];
  /** Where an ADOPTING part lands: after the root UPDATE under a guarded transition. */
  readonly adoptParts: Part[];
  /** The source an adopting kind writes — post-transition where one applies. */
  readonly adoptWrite: FinalReferenceSource;
  /**
   * The referenced-key transition regime, which only a declared foreign key can be
   * under: a direct polymorphic membership resolves its transition into the write
   * source instead, and states `none` here.
   */
  readonly keyTransition:
    | { readonly regime: "none" }
    | { readonly regime: "guarded"; readonly write: FinalReferenceSource };
}

/**
 * H3 — the CARDINALITY decides whether a child-held payload composes: a singular
 * relation's entries are ordered vacate → supply → modify by the relation owner (and
 * the modify may be located by the supplier's identity), while a to-many payload keeps
 * the order the parser produced. The MEMBERSHIP does not enter into it — a fixed
 * polymorphic inverse takes the same lattice, from the same owner.
 */
function composeChildHeldEntries(
  relation: ChildHeldRelation,
  relationName: string,
  entries: readonly RelationMutationEntry[]
): ComposedToOnePayload {
  return relation.cardinality === "one"
    ? composeToOneEntries(relationName, entries)
    : { entries };
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
  // PHASE 5 PARTIAL: this scalar channel folds into the source-bound membership
  // only once the Part-level channels it feeds (WritePartBase.parentId /
  // membershipReadSource) fold — blocked on the kind-named lazy narrowing at the
  // Parts; see WritePartBase.membershipReadSource.
  private readonly parentIdSource: FinalReferenceSource;
  private readonly incomingParentContinuity:
    | SelectedIncomingParentContinuity
    | undefined;
  private readonly selectedTargetContinuity:
    | SelectedIncomingParentContinuity
    | undefined;
  private readonly childParts: readonly Part[];
  private readonly afterRootParts: readonly Part[];
  private readonly toOneLinks: readonly ToOneLink[];
  private readonly parentHeldTargets: readonly ParentHeldTarget[];
  private readonly relationKeyGuards: readonly RelationKeyGuard[];
  private readonly assignmentSeed: FinalAssignmentLedger;
  private readonly parentUpdateData: Record<string, unknown>;
  /**
   * E1 — which members of THIS record's row key a parent-held shared-primary-key arm
   * rewrites. Topological and payload-only (relation direction, entry kind, the
   * foreign/row-key overlap), so it is decided BEFORE the relation loop and every
   * relation can ask it whatever order the payload lists them in. It is the answer to
   * "does this update move the record's own key" for the half of that question the
   * scalar SET does not carry ({@link RecordUpdateCompilerState.relationTransitionFinal} carries
   * the value).
   */
  private readonly sharedKeyMembers: ReadonlySet<string>;
  /** Every root field whose final value is supplied by a selected parent-held arm.
   * The row-key subset above owns terminal identity; this complete set owns relation
   * transitions and downstream reference publication. */
  private readonly relationTransitionMembers: ReadonlySet<string>;
  /**
   * E1 — the FINAL value each of those members takes: the literal the arm spells, or
   * the `Ref` the before-root target's own INSERT publishes. The
   * arms fill it while the relation loop runs and every reader consults it at COMPILE —
   * the terminal read's where, and the post-transition source a child-held edge writes
   * — so no reader depends on the order the payload happened to list relations in.
   */
  private readonly relationTransitionFinal: Record<string, unknown> = {};
  private readonly relationTransitionSeed: Readonly<Record<string, unknown>>;
  private readonly requiredTargetFields: ReadonlySet<string>;
  private compiledFinalFieldValues: Readonly<Record<string, unknown>> = {};
  private compiledSelectedRowKey: Readonly<Record<string, unknown>> = {};
  private selectedIncomingParentKeyChange:
    | { readonly field: string; readonly relationName: string }
    | undefined;
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
    this.incomingParentContinuity = input.incomingParentContinuity;
    this.selectedTargetContinuity = input.selectedTargetContinuity;
    this.requiredTargetFields = new Set(input.requiredTargetFields ?? []);
    this.assignmentSeed = new FinalAssignmentLedger(
      input.engine,
      input.targetScope,
      {},
      input.relationName
    );
    const scalarUpdateData =
      this.assignmentSeed.absorbDemandedMembershipScalars(
        input.scalarData,
        input.incomingMembership
      );
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
    // No `parentPrimaryKeys.length === 0` refusal: `getPrimaryKeyFields` is total — a
    // model with no declared id answers `["id"]` — so the empty list is unreachable.
    // Same dead shape as `ManyAndReturnOperation.pkSelect`'s.
    const parentPrimaryKeys = getPrimaryKeyFields(this.model);
    this.targetReadId = resolveStepAddress(input.scope, input.targetRead);
    this.writeId = resolveStepAddress(input.scope, input.rootWrite);

    const parentIdSource =
      input.selectedTargetContinuity?.executionSource ??
      plannedParentId(this.targetReadId);
    this.parentIdSource = parentIdSource;
    const childParts: Part[] = [];
    const afterRootParts: Part[] = [];
    const toOneLinks: ToOneLink[] = [];
    const parentHeldTargets: ParentHeldTarget[] = [];
    const polymorphicStorage: PolymorphicStorageValue<FinalReferenceSource>[] =
      [];
    const relationKeyGuards: RelationKeyGuard[] = [];
    const relationTransitionMembers = new Set(
      resolveRelationTransitionMembers(
        input.targetScope,
        input.relations,
        parentPrimaryKeys
      )
    );
    const sharedKeyMembers = new Set(
      [...relationTransitionMembers].filter((field) =>
        parentPrimaryKeys.includes(field)
      )
    );
    if (input.incomingMembership?.kind === "foreignKey") {
      for (const member of input.incomingMembership.members) {
        relationTransitionMembers.add(member.foreignField);
        const finalValue = foreignKeyWriteValue(
          member,
          undefined,
          input.relationName,
          "update"
        );
        const isRowKey = parentPrimaryKeys.includes(member.foreignField);
        if (isRowKey && (finalValue === null || finalValue === undefined)) {
          FinalAssignmentLedger.refuse(
            `query-engine-v2 update cannot assign a null final value to row-key field '${member.foreignField}' through relation '${input.relationName}'.`
          );
        }
        this.relationTransitionFinal[member.foreignField] = finalValue;
        if (isRowKey) {
          sharedKeyMembers.add(member.foreignField);
        }
        this.assignmentSeed.demandFinalValue(
          member.foreignField,
          finalValue,
          relationOwnsForeignKey(
            input.relationName,
            input.incomingMembership.members.map(
              (incomingMember) => incomingMember.foreignField
            )
          )
        );
      }
    }
    this.relationTransitionMembers = relationTransitionMembers;
    this.sharedKeyMembers = sharedKeyMembers;
    const locateFields = new Set<string>([
      ...parentPrimaryKeys,
      ...(input.requiredTargetFields ?? []),
    ]);
    const parentFkLocateFields = new Set<string>();
    const targetColumns = new Map<string, PolymorphicStorageColumn>();
    const txMode = this.mode === "transaction";
    for (const parsed of input.relations) {
      // The targetless disconnects are lowered in their own pass below, after every
      // target mutation has been interpreted — the order the two former maps
      // produced, and the order the private columns are assembled in.
      if (parsed.kind === "polymorphicDisconnect") continue;
      if (parsed.kind === "polymorphicCollection") {
        // MOUNT 2 of 3 — a direct polymorphic collection under a LOCATED record.
        // A `childPart`, never a parent-held link: nothing it writes lands on
        // this row, so it has no assignment to reconcile into the root SET.
        childParts.push(
          this.buildCollectionPart({
            scope: input.scope,
            parent: input.targetScope,
            arm: parsed,
            parentIdSource,
            txMode,
          })
        );
        continue;
      }
      const { program } = parsed;
      if (parsed.kind === "polymorphicTarget") {
        const entry = program.entries[0];
        if (
          entry?.kind === "update" ||
          entry?.kind === "delete" ||
          entry?.kind === "upsert"
        ) {
          for (const column of [
            parsed.edge.storage.typeColumn,
            parsed.edge.storage.idColumn,
          ]) {
            targetColumns.set(column.name, column);
          }
        }
        this.interpretPolymorphicRelation({
          scope: input.scope,
          edge: parsed.edge,
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
        rootScalarData: scalarUpdateData,
      });
    }
    for (const parsed of input.relations) {
      if (parsed.kind !== "polymorphicDisconnect") continue;
      polymorphicStorage.push({
        kind: "empty",
        storage: parsed.storage,
      });
    }
    this.childParts = childParts;
    this.afterRootParts = afterRootParts;
    this.toOneLinks = toOneLinks;
    this.parentHeldTargets = parentHeldTargets;
    this.polymorphicStorage = polymorphicStorage;
    this.relationKeyGuards = relationKeyGuards;

    const parentSet = { ...scalarUpdateData };
    for (const link of toOneLinks) {
      if (link.assignment?.kind === "foreignKey") {
        Object.assign(parentSet, link.assignment.data);
      }
    }
    this.parentUpdateData = parentSet;
    this.relationTransitionSeed = { ...this.relationTransitionFinal };
    // E1 — a shared-primary-key fold writes the record's own row key from a RELATION
    // arm, so it never appears in `parentSet`. It is the same reorder question the
    // scalar SET asks, asked of the other half of the same column.
    this.reorderRootUpdateAfterChildren =
      childParts.length > 0 &&
      [...locateFields].some(
        (field) =>
          Object.hasOwn(parentSet, field) ||
          this.relationTransitionMembers.has(field)
      );
    const targetFields = [
      ...new Set([...locateFields, ...parentFkLocateFields]),
    ];
    for (const field of targetFields) {
      this.selectedTargetContinuity?.demandExecutionField(field);
    }
    this.targetProjection = buildTargetProjection(this.model, targetFields, [
      ...targetColumns.values(),
    ]);
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
        target.kind === "polymorphicUpdate" ||
        target.kind === "polymorphicUpsert"
      ) {
        steps.push(target.probe);
      }
      if (
        target.kind === "create" ||
        target.kind === "connectOrCreate" ||
        target.kind === "upsert" ||
        target.kind === "polymorphicUpsert"
      ) {
        steps.push(...target.before.subtree.planning(this.scope));
      }
      if (target.kind === "update" && target.compiler) {
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

  assertSelectedIncomingParentLegality(): void {
    const change = this.selectedIncomingParentKeyChange;
    if (!change) return;
    refuseIncomingParentMutation(change.relationName, change.field);
  }

  updatedPrimaryKeyWhere(
    locatedRow: Record<string, unknown>
  ): Record<string, unknown> {
    if (Object.keys(this.compiledSelectedRowKey).length > 0) {
      return buildPrimaryKeyWhereUnique(
        this.model,
        this.compiledSelectedRowKey
      );
    }
    const target = createQueryScope(this.engine.adapter, this.model);
    const modelName = getStepModelName(
      this.model,
      this.relationName || "record"
    );
    const folded = [...this.sharedKeyMembers].flatMap((field) =>
      Object.hasOwn(this.relationTransitionFinal, field)
        ? [[field, this.relationTransitionFinal[field]] as const]
        : []
    );
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
          ([field]) => !this.sharedKeyMembers.has(field)
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

  updatedFieldValue(
    field: string,
    locatedRow: Record<string, unknown>
  ): unknown {
    if (Object.hasOwn(this.compiledFinalFieldValues, field)) {
      return this.compiledFinalFieldValues[field];
    }
    if (
      this.sharedKeyMembers.has(field) &&
      Object.hasOwn(this.relationTransitionFinal, field)
    ) {
      return this.relationTransitionFinal[field];
    }
    if (!Object.hasOwn(this.parentUpdateData, field)) {
      return Object.hasOwn(this.compiledSelectedRowKey, field)
        ? this.compiledSelectedRowKey[field]
        : locatedRow[field];
    }
    return getUpdatedPrimaryKeyValue(
      this.model,
      field,
      locatedRow[field],
      this.parentUpdateData[field],
      getStepModelName(this.model, this.relationName || "record")
    );
  }

  private compileLocatedRecord(
    known: Readonly<Record<string, unknown>>,
    locatedRow: Record<string, unknown>
  ): OperationStep[] {
    this.compiledFinalFieldValues = {};
    this.compiledSelectedRowKey = this.resolveSelectedTargetRowKey(known);
    // Build-don't-select: to-one connect checks + child arms construct
    // their taken steps; the shared root update and deep terminal read emit once.
    // Guards hoist ahead of every write (batch pins premises first).
    for (const field of Object.keys(this.relationTransitionFinal)) {
      delete this.relationTransitionFinal[field];
    }
    Object.assign(this.relationTransitionFinal, this.relationTransitionSeed);
    const relationGuards: OperationStep[] = [];
    const connectGuards: OperationStep[] = [];
    const armGuards: OperationStep[] = [];
    const writes: OperationStep[] = [];
    // CLASS IV (T4c): the referential-action occupied guards. The transition is real
    // (before != after, decided at construction). tx mode inspects the locked probe
    // and throws V1's byte-identical `NestedWriteError` before any write; batch mode
    // pins the empty-slot decision with an `exists` guard that aborts the atomic unit
    // if the slot is occupied (the concurrent-plant race).
    const selectedLinks: FinalRootAssignment[] = [];
    for (const link of this.toOneLinks) {
      connectGuards.push(...this.compileToOneConnect(link, known));
      if (link.assignment) {
        const assignment = this.selectedToOneAssignment(link, known);
        selectedLinks.push(assignment);
        this.recordSelectedTransitionAssignment(assignment, known, "connect");
      }
    }
    // Parent-held target INSERTs land before the root UPDATE, whose FK assignment
    // references the possibly just-created identity.
    const beforeRootWrites: OperationStep[] = [];
    const rootExtraSet = this.compileParentHeldTargets(
      known,
      locatedRow,
      armGuards,
      beforeRootWrites,
      writes
    );
    for (const assignment of rootExtraSet.assignments) {
      this.recordSelectedTransitionAssignment(assignment, known, "update");
    }
    for (const demand of rootExtraSet.demands) {
      this.recordSelectedTransitionAssignment(demand, known, "update");
    }
    const selectedTargetOwnsKeyTransition = rootExtraSet.demands.some(
      (assignment) => this.assignmentMovesRelationReference(assignment)
    );
    this.compileRelationKeyGuards(known, locatedRow, relationGuards);
    const guards: OperationStep[] = [
      ...relationGuards,
      ...connectGuards,
      ...armGuards,
    ];
    for (const part of this.childParts) {
      bucketOperationSteps(part.compile(this.scope, known), guards, writes);
    }
    // The post-transition Parts (transitioned create leaves + the guarded adopt family).
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
    const assignments = this.assignmentSeed.fork(known);
    for (const assignment of selectedLinks) {
      assignments.addRootAssignment(assignment, "update");
    }
    for (const value of this.polymorphicStorage) {
      assignments.addRootAssignment(
        { kind: "polymorphic", storage: value },
        "update"
      );
    }
    for (const assignment of rootExtraSet.assignments) {
      assignments.addRootAssignment(assignment, "update");
    }
    for (const demand of rootExtraSet.demands) {
      assignments.demandRootAssignment(demand);
    }
    if (this.incomingMembership) {
      assignments.addMembership(this.incomingMembership, "update");
    }
    this.compiledFinalFieldValues = { ...assignments.finalValues };
    const hasRootUpdate =
      Object.keys(assignments.data).length > 0 ||
      assignments.polymorphicStorage.length > 0;
    const rootUpdate = hasRootUpdate
      ? this.buildRootUpdate(
          locatedRow,
          assignments.data,
          assignments.polymorphicStorage
        )
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
    const transitionWriteIds = selectedTargetOwnsKeyTransition
      ? new Set(rootExtraSet.transitionWriteIds)
      : undefined;
    const currentMembershipWrites = transitionWriteIds
      ? writes.filter((step) => !transitionWriteIds.has(step.id))
      : writes;
    const selectedTransitionWrites = transitionWriteIds
      ? writes.filter((step) => transitionWriteIds.has(step.id))
      : [];
    steps.push(...currentMembershipWrites);
    if (rootUpdate && this.reorderRootUpdateAfterChildren) {
      steps.push(rootUpdate);
    }
    steps.push(...selectedTransitionWrites);
    // CLASS III — every write whose foreign key is the POST-transition
    // referenced value lands here: the transitioned-PK create INSERTs, and the guarded
    // adopt family's reparent UPDATEs. They must follow the root UPDATE, which is what
    // makes the new parent row exist (a NO-ACTION foreign key does not cascade a fresh
    // or reparented row onto an id the transition has not written yet).
    if (this.afterRootParts.length > 0) {
      if (!(rootUpdate || selectedTargetOwnsKeyTransition)) {
        throw new QueryEngineError(
          "query-engine-v2 update built a post-transition child write with no selected key transition to run before it."
        );
      }
      steps.push(...afterRootWrites);
    }
    return steps;
  }

  private compileRelationKeyGuards(
    known: Readonly<Record<string, unknown>>,
    locatedRow: Readonly<Record<string, unknown>>,
    guards: OperationStep[]
  ): void {
    for (const guard of this.relationKeyGuards) {
      if (!guard.oldReferenceIsAddressable(known)) continue;
      if (
        guard.relation.membership.referencedFields.every((field) => {
          if (!Object.hasOwn(this.relationTransitionFinal, field)) return false;
          const after = this.relationTransitionFinal[field];
          return (
            !isOperationValueReference(after) &&
            fkEquals(locatedRow[field], after)
          );
        })
      ) {
        continue;
      }
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
    readonly edge: ResolvedPolymorphicEdge;
    readonly program: RelationMutationProgram;
    readonly txMode: boolean;
    readonly toOneLinks: ToOneLink[];
    readonly parentHeldTargets: ParentHeldTarget[];
    readonly polymorphicStorage: PolymorphicStorageValue<FinalReferenceSource>[];
  }): void {
    const { edge, program } = input;
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
        kind: "create",
        before,
        assignment: {
          kind: "polymorphic",
          storage: linkedPolymorphicStorage(
            directPolymorphicMembership(edge),
            source
          ),
        },
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
        createRacePin(childScope, spec.where)
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
        kind: "connectOrCreate",
        relationInfo: edge.relationInfo,
        probeId,
        guardId,
        lookup: {
          kind: "capturedDiscriminator",
          guardField,
          where: spec.where,
        },
        probe,
        before,
        foundAssignment: {
          kind: "polymorphic",
          storage: linkedPolymorphicStorage(directPolymorphicMembership(edge), {
            kind: "planningField",
            step: probeId,
          }),
        },
        missingAssignment: {
          kind: "polymorphic",
          storage: linkedPolymorphicStorage(
            directPolymorphicMembership(edge),
            source
          ),
        },
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
    data: RecordMutationData,
    filter: Record<string, unknown> | undefined,
    txMode: boolean
  ): Extract<ParentHeldTarget, { kind: "polymorphicUpdate" }> | undefined {
    const relationName = edge.relationInfo.name;
    const selectedTarget = this.selectedIncomingParentForPolymorphicEdge(edge);
    const parsed = buildParsedRelationPrograms(
      childScope,
      data.parsed,
      data.source
    );
    assertPortablePrimaryKeyUpdateInput(childScope.model, "update", {
      data: parsed.scalarData,
    });
    assertRelationKeyUpdatesAreCompilable(
      childScope,
      parsed.scalarData,
      parsed.relations
    );
    if (selectedTarget) {
      this.recordSelectedIncomingParentKeyChange(
        childScope,
        parsed.scalarData,
        parsed.relations,
        relationName
      );
    }
    const childName = getStepModelName(edge.targetModel, relationName);
    const compiler = this.recordCompilers.updateSelected({
      scope,
      engine: this.engine,
      targetScope: childScope,
      scalarData: parsed.scalarData,
      relations: parsed.relations,
      targetRead: { label: `${childName}.find` },
      rootWrite: { label: `${childName}.update` },
      relationName,
      ...(selectedTarget ? { selectedTargetContinuity: selectedTarget } : {}),
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
    create: RecordMutationData,
    update: RecordMutationData,
    txMode: boolean
  ): Extract<ParentHeldTarget, { kind: "polymorphicUpsert" }> {
    const relationName = edge.relationInfo.name;
    const selectedTarget = this.selectedIncomingParentForPolymorphicEdge(edge);
    const before = this.buildBeforeTarget(childScope, create);
    const source = before.subtree.rootReferenced(edge.referencedField);
    if (!source) {
      throw new QueryEngineError(
        `query-engine update cannot resolve referenced field '${edge.referencedField}' for relation '${relationName}'.`
      );
    }
    const parsed = buildParsedRelationPrograms(
      childScope,
      update.parsed,
      update.source
    );
    const hasUpdate =
      Object.keys(parsed.scalarData).length > 0 || parsed.relations.length > 0;
    if (selectedTarget) {
      this.recordSelectedIncomingParentKeyChange(
        childScope,
        parsed.scalarData,
        parsed.relations,
        relationName
      );
    }
    const childName = getStepModelName(edge.targetModel, relationName);
    const compiler = hasUpdate
      ? this.recordCompilers.updateSelected({
          scope,
          engine: this.engine,
          targetScope: childScope,
          scalarData: parsed.scalarData,
          relations: parsed.relations,
          targetRead: { label: `${childName}.find` },
          rootWrite: { label: `${childName}.update` },
          relationName,
          requiredTargetFields: [edge.referencedField],
          ...(selectedTarget
            ? { selectedTargetContinuity: selectedTarget }
            : {}),
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
      missingAssignment: linkedPolymorphicStorage(
        directPolymorphicMembership(edge),
        source
      ),
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

  /**
   * MOUNT 2 of 3 — the collection coordinator under a located record.
   *
   * It takes the SAME `parentIdSource` the junction arm above takes, broadcast
   * over the owner's row-key members, and the same nested builder — so a
   * collection target that carries its own relations folds one level deeper
   * exactly as a junction target does. There is no key-transition case to name
   * here that the junction arm does not already name: `interpretRelation`
   * returns for a junction before it classifies a referenced-key transition, and
   * a member junction inherits that reading with the same `ON UPDATE CASCADE`
   * ownership.
   */
  private buildCollectionPart(input: {
    scope: StepScope;
    parent: QueryScope;
    arm: Extract<ParsedRelationMutation, { kind: "polymorphicCollection" }>;
    parentIdSource: FinalReferenceSource;
    txMode: boolean;
  }): Part {
    const engine = this.engine;
    const scope = input.scope;
    const ownerSources = Object.fromEntries(
      getPrimaryKeyFields(input.parent.model).map((field) => [
        field,
        input.parentIdSource,
      ])
    );
    return buildPolymorphicCollectionPart({
      scope,
      engine,
      parentScope: input.parent,
      arm: input.arm,
      parentId: ownerSources,
      membershipReadSource: ownerSources,
      txMode: input.txMode,
      recordCompilers: this.recordCompilers,
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
    });
  }

  private interpretRelation(input: {
    scope: StepScope;
    parent: QueryScope;
    program: RelationMutationProgram;
    parentIdSource: FinalReferenceSource;
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
    const relation = bindRelation(input.parent, relationInfo);
    const entries = program.entries;

    if (entries.length === 0) {
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
      const junctionParentSources = Object.fromEntries(
        relation.membership.source.members.map((member) => [
          member.referencedField,
          input.parentIdSource,
        ])
      );
      // THE JUNCTION-TO-ONE FORK, asked BEFORE `buildJunctionParts` so the
      // decision has ONE writer. `OwnWriteRelation` already answers the same
      // question in the same words — `cardinality === "one"` on a bound junction —
      // when it resolves the composed continuation and the upsert decision, and a
      // compiler that only learned the shape INSIDE the plural fold would be the
      // ledger's N5 skew re-opened: one invariant, two readers, agreeing by
      // construction. A singular member table's four correlated spellings are the
      // to-one Part's; nothing else about the topology differs.
      if (isSingularCollectionInverse(relation)) {
        input.childParts.push(
          ...buildJunctionToOneParts({
            scope,
            engine,
            parentScope: input.parent,
            relation,
            program,
            parentId: junctionParentSources,
            membershipReadSource: junctionParentSources,
            txMode: input.txMode,
            recordCompilers: this.recordCompilers,
          })
        );
        return;
      }
      input.childParts.push(
        ...buildJunctionParts({
          scope,
          engine,
          parentScope: input.parent,
          relation,
          program,
          parentId: junctionParentSources,
          // A junction edge reads its EXISTING join rows by the located key.
          // `interpretRelation` returns for a junction before it classifies a
          // referenced-key transition, so `parentId` is the located source here too
          // and the two agree; naming the read source anyway is what stops that
          // agreement from being an unstated coincidence. Junction transitions stay
          // owned by the database's `ON UPDATE CASCADE` (both sides default to it),
          // and an opt-out pair fails closed at the constraint — measured, and left
          // exactly as measured, in `nested-arm-dispatch`'s B1 RESIDUE block.
          membershipReadSource: junctionParentSources,
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
      // This dispatch is TOTAL over the parent-held half of the to-one composition
      // lattice, not one arm behind an arity refusal. What an earlier measurement
      // declined to own is exactly what {@link interpretParentHeldComposition}
      // now owns: the FK-null of a `delete` is elided when a sibling supplier rebinds the
      // same columns (without the elision the fresh row was inserted and then ORPHANED —
      // `station.depotId = null`, `depots = [d-alt, d-new]`), and `disconnect` + supplier
      // no longer depends on which of two spellings object-assign order happened to leave
      // last in the root SET: the supplier is the only writer of those columns and says so.
      this.interpretParentHeldComposition(input, relation, entries);
      return;
    }

    // Child-held direction (the target holds the FK), ONE path from here for both
    // memberships and both cardinalities. One-to-many is the plural case; the
    // inverse-side one-to-one is its arity-1 case — the same correlated/global-adopt
    // child writes, differing only in the to-one payload spelling (`update: <data>`
    // with no selector, `disconnect: true`). The parent exists, so no fresh-parent
    // elision: every probe reads committed state, exactly as the to-many family
    // already does under update.
    this.interpretChildHeldRelation(input, relation, entries);
  }

  /**
   * THE child-held owner. It resolves the dispatch — position, cardinality,
   * membership, the parent's read/write sources and each half's Part list — and then
   * runs ONE loop over ONE per-entry dispatcher. The two resolvers below are the only
   * membership-specific code, and each keeps its own order of operations because that
   * order decides which refusal a malformed payload reports first.
   */
  private interpretChildHeldRelation(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: ChildHeldRelation,
    entries: readonly RelationMutationEntry[]
  ): void {
    const dispatch = hasPolymorphicMembership(relation)
      ? this.resolvePolymorphicChildHeld(input, relation, entries)
      : this.resolveOrdinaryChildHeld(input, relation, entries);
    // Multiple mutation kinds may coexist on one relation (V1's `{ delete,
    // deleteMany }`, `{ update, updateMany }`, …). Each present kind contributes its
    // own Part(s); they compose into the one linear fragment in the order the
    // resolved collection gives them (the to-one lattice's vacate → supply → modify
    // for a singular relation, `RELATION_MUTATION_KEYS` order otherwise).
    for (const entry of dispatch.entries) {
      this.interpretChildHeldEntry(dispatch, entry);
    }
  }

  /**
   * The ordinary child-held dispatch: the located parent is the source on every kind,
   * except under a guarded non-cascade referenced-key transition, where the ADOPT
   * kinds take the post-transition source and land after the root UPDATE.
   */
  private resolveOrdinaryChildHeld(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: OrdinaryChildHeldRelation,
    entries: readonly RelationMutationEntry[]
  ): ChildHeldDispatch {
    const relationInfo = relation.relationInfo;
    const relationName = relationInfo.name;
    // Compound foreign keys are per-field (ATOM “Field-bound foreign-key provenance”): every referenced parent
    // column — the PK, a subset of it, or a non-PK unique — is added
    // to the locate read's select/outputs so a per-field child part reads or refs
    // each one. The whole family (link/adopt/write/set) generalizes together; no
    // shape needs a separate path solely because the edge is compound.
    //
    // A nested `create`/`createMany` resolves its FK from the update's own inputs
    // (the referenced column pinned by the unique `where`, or rewritten by the root
    // SET), NOT from the located row, so a create-ONLY relation adds no referenced
    // column to `locateFields`. This keeps the ordering correct: the root UPDATE stays reorder-FALSE (before the child INSERT), so the
    // fresh row references the post-transition value that already exists.
    const needsLocatedReference = entries.some(
      (entry) => entry.kind !== "create" && entry.kind !== "createMany"
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
    // The ADOPT family under a guarded non-cascade transition. The occupied
    // guard just emitted proves the OLD slot is empty, so an adopt edge has exactly
    // one correct target: the parent's POST-transition referenced value, and the WRITE
    // is deferred until after the root UPDATE, which is what makes the row it points at
    // exist. Ordering closes this family; no new expressiveness was needed.
    //
    // The value is a construction literal where the locator pins the reference and
    // a per-member compile-time source otherwise; both are one `FinalReferenceSource`,
    // so nothing downstream distinguishes them. What used to be refused here (a
    // compound, non-PK, or unpinned reference under any kind but `create`) now takes
    // the second spelling and compiles.
    // The ADOPT family's two facts, kept apart because they are not one
    // fact: `adoptWrite` is the SOURCE an adopt edge writes (it overrides
    // `WritePartBase.parentId` and deliberately leaves `membershipReadSource` alone
    // — that split IS the old-read / new-write rule), and the adopt PLACEMENT is the
    // Part list whose writes are emitted after the root UPDATE. Without a transition
    // both fall back to the located source and the ordinary child-part list, byte for
    // byte.
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
    // H3 — the CARDINALITY decides the composition, for both memberships: a singular
    // relation's entries are ordered vacate → supply → modify by the relation owner,
    // and a to-many payload keeps the parsed order. Composed AFTER the transition
    // guard above, because that is where this call has always stood: a payload that is
    // both an illegal composition and a guarded transition reports the guard's refusal
    // first.
    const composition = composeChildHeldEntries(
      relation,
      relationName,
      entries
    );
    return {
      input,
      writeBase,
      entries: composition.entries,
      modify: composition.modify,
      continuation: composition.continuation,
      parts: input.childParts,
      adoptParts:
        keyTransition.regime === "guarded"
          ? input.afterRootParts
          : input.childParts,
      adoptWrite:
        keyTransition.regime === "guarded"
          ? keyTransition.write
          : input.parentIdSource,
      keyTransition,
    };
  }

  /**
   * The direct polymorphic child-held dispatch. Its ONE real difference from the
   * ordinary resolver is the parent triple: {@link resolvePolymorphicParent} answers
   * the read source, the write source and the placement together, because a private
   * `(type, id)` pair references the storage owner's own row key and a rewrite of that
   * key moves ALL of this relation's writes after the root UPDATE — not just the
   * adopting half. That is why both Part lists here are the same list.
   *
   * There is no guarded regime to carry: the ordinary side's occupied guard belongs to
   * a non-cascade referenced-key transition on a declared foreign key, and this
   * membership has none — its transition is already resolved into the write source.
   */
  private resolvePolymorphicChildHeld(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: PolymorphicChildHeldRelation,
    entries: readonly RelationMutationEntry[]
  ): ChildHeldDispatch {
    const relationName = relation.relationInfo.name;
    // H3 — the fixed inverse topology takes the SAME composition as the ordinary
    // child-held to-one: it is the same lattice owner (`to-one-mutation-schema.ts` via
    // the polymorphic relation input), the same `buildToOneUpdatePart` leaf, and the same
    // reason a composed modify cannot correlate. The discriminator is a qualifier of the
    // MEMBERSHIP key, never of the target's row key, so the supplied selector locates the
    // incoming row here exactly as it does there. Composed BEFORE the parent triple,
    // because that is where this call has always stood: a payload that is both an
    // illegal composition and a non-literal rewritten reference reports the
    // composition's refusal first.
    const composition = composeChildHeldEntries(
      relation,
      relationName,
      entries
    );
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
    // The inverse topology's discriminator is a fixed qualifier of the MEMBERSHIP
    // key, never a member of the target's row key: it is bound by
    // `bindRelationMembership` beside the write source, and the projection here
    // publishes only the target's own row key. So a compound-keyed polymorphic
    // target needs nothing that an ordinary child-held one does not.
    const writeBase: Parameters<typeof buildToManyUpdateParts>[0] = {
      scope: input.scope,
      engine: this.engine,
      relation,
      childName,
      childScope,
      targetProjection: buildTargetProjection(childScope.model),
      parentId: parent.write,
      membershipReadSource: parent.read,
      txMode: input.txMode,
      recordCompilers: this.recordCompilers,
    };
    return {
      input,
      writeBase,
      entries: composition.entries,
      modify: composition.modify,
      continuation: composition.continuation,
      parts: target,
      adoptParts: target,
      adoptWrite: parent.write,
      keyTransition: { regime: "none" },
    };
  }

  /**
   * ONE child-held entry, dispatched once — for both memberships and both
   * cardinalities. Everything that used to make three dispatchers out of this one is
   * decided BEFORE the switch and rides as data on {@link ChildHeldDispatch}: which
   * source an adopting kind writes, which source existing membership is read by, which
   * Part list each half lands in, and whether a guarded referenced-key transition
   * reroutes a to-one upsert's create arm.
   *
   * What stays inside the arms is the handful of differences that are real, each at the
   * one arm it belongs to: a fresh record's foreign-key provenance (an ordinary parent
   * resolves it per member at {@link RecordUpdateCompilerState.interpretChildHeldCreate};
   * a polymorphic one was already resolved into the write source), and the
   * correlated-versus-global upsert shapes. The switch enumerates the parsed entry
   * union exhaustively, and its `default` binds the entry to `never` so a future
   * twelfth kind is a compile error rather than a silent drop — which is what
   * retired the two runtime engine-fault throws the ordinary pair carried.
   */
  private interpretChildHeldEntry(
    dispatch: ChildHeldDispatch,
    entry: RelationMutationEntry
  ): void {
    const { input, writeBase, parts, adoptParts, adoptWrite, keyTransition } =
      dispatch;
    const { relation, childScope, childName, targetProjection, scope, txMode } =
      writeBase;
    const relationName = relation.relationInfo.name;
    const isInverseToOne = relation.cardinality === "one";
    const push = (built: readonly Part[]) => parts.push(...built);
    // An ADOPT kind writes the post-transition source and lands in the adopt list;
    // without a transition both are the located source and the ordinary child parts.
    const pushAdopt = (built: readonly Part[]) => adoptParts.push(...built);

    switch (entry.kind) {
      case "create":
      case "createMany": {
        // A fresh child's foreign key comes from whichever parent this membership
        // has. An ORDINARY one is resolved per member — a construction literal, the
        // located row's Ref, or a post-transition value — and that resolution also
        // decides whether the INSERT lands after the root UPDATE, so it keeps its own
        // owner (T3b-2 family E). A DIRECT POLYMORPHIC one is a single already-resolved
        // source, so the membership binds beside it and the Part lands with the rest of
        // this relation's writes.
        if (hasPolymorphicMembership(relation)) {
          if (entry.kind === "create") {
            push(
              entry.items.map((data) =>
                this.createFresh(this.scope, {
                  childScope,
                  data,
                  incomingMembership: bindRelationMembership(
                    relation,
                    adoptWrite
                  ),
                  relationName,
                })
              )
            );
            return;
          }
          if (createManyCarriesRelations(childScope, entry)) {
            // No `parentRowKey` here, and the omission is MEASURED rather than an
            // oversight: an inverse polymorphic parent is the polymorphic TARGET, and
            // schema rule P009 ("requires one scalar primary key") admits only a
            // single-scalar-PK target, whose one row-key member IS this membership's
            // referenced field. The membership derivation therefore always resolves the
            // complete row key on this edge, and threading the selected record's copy
            // beside it would be a second source for a fact that cannot disagree. The
            // ORDINARY child-held edge below is the one that can reference a non-row-key
            // unique, so that is where the selected row key is handed over.
            push([
              buildFreshRecordSeriesPart({
                scope,
                engine: this.engine,
                childScope,
                childName,
                relationName,
                rows: entry.rows,
                incomingMembership: bindRelationMembership(
                  relation,
                  adoptWrite
                ),
                skipDuplicates: entry.skipDuplicates === true,
                createFresh: this.createFresh,
              }),
            ]);
            return;
          }
          push([
            buildPolymorphicParentCreateManyPart({
              scope,
              engine: this.engine,
              childScope,
              childName,
              relation,
              parentId: adoptWrite,
              createManyEntry: entry,
            }),
          ]);
          return;
        }
        this.interpretChildHeldCreate({
          entry,
          relation,
          childScope,
          childName,
          input,
        });
        return;
      }
      case "connect":
        // Global lookup-and-adopt. On a singular relation the unique child FK
        // enforces the one-row slot; the database owns that, not a second guard here.
        pushAdopt(
          buildToManyLinkParts(
            scope,
            this.engine,
            relation,
            childName,
            childScope,
            targetProjection,
            entry,
            adoptWrite,
            txMode
          )
        );
        return;
      case "disconnect":
        // A required child FK cannot be nulled — V1's verbatim typed rejection, asked
        // here on every side because the answer is a property of the edge. A release
        // addresses the rows that carry the parent's CURRENT value, so it reads the
        // membership source and keeps its place among the ordinary child parts.
        assertRelationCanDisconnect(relation);
        push(
          buildToManyLinkParts(
            scope,
            this.engine,
            relation,
            childName,
            childScope,
            targetProjection,
            entry,
            writeBase.membershipReadSource,
            txMode
          )
        );
        return;
      case "connectOrCreate":
        // Still a GLOBAL lookup-and-adopt under update (found → reparent, absent →
        // create), never correlated.
        pushAdopt(
          buildConnectOrCreateParts(
            scope,
            this.engine,
            entry.items,
            bindRelationMembership(relation, adoptWrite),
            txMode,
            this.recordCompilers
          )
        );
        return;
      case "upsert": {
        if (isInverseToOne) {
          // A correlated probe decides found → update / absent → create (fk = parent),
          // no unique `where` — the same locator as the `update` arm, with a create
          // branch.
          const item = entry.items[0];
          if (!item) {
            throw new QueryEngineError(
              `query-engine-v2 internal: inverse to-one upsert on relation '${relationName}' has no item.`
            );
          }
          // CLASS IV (T4c): under a guarded transition the relation-level occupied
          // guard has already rejected an occupied old slot, so the update arm is
          // unreachable and the CREATE arm is rerouted onto the post-transition source,
          // ordered after the root UPDATE.
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
          push([buildInverseToOneUpsertPart(writeBase, item)]);
          return;
        }
        {
          const membership = bindCorrelatedRelationMembership(
            relation,
            planningSourceFromFinal(
              writeBase.membershipReadSource,
              relationName,
              "upsert"
            ),
            adoptWrite
          );
          const phase: SelectedRowPhaseOwner =
            adoptParts === input.afterRootParts
              ? "afterRoot"
              : () => this.ordinaryChildPhase();
          pushAdopt(
            buildCorrelatedToManyUpsertParts(
              scope,
              this.engine,
              entry.items,
              membership,
              txMode,
              this.recordCompilers,
              this.selectedIncomingParentAt(
                membership,
                phase,
                input.rootScalarData,
                input.parentFkLocateFields
              )
            )
          );
        }
        return;
      }
      case "update": {
        // Correlation is the whole locator on a singular relation; the optional
        // `{ where, data }` wrapper arrives already told apart from bare data by the
        // relation schema. The ONE entry that addresses a different row — a modify
        // composed with a supplier — takes the composition's continuation instead (H3).
        if (!isInverseToOne) {
          push(buildToManyUpdateParts(writeBase, entry));
          return;
        }
        const continuation =
          entry === dispatch.modify ? dispatch.continuation : undefined;
        if (continuation?.kind === "membershipCapture") {
          // The supplier PRODUCES the row, so nothing names it until that write lands.
          // The modify becomes a record-series continuation: capture the singular
          // member through the exact physical-membership predicate the supplier just
          // satisfied, then compile the ordinary selected-record update against the
          // captured row key.
          //
          // It is an ADOPT part in BOTH of that family's senses, and it needs both:
          // the adopt PLACEMENT keeps it behind its own supplier (the ordinary child
          // parts, or the after-root parts under a guarded referenced-key transition),
          // and `adoptWrite` is the source the capture must correlate on, because the
          // row it is looking for is the one the supplier just wrote the POST-
          // transition value onto. Reading the located pre-transition value here would
          // find no member at all — the ordinary old-read/new-write split, on the one
          // arm whose read is looking for what a sibling write just produced.
          pushAdopt([
            buildToOneContinuationPart(
              { ...writeBase, parentId: adoptWrite },
              entry
            ),
          ]);
          return;
        }
        push([buildToOneUpdatePart(writeBase, entry, continuation?.where)]);
        return;
      }
      case "updateMany":
        push(buildToManyUpdateManyParts(writeBase, entry));
        return;
      case "delete":
        // On a singular relation `delete: true` is a correlated bulk delete — DELETE
        // child WHERE fk = parent. `true` is the arm's only reachable value: the parse
        // boundary types it `v.boolean()` and `false` is Prisma's no-op, dropped from
        // the entry list.
        push(
          isInverseToOne
            ? buildToManyDeleteManyParts(writeBase, {
                kind: "deleteMany",
                filters: [{}],
              })
            : buildToManyDeleteParts(writeBase, entry)
        );
        return;
      case "deleteMany":
        push(buildToManyDeleteManyParts(writeBase, entry));
        return;
      case "set":
        // `set` is BOTH halves at once: it reparents its targets (the adopt half) and
        // releases the departing rows, which still carry the PRE-transition value.
        // `membershipReadSource` keeps those two apart; without a transition they are
        // the same source.
        pushAdopt([
          buildToManySetPart({ ...writeBase, parentId: adoptWrite }, entry),
        ]);
        return;
      default: {
        const unhandled: never = entry;
        throw new Error(`unreachable entry kind ${JSON.stringify(unhandled)}`);
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
    const field = relation.membership.referencedField;
    const pinned = this.pinnedTargetValue(field);
    const read = pinned
      ? literalParentId(pinned.value)
      : plannedParentId(this.targetReadId);
    if (!pinned) input.parentFkLocateFields.add(field);
    if (!Object.hasOwn(input.rootScalarData, field)) {
      return {
        read,
        write: this.selectedTargetContinuity ? this.parentIdSource : read,
        afterRoot: false,
      };
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
        relation.relationInfo.name
      ),
      afterRoot: true,
    };
  }

  /**
   * The ONE post-transition reference-value derivation, for every member of a
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
   * derivable post value go to
   * {@link requireRewrittenReferenceValue}, the one owner of that verdict, rather
   * than falling into `getUpdatedPrimaryKeyValue`'s internal error.
   *
   * Residual §G1/§G2 — this position no longer names itself in a message. The
   * refusal it used to spell ("nested create" / "membership") was one sentence with
   * a noun swapped, and the noun was the only thing distinguishing it from the
   * construction-time twin in {@link resolveCreateParent}; both now call one owner
   * whose sentences name the FIELD and the RELATION instead.
   */
  private postTransitionReference(
    rootScalarData: Record<string, unknown>,
    relationName: string
  ): FinalReferenceSource {
    const model = this.model;
    const stepModelName = getStepModelName(model, "record");
    return transitionedParentId(this.targetReadId, (before, field) => {
      // E1 — a member a shared-primary-key arm MOVES takes the fold's own final value:
      // the literal the arm spells, or the `Ref` the before-root INSERT publishes. Read
      // HERE, at compile, which is why the arms may fill the map in any order.
      //
      // Asked of the transition topology, not the row-key subset, so that "does this
      // referenced member move" has one answer everywhere. A compound edge may move a
      // non-row-key member that a downstream relation also references. A member in this
      // set always has its value by the time this closure runs: the arm either filled
      // the map or refused.
      if (this.relationTransitionMembers.has(field)) {
        return this.relationTransitionFinal[field];
      }
      // A member the SET leaves alone is not in transition: the located value IS the
      // value the membership must reference.
      if (!Object.hasOwn(rootScalarData, field)) return before;
      const operand = rootScalarData[field];
      // The verdict only; the unwrapped literal it hands back is this position's
      // INPUT, not its answer — `getUpdatedPrimaryKeyValue` needs the original
      // operand so a portable arithmetic envelope can still be applied to `before`.
      requireRewrittenReferenceValue({
        operand,
        locatedValueKnown: true,
        relationName,
        field,
      });
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
   * The complete key of this exact selected row at a caller-owned execution phase.
   * Every member comes from the captured target projection. An after-root member then
   * applies the compiler's one post-transition derivation; unchanged members return
   * their captured value. The phase may be lazy because ordinary child placement is
   * known only after the complete relation topology decides root ordering.
   */
  private selectedRowKeyAt(
    phase: SelectedRowPhaseOwner,
    rootScalarData: Record<string, unknown>,
    relationName: string
  ): FinalReferenceSources {
    const transitioned = this.postTransitionReference(
      rootScalarData,
      relationName
    );
    if (transitioned.kind !== "transitionedPlanningField") {
      throw new QueryEngineError(
        "query-engine-v2 internal: selected-row continuity requires one transitioned planning source."
      );
    }
    const source = selectedRowContinuity(this.targetReadId, (before, field) => {
      const resolvedPhase = typeof phase === "function" ? phase() : phase;
      return resolvedPhase === "beforeRoot"
        ? before
        : transitioned.apply(before, field);
    });
    return Object.fromEntries(
      getPrimaryKeyFields(this.model).map((field) => [field, source])
    );
  }

  /** One transport for the exact incoming parent. The relation owner supplies only
   * placement; this compiler supplies both captured and execution-time keys. */
  private selectedIncomingParentAt(
    membership: RelationMembershipBinding,
    phase: SelectedRowPhaseOwner,
    rootScalarData: Record<string, unknown>,
    executionProjection: Set<string>
  ): SelectedIncomingParentContinuity {
    const relationName = membership.relation.relationInfo.name;
    const planningSource: PlanningReferenceSource = {
      kind: "planningField",
      step: this.targetReadId,
    };
    const executionRowKey = this.selectedRowKeyAt(
      phase,
      rootScalarData,
      relationName
    );
    const firstKey = getPrimaryKeyFields(this.model)[0]!;
    return {
      membership,
      planningRowKey: Object.fromEntries(
        getPrimaryKeyFields(this.model).map((field) => [field, planningSource])
      ),
      executionRowKey,
      executionSource: executionRowKey[firstKey]!,
      demandExecutionField: (field) => executionProjection.add(field),
    };
  }

  private ordinaryChildPhase(): SelectedRowPhase {
    return this.reorderRootUpdateAfterChildren ? "beforeRoot" : "afterRoot";
  }

  private resolveSelectedTargetRowKey(
    known: PlanningKnown
  ): Readonly<Record<string, unknown>> {
    const continuity = this.selectedTargetContinuity;
    if (!continuity) return {};
    const resolved = resolveFinalReferenceRowKey(
      this.model,
      Object.entries(continuity.executionRowKey).map(([field, source]) => ({
        field,
        source,
      })),
      known,
      this.relationName,
      "update"
    );
    if (resolved) return resolved;
    throw new QueryEngineError(
      `query-engine-v2 selected incoming-parent re-entry on relation '${this.relationName}' could not resolve the complete execution row key.`
    );
  }

  /** Complete selected-parent identity for a progressive nested series. */
  private progressiveParentRowKey(
    rootScalarData: Record<string, unknown>,
    phase: SelectedRowPhaseOwner
  ): FinalReferenceSources | undefined {
    if (
      this.engine.driver.supportsTransactions ||
      !this.engine.driver.supportsBatch
    ) {
      return undefined;
    }
    return this.selectedRowKeyAt(phase, rootScalarData, this.relationName);
  }

  /**
   * A child-held nested `create`/`createMany` under the update root. The fresh
   * child's foreign key is the located parent's
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
          this.createFresh(this.scope, {
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
    if (createManyCarriesRelations(childScope, entry)) {
      const parentRowKey = this.progressiveParentRowKey(
        input.rootScalarData,
        afterRoot ? "afterRoot" : () => this.ordinaryChildPhase()
      );
      target.push(
        buildFreshRecordSeriesPart({
          scope: input.scope,
          engine: this.engine,
          childScope,
          childName,
          relationName,
          rows: entry.rows,
          incomingMembership: {
            kind: "foreignKey",
            relation,
            members,
          },
          ...(parentRowKey ? { parentRowKey } : {}),
          skipDuplicates: entry.skipDuplicates === true,
          createFresh: this.createFresh,
        })
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
   *     — → the **located-parent Ref**: every referenced column joins the locate
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
   *   - `ON UPDATE CASCADE`, any arity, pinned or not → the LOCATED pre-transition
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
        this.relationTransitionMembers.has(field)
    );
    if (rewritten.length === 0) {
      return this.locatedCreateParent(input, relation);
    }
    // A rewritten reference on an `ON UPDATE CASCADE` edge needs NO
    // post-transition derivation at all, whatever its arity and wherever its
    // pre-transition value lives. Write the fresh row against the LOCATED (pre-transition)
    // values, before the root UPDATE, and the cascade carries it new — the same ordering
    // `reorderRootUpdateAfterChildren` already applies to a reparent, applied to an
    // INSERT. `locatedCreateParent` is entered unchanged, so a compound reference rides
    // it per field. This is checked BEFORE the arity and
    // pinned-value branches below, because both of those exist only to derive a
    // POST-transition value, and a cascading edge never needs one.
    if (relation.membership.onUpdate === "cascade") {
      return this.locatedCreateParent(input, relation);
    }
    if (referencedFields.length !== 1) {
      // A NON-cascade COMPOUND reference the root SET rewrites. The located row
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
    if (this.relationTransitionMembers.has(referencedField)) {
      return this.transitionedCreateParent(input, relation);
    }
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
      if (!pinnedBefore) {
        // The `where` pins some OTHER unique, so the pre-transition value lives only
        // in the located row. The Ref reaches it, as measured; what a
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
        members: pairForeignKeyMembers(relation.membership.members, [
          literalParentId(transitioned),
        ]),
        afterRoot: true,
      };
    }
    // `{ set: v }` is the SAME assignment as the bare `v`, spelled with the
    // envelope Prisma's scalar update input allows. `classifyRelationKeyScalarUpdate`
    // is the engine's one reader of that envelope, and the unwrapping now happens
    // inside {@link requireRewrittenReferenceValue} — the one owner of what a
    // rewritten reference member is worth. This position's own answer is only the
    // construction-time part: the literal it accepts becomes the fresh row's
    // parent id, ordered BEFORE the root UPDATE (`afterRoot: false`), which is what
    // makes it a different arm from its compile-time sibling rather than a
    // duplicate of it.
    const literal = requireRewrittenReferenceValue({
      operand: input.rootScalarData[referencedField],
      locatedValueKnown: false,
      relationName,
      field: referencedField,
    });
    return {
      members: pairForeignKeyMembers(relation.membership.members, [
        literalParentId(literal),
      ]),
      afterRoot: false,
    };
  }

  /**
   * The parent id for a nested create under a NON-CASCADE transition whose
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
   * Only the `null` arm of the shared refusal is reachable from the
   * public client — the parse boundary has no `Sql` member in write data.
   */
  private transitionedCreateParent(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: OrdinaryChildHeldRelation
  ): { members: ForeignKeyMember[]; afterRoot: boolean } {
    const { members, referencedFields } = relation.membership;
    for (const field of referencedFields) {
      input.parentFkLocateFields.add(field);
    }
    const write = this.postTransitionReference(
      input.rootScalarData,
      relation.relationInfo.name
    );
    return {
      members: pairForeignKeyMembers(
        members,
        members.map(() => write)
      ),
      afterRoot: true,
    };
  }

  /**
   * The parent id for a nested create whose referenced columns the root SET leaves
   * alone. A SINGLE referenced column the unique `where` PINS keeps its
   * construction-time literal, byte for byte. Everything else — an
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
    const { members, referencedFields } = relation.membership;
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
          members: pairForeignKeyMembers(relation.membership.members, [
            literalParentId(pinned.value),
          ]),
          afterRoot: false,
        };
      }
    }
    for (const field of referencedFields) input.locateFields.add(field);
    return {
      members: pairForeignKeyMembers(
        members,
        members.map(() => this.parentIdSource)
      ),
      afterRoot: false,
    };
  }

  /**
   * CLASS IV (T4c / T4c-fix) — V1's `RelationUpdates.compileRelationKeyGuards`,
   * reproduced at the RELATION level (kind- AND cardinality-agnostic, exactly as V1
   * loops `relations` independent of the mutation planning). A child-held, non-cascade
   * relation whose referenced key the SAME root update TRANSITIONS may not leave the OLD
   * slot occupied: V1 rejects `Cannot update relation '…' with onUpdate('…') while the
   * current relation is occupied.` for ANY nested mutation on it (upsert / update /
   * delete / disconnect / create / …) and either cardinality. Called once per relation
   * before the per-kind dispatch, and kind-BLIND in its body since it lost the one
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
   *     parent value and are ORDERED after the root UPDATE (the dispatch's `adoptWrite`
   *     and `adoptParts`), which is why the source is returned rather than consumed
   *     here.
   *
   * There is no `pastSurface` third answer. What used to be past the surface — a
   * COMPOUND reference, a NON-PK referenced unique, and a pre-value the unique
   * `where` does not pin — is compiled by the same two
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
    const { referencedFields } = relation.membership;
    const relationName = relation.relationInfo.name;
    if (relation.membership.onUpdate === "cascade") return { regime: "none" };
    // Does the root SET rewrite a referenced parent column — or, E1, does a
    // shared-primary-key arm fold a new value into one? Both are the same fact about
    // the same column, and a transition that only ONE of them can see is the silent
    // orphan closed for the scalar half.
    const changed = referencedFields.filter(
      (field) =>
        Object.hasOwn(input.rootScalarData, field) ||
        this.relationTransitionMembers.has(field)
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
    // pre-widening plan, and it is the only place the no-op question can be answered before
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
    write ??= this.postTransitionReference(input.rootScalarData, relationName);
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
          relation.membership.members,
          readSources,
          relation.membership.members.map(() => write)
        ),
      },
    });
    return { regime: "guarded", write };
  }

  /** CLASS IV (T4c) — emit V1's occupied guard onto `relationKeyGuards`: a read of the
   *  OLD slot (a child correlated on the pre-transition parent values), locked in tx
   *  mode. The correlation is lowered from the COMPLETE correlated binding through
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
   *  RAISED AND SETTLED BY MEASUREMENT. The claim was that dropping
   *  `upsertInput.update` here loses a payload silently. It
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
    relation: ChildHeldRelation;
    childScope: QueryScope;
    upsertInput: NormalizedRelationUpsert;
    write: FinalReferenceSource;
  }): void {
    const { input, relation, childScope, upsertInput, write } = args;
    input.afterRootParts.push(
      this.createFresh(this.scope, {
        childScope,
        data: upsertInput.create,
        incomingMembership: bindRelationMembership(relation, write),
        relationName: relation.relationInfo.name,
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
      this.interpretParentHeld(input, relation, entries[0]!);
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
      this.interpretParentHeld(input, relation, supplier);
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
      this.interpretParentHeld(input, relation, supplier);
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
  private interpretParentHeld(
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
          this.interpretParentHeldCreate(relation, entry)
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
        // Unreachable by construction: `toOneUpdateFactory`
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
   * The ARITY OF THE EDGE was never load-bearing either, and the old refusal
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
  private selectedIncomingParentForRelation(
    relation: ParentHeldRelation
  ): SelectedIncomingParentContinuity | undefined {
    const continuity = this.incomingParentContinuity;
    if (!continuity) return undefined;
    return relationMembershipScopesEqual(
      getRelationMembershipScope(continuity.membership.relation),
      getRelationMembershipScope(relation)
    )
      ? continuity
      : undefined;
  }

  private selectedIncomingParentForPolymorphicEdge(
    edge: ResolvedPolymorphicEdge
  ): SelectedIncomingParentContinuity | undefined {
    const continuity = this.incomingParentContinuity;
    if (!continuity) return undefined;
    return relationMembershipScopesEqual(
      getRelationMembershipScope(continuity.membership.relation),
      getMembershipScope(directPolymorphicMembership(edge))
    )
      ? continuity
      : undefined;
  }

  private recordSelectedIncomingParentKeyChange(
    target: QueryScope,
    scalarData: Readonly<Record<string, unknown>>,
    relations: readonly ParsedRelationMutation[],
    relationName: string
  ): void {
    const rowKey = getPrimaryKeyFields(target.model);
    const relationMoves = resolveRelationTransitionMembers(
      target,
      relations,
      rowKey
    );
    const field = rowKey.find(
      (candidate) =>
        Object.hasOwn(scalarData, candidate) || relationMoves.has(candidate)
    );
    if (field && !this.selectedIncomingParentKeyChange) {
      this.selectedIncomingParentKeyChange = { field, relationName };
    }
  }

  private parentHeldCorrelation(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: ParentHeldRelation,
    suppliedTarget?: Record<string, unknown>,
    selectedTarget?: SelectedIncomingParentContinuity
  ): ParentHeldCorrelation {
    const { foreignFields, members } = relation.membership;
    if (suppliedTarget) {
      // H3/R2 — the incoming member is named by the supplier's own unique selector, so
      // this arm reads none of the parent's foreign-key columns: adding them to the
      // locate would publish a value nothing consumes.
      return {
        members,
        override: {},
        suppliedFilters: uniqueSelectorConjuncts(
          { model: relation.relationInfo.targetModel },
          suppliedTarget
        ),
      };
    }
    if (selectedTarget) {
      return { members, override: {}, selectedTarget };
    }
    // Every parent FK column must be a firstRowField output of the locate read so
    // the untouched-column path can ref/read it. Held in the parent-FK set (NOT
    // `locateFields`): these are the parent's own columns, not child-referenced, so
    // a same-root rebind of one must not trigger the child-edge reorder.
    for (const field of foreignFields) input.parentFkLocateFields.add(field);
    return {
      members,
      override: resolveParentFkRebinds(input.rootScalarData, foreignFields),
    };
  }

  /** A parent-held to-one `update`: locate the referenced target by the parent's
   *  final FK value, then compile its scalar and descendant mutations against the
   *  captured primary key. */
  private interpretParentHeldUpdate(
    input: Parameters<RecordUpdateCompilerState["interpretRelation"]>[0],
    relation: ParentHeldRelation,
    target: SourcedToOneUpdateTarget,
    /** H3/R2 — the sibling supplier's selector, when this modify composes with one. */
    suppliedTarget?: Record<string, unknown>
  ): ParentHeldTarget | undefined {
    const { relationInfo } = relation;
    const relationName = relationInfo.name;
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const selectedTarget = suppliedTarget
      ? undefined
      : this.selectedIncomingParentForRelation(relation);
    const correlation = this.parentHeldCorrelation(
      input,
      relation,
      suppliedTarget,
      selectedTarget
    );
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    const childUpdate = buildParsedRelationPrograms(
      childScope,
      target.data.parsed,
      target.data.source
    );
    assertPortablePrimaryKeyUpdateInput(childScope.model, "update", {
      data: childUpdate.scalarData,
    });
    assertRelationKeyUpdatesAreCompilable(
      childScope,
      childUpdate.scalarData,
      childUpdate.relations
    );
    if (selectedTarget) {
      this.recordSelectedIncomingParentKeyChange(
        childScope,
        childUpdate.scalarData,
        childUpdate.relations,
        relationName
      );
    }
    const compiler = this.recordCompilers.updateSelected({
      scope: input.scope,
      engine: this.engine,
      targetScope: childScope,
      scalarData: childUpdate.scalarData,
      relations: childUpdate.relations,
      targetRead: { label: `${childName}.find` },
      rootWrite: { label: `${childName}.update` },
      relationName,
      requiredTargetFields: relation.membership.referencedFields,
      ...(selectedTarget ? { selectedTargetContinuity: selectedTarget } : {}),
    });
    if (!(compiler || this.relationNeedsSelectedFinalValue(relation))) {
      return undefined;
    }
    const targetProjection =
      compiler?.targetProjection ??
      buildTargetProjection(
        childScope.model,
        relation.membership.referencedFields
      );
    const probeId =
      compiler?.targetReadId ?? input.scope.allocate(`${childName}.find`);
    const hasDescendantPlanning = (compiler?.planning().length ?? 0) > 0;
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
        targetProjection
      ),
      outputs: hasDescendantPlanning
        ? {
            rows: { kind: "rows" },
            ...targetProjectionOutputs(targetProjection),
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
      targetProjection,
      ...(target.filter ? { filter: target.filter } : {}),
      ...(compiler ? { compiler } : {}),
    };
  }

  /** A parent-held to-one `delete: true`: NULL the parent FK (a required FK is V1's
   *  typed reject), then correlated bulk-delete the referenced target. `true` is the
   *  arm's only reachable value — the parse boundary types it `v.boolean()` and `false`
   *  is Prisma's no-op, dropped from the kind list. */
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
    const selectedTarget = this.selectedIncomingParentForRelation(relation);
    const correlation = this.parentHeldCorrelation(
      input,
      relation,
      undefined,
      selectedTarget
    );
    const spec = entry.items[0];
    if (!(spec && spec.target.kind === "correlated")) {
      throw new QueryEngineError(
        `query-engine-v2 internal: parent-held to-one upsert on relation '${relationName}' requires one correlated target.`
      );
    }
    const before = this.buildBeforeTarget(childScope, spec.create);
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    const childUpdate = buildParsedRelationPrograms(
      childScope,
      spec.update.parsed,
      spec.update.source
    );
    const hasUpdate =
      Object.keys(childUpdate.scalarData).length > 0 ||
      childUpdate.relations.length > 0;
    if (selectedTarget) {
      this.recordSelectedIncomingParentKeyChange(
        childScope,
        childUpdate.scalarData,
        childUpdate.relations,
        relationName
      );
    }
    const compiler = hasUpdate
      ? this.recordCompilers.updateSelected({
          scope: input.scope,
          engine: this.engine,
          targetScope: childScope,
          scalarData: childUpdate.scalarData,
          relations: childUpdate.relations,
          targetRead: { label: `${childName}.find` },
          rootWrite: { label: `${childName}.update` },
          relationName,
          requiredTargetFields: relation.membership.referencedFields,
          ...(selectedTarget
            ? { selectedTargetContinuity: selectedTarget }
            : {}),
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
          compiler.assertSelectedIncomingParentLegality();
        }
      : undefined;
    const probeId =
      compiler?.targetReadId ?? input.scope.allocate(`${childName}.find`);
    const targetProjection =
      compiler?.targetProjection ??
      buildTargetProjection(
        childScope.model,
        relation.membership.referencedFields
      );
    return {
      kind: "upsert",
      relation,
      childScope,
      probeId,
      guardId: input.scope.allocate(`${childName}.guard.exists`),
      parentSetId: input.scope.allocate("parent.fkset"),
      correlation,
      targetProjection,
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
          targetProjection
        ),
        outputs: {
          rows: { kind: "rows" },
          ...targetProjectionOutputs(targetProjection, true),
        },
      },
      compiler,
      updateLegality,
      before,
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
    const selectedTarget = correlation.selectedTarget;
    if (selectedTarget) {
      return Object.entries(selectedTarget.planningRowKey).map(
        ([field, readSource]) => {
          const member = {
            foreignField: field,
            referencedField: field,
            readSource,
            writeSource:
              selectedTarget.executionRowKey[field] ??
              selectedTarget.executionSource,
          };
          return {
            [field]: {
              equals: useRef
                ? foreignKeyCorrelationValue(member)
                : foreignKeyResolvedReadValue(
                    member,
                    known ?? {},
                    relationName,
                    kind
                  ),
            },
          };
        }
      );
    }
    // H3/R2 — a composed supplier names the INCOMING member itself. Correlating on the
    // parent's foreign-key column here would address the OUTGOING one: the column still
    // holds the old value at planning (the root UPDATE has not run) and at compile (the
    // located row is what is inlined).
    if (correlation.suppliedFilters) return [...correlation.suppliedFilters];
    return correlation.members.map(
      ({ foreignField: fkField, referencedField: childField }) => {
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
      }
    );
  }

  /** The correlated locate probe for a parent-held `update`/`upsert`: `WHERE
   *  <referenced> = <finalFk> [AND <filter>] [AND <every row-key member> =
   *  <its captured value>]`, one row, FOR UPDATE in tx. `filter` is the non-unique
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
    const assignment = this.beforeTargetFkAssign(relation, before);
    for (const member of assignment.members) {
      if (!this.relationTransitionMembers.has(member.foreignField)) continue;
      const value = foreignKeyWriteValue(
        member,
        undefined,
        relationName,
        "create"
      );
      const failure = `query-engine-v2 update does not support a shared-primary-key create on relation '${relationName}' whose foreign key '${member.foreignField}' (this record's primary key) does not resolve to one final value.`;
      this.assignmentSeed.demandFinalValue(member.foreignField, value, failure);
      this.relationTransitionFinal[member.foreignField] = value;
    }
    return {
      kind: "create",
      before,
      assignment,
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
      createRacePin(childScope, where)
    );
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    const probeId = input.scope.allocate(`${childName}.find`);
    const guardId = input.scope.allocate(`${childName}.guard.exists`);
    const pkSelect = Object.fromEntries(
      referencedFields.map((field) => [field, true])
    );
    return {
      kind: "connectOrCreate",
      relationInfo,
      probeId,
      guardId,
      lookup: {
        kind: "referencedKey",
        relation,
        where,
        guardProbe: buildFindUnique(childScope, { where, select: pkSelect }),
        ...(() => {
          const capturedFields = relation.membership.members
            .filter(({ foreignField }) =>
              this.needsSelectedFinalValue(foreignField)
            )
            .filter(
              ({ referencedField }) => !Object.hasOwn(where, referencedField)
            )
            .map(({ referencedField }) => referencedField);
          return capturedFields.length > 0 ? { capturedFields } : {};
        })(),
      },
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
      foundAssignment: {
        ...this.toOneFkAssign(relation, where),
      },
      before,
      missingRelation: relation,
    };
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
    createData: RecordMutationData,
    rootRacePin?: CreateRacePin
  ): BeforeTarget {
    return {
      subtree: this.createFresh(this.scope, {
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
  ): Extract<FinalRootAssignment, { kind: "foreignKey" }> {
    const { relationInfo } = relation;
    const fkAssign: Record<string, unknown> = {};
    const members: ForeignKeyMember[] = [];
    for (const { foreignField, referencedField } of relation.membership
      .members) {
      // Residual §G3 — the subtree answers for its own INSERT. This loop used to
      // construct the identical limitation itself (former
      // `beforeTargetReferenceSource`), which made "a fresh record cannot publish
      // the referenced column this edge needs" two owners over one predicate.
      const source = before.subtree.requireRootReferenced(
        referencedField,
        relationInfo.name
      );
      members.push({ foreignField, referencedField, writeSource: source });
      fkAssign[foreignField] = referenceSql(
        this.engine,
        this.model,
        foreignField,
        foreignKeyWriteValue(
          { foreignField, referencedField, writeSource: source },
          undefined,
          relationInfo.name,
          "update"
        )
      );
    }
    return { kind: "foreignKey", data: fkAssign, members };
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
  ): FinalRootAssignment {
    const { relationInfo } = relation;
    const recordScope = {
      ...createQueryScope(this.engine.adapter, this.model),
      mutationTable: getTableName(this.model),
    };
    const fkAssign: Record<string, unknown> = {};
    const members: ForeignKeyMember[] = [];
    for (const {
      foreignField: fkField,
      referencedField: referenced,
    } of relation.membership.members) {
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
      members.push(member);
      fkAssign[fkField] = referenceSql(
        this.engine,
        this.model,
        fkField,
        foreignKeyWriteValue(member, undefined, relationInfo.name, "connect")
      );
    }
    return { kind: "foreignKey", data: fkAssign, members };
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
    readonly assignments: FinalRootAssignment[];
    readonly demands: FinalRootAssignment[];
    readonly transitionWriteIds: readonly string[];
  } {
    const assignments: FinalRootAssignment[] = [];
    const demands: FinalRootAssignment[] = [];
    const transitionWriteIds: string[] = [];
    for (const target of this.parentHeldTargets) {
      switch (target.kind) {
        case "create":
          this.emitBeforeTarget(target.before, known, guards, beforeRootWrites);
          assignments.push(target.assignment);
          break;
        case "connectOrCreate":
          this.compileParentHeldConnectOrCreate(
            target,
            known,
            guards,
            beforeRootWrites,
            assignments
          );
          break;
        case "update":
          this.compileParentHeldUpdate(
            target,
            known,
            guards,
            writes,
            demands,
            transitionWriteIds
          );
          break;
        case "delete":
          this.compileParentHeldDelete(target, known, locatedRow, writes);
          break;
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
          assignments.push({
            kind: "polymorphic",
            storage: { kind: "empty", storage: target.edge.storage },
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
            assignments.push({
              kind: "polymorphic",
              storage: target.missingAssignment,
            });
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
            writes,
            assignments,
            demands,
            transitionWriteIds
          );
          break;
      }
    }
    return { assignments, demands, transitionWriteIds };
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
    assignments: FinalRootAssignment[]
  ): void {
    const { relationInfo, lookup } = target;
    const relationName = relationInfo.name;
    const rows = known[planningKey(target.probeId, "rows")];
    // Zero rows is the ARM DECISION here, not an error: the probe's empty read is
    // exactly what makes this a create.
    const found = Array.isArray(rows) && rows.length > 0;
    if (found) {
      if (lookup.kind === "referencedKey") {
        this.assertLookupKeyPresent(
          rows,
          relationInfo,
          lookup.relation.membership.referencedFields,
          lookup.where
        );
      }
      assignments.push(
        this.selectedForeignKeyAssignment(
          target.foundAssignment,
          rows,
          relationInfo.name
        )
      );
      if (this.mode === "batch") {
        guards.push(
          presenceGuard(
            target.guardId,
            this.parentHeldLookupGuard(lookup, relationInfo, rows),
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
    // through `nestedFresh.rootRacePin` at construction.
    const missingAssignment = target.missingRelation
      ? this.beforeTargetFkAssign(target.missingRelation, target.before)
      : target.missingAssignment;
    if (!missingAssignment) {
      throw new QueryEngineError(
        `query-engine-v2 internal: connectOrCreate on relation '${relationName}' has no missing assignment.`
      );
    }
    this.emitBeforeTarget(target.before, known, guards, beforeRootWrites);
    assignments.push(missingAssignment);
  }

  /**
   * The statement a parent-held found-arm's batch guard runs. A `referencedKey`
   * lookup precompiled it at construction; a `capturedDiscriminator` rebuilds it here,
   * because only the probe's own row carries the referenced value that makes the
   * discriminated selector exact.
   */
  private parentHeldLookupGuard(
    lookup: ParentHeldLookup,
    relationInfo: RelationInfo,
    rows: readonly unknown[]
  ): Sql {
    if (lookup.kind === "referencedKey") {
      if (!lookup.capturedFields?.length) return lookup.guardProbe;
      const childScope = createQueryScope(
        this.engine.adapter,
        relationInfo.targetModel
      );
      return buildFind(
        childScope,
        {
          where: capturedSelectorWhere(
            childScope,
            lookup.where,
            this.capturedFields(rows, lookup.capturedFields, relationInfo.name)
          ),
          select: Object.fromEntries(
            lookup.capturedFields.map((field) => [field, true])
          ),
        },
        { limit: 1 }
      );
    }
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    return buildFind(
      childScope,
      {
        where: this.capturedConnectWhere(
          childScope,
          rows,
          lookup.guardField,
          relationInfo.name,
          lookup.where
        ),
        select: { [lookup.guardField]: true },
      },
      { limit: 1 }
    );
  }

  /** Compile a family-A parent-held `update`: the captured PK addresses the located
   *  target's UPDATE (empty capture is V1's "target record was not found for this
   *  parent"); the batch split-witness guard pins the correlation. */
  private compileParentHeldUpdate(
    target: Extract<ParentHeldTarget, { kind: "update" }>,
    known: Readonly<Record<string, unknown>>,
    guards: OperationStep[],
    writes: OperationStep[],
    demands: FinalRootAssignment[],
    transitionWriteIds: string[]
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
            // The batch guard re-asserts the wrapper's filter alongside the
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
    const compiled = target.compiler?.compile(known) ?? [];
    bucketOperationSteps(compiled, guards, writes);
    if (this.relationNeedsSelectedFinalValue(target.relation)) {
      transitionWriteIds.push(
        ...compiled
          .filter((step) => step.kind !== "guard")
          .map((step) => step.id)
      );
      demands.push(
        this.parentHeldSelectedFinalAssignment(
          target.relation,
          target.compiler,
          captured
        )
      );
    }
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
    writes: OperationStep[],
    assignments: FinalRootAssignment[],
    demands: FinalRootAssignment[],
    transitionWriteIds: string[]
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
      // Resolve the selected MISSING arm before compiling its subtree so the target
      // INSERT declares every demanded field. Shared row-key members join the root's
      // normal final assignment; non-shared relations retain the historic dedicated
      // parent SET and its step ordering.
      const missingAssignment = this.beforeTargetFkAssign(
        target.relation,
        target.before
      );
      this.emitBeforeTarget(target.before, known, guards, beforeRootWrites);
      if (this.assignmentMovesSharedKey(missingAssignment)) {
        assignments.push(missingAssignment);
      } else {
        writes.push({
          id: target.parentSetId,
          kind: "write",
          statement: buildUpdate(
            createQueryScope(this.engine.adapter, this.model),
            {
              where: this.parentPrimaryKeyWhere(locatedRow),
              data: missingAssignment.data,
              select: this.pkSelect(),
            }
          ),
          outputs: {},
        });
      }
      const selected = this.selectedFinalAssignment(missingAssignment);
      if (selected) demands.push(selected);
      return;
    }
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
            undefined,
            target.targetProjection
          ),
          nestedWriteFailure(
            upsertPremiseChanged(relationName),
            relationName,
            false
          )
        )
      );
    }
    let compiled: readonly OperationStep[] = [];
    if (target.compiler) {
      target.updateLegality?.();
      compiled = target.compiler.compile(known);
      bucketOperationSteps(compiled, guards, writes);
    }
    if (this.relationNeedsSelectedFinalValue(target.relation)) {
      transitionWriteIds.push(
        ...compiled
          .filter((step) => step.kind !== "guard")
          .map((step) => step.id)
      );
      const foundAssignment = this.parentHeldSelectedFinalAssignment(
        target.relation,
        target.compiler,
        captured
      );
      // The target update (or its ON UPDATE cascade) owns the physical change. The
      // selected parent compiler needs only the exact final value for conflicts,
      // descendants and terminal addressing; emitting another SET would race the
      // target update and duplicate ordering ownership.
      demands.push(foundAssignment);
    }
  }

  private assignmentMovesSharedKey(assignment: FinalRootAssignment): boolean {
    return (
      assignment.kind === "foreignKey" &&
      assignment.members.some((member) =>
        this.sharedKeyMembers.has(member.foreignField)
      )
    );
  }

  private assignmentMovesRelationReference(
    assignment: FinalRootAssignment
  ): boolean {
    return (
      assignment.kind === "foreignKey" &&
      assignment.members.some((member) =>
        this.relationTransitionMembers.has(member.foreignField)
      )
    );
  }

  private parentHeldSelectedFinalAssignment(
    relation: ParentHeldRelation,
    compiler: RecordUpdateCompiler | undefined,
    captured: Record<string, unknown>
  ): Extract<FinalRootAssignment, { kind: "foreignKey" }> {
    const data: Record<string, unknown> = {};
    const members: ForeignKeyMember[] = [];
    for (const { foreignField, referencedField } of relation.membership
      .members) {
      if (!this.needsSelectedFinalValue(foreignField)) continue;
      const value = compiler
        ? compiler.updatedFieldValue(referencedField, captured)
        : captured[referencedField];
      if (value === null || value === undefined || isSql(value)) {
        FinalAssignmentLedger.refuse(
          `query-engine-v2 update cannot publish one exact final value for foreign key '${foreignField}' through relation '${relation.relationInfo.name}'.`
        );
      }
      const writeSource: FinalReferenceSource = isOperationValueReference(value)
        ? { kind: "finalRef", ref: value }
        : { kind: "literal", value };
      members.push({ foreignField, referencedField, writeSource });
      data[foreignField] = referenceSql(
        this.engine,
        this.model,
        foreignField,
        value
      );
    }
    return { kind: "foreignKey", data, members };
  }

  private selectedFinalAssignment(
    assignment: FinalRootAssignment
  ): Extract<FinalRootAssignment, { kind: "foreignKey" }> | undefined {
    if (assignment.kind !== "foreignKey") return undefined;
    const members = assignment.members.filter((member) =>
      this.needsSelectedFinalValue(member.foreignField)
    );
    if (members.length === 0) return undefined;
    return {
      kind: "foreignKey",
      members,
      data: Object.fromEntries(
        members.map((member) => [
          member.foreignField,
          assignment.data[member.foreignField],
        ])
      ),
    };
  }

  private relationNeedsSelectedFinalValue(
    relation: ParentHeldRelation
  ): boolean {
    return relation.membership.members.some((member) =>
      this.needsSelectedFinalValue(member.foreignField)
    );
  }

  /** The parent's row-key where-unique for a dedicated parent-FK write. */
  private parentPrimaryKeyWhere(
    locatedRow: Record<string, unknown>
  ): Record<string, unknown> {
    if (Object.keys(this.compiledSelectedRowKey).length > 0) {
      return buildPrimaryKeyWhereUnique(
        this.model,
        this.compiledSelectedRowKey
      );
    }
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
        assignment: {
          kind: "foreignKey",
          data: Object.fromEntries(
            foreignFields.map((field) => [field, { set: null }])
          ),
          members: relation.membership.members.map(
            ({ foreignField, referencedField }) => ({
              foreignField,
              referencedField,
              writeSource: { kind: "literal", value: null },
            })
          ),
        },
      };
    }
    const connect = requireToOneConnectTarget(entry, relationName);
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
    const capturedSharedFields = relation.membership.members
      .filter(
        ({ foreignField, referencedField }) =>
          this.needsSelectedFinalValue(foreignField) &&
          !Object.hasOwn(connect, referencedField)
      )
      .map(({ referencedField }) => referencedField);
    return {
      relationInfo,
      referencedFields,
      assignment,
      connect: {
        probeId,
        guardId,
        probe,
        where: connect,
        ...(capturedSharedFields.length > 0 ? { capturedSharedFields } : {}),
      },
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
    const capturedSharedFields = link.connect.capturedSharedFields ?? [];
    const capturedShared = capturedSharedFields.length
      ? this.capturedFields(rows, capturedSharedFields, relationInfo.name)
      : undefined;
    const guardStatement = capturedShared
      ? buildFind(
          guardScope,
          {
            where: capturedSelectorWhere(
              guardScope,
              link.connect.where,
              capturedShared
            ),
            select: Object.fromEntries(
              capturedSharedFields.map((field) => [field, true])
            ),
            forUpdate: true,
          },
          { limit: 1 }
        )
      : link.connect.capturedGuardField
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

  /** Resolve only shared row-key lookup members from the exact row the arm probe
   * selected. Non-shared and already-literal members retain their historic SQL. */
  private selectedToOneAssignment(
    link: ToOneLink,
    known: Readonly<Record<string, unknown>>
  ): FinalRootAssignment {
    const assignment = link.assignment;
    if (!(assignment && assignment.kind === "foreignKey" && link.connect)) {
      if (!assignment) {
        throw new QueryEngineError(
          "query-engine-v2 internal: selected to-one link has no assignment."
        );
      }
      return assignment;
    }
    const rows = known[planningKey(link.connect.probeId, "rows")];
    return this.selectedForeignKeyAssignment(
      assignment,
      Array.isArray(rows) ? rows : [],
      link.relationInfo.name
    );
  }

  /** Replace only shared lookup members with the exact tuple captured by the arm's
   * planning read. The same tuple is pinned by its batch guard. */
  private selectedForeignKeyAssignment(
    assignment: FinalRootAssignment,
    rows: readonly unknown[],
    relationName: string
  ): FinalRootAssignment {
    if (assignment.kind !== "foreignKey") return assignment;
    const row = isRecord(rows[0]) ? rows[0] : undefined;
    if (!row) return assignment;
    let changed = false;
    const data = { ...assignment.data };
    const members = assignment.members.map((member) => {
      if (
        !this.needsSelectedFinalValue(member.foreignField) ||
        member.writeSource.kind !== "lookup"
      ) {
        return member;
      }
      const value = row[member.referencedField];
      if (value === null || value === undefined) {
        FinalAssignmentLedger.refuse(
          `query-engine-v2 update cannot assign a null final value to row-key field '${member.foreignField}' through relation '${relationName}'.`
        );
      }
      changed = true;
      const selected: ForeignKeyMember = {
        ...member,
        writeSource: { kind: "literal", value },
      };
      data[member.foreignField] = referenceSql(
        this.engine,
        this.model,
        member.foreignField,
        value
      );
      return selected;
    });
    return changed ? { kind: "foreignKey", data, members } : assignment;
  }

  private needsSelectedFinalValue(field: string): boolean {
    return (
      this.relationTransitionMembers.has(field) ||
      this.requiredTargetFields.has(field)
    );
  }

  private capturedFields(
    rows: readonly unknown[],
    fields: readonly string[],
    relationName: string
  ): Record<string, unknown> {
    const row = rows[0];
    if (!isRecord(row)) {
      throw new NestedWriteError(
        `query-engine update connect probe for relation '${relationName}' did not expose a captured row.`,
        relationName
      );
    }
    const captured: Record<string, unknown> = {};
    for (const field of fields) {
      const value = row[field];
      if (value === undefined || value === null) {
        throw new NestedWriteError(
          `query-engine update connect probe for relation '${relationName}' did not expose '${field}'.`,
          relationName
        );
      }
      captured[field] = value;
    }
    return captured;
  }

  /** Record the taken assignment's exact transitioned reference values; its row-key
   * subset also owns terminal addressing. */
  private recordSelectedTransitionAssignment(
    assignment: FinalRootAssignment,
    known: Readonly<Record<string, unknown>>,
    operation: string
  ): void {
    if (assignment.kind !== "foreignKey") return;
    for (const member of assignment.members) {
      if (!this.relationTransitionMembers.has(member.foreignField)) continue;
      const value = foreignKeyWriteValue(
        member,
        known,
        this.relationName,
        operation
      );
      if (value === null || value === undefined || isSql(value)) {
        FinalAssignmentLedger.refuse(
          `query-engine-v2 update does not support a shared-primary-key ${operation} whose foreign key '${member.foreignField}' (this record's primary key) does not resolve to one final value.`
        );
      }
      this.relationTransitionFinal[member.foreignField] = value;
    }
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
    finalData: Record<string, unknown>,
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
        // One fresh compile ledger reconciles every scalar, relation fold and
        // demanded membership contribution before this final SET is rendered.
        data: finalData,
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
    if (Object.keys(this.compiledSelectedRowKey).length > 0) {
      return buildPrimaryKeyWhereUnique(
        this.model,
        this.compiledSelectedRowKey
      );
    }
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
 * value of their own, or can change it through the target row, and therefore move a row
 * key that is also that foreign key. `update` writes no parent column, but its target
 * compiler can rewrite the referenced value and the database cascade then moves this
 * record's key. `delete` is absent because it supplies no final key. A
 * `delete` alone NULLs the column, which a row-key member refuses at
 * {@link assertRelationCanDisconnect} before this question arises; a `delete` beside a
 * supplier does not write the column at all, because that UPDATE is elided and the
 * supplier — a fold kind, counted here — owns the slot's final value. `upsert` has the
 * same selected-final-value requirement as `update` on its found arm and a supplier on
 * its missing arm.
 */
const RELATION_TRANSITION_KINDS: ReadonlySet<string> = new Set([
  "connect",
  "create",
  "connectOrCreate",
  "update",
  "upsert",
]);

/**
 * Which root fields a selected parent-held arm may supply or cascade, decided from the
 * payload's TOPOLOGY alone. This complete relation tuple is distinct from its row-key
 * subset: non-key members can still be referenced by downstream memberships. No value is read
 * and no step is allocated, which is what lets it run BEFORE the relation loop: the
 * child-held transition machinery asks this question while that loop is still running,
 * and the answer must not depend on the order the payload happened to list relations
 * in. The matching VALUES arrive later, on the same map every reader consults at
 * compile ({@link RecordUpdateCompilerState.relationTransitionFinal}).
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
 * and pinned in `shared-pk-update-root-behavior.ts`. Kept rather
 * than closed: closing it means deriving each arm's value a SECOND time here, in a
 * second enumeration of "what does this arm fold", and a fold the two enumerations
 * disagree about is the silent orphan. Refusing a satisfiable payload is the
 * recoverable direction; under-counting is not.
 */
function resolveRelationTransitionMembers(
  targetScope: QueryScope,
  relations: readonly ParsedRelationMutation[],
  parentPrimaryKeys: readonly string[]
): ReadonlySet<string> {
  const members = new Set<string>();
  for (const parsed of relations) {
    // A direct polymorphic edge writes its `polymorphicStorage` columns, never the
    // relation's `foreignFields`, and a storage column is private to that edge — it is
    // not a declared scalar and so is never a row-key member. The entry says which
    // kind it is, so this skip no longer depends on two maps agreeing; the day a
    // storage id column becomes addressable as a row key, this function is one of the
    // four readers that has to learn about it (with the transition regime, the
    // reorder, and {@link RecordUpdateCompilerState.updatedPrimaryKeyWhere}).
    if (parsed.kind !== "ordinary") continue;
    const program = parsed.program;
    const relation = bindRelation(targetScope, program.relationInfo);
    if (relation.position !== "parentHeld") continue;
    if (
      !relation.membership.foreignFields.some((foreignField) =>
        parentPrimaryKeys.includes(foreignField)
      )
    ) {
      continue;
    }
    // H — the question is "does any entry FOLD", never "is there exactly one entry".
    // A multi-kind to-one payload used to be refused before any of this mattered, by
    // `interpretRelation`'s OWN parent-held dispatch guard (`kinds.length !== 1`), and
    // reading the entry count here was reading that guard's premise rather than this
    // map's question. The to-one lattice admits a supplier beside an `update` and
    // beside a vacate, so the old skip would have gone fail-OPEN: the supplier would
    // still fill the final-value map while this topology stayed empty, moving the terminal
    // without the transition regime, the reorder, or the occupied guard.
    // The union is over every entry, and at most one of them can be a fold: two
    // suppliers on one relation are refused by `to-one-mutation-schema.ts` (the lattice
    // owner) in both directions, and neither `update` nor a vacate is a fold kind. The
    // members a fold contributes do not depend on WHICH entry carries it — they are the
    // complete edge tuple, once at least one member overlaps this record's row key.
    let foldsThisRecordsKey = false;
    for (const entry of program.entries) {
      if (RELATION_TRANSITION_KINDS.has(entry.kind)) {
        foldsThisRecordsKey = true;
        break;
      }
    }
    if (!foldsThisRecordsKey) continue;
    for (const foreignField of relation.membership.foreignFields) {
      members.add(foreignField);
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

/**
 * H3 — the child-held composition, as ONE ordered list, read from the shared
 * classification owner (`builders/to-one-composition.ts`) rather than re-derived here.
 * §6 H3's steps 1-4 are an ORDER claim ("vacate, supply, capture the supplied identity,
 * modify"), and before H that order was an accident of `RELATION_MUTATION_KEYS` —
 * `isVacateThenSupply` read `kinds[0]`/`kinds[1]` POSITIONALLY off that constant, which
 * `parity-h-to-one-lattice` falsified by reordering it and turning all five accepted
 * pairs red. The relation owner states the order, so the constant decides nothing.
 *
 * `continuation` is HOW the modify half reaches its row, because a lone `update` on this
 * direction is located by correlation alone (`WHERE fk = parent`) and correlation before
 * the fragment's first write names the OUTGOING member, or nothing at all on an empty
 * slot. A `connect` supplier hands over its unique selector; a PRODUCING supplier hands
 * over nothing and the modify becomes the continuation of a record series instead, whose
 * capture reads membership AFTER the supplier has written it.
 */
interface ComposedToOnePayload {
  readonly entries: readonly RelationMutationEntry[];
  readonly modify?: RelationMutationEntry;
  readonly continuation?: ToOneContinuation;
}

/**
 * The one correlated target a parent-held to-one `update` entry carries, in the envelope
 * {@link RecordUpdateCompilerState.interpretParentHeldUpdate} consumes. Both the lone
 * `update` and the one composed with a `connect` ask for it, and they must not ask
 * differently.
 *
 * The payload reaches here as the relation schema's canonical envelope — bare
 * data and Prisma's `{ where?, data }` wrapper are told apart ONCE, at the parse, off
 * the user's own payload (a schema output rewrites scalar shorthands and is not a
 * faithful witness of the form). The wrapper's `where` is a NON-unique filter on the
 * connected record; it rides the locate, never the write. The bare form yields no
 * filter and is byte-identical to the bare-payload plan.
 */
interface SourcedToOneUpdateTarget {
  readonly data: RecordMutationData;
  readonly filter?: Record<string, unknown>;
}

function parentHeldUpdateTarget(
  entry: RelationMutationEntry,
  relationName: string
): SourcedToOneUpdateTarget {
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

function composeToOneEntries(
  relationName: string,
  entries: readonly RelationMutationEntry[]
): ComposedToOnePayload {
  if (entries.length <= 1) return { entries };
  const composition = classifyToOneComposition(relationName, entries);
  if (!composition) {
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
  return {
    entries: composition.ordered,
    ...(composition.modify ? { modify: composition.modify } : {}),
    ...(composition.continuation
      ? { continuation: composition.continuation }
      : {}),
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

/**
 * THE owner of what one member of a reference key the root SET rewrites is worth
 * (residual plan §G1's three value states). Two positions ask it — the
 * construction-time arity-1 arm of {@link RecordUpdateCompiler.resolveCreateParent}
 * and the compile-time per-member closure of
 * {@link RecordUpdateCompiler.postTransitionReference} — and before residual §G2
 * each spelled its own refusal with the SAME sentence and a swapped noun, which is
 * two owners over one predicate.
 *
 * 1. **An exact final value** — returned. What the caller does with it is the
 *    caller's: the construction arm makes it the fresh row's parent id, the compile
 *    arm applies the ORIGINAL operand to the located `before`. Those are genuinely
 *    different arms (they even order the INSERT differently), which is why the
 *    positions survive while the verdict does not.
 * 2. **An exact `null`** — a CONTRADICTION, not a capability gap, and therefore a
 *    `NestedWriteError` rather than an `UnsupportedOperationError`. A foreign key
 *    equal to NULL references no row, so there is no value to publish, no substrate
 *    that could publish one, and no future package that changes the answer. It is
 *    the sibling of `relation-key-legality`'s "use a literal value" verdict about
 *    the same column, and it keeps that owner's message shape.
 * 3. **Anything else** — the engine has no representable post-transition value. It
 *    is an engine fault rather than a refusal a caller can provoke, because the
 *    operand classes that would land here are answered by earlier boundaries. TWO of
 *    those boundaries are WITNESSED, in `sql-operand-boundary-behavior.ts`: an `Sql`
 *    operand dies at the parse boundary (no write-data input has an `Sql` member —
 *    pinned bare and as `{ set: … }`, under both roots and with no nested write at
 *    all), and arithmetic dies at relation-key legality's CLASS IV guard with its own
 *    message (pinned for `increment` and `multiply`). The remaining spellings that
 *    would reach this state — an array operand, and an explicit `undefined` the parse
 *    boundary strips — are answered by those SAME two boundaries but have no witness
 *    of their own. That is the whole of the coverage: two pinned arms, not four, and
 *    a reader must not take this state's unreachability as four measured facts.
 *
 * The ONE axis is whether the located pre-transition value is in hand, because that
 * is the only thing that makes a portable arithmetic envelope derivable —
 * `getUpdatedPrimaryKeyValue` computes it from `before`, and at construction there
 * is no `before` to compute from. States 2 and 3 answer the same at both timings.
 *
 * NOT every payload of this shape reaches here, and the narrower claim is the true
 * one: when the referenced column is a ROW-KEY member the locator PINS,
 * {@link RecordUpdateCompiler.resolveCreateParent} takes its pinned branch instead
 * and derives the post value through `getUpdatedPrimaryKeyValue`, whose own
 * pre-existing `QueryEngineError` ("Cannot determine the updated primary key …")
 * answers an underivable operand there. That owner is older than this one, reads the
 * same predicate, and is not consulted here — so "one owner, one message" is true of
 * the two positions this function serves, not of the shape as a whole. No public
 * payload reaching that third path was measured, and it therefore carries no witness.
 */
function requireRewrittenReferenceValue(args: {
  readonly operand: unknown;
  readonly locatedValueKnown: boolean;
  readonly relationName: string;
  readonly field: string;
}): unknown {
  const { operand, locatedValueKnown, relationName, field } = args;
  const classified = classifyRelationKeyScalarUpdate(operand);
  const literal = classified.resolved ? classified.value : operand;
  if (literal === null) {
    throw new NestedWriteError(
      `Cannot update relation key field '${field}' to null while mutating relation '${relationName}'. A null reference names no row for that relation to point at.`,
      relationName,
      { meta: { operation: "update", field, relation: relationName } }
    );
  }
  const representable = locatedValueKnown
    ? !isSql(literal)
    : isConstructionLiteral(literal);
  if (representable) return literal;
  throw new QueryEngineError(
    `query-engine-v2 internal: relation key field '${field}' has no representable post-transition value while mutating relation '${relationName}'.`
  );
}
