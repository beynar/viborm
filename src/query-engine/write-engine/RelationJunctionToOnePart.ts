// biome-ignore-all lint/style/useFilenamingConvention: RelationJunctionToOnePart is the architecture name.
import { NestedWriteError, QueryEngineError } from "@errors";
import { bindOwnerOrientedCollectionMember } from "../builders/polymorphic-collection-mutation";
import type { JunctionBoundRelation } from "../builders/relation-data-builder";
import {
  buildParsedRelationPrograms,
  type ParsedRecordPrograms,
  type RecordMutationData,
  type RelationMutationEntry,
  type RelationMutationProgram,
} from "../builders/relation-mutation-parser";
import {
  classifyToOneComposition,
  type ToOneContinuation,
} from "../builders/to-one-composition";
import { createQueryScope } from "../context/query-scope";
import { JunctionStatements } from "../JunctionStatements";
import { buildDelete, buildFind, buildFindUnique } from "../operations";
import { assertPortablePrimaryKeyUpdateInput } from "../operations/mutation-identity";
import type { QueryEngine } from "../query-engine";
import { assertRelationKeyUpdatesAreCompilable } from "../relation-key-legality";
import { isVariantJunctionInverse, type QueryScope } from "../types";
import type { FreshRecordPart } from "./CreateOperation";
import { createRacePin } from "./create-race-pin";
import {
  nestedWriteFailure,
  presenceGuard,
  referenceSql,
} from "./fragment-builders";
import {
  type JunctionSingularTransfer,
  type JunctionTransferAddress,
  transferSingularJunctionMembership,
} from "./junction-singular-transfer";
import { nestedReplacement, relationTargetNotFound } from "./messages";
import { NestedSelectedRecordSeries } from "./NestedSelectedRecordSeries";
import type {
  GuardStep,
  OperationStep,
  ReadStep,
  RecordSeriesStep,
  StatementStep,
  WriteStep,
} from "./OperationFragment";
import { bucketOperationSteps } from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { planningKey } from "./Part";
import type {
  RecordCompilerSeam,
  RecordUpdateCompiler,
} from "./RecordUpdateCompiler";
import { progressiveJunctionParentGuard } from "./RelationJunctionPart";
import {
  type CorrelatedForeignKeyMember,
  type FinalReferenceSource,
  type FinalReferenceSources,
  type ForeignKeyMember,
  foreignKeyCorrelationValue,
  foreignKeyWriteValueWith,
  planningSourceFromFinal,
} from "./relation-membership";
import type { StepScope } from "./StepScope";
import { parseCapturedRowKeys } from "./series-result-read";
import { capturedSelectorWhere, getStepModelName } from "./shared";
import {
  buildTargetProjection,
  capturedTargetWhere,
  type TargetProjection,
  targetProjectionRowKeySelect,
} from "./target-projection";

/**
 * THE SINGULAR COLLECTION INVERSE (plan §9.4) — a THIN DISPATCHER and ORIENTATION
 * ADAPTER over the bound member-table topology and `JunctionStatements`.
 *
 * An `s.toOne` bound to a collection carrier whose member declares
 * `inverseCardinality: "one"` holds AT MOST ONE membership, physically backed by
 * the member table's UNIQUE over the complete VARIANT side. Read from the variant,
 * the slot behaves like an ordinary child-held to-one — which is why the ordinary
 * to-one verb FAMILIES serve it verbatim — but its four correlated spellings are
 * not the ones `RelationJunctionPart` lowers, and that is the whole reason this
 * owner exists. Four measured facts, each a wrong answer rather than a gap:
 *
 *  1. `disconnect: true` reaches `m2mDisconnectRequiresSelector` — a sentence
 *     written for an ordinary many-to-many, where "which membership" is a real
 *     question. A singular slot has one, so it needs no selector.
 *  2. `delete: true` lowers to `{kind: "deleteMany", filters: [{}]}`, whose
 *     `compileDeleteMany` sweeps the whole CONNECTED SET through
 *     `membership.target.model` — in this reversed orientation, the polymorphic
 *     OWNER. Here it deletes the ONE captured owner row, addressed by its captured
 *     row key.
 *  3. correlated `update` and `upsert` both raise "requires a unique target"; an
 *     inverse to-one modify is correlated BY CONSTRUCTION, because a to-one
 *     payload spells no `where`.
 *  4. the payload's key order inverts the composition: `RELATION_MUTATION_KEYS`
 *     lists `update` (3rd) before `connect` (9th), so a `{disconnect, connect,
 *     update}` payload would lower MODIFY BEFORE SUPPLY. The order is read from
 *     {@link classifyToOneComposition} — the same owner `OwnWriteRelation` reads —
 *     and never from the parsed entry order.
 *
 * What it does NOT own: statement materialization, chunking, target probes, race
 * pins, or the transfer protocol. Those stay where they are.
 */
export interface JunctionToOneContext {
  readonly engine: QueryEngine;
  /** The VARIANT model's scope — the record this traversal is anchored on. */
  readonly parentScope: QueryScope;
  /** INVERSE orientation: `source` is the variant side, `target` the owner side. */
  readonly relation: JunctionBoundRelation;
  /**
   * OWNER orientation of the SAME member table — the only input the singular
   * transfer may legally receive. Resolved once, by
   * {@link bindOwnerOrientedCollectionMember}.
   */
  readonly ownerJunction: JunctionBoundRelation;
  readonly parentId: FinalReferenceSources;
  readonly membershipReadSource: FinalReferenceSources;
  /** A create-root variant row has no pre-existing membership to capture. */
  readonly freshParent: boolean;
  readonly txMode: boolean;
  readonly recordCompilers: RecordCompilerSeam;
  /**
   * A COMPOSED VACATE runs before this supplier and empties the slot by
   * construction — `disconnect: true` deletes the member row for this variant,
   * and `delete: true` deletes it and the owner row behind it.
   *
   * So the supplier does NOT go through the slot-replacement protocol: there is
   * no occupant left to capture, the capture's `affectedRows(1)` vacate would
   * address a row the composed delete already removed (measured: the transaction
   * leg reported `the captured owner's membership was already removed` and
   * retried into the same state), and in batch mode the transfer's premises would
   * be evaluated BEFORE the composed delete ran. The compare-and-swap is then the
   * composed DELETE plus the member table's target-side UNIQUE, in one atomic
   * unit — which §9.4 already names as the batch leg's enforcement.
   *
   * This is the junction twin of the parent-held direction's own elision, where a
   * vacate's FK-null is dropped when a sibling supplier rebinds the same columns.
   */
  readonly slotPreVacated: boolean;
}

/** The owner row a supplier brings in, always compiled as a fresh subtree. */
interface PreparedOwner {
  readonly record: FreshRecordPart;
  readonly values: Record<string, unknown>;
  /** A produced row key names no row until its INSERT lands. */
  readonly produced: boolean;
}

/** A probe that names ONE owner row by a complete unique selector. */
interface OwnerProbeSlot {
  readonly where: Record<string, unknown>;
  readonly probeId: string;
  readonly guardId: string;
  readonly probe: ReadStep;
}

/** A probe that reads THE connected owner through the membership correlation. */
interface ConnectedSlot {
  readonly probeId: string;
  readonly guardId: string;
  readonly probe: ReadStep;
}

type ToOnePlan =
  | {
      readonly kind: "connect";
      readonly slot: OwnerProbeSlot;
      readonly writeId: string;
    }
  | { readonly kind: "disconnect"; readonly writeId: string }
  | {
      readonly kind: "delete";
      readonly slot: ConnectedSlot;
      readonly memberId: string;
      readonly ownerId: string;
    }
  | {
      readonly kind: "update";
      readonly slot: ConnectedSlot;
      readonly compiler: RecordUpdateCompiler;
      /**
       * The unique selector a sibling `connect` supplied. When present it is the
       * whole locator AND the whole premise: the row it names is the owner this
       * payload is bringing IN, which is not yet a member when a batch evaluates
       * its guards, so asserting membership here would fail a premise that the
       * composition is about to make true.
       */
      readonly supplied: Record<string, unknown> | undefined;
    }
  | {
      readonly kind: "continuation";
      readonly seriesId: string;
      readonly programs: ParsedRecordPrograms;
    }
  | {
      readonly kind: "create";
      readonly owner: PreparedOwner;
      readonly joinId: string;
    }
  | {
      readonly kind: "connectOrCreate";
      readonly slot: OwnerProbeSlot;
      readonly owner: PreparedOwner;
      readonly joinId: string;
    }
  | {
      readonly kind: "upsert";
      readonly slot: ConnectedSlot;
      readonly compiler: RecordUpdateCompiler | undefined;
      readonly owner: PreparedOwner;
      readonly joinId: string;
    };

export class RelationJunctionToOnePart implements Part {
  private readonly context: JunctionToOneContext;
  private readonly statements: JunctionStatements;
  private readonly ownerScope: QueryScope;
  private readonly ownerProjection: TargetProjection;
  private readonly childName: string;
  private readonly plan: ToOnePlan;
  /** Present on every membership-ADDING plan; absent on the removals and modify. */
  private readonly transfer: JunctionSingularTransfer | undefined;

  constructor(
    scope: StepScope,
    context: JunctionToOneContext,
    plan: ToOnePlan
  ) {
    this.context = context;
    this.statements = new JunctionStatements(
      context.parentScope,
      context.txMode
    );
    this.ownerScope = createQueryScope(
      context.engine,
      context.relation.relationRef.targetModel
    );
    this.ownerProjection = buildTargetProjection(this.ownerScope.model);
    this.childName = getStepModelName(
      this.ownerScope.model,
      context.relation.relationRef.name
    );
    this.plan = plan;
    this.transfer = this.allocateTransfer(scope);
  }

  private get relationName(): string {
    return this.context.relation.relationRef.name;
  }

  /**
   * ONE transfer per membership-adding plan, in OWNER orientation.
   *
   * `address` names the TARGET side, which in owner orientation is the VARIANT
   * row this traversal is anchored on: a located variant addresses itself by its
   * planning correlation, and a create-root variant addresses NOTHING — no
   * membership can reference a row that does not exist yet, so the slot is provably
   * empty and the capture is elided rather than paid for.
   */
  private allocateTransfer(
    scope: StepScope
  ): JunctionSingularTransfer | undefined {
    if (
      this.plan.kind !== "connect" &&
      this.plan.kind !== "create" &&
      this.plan.kind !== "connectOrCreate" &&
      this.plan.kind !== "upsert"
    ) {
      return undefined;
    }
    if (this.context.slotPreVacated) return undefined;
    const address: JunctionTransferAddress = this.context.freshParent
      ? { kind: "fresh" }
      : { kind: "values", values: this.variantCorrelation() };
    return transferSingularJunctionMembership({
      engine: this.context.engine,
      scope,
      statements: this.statements,
      junction: this.context.ownerJunction,
      stepPrefix: `${this.childName}.slot`,
      address,
      // An inverse composition never issues a relation-wide clear:
      // `reinsertAfterOwnerClear` belongs to the DIRECT collection `set`
      // coordinator alone, and this surface has no `set`.
      mode: "preserveExact",
      txMode: this.context.txMode,
    });
  }

  planning(scope: StepScope): readonly StatementStep[] {
    const steps: StatementStep[] = [];
    switch (this.plan.kind) {
      case "connect":
      case "connectOrCreate":
        steps.push(this.plan.slot.probe);
        break;
      case "delete":
        steps.push(this.plan.slot.probe);
        break;
      case "update":
        steps.push(this.plan.slot.probe, ...this.plan.compiler.planning());
        break;
      case "upsert":
        steps.push(this.plan.slot.probe);
        if (this.plan.compiler) steps.push(...this.plan.compiler.planning());
        break;
      case "disconnect":
      case "continuation":
      case "create":
        break;
      default: {
        const exhaustive: never = this.plan;
        throw new QueryEngineError(
          `query-engine-v2 singular junction inverse has no planning for '${String(exhaustive)}'.`
        );
      }
    }
    if (this.plan.kind === "create" || this.plan.kind === "connectOrCreate") {
      steps.push(...this.plan.owner.record.planning(scope));
    }
    if (this.plan.kind === "upsert") {
      steps.push(...this.plan.owner.record.planning(scope));
    }
    if (this.transfer) steps.push(...this.transfer.planning);
    return steps;
  }

  compile(scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    switch (this.plan.kind) {
      case "connect":
        return this.compileConnect(known, this.plan);
      case "disconnect":
        return [this.memberDelete(this.plan.writeId, known)];
      case "delete":
        return this.compileDelete(known, this.plan);
      case "update":
        return this.compileUpdate(known, this.plan);
      case "continuation":
        return [this.compileContinuation(known, this.plan)];
      case "create":
        return this.compileCreate(scope, known, this.plan);
      case "connectOrCreate":
        return this.compileConnectOrCreate(scope, known, this.plan);
      case "upsert":
        return this.compileUpsert(scope, known, this.plan);
      default: {
        const exhaustive: never = this.plan;
        throw new QueryEngineError(
          `query-engine-v2 singular junction inverse has no compile for '${String(exhaustive)}'.`
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // The four correlated spellings, and the three suppliers.
  // -------------------------------------------------------------------------

  private compileConnect(
    known: PlanningKnown,
    plan: Extract<ToOnePlan, { kind: "connect" }>
  ): readonly OperationStep[] {
    const owner = this.requireProbedOwner(plan.slot, known, "connect");
    const guards: OperationStep[] = this.context.txMode
      ? []
      : [
          presenceGuard(
            plan.slot.guardId,
            this.capturedSelectorRead(plan.slot.where, owner),
            nestedWriteFailure(
              relationTargetNotFound(
                this.context.relation.relationRef,
                "connect"
              ),
              this.relationName,
              false
            )
          ),
        ];
    return [...guards, ...this.membershipAdd(plan.writeId, owner, known)];
  }

  /**
   * `delete: true` — the SINGLE connected owner row, and the member row that named
   * it. Its other-variant memberships go by the member tables' own source-FK
   * cascade; nothing here sweeps a connected set.
   *
   * An empty slot is a NO-OP, exactly as the ordinary child-held inverse
   * `delete: true` is: that arm lowers to a correlated bulk delete, which deletes
   * nothing when nothing is connected.
   */
  private compileDelete(
    known: PlanningKnown,
    plan: Extract<ToOnePlan, { kind: "delete" }>
  ): readonly OperationStep[] {
    const owner = this.connectedOwner(plan.slot, known);
    if (!owner) return [];
    const guards: OperationStep[] = this.context.txMode
      ? []
      : [
          this.connectedPresenceGuard(
            plan.slot.guardId,
            owner,
            "delete",
            known
          ),
        ];
    return [
      ...guards,
      this.memberDelete(plan.memberId, known),
      {
        id: plan.ownerId,
        kind: "write",
        model: getStepModelName(this.ownerScope.model, "record"),
        statement: buildDelete(this.ownerScope, {
          where: capturedTargetWhere(
            this.ownerScope.model,
            this.ownerProjection,
            owner
          ),
        }),
        outputs: {},
      },
    ];
  }

  private compileUpdate(
    known: PlanningKnown,
    plan: Extract<ToOnePlan, { kind: "update" }>
  ): readonly OperationStep[] {
    const owner = this.connectedOwner(plan.slot, known);
    if (!owner) {
      throw new NestedWriteError(
        relationTargetNotFound(this.context.relation.relationRef, "update"),
        this.relationName
      );
    }
    const guards: OperationStep[] = [];
    const writes: OperationStep[] = [];
    if (!this.context.txMode) {
      guards.push(
        plan.supplied
          ? presenceGuard(
              plan.slot.guardId,
              this.capturedSelectorRead(plan.supplied, owner),
              nestedWriteFailure(
                relationTargetNotFound(
                  this.context.relation.relationRef,
                  "update"
                ),
                this.relationName,
                false
              )
            )
          : this.connectedPresenceGuard(
              plan.slot.guardId,
              owner,
              "update",
              known
            )
      );
    }
    bucketOperationSteps(plan.compiler.compile(known), guards, writes);
    return [...guards, ...writes];
  }

  /**
   * The composed modify of a PRODUCING supplier (`create`, or `connectOrCreate`'s
   * missing arm) — {@link classifyToOneComposition}'s `membershipCapture`
   * continuation, lowered exactly as the child-held direction lowers it: the
   * supplier runs, the singular member is then captured through the physical
   * membership predicate the supplier just satisfied, and the retained update
   * compiles against that captured row key.
   */
  private compileContinuation(
    known: PlanningKnown,
    plan: Extract<ToOnePlan, { kind: "continuation" }>
  ): RecordSeriesStep {
    const capture: ReadStep = {
      id: `${plan.seriesId}.capture`,
      kind: "read",
      model: getStepModelName(this.ownerScope.model, "record"),
      statement: this.statements.materialize(
        this.context.relation,
        "membershipRead",
        {
          parentValue: this.variantWriteKey(known),
          select: targetProjectionRowKeySelect(this.ownerProjection),
          take: 1,
        }
      ),
      outputs: { rows: { kind: "rows" } },
    };
    return {
      id: plan.seriesId,
      kind: "recordSeries",
      progressive: progressiveJunctionParentGuard({
        engine: this.context.engine,
        parentScope: this.context.parentScope,
        relation: this.context.relation,
        source: this.context.membershipReadSource,
        known,
        operation: "updateMany",
        stepId: plan.seriesId,
      }),
      series: new NestedSelectedRecordSeries({
        engine: this.context.engine,
        sourceScope: this.context.parentScope,
        targetScope: this.ownerScope,
        relationRef: this.context.relation.relationRef,
        member: { kind: "parsedOnce", programs: plan.programs },
        capture,
        recordCompilers: this.context.recordCompilers,
        membership: {
          kind: "junction",
          relation: this.context.relation,
          parentValue: this.variantWriteKey(known),
          txMode: this.context.txMode,
        },
      }),
    };
  }

  private compileCreate(
    scope: StepScope,
    known: PlanningKnown,
    plan: Extract<ToOnePlan, { kind: "create" }>
  ): readonly OperationStep[] {
    return [
      ...plan.owner.record.compile(scope, known),
      ...this.membershipAdd(plan.joinId, plan.owner.values, known),
    ];
  }

  private compileConnectOrCreate(
    scope: StepScope,
    known: PlanningKnown,
    plan: Extract<ToOnePlan, { kind: "connectOrCreate" }>
  ): readonly OperationStep[] {
    const probed = this.probedOwner(plan.slot, known);
    if (probed) {
      const guards: OperationStep[] = this.context.txMode
        ? []
        : [
            presenceGuard(
              plan.slot.guardId,
              this.capturedSelectorRead(plan.slot.where, probed),
              nestedWriteFailure(
                nestedReplacement("connectOrCreate"),
                this.relationName,
                false
              )
            ),
          ];
      return [...guards, ...this.membershipAdd(plan.joinId, probed, known)];
    }
    return [
      ...plan.owner.record.compile(scope, known),
      ...this.membershipAdd(plan.joinId, plan.owner.values, known),
    ];
  }

  /**
   * `upsert` on a singular slot: the CONNECTED owner is the whole locator — a
   * to-one upsert spells no `where`. Found → the update arm against that captured
   * row; absent → the create arm, linked through the same transfer every other
   * supplier uses.
   */
  private compileUpsert(
    scope: StepScope,
    known: PlanningKnown,
    plan: Extract<ToOnePlan, { kind: "upsert" }>
  ): readonly OperationStep[] {
    const owner = this.connectedOwner(plan.slot, known);
    if (!owner) {
      return [
        ...plan.owner.record.compile(scope, known),
        ...this.membershipAdd(plan.joinId, plan.owner.values, known),
      ];
    }
    if (!plan.compiler) return [];
    const guards: OperationStep[] = [];
    const writes: OperationStep[] = [];
    if (!this.context.txMode) {
      guards.push(
        this.connectedPresenceGuard(plan.slot.guardId, owner, "update", known)
      );
    }
    bucketOperationSteps(plan.compiler.compile(known), guards, writes);
    return [...guards, ...writes];
  }

  // -------------------------------------------------------------------------
  // Leaves.
  // -------------------------------------------------------------------------

  /**
   * The slot replacement — capture, vacate a foreign owner, then insert — or a
   * plain insert when a composed vacate already emptied the slot.
   */
  private membershipAdd(
    writeId: string,
    owner: Record<string, unknown>,
    known: PlanningKnown
  ): readonly OperationStep[] {
    const targetKey = this.variantWriteKey(known);
    const insert = (): WriteStep => {
      const materialized = this.statements.materializeJunctionInsert(
        this.context.ownerJunction,
        { parentValue: owner, targetValue: targetKey }
      );
      return {
        id: writeId,
        kind: "write",
        statement: materialized.statement,
        outputs: {},
        ...(materialized.racePin ? { racePin: materialized.racePin } : {}),
      };
    };
    if (!this.transfer) return [insert()];
    return this.transfer.compile(known, {
      targetKey,
      desiredOwner: owner,
      insert,
    });
  }

  /**
   * `disconnect: true` — THE junction row, named by the variant side alone.
   *
   * A singular slot holds at most one membership, so no selector exists to
   * require: `junctionDelete` with no `targetWhere` is the whole statement, and it
   * is idempotent on an empty slot.
   */
  private memberDelete(id: string, known: PlanningKnown): WriteStep {
    return {
      id,
      kind: "write",
      statement: this.statements.materialize(
        this.context.relation,
        "junctionDelete",
        { parentValue: this.variantWriteKey(known) }
      ),
      outputs: {},
    };
  }

  private connectedPresenceGuard(
    id: string,
    owner: Record<string, unknown>,
    operation: "delete" | "update",
    known: PlanningKnown
  ): GuardStep {
    return {
      id,
      kind: "guard",
      premise: {
        kind: "exists",
        statement: this.statements.materialize(
          this.context.relation,
          "membershipRead",
          {
            parentValue: this.variantWriteKey(known),
            where: {
              AND: this.ownerProjection.identityFields.map((field) => ({
                [field]: { equals: owner[field] },
              })),
            },
            select: targetProjectionRowKeySelect(this.ownerProjection),
            take: 1,
          }
        ),
      },
      failure: nestedWriteFailure(
        relationTargetNotFound(this.context.relation.relationRef, operation),
        this.relationName,
        false
      ),
    };
  }

  /**
   * Reassert that the complete selector still names the captured owner row —
   * split-witness correlation, so a concurrent move of the selector onto a
   * replacement leaves no such row and the supply fails closed.
   *
   * `buildFind` with a limit, not `buildFindUnique`: the merged predicate is the
   * selector AND the captured row key spelled field by field, which is not a
   * unique discriminator for a COMPOUND-keyed owner.
   */
  private capturedSelectorRead(
    where: Record<string, unknown>,
    captured: Record<string, unknown>
  ) {
    return buildFind(
      this.ownerScope,
      {
        where: capturedSelectorWhere(this.ownerScope, where, captured),
        select: targetProjectionRowKeySelect(this.ownerProjection),
      },
      { limit: 1 }
    );
  }

  // -------------------------------------------------------------------------
  // Probe consumption + the variant-side correlation.
  // -------------------------------------------------------------------------

  private requireProbedOwner(
    slot: OwnerProbeSlot,
    known: PlanningKnown,
    operation: "connect"
  ): Readonly<Record<string, unknown>> {
    const owner = this.probedOwner(slot, known);
    if (owner) return owner;
    throw new NestedWriteError(
      relationTargetNotFound(this.context.relation.relationRef, operation),
      this.relationName
    );
  }

  private probedOwner(
    slot: OwnerProbeSlot,
    known: PlanningKnown
  ): Readonly<Record<string, unknown>> | undefined {
    return this.firstRowKey(known[planningKey(slot.probeId, "rows")]);
  }

  private connectedOwner(
    slot: ConnectedSlot,
    known: PlanningKnown
  ): Readonly<Record<string, unknown>> | undefined {
    return this.firstRowKey(known[planningKey(slot.probeId, "rows")]);
  }

  /**
   * The probed owner's complete row KEY, or `undefined` for an empty slot.
   *
   * DECODED, not raw. Every member of this key is re-addressed — the owner
   * delete's `whereUnique`, the membership guard's equality conjuncts, the
   * junction insert's target value — through the ordinary where/values builder,
   * which lowers a LOGICAL value, while the probe published the PHYSICAL row.
   * They are the same text for most scalars and not for a decimal, whose SQLite
   * column answers with the unscaled coefficient, so re-binding the captured
   * spelling would address `captured x 10^scale`. {@link parseCapturedRowKeys}
   * is the one decode, and it owns the malformed-row refusal with it.
   */
  private firstRowKey(
    rows: unknown
  ): Readonly<Record<string, unknown>> | undefined {
    if (!Array.isArray(rows)) {
      throw new QueryEngineError(
        `query-engine-v2 internal: the singular collection inverse '${this.relationName}' did not observe its owner probe.`
      );
    }
    const [captured] = parseCapturedRowKeys(
      this.context.engine,
      this.ownerScope.model,
      rows.slice(0, 1)
    );
    return captured;
  }

  /** The variant row key a PLANNING read correlates on (Ref or literal). */
  private variantCorrelation(): Record<string, unknown> {
    return Object.fromEntries(
      this.correlatedMembers().map((member) => [
        member.referencedField,
        foreignKeyCorrelationValue(member),
      ])
    );
  }

  /** The variant row key a WRITE carries — a located literal or a produced `Ref`. */
  private variantWriteKey(known: PlanningKnown): Record<string, unknown> {
    return Object.fromEntries(
      this.writeMembers().map((member) => [
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

  private writeMembers(): readonly ForeignKeyMember[] {
    return this.context.relation.membership.source.members.map((member) => ({
      foreignField: member.junctionField,
      referencedField: member.referencedField,
      writeSource: this.variantSource(
        this.context.parentId,
        member.referencedField
      ),
    }));
  }

  private correlatedMembers(): readonly CorrelatedForeignKeyMember[] {
    return this.writeMembers().map((member) => ({
      ...member,
      readSource: planningSourceFromFinal(
        this.variantSource(
          this.context.membershipReadSource,
          member.referencedField
        ),
        this.relationName,
        "junction"
      ),
    }));
  }

  private variantSource(
    sources: FinalReferenceSources,
    field: string
  ): FinalReferenceSource {
    const source = sources[field];
    if (source) return source;
    throw new QueryEngineError(
      `query-engine-v2 internal: singular collection inverse '${this.relationName}' has no parent source for row-key field '${field}'.`
    );
  }
}

// ---------------------------------------------------------------------------
// Fold — one singular-inverse payload into ordered Parts.
// ---------------------------------------------------------------------------

export interface JunctionToOneInput {
  readonly scope: StepScope;
  readonly engine: QueryEngine;
  readonly parentScope: QueryScope;
  readonly relation: JunctionBoundRelation;
  readonly program: RelationMutationProgram;
  readonly parentId: FinalReferenceSources;
  readonly membershipReadSource: FinalReferenceSources;
  readonly freshParent?: boolean;
  readonly txMode: boolean;
  readonly recordCompilers: RecordCompilerSeam;
}

/**
 * Whether this bound relation is the SINGULAR collection inverse — the ONE
 * question both compiler mounts ask before they reach `buildJunctionParts`, so the
 * junction-to-one decision has a single writer.
 */
export function isSingularCollectionInverse(
  relation: JunctionBoundRelation
): boolean {
  return (
    relation.cardinality === "one" &&
    relation.membership.polymorphicMember === true
  );
}

export function buildJunctionToOneParts(input: JunctionToOneInput): Part[] {
  const relationName = input.relation.relationRef.name;
  const inverse = input.relation.relationRef.resolved;
  if (!isVariantJunctionInverse(inverse)) {
    throw new QueryEngineError(
      `query-engine-v2 internal: singular collection inverse '${relationName}' is not a bound member of a collection carrier.`
    );
  }
  const ownerScope = createQueryScope(
    input.engine,
    input.relation.relationRef.targetModel
  );
  const ownerJunction = bindOwnerOrientedCollectionMember(ownerScope, inverse);
  // THE ORDER CLAIM, consumed and never re-derived: `RELATION_MUTATION_KEYS`
  // lists `update` third and `connect` ninth, so the PARSED order lowers modify
  // before supply — the exact inversion `parity-h-to-one-lattice` falsified for
  // the row-held direction. `classifyToOneComposition` is the one owner of
  // `(vacate, supplier, modify)`, and `OwnWriteRelation` reads the same one.
  const composition = classifyToOneComposition(
    relationName,
    input.program.entries
  );
  const entries = composition?.ordered ?? input.program.entries;
  const context: JunctionToOneContext = {
    engine: input.engine,
    parentScope: input.parentScope,
    relation: input.relation,
    ownerJunction,
    parentId: input.parentId,
    membershipReadSource: input.membershipReadSource,
    freshParent: input.freshParent === true,
    txMode: input.txMode,
    recordCompilers: input.recordCompilers,
    slotPreVacated:
      composition !== undefined &&
      composition.ordered[0] !== composition.supplier,
  };
  const parts: Part[] = [];
  for (const entry of entries) {
    parts.push(
      buildEntryPart(
        input,
        context,
        ownerScope,
        entry,
        entry === composition?.modify ? composition.continuation : undefined
      )
    );
  }
  return parts;
}

function buildEntryPart(
  input: JunctionToOneInput,
  context: JunctionToOneContext,
  ownerScope: QueryScope,
  entry: RelationMutationEntry,
  continuation: ToOneContinuation | undefined
): Part {
  const { scope } = input;
  const relationName = context.relation.relationRef.name;
  const childName = getStepModelName(ownerScope.model, relationName);
  const projection = buildTargetProjection(ownerScope.model);
  const rowKeySelect = targetProjectionRowKeySelect(projection);

  const ownerProbe = (where: Record<string, unknown>): OwnerProbeSlot => {
    const probeId = scope.allocate(`${childName}.find`);
    return {
      where,
      probeId,
      guardId: scope.allocate(`${childName}.guard.target`),
      probe: {
        id: probeId,
        kind: "read",
        model: getStepModelName(ownerScope.model, "record"),
        statement: buildFindUnique(ownerScope, {
          where,
          select: rowKeySelect,
          forUpdate: context.txMode,
        }),
        outputs: { rows: { kind: "rows" } },
      },
    };
  };

  const connectedProbe = (): ConnectedSlot => {
    const probeId = scope.allocate(`${childName}.member`);
    const statements = new JunctionStatements(
      context.parentScope,
      context.txMode
    );
    return {
      probeId,
      guardId: scope.allocate(`${childName}.guard.member`),
      probe: {
        id: probeId,
        kind: "read",
        model: getStepModelName(ownerScope.model, "record"),
        statement: statements.materialize(context.relation, "membershipRead", {
          parentValue: correlatedVariantKey(context, relationName),
          select: rowKeySelect,
          take: 1,
          lock: "transaction",
        }),
        outputs: { rows: { kind: "rows" } },
      },
    };
  };

  const freshOwner = (
    data: RecordMutationData,
    where?: Record<string, unknown>
  ): PreparedOwner => {
    const record = input.recordCompilers.createFresh(scope, {
      childScope: ownerScope,
      data,
      relationName: "",
      ...(where ? { racePin: createRacePin(ownerScope, where) } : {}),
    });
    const published = record.rootRowKey();
    const values: Record<string, unknown> = {};
    let produced = false;
    for (const member of context.ownerJunction.membership.source.members) {
      const source = published[member.referencedField];
      if (!source) {
        throw new QueryEngineError(
          `query-engine-v2 internal: the singular collection inverse '${relationName}' resolved no owner row-key member '${member.referencedField}' from its create arm.`
        );
      }
      values[member.referencedField] = foreignKeyWriteValueWith(
        {
          foreignField: member.junctionField,
          referencedField: member.referencedField,
          writeSource: source,
        },
        undefined,
        relationName,
        "create-through-member-junction",
        (reference) => {
          produced = true;
          return referenceSql(
            context.engine,
            ownerScope.model,
            member.referencedField,
            reference
          );
        }
      );
    }
    return { record, values, produced };
  };

  const selectedCompiler = (
    data: RecordMutationData,
    probeId: string
  ): RecordUpdateCompiler | undefined => {
    const parsed = buildParsedRelationPrograms(
      ownerScope,
      data.parsed,
      data.source
    );
    assertPortablePrimaryKeyUpdateInput(ownerScope.model, "update", {
      data: parsed.scalarData,
    });
    assertRelationKeyUpdatesAreCompilable(
      ownerScope,
      parsed.scalarData,
      parsed.relations
    );
    return input.recordCompilers.updateSelected({
      scope,
      engine: input.engine,
      targetScope: ownerScope,
      scalarData: parsed.scalarData,
      relations: parsed.relations,
      targetRead: { id: probeId },
      rootWrite: { label: `${childName}.update` },
      relationName,
    });
  };

  switch (entry.kind) {
    case "connect": {
      const where = entry.targets[0];
      if (!where) {
        throw new QueryEngineError(
          `query-engine-v2 internal: singular collection inverse '${relationName}' connect has no target.`
        );
      }
      return new RelationJunctionToOnePart(scope, context, {
        kind: "connect",
        slot: ownerProbe(where),
        writeId: scope.allocate(`${childName}.junction.insert`),
      });
    }
    case "disconnect": {
      requireCurrentTarget(entry, relationName);
      return new RelationJunctionToOnePart(scope, context, {
        kind: "disconnect",
        writeId: scope.allocate(`${childName}.junction.delete`),
      });
    }
    case "delete": {
      requireCurrentTarget(entry, relationName);
      return new RelationJunctionToOnePart(scope, context, {
        kind: "delete",
        slot: connectedProbe(),
        memberId: scope.allocate(`${childName}.junction.delete`),
        ownerId: scope.allocate(`${childName}.delete`),
      });
    }
    case "create": {
      const data = entry.items[0];
      if (!data) {
        throw new QueryEngineError(
          `query-engine-v2 internal: singular collection inverse '${relationName}' create has no record.`
        );
      }
      return new RelationJunctionToOnePart(scope, context, {
        kind: "create",
        owner: freshOwner(data),
        joinId: scope.allocate(`${childName}.junction.insert`),
      });
    }
    case "connectOrCreate": {
      const item = entry.items[0];
      if (!item) {
        throw new QueryEngineError(
          `query-engine-v2 internal: singular collection inverse '${relationName}' connectOrCreate has no item.`
        );
      }
      return new RelationJunctionToOnePart(scope, context, {
        kind: "connectOrCreate",
        slot: ownerProbe(item.where),
        owner: freshOwner(item.create, item.where),
        joinId: scope.allocate(`${childName}.junction.insert`),
      });
    }
    case "update": {
      const item = entry.items[0];
      if (!item || item.target.kind !== "correlated") {
        throw new QueryEngineError(
          `query-engine-v2 internal: singular collection inverse '${relationName}' update requires one correlated target.`
        );
      }
      if (continuation?.kind === "membershipCapture") {
        // The supplier PRODUCES the owner, so nothing names it until that write
        // lands: the modify becomes a record-series continuation whose capture
        // reads the singular member AFTER the supplier satisfied it.
        return new RelationJunctionToOnePart(scope, context, {
          kind: "continuation",
          seriesId: scope.allocate(`${childName}.continuation`),
          programs: buildParsedRelationPrograms(
            ownerScope,
            item.data.parsed,
            item.data.source
          ),
        });
      }
      // A `connect` supplier hands over its unique selector, which REPLACES the
      // membership correlation: correlation before the fragment's first write
      // names the OUTGOING owner, or nothing at all on an empty slot.
      const supplied =
        continuation?.kind === "suppliedSelector"
          ? continuation.where
          : undefined;
      const slot: ConnectedSlot = supplied
        ? asConnectedSlot(ownerProbe(supplied))
        : connectedProbe();
      const compiler = selectedCompiler(item.data, slot.probeId);
      if (!compiler) {
        throw new QueryEngineError(
          `query-engine-v2 internal: singular collection inverse '${relationName}' update compiled no work.`
        );
      }
      return new RelationJunctionToOnePart(scope, context, {
        kind: "update",
        slot,
        compiler,
        supplied,
      });
    }
    case "upsert": {
      const item = entry.items[0];
      if (!item || item.target.kind !== "correlated") {
        throw new QueryEngineError(
          `query-engine-v2 internal: singular collection inverse '${relationName}' upsert requires a correlated target.`
        );
      }
      const slot = connectedProbe();
      return new RelationJunctionToOnePart(scope, context, {
        kind: "upsert",
        slot,
        compiler: selectedCompiler(item.update, slot.probeId),
        owner: freshOwner(item.create),
        joinId: scope.allocate(`${childName}.junction.insert`),
      });
    }
    default:
      throw new QueryEngineError(
        `query-engine-v2 internal: nested operation '${entry.kind}' is not part of the singular collection inverse lattice on relation '${relationName}'.`
      );
  }
}

/**
 * A supplied selector locates the INCOMING owner, so its probe stands where the
 * membership probe would. Both shapes publish the same `rows` output under the
 * same key, which is what lets one `update` plan take either.
 */
function asConnectedSlot(slot: OwnerProbeSlot): ConnectedSlot {
  return { probeId: slot.probeId, guardId: slot.guardId, probe: slot.probe };
}

function requireCurrentTarget(
  entry: Extract<RelationMutationEntry, { kind: "disconnect" | "delete" }>,
  relationName: string
): void {
  if (entry.target.kind === "current") return;
  throw new QueryEngineError(
    `query-engine-v2 internal: singular collection inverse '${relationName}' ${entry.kind} carries a selector; a singular slot names its membership by correlation alone.`
  );
}

function correlatedVariantKey(
  context: JunctionToOneContext,
  relationName: string
): Record<string, unknown> {
  return Object.fromEntries(
    context.relation.membership.source.members.map((member) => {
      const source = context.membershipReadSource[member.referencedField];
      if (!source) {
        throw new QueryEngineError(
          `query-engine-v2 internal: singular collection inverse '${relationName}' has no parent source for row-key field '${member.referencedField}'.`
        );
      }
      return [
        member.referencedField,
        foreignKeyCorrelationValue({
          foreignField: member.junctionField,
          referencedField: member.referencedField,
          writeSource: source,
          readSource: planningSourceFromFinal(source, relationName, "junction"),
        }),
      ];
    })
  );
}
