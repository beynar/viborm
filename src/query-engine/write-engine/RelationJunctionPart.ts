// biome-ignore-all lint/style/useFilenamingConvention: RelationJunctionPart is the architecture name.
import { NestedWriteError, QueryEngineError } from "@errors";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import { getPrimaryKeyFields } from "../builders/correlation-utils";
import { getManyToManyJoinInfo } from "../builders/many-to-many-utils";
import {
  buildParsedRelationPrograms,
  type RelationMutationProgram,
} from "../builders/relation-mutation-parser";
import { buildInsert } from "../builders/values-builder";
import { getWhereUniqueEntries } from "../builders/where-unique-builder";
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
  buildUpdate,
} from "../operations";
import type { QueryEngine } from "../query-engine";
import type { QueryScope, RelationInfo } from "../types";
import {
  type CorrelatedForeignKeyMember,
  type FinalReferenceSource,
  type ForeignKeyMember,
  foreignKeyCorrelationValue,
  foreignKeyResolvedReadValue,
  foreignKeyWriteValueWith,
  isPlanningFieldSource,
  planningSourceFromFinal,
} from "./foreign-key-reference";
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
import {
  buildNestedTargetFreshCreatePart,
  buildNestedTargetUpdatePart,
  type NestedChildBuilder,
  targetNeedsFullUpdate,
} from "./nested-target-parts";
import {
  type GuardStep,
  type OperationStep,
  type ReadStep,
  ref,
  type StatementStep,
  type TargetConstraintPin,
  type WriteStep,
} from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { planningKey } from "./Part";
import { literalParentId, plannedParentId } from "./RelationUpsertPart";
import type { StepScope } from "./StepScope";
import {
  getStepModelName,
  UnsupportedOperationError,
  uniqueSelectorConjuncts,
} from "./shared";

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
  | "connectOrCreate"
  | "create"
  | "createMany"
  | "delete"
  | "deleteMany"
  | "disconnect"
  | "set"
  | "update"
  | "updateMany"
  | "upsert";

export interface RelationJunctionConfig {
  readonly engine: QueryEngine;
  readonly parentScope: QueryScope;
  readonly relationName: string;
  readonly relationInfo: RelationInfo;
  readonly childName: string;
  readonly kind: JunctionKind;
  /** The located parent id (a planning value; a literal at compile, a Ref at planning). */
  readonly parentId: FinalReferenceSource;
  /**
   * E2-U3 — where this parent's membership ALREADY is, when that is not the key its
   * join rows must carry from now on. The two coincide everywhere except under a nested
   * target that transitions its own primary key and is ordered AFTER its self-UPDATE (a
   * non-cascade sibling edge, {@link RelationWritePart} `interpretChildParts`): the
   * membership READ runs at planning, before any write, so it must ask for the key the
   * join rows still carry; the WRITES run after the self-UPDATE, by which time
   * `ON UPDATE CASCADE` has carried those same rows to the new one. Absent → every read
   * takes {@link parentId}, byte-identical to pre-E2-U3. The same split
   * `RelationSetConfig.membershipReadSource` makes for `set`.
   */
  readonly membershipReadSource?: FinalReferenceSource;
  /**
   * E5-U1 — this parent is a row the enclosing operation is MAKING, so it can have no
   * membership yet (fresh-parent elision, ATOM §4). Only the `upsert` kind reads it,
   * and what it means there is total: the correlated three-way collapses to the
   * two-way the adopt family already expresses — a global probe, then adopt-and-update
   * or create — because the "exists but is not a member of this parent" branch is the
   * ONLY branch a fresh parent can take for an existing row, and refusing it would
   * refuse every existing row.
   *
   * It is also what makes the shape expressible at all: the membership read correlates
   * on {@link parentRef}, which requires a `planned` or `literal` parent, and a create
   * root whose primary key is DB-generated supplies a `ref`. Eliding the read removes
   * the requirement instead of working around it.
   */
  readonly freshParent?: boolean;
  readonly txMode: boolean;
  /** connect/disconnect/set/delete/update: the child unique locator(s). */
  readonly wheres?: readonly Record<string, unknown>[];
  /**
   * N4-U1 (`update` only): the target-slot probe ids, allocated by the builder before
   * the target payloads fold, because a target named by a NON-primary-key unique hands
   * its deeper edges a planning source addressing that probe — and a source value
   * is a value, so the id must exist first. Aligned to {@link wheres}; absent for every
   * other kind, which allocates its probe ids in the constructor as before.
   */
  readonly targetProbeIds?: readonly string[];
  /** Aligned to {@link wheres}: whether that slot's probe must PUBLISH its captured
   *  target primary key as a `firstRowField` output (set exactly when the slot's
   *  deeper edges `planned`-read it). */
  readonly targetPublishesPk?: readonly boolean[];
  /** update/updateMany: the validated scalar data, aligned to `wheres`/`filters`. */
  readonly data?: readonly Record<string, unknown>[];
  /** deleteMany/updateMany: the correlated filter(s). */
  readonly filters?: readonly Record<string, unknown>[];
  /** create / createMany: the child create data (scalar only) for each item. */
  readonly creates?: readonly Record<string, unknown>[];
  /** createMany only (N3-U1): each child INSERT skips a duplicate instead of failing,
   *  through the dialect's own primitive — `ON CONFLICT DO NOTHING` / `INSERT OR
   *  IGNORE` as a SQL leaf, or the savepoint-wrapped `onUniqueConflict: "skip"`
   *  executor effect on a `recoverableUniqueError` dialect (MySQL). */
  readonly skipDuplicates?: boolean;
  /** connectOrCreate: each `{ where, create }` adopt-or-insert item. */
  readonly adopts?: readonly {
    readonly where: Record<string, unknown>;
    readonly create: Record<string, unknown>;
  }[];
  /** upsert: each `{ where, create, update }` correlated three-way item. */
  readonly upserts?: readonly {
    readonly where: Record<string, unknown>;
    readonly create: Record<string, unknown>;
    readonly update: Record<string, unknown>;
  }[];
  /**
   * E6.1 (`upsert` only): the slot's TWO probe ids, allocated by the builder before the
   * arm payloads fold — {@link targetProbeIds}' reason in the kind that has two probes.
   * Aligned to {@link upserts}, and allocated in the order {@link buildUpsertSlot} would
   * allocate them, so threading them moves no step id ({@link StepScope.allocate} counts
   * per label).
   */
  readonly upsertProbeIds?: readonly {
    readonly member: string;
    readonly global: string;
  }[];
  /**
   * E6.1 — aligned to {@link upserts}: the id of the probe whose captured target primary
   * key this arm's update payload addresses, or `undefined` when nothing addresses it
   * (the payload named the primary key itself, or carries no deeper edge at all). Always
   * one of the two ids in {@link upsertProbeIds}.
   *
   * The BUILDER makes this choice because a final source is a value, so the
   * arm cannot fold until the id exists. The slot then publishes the `firstRowField` on
   * whichever probe this names — one decision, read twice, so the two sites cannot drift
   * about which probe `compile` spends on the arm.
   */
  readonly upsertArmProbeIds?: readonly (string | undefined)[];
  // T3b-2 mechanism 2 / mechanism 1 reuse (TO-ONE.md §7.7). A junction create /
  // update / upsert target whose data carries its own relation writes folds them
  // one level deeper through the same {@link NestedChildBuilder} the child-held
  // families use — a fresh created target (mechanism 2, its explicit PK the child
  // parts' literal parent) or a located-by-PK updated target (mechanism 1, the
  // `where` PK the literal parent). Aligned index-for-index to `creates` / `wheres`
  // (update) / `upserts`; emitted after the relevant child write, branch-specific
  // for the upsert arms. Empty when the target payload is scalar-only.
  readonly createChildParts?: readonly (readonly Part[])[];
  readonly updateChildParts?: readonly (readonly Part[])[];
  readonly upsertCreateChildParts?: readonly (readonly Part[])[];
  readonly upsertUpdateChildParts?: readonly (readonly Part[])[];
  /** E2-U2 — the `connectOrCreate` CREATE arm's own relations, folded one level deeper
   *  against the arm's explicit literal PK (mechanism 2, the fresh target). Aligned to
   *  {@link adopts}; emitted ONLY on the branch that inserts the row — an adopted target
   *  (found globally, or created by an earlier item) is the row that was already there,
   *  and this arm's create payload is not applied to it. Empty for a scalar-only arm. */
  readonly adoptCreateChildParts?: readonly (readonly Part[])[];
  // X1c — a FRESH create/upsert-create junction target whose data carries the
  // parent-held to-one projection (its FK folds into the target's OWN INSERT — X1b's
  // fresh mechanism) delegates its whole create to `CreateOperation`. When present at an
  // index, the delegated Part REPLACES the slot's `childInsert` (it does the target
  // INSERT and its before-parent writes); the join row references the target's literal
  // PK after. Aligned to `creates` / `upserts`; `undefined` for a scalar-only or
  // located-update-projection target.
  readonly createDelegated?: readonly (Part | undefined)[];
  readonly upsertCreateDelegated?: readonly (Part | undefined)[];
  /** E4-U3 — the `connectOrCreate` create arm's delegated subtree, aligned to
   *  `adopts`; present when the arm's whole create is a subtree rather than the
   *  slot's own `childInsert`. */
  readonly adoptCreateDelegated?: readonly (Part | undefined)[];
  /**
   * E4-U3 — the join row's target value when a DELEGATED subtree owns the INSERT,
   * aligned to `creates` / `adopts` / `upserts`. The slot cannot ask `resolveCreatePk`
   * for it: that resolver `Ref`s the slot's OWN `childInsert` step, which a delegated
   * arm never emits, so the join row would address a statement that is not in the
   * fragment. `undefined` keeps the slot's own resolution.
   */
  readonly createIdentity?: readonly (JunctionCreateIdentity | undefined)[];
  readonly adoptIdentity?: readonly (JunctionCreateIdentity | undefined)[];
  readonly upsertCreateIdentity?: readonly (
    | JunctionCreateIdentity
    | undefined
  )[];
}

/** E4-U3 — a fresh junction target's identity as the join row spends it: the value,
 *  and whether the row's INSERT is what PRODUCED it (which is what the connectOrCreate
 *  dedup ledger keys on — a produced key has no compile-time value to key by). */
interface JunctionCreateIdentity {
  readonly pk: unknown;
  readonly generatedField?: string;
}

/** A per-target probe slot (connect/set/delete/update) with its write ids. */
interface TargetSlot {
  readonly where: Record<string, unknown>;
  readonly probeId: string;
  readonly guardId: string;
  readonly writeId: string;
  readonly childId: string;
  readonly probe: ReadStep;
  /** update (mechanism 1): the located target's own nested child Parts, folded one
   *  level deeper against its literal `where` PK. Empty for a scalar-only update. */
  readonly childParts: readonly Part[];
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

/** A probe-less slot (disconnect/updateMany) — a single write id per item. */
interface BareSlot {
  readonly where: Record<string, unknown>;
  readonly writeId: string;
  readonly data?: Record<string, unknown>;
}

/** A `create` slot — INSERT the fresh child, then INSERT the join row. The
 *  target PK is a compile-time literal the create data carries, or — when the
 *  target PK is a DB-generated auto-increment the data omits — a backward `Ref`
 *  to the child INSERT's produced identity ({@link generatedField} set). */
interface CreateSlot {
  readonly create: Record<string, unknown>;
  readonly createPk: unknown;
  /** Set when the target PK is DB-generated: the child INSERT captures it
   *  (`firstRowField` via RETURNING in tx mode on a returning driver, driver
   *  `insertId` otherwise) and {@link createPk} is the cast-wrapped backward Ref. */
  readonly generatedField?: string;
  readonly childId: string;
  readonly joinId: string;
  /** create (mechanism 2): the fresh target's own nested child Parts, folded one
   *  level deeper against its explicit literal PK. Empty for a scalar-only create. */
  readonly childParts: readonly Part[];
  /** X1c — when present, the fresh target's whole create delegates to `CreateOperation`
   *  (a parent-held to-one folds into its OWN INSERT); this Part REPLACES `childInsert`,
   *  emitted BEFORE the join (the target must exist first). */
  readonly delegated?: Part;
}

/** A `connectOrCreate` slot — a global probe, then adopt (join) or create+join. */
interface AdoptSlot {
  readonly where: Record<string, unknown>;
  readonly create: Record<string, unknown>;
  readonly createPk: unknown;
  /** Set when the target PK is DB-generated (see {@link CreateSlot.generatedField}):
   *  the missing arm's INSERT captures the identity the join row references. */
  readonly generatedField?: string;
  readonly probeId: string;
  readonly guardId: string;
  readonly childId: string;
  readonly joinId: string;
  readonly probe: ReadStep;
  /** E2-U2 (mechanism 2): the fresh target's own nested child Parts, folded one level
   *  deeper against its explicit literal PK. Emitted on the CREATE branch only. */
  readonly childParts: readonly Part[];
  /** E4-U3 — when present, the create arm's whole create is a SUBTREE which REPLACES
   *  this slot's `childInsert` on the create branch (it carries the arm's `racePin` on
   *  its own root INSERT) and produces the identity {@link createPk} references. */
  readonly delegated?: Part;
}

/** An `upsert` slot — a membership probe + a global probe decide the three-way. */
interface UpsertSlot {
  readonly where: Record<string, unknown>;
  readonly create: Record<string, unknown>;
  /** The join row's target value: a literal PK, or the backward `Ref` into this
   *  slot's own INSERT capture when the PK is DB-generated (N3-U2). */
  readonly createPk: unknown;
  /** Set when the create arm's PK is DB-generated: its INSERT captures the identity
   *  the join row references (see {@link CreateSlot.generatedField}). */
  readonly generatedField?: string;
  readonly update: Record<string, unknown>;
  readonly membershipProbeId: string;
  readonly globalProbeId: string;
  readonly guardId: string;
  readonly childId: string;
  readonly updateId: string;
  readonly joinId: string;
  /**
   * E5-U1 — absent under {@link RelationJunctionConfig.freshParent}. The membership
   * read correlates on {@link RelationJunctionPart.parentRef}, which a fresh parent's
   * `ref` source cannot answer, and the answer it would give is known anyway: a row
   * this operation is MAKING has no members. The slot's id stays allocated so the
   * correlated three-way ({@link RelationJunctionPart.compileUpsert}) reads one
   * required field, not an optional one.
   */
  readonly membershipProbe?: ReadStep;
  readonly globalProbe: ReadStep;
  /** upsert arms (mechanism 2 / mechanism 1 reuse): the create-arm and update-arm
   *  nested child Parts, folded one level deeper against the target's literal PK
   *  (`create` PK / `where` PK). Emitted branch-specifically: create-arm on the absent
   *  decision, update-arm on the member decision. Empty for a scalar-only arm. */
  readonly createChildParts: readonly Part[];
  readonly updateChildParts: readonly Part[];
  /** X1c — when present, the fresh create-arm target's whole create delegates to
   *  `CreateOperation`, REPLACING the create branch's `childInsert` (emitted before the
   *  join). The update arm keeps the located-update projection (empty scalar + the
   *  delegated update Part in `updateChildParts`). */
  readonly createDelegated?: Part;
}

export class RelationJunctionPart implements Part {
  private readonly config: RelationJunctionConfig;
  private readonly targetPkField: string;
  private readonly sourcePkField: string;
  private readonly sourceFieldName: string;
  private readonly childScope: QueryScope;
  private readonly statements: ManyToManyStatements;
  private readonly targets: readonly TargetSlot[];
  private readonly bulks: readonly BulkSlot[];
  private readonly bare: readonly BareSlot[];
  private readonly creates: readonly CreateSlot[];
  private readonly adopts: readonly AdoptSlot[];
  private readonly upserts: readonly UpsertSlot[];
  private readonly setClearId: string;
  private readonly setInsertId: string;

  constructor(scope: StepScope, config: RelationJunctionConfig) {
    this.config = config;
    const join = getManyToManyJoinInfo(config.parentScope, config.relationInfo);
    this.targetPkField = join.targetPkField;
    this.sourcePkField = join.sourcePkField;
    this.sourceFieldName = join.sourceFieldName;
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
    this.creates =
      kind === "create" || kind === "createMany"
        ? (config.creates ?? []).map((create, index) =>
            this.buildCreateSlot(scope, create, index)
          )
        : [];
    this.adopts =
      kind === "connectOrCreate"
        ? (config.adopts ?? []).map((item, index) =>
            this.buildAdoptSlot(scope, item, index)
          )
        : [];
    this.upserts =
      kind === "upsert"
        ? (config.upserts ?? []).map((item, index) =>
            this.buildUpsertSlot(scope, item, index)
          )
        : [];
    this.setClearId =
      kind === "set" ? scope.allocate(`${config.childName}.set.clear`) : "";
    this.setInsertId =
      kind === "set" ? scope.allocate(`${config.childName}.set.insert`) : "";
  }

  planning(scope: StepScope): readonly StatementStep[] {
    const steps: StatementStep[] = [];
    for (const target of this.targets) {
      steps.push(target.probe);
      // Depth (T3b-2): the located update target's own child Parts plan their probes
      // here, one level deeper — the unconditional planning superset (ATOM §3
      // technique 2), identical to the root and the child-held recursion.
      for (const child of target.childParts)
        steps.push(...child.planning(scope));
    }
    for (const bulk of this.bulks) steps.push(bulk.read);
    for (const adopt of this.adopts) {
      steps.push(adopt.probe);
      // E2-U2: the create arm's child Parts plan their probes here, UNCONDITIONALLY —
      // the same widened superset every other arm uses (ATOM §3 technique 2). Which
      // branch this slot takes is a compile-time decision made from `adopt.probe`'s
      // rows, and planning runs before that decision exists.
      // E4-U3: a DELEGATED create arm plans its whole subtree here for the same reason.
      if (adopt.delegated) steps.push(...adopt.delegated.planning(scope));
      for (const child of adopt.childParts)
        steps.push(...child.planning(scope));
    }
    for (const create of this.creates) {
      // X1c: a delegated fresh-create target plans its whole `CreateOperation` subtree
      // (its before-parent writes / generated-PK probes) one level deeper.
      if (create.delegated) steps.push(...create.delegated.planning(scope));
      for (const child of create.childParts)
        steps.push(...child.planning(scope));
    }
    for (const upsert of this.upserts) {
      // E5-U1: a fresh parent has no membership to read, so the slot carries only the
      // global probe and the three-way is decided from it alone.
      if (upsert.membershipProbe) steps.push(upsert.membershipProbe);
      steps.push(upsert.globalProbe);
      // Both arms' child Parts plan unconditionally (a superset); `compile` emits
      // only the taken arm's writes (technique 2), exactly as the arm decision itself.
      if (upsert.createDelegated) {
        steps.push(...upsert.createDelegated.planning(scope));
      }
      for (const child of upsert.createChildParts) {
        steps.push(...child.planning(scope));
      }
      for (const child of upsert.updateChildParts) {
        steps.push(...child.planning(scope));
      }
    }
    return steps;
  }

  compile(scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
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
        return this.compileUpdate(scope, known);
      case "updateMany":
        return this.compileUpdateMany(parent);
      case "create":
      case "createMany":
        // N3-U1: `createMany` IS `create` through the junction — the same per-row
        // child INSERT + join row — plus the per-row duplicate skip its INSERT
        // carries (see {@link RelationJunctionConfig.skipDuplicates}).
        return this.compileCreate(scope, parent, known);
      case "connectOrCreate":
        return this.compileConnectOrCreate(scope, parent, known);
      case "upsert":
        return this.config.freshParent
          ? this.compileFreshUpsert(scope, parent, known)
          : this.compileUpsert(scope, parent, known);
      default: {
        const exhaustive: never = this.config.kind;
        throw new QueryEngineError(
          `query-engine-v2 junction part has no compile for '${exhaustive}'.`
        );
      }
    }
  }

  // connect — probe the targets globally, then INSERT the idempotent join rows.
  //
  // P4 — ONE `junctionInsertMany` for the whole list, the consolidated form the
  // `set` arm below already uses. `buildJunctionInsert` IS `buildJunctionInsertMany`
  // over a one-element list, so the duplicate skip that makes `connect` idempotent
  // is the same clause; nothing about the statement changes except how many target
  // tuples it carries. The target PROBES stay per target: their captured primary
  // keys are what the split-witness guards pair with their own selector, and a
  // grouped probe cannot hand that pairing back without comparing a decoded column
  // value against an input value.
  private compileConnect(
    parent: unknown,
    known: PlanningKnown
  ): readonly OperationStep[] {
    const guards: OperationStep[] = [];
    const targetPks: unknown[] = [];
    for (const target of this.targets) {
      const targetPk = this.requireTarget(target, known, "connect");
      targetPks.push(targetPk);
      if (!this.config.txMode) {
        guards.push(this.targetPresenceGuard(target, "connect", targetPk));
      }
    }
    if (targetPks.length === 0) return guards;
    return [
      ...guards,
      // The first slot's write id, because this statement replaces exactly the
      // writes those slots used to emit one at a time.
      this.junctionWrite(this.targets[0]!.writeId, "junctionInsertMany", {
        parentValue: parent,
        targetValues: targetPks,
      }),
    ];
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
      const targetPk = this.requireTarget(target, known, "set");
      targetPks.push(targetPk);
      if (!this.config.txMode) {
        guards.push(this.targetPresenceGuard(target, "set", targetPk));
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
    known: PlanningKnown
  ): readonly OperationStep[] {
    const guards: OperationStep[] = [];
    const writes: OperationStep[] = [];
    for (const bulk of this.bulks) {
      const targetPks = this.connectedSet(bulk, known);
      if (!this.config.txMode) {
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
    scope: StepScope,
    known: PlanningKnown
  ): readonly OperationStep[] {
    const guards: OperationStep[] = [];
    const writes: OperationStep[] = [];
    const data = this.config.data ?? [];
    for (let index = 0; index < this.targets.length; index += 1) {
      const target = this.targets[index]!;
      const targetPk = this.requireTarget(target, known, "update");
      if (!this.config.txMode) {
        guards.push(
          this.connectedPresenceGuard(
            target,
            this.membershipLiteral(known),
            "update",
            targetPk
          )
        );
      }
      // The self-UPDATE lands only when the payload carries scalar assignments; a
      // relation-only nested update (`data: { tags: { create } }`) writes no target
      // row, only its child Parts (mechanism 1). Membership is still validated by
      // `requireTarget`/the presence guard above.
      const scalar = data[index] ?? {};
      if (Object.keys(scalar).length > 0) {
        writes.push(
          this.childUpdate(
            target.writeId,
            { [this.targetPkField]: targetPk },
            scalar
          )
        );
      }
      for (const child of target.childParts) {
        writes.push(...child.compile(scope, known));
      }
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
          this.config.relationInfo,
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
    known: PlanningKnown
  ): readonly OperationStep[] {
    const steps: OperationStep[] = [];
    for (const slot of this.creates) {
      if (slot.delegated) {
        // X1c: the fresh target's create delegates to `CreateOperation` (a parent-held
        // to-one folds into its OWN INSERT). The subtree — its before-parent writes then
        // the target INSERT — runs FIRST so the target exists before the join row.
        steps.push(...slot.delegated.compile(scope, known));
        steps.push(
          this.junctionWrite(slot.joinId, "junctionInsert", {
            parentValue: parent,
            targetValue: slot.createPk,
          })
        );
        continue;
      }
      steps.push(
        this.childInsert(
          slot.childId,
          slot.create,
          undefined,
          slot.generatedField
        )
      );
      steps.push(
        this.junctionWrite(slot.joinId, "junctionInsert", {
          parentValue: parent,
          targetValue: slot.createPk,
        })
      );
      // Mechanism 2: the fresh target's own relations fold one level deeper against
      // its explicit literal PK, emitted AFTER its INSERT + join (the deeper FK edges
      // reference the now-existing target). Fresh-parent elision (ATOM §4): no
      // pre-existing membership, so a correlated read below vanishes to its
      // uncorrelated part — the child builders already produce unconditional writes.
      for (const child of slot.childParts) {
        steps.push(...child.compile(scope, known));
      }
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
    known: PlanningKnown
  ): readonly OperationStep[] {
    const steps: OperationStep[] = [];
    // Targets an earlier array item already created in THIS operation. V1
    // processes the array sequentially (branch ledger: "merge input N before
    // deciding input N+1"), so a duplicate target adopts the just-created row
    // instead of re-creating it. V2 decides that at compile from the fixed order.
    // The ledger maps the target's identity key (its literal create PK, or — for
    // a DB-generated PK — its unique selector) to the join value the earlier
    // item produced (a literal, or the earlier INSERT's backward Ref).
    const created = new Map<string, unknown>();
    for (const slot of this.adopts) {
      const rows = known[planningKey(slot.probeId, "rows")];
      const found = Array.isArray(rows) && rows.length > 0;
      if (found) {
        const capturedPk = this.pkOf(rows[0]);
        if (!this.config.txMode) {
          steps.push(this.adoptFoundGuard(slot, capturedPk));
        }
        steps.push(this.joinInsert(slot.joinId, parent, capturedPk));
        continue;
      }
      const key = adoptDedupKey(slot);
      if (created.has(key)) {
        // Created by an earlier same-target item — adopt (the join is idempotent).
        // The earlier item's INSERT already ran this create payload, its child Parts
        // included, so THIS item's children are not emitted: first create wins, whole.
        steps.push(this.joinInsert(slot.joinId, parent, created.get(key)));
        continue;
      }
      created.set(key, slot.createPk);
      if (slot.delegated) {
        // E4-U3: the whole create arm is a SUBTREE. It runs FIRST (its before-parent
        // writes, then the target INSERT that produces the identity), and the join row
        // references what that INSERT made — never this slot's own `childInsert`, which
        // is not emitted here at all. The arm's missing-premise `racePin` rides the
        // subtree's root INSERT, so the delegation costs the arm no race protection.
        steps.push(...slot.delegated.compile(scope, known));
        steps.push(this.joinInsert(slot.joinId, parent, slot.createPk));
        continue;
      }
      steps.push(
        this.childInsert(
          slot.childId,
          slot.create,
          slot.where,
          slot.generatedField
        ),
        this.joinInsert(slot.joinId, parent, slot.createPk)
      );
      // E2-U2 (mechanism 2): the fresh target's own relations, correlated to its
      // explicit literal PK and emitted AFTER its INSERT + join — the branch that made
      // the row. The two ADOPT branches above skip them for the same reason they skip
      // the INSERT: the row was already there, so this arm's create payload, relations
      // and all, is not what describes it (Prisma's connectOrCreate semantics).
      // Fresh-parent elision (ATOM §4): no pre-existing membership below a row this
      // statement just made, so the child builders' writes are unconditional.
      for (const child of slot.childParts) {
        steps.push(...child.compile(scope, known));
      }
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
    known: PlanningKnown
  ): readonly OperationStep[] {
    const steps: OperationStep[] = [];
    const emitChildren = (parts: readonly Part[]) => {
      for (const child of parts) steps.push(...child.compile(scope, known));
    };
    // NO same-operation dedup ledger here, unlike `compileConnectOrCreate`. The two
    // kinds differ in what a second array item MEANS. `connectOrCreate` says "this
    // target, adopted or made", so a second item naming the same target is satisfied
    // by the first item's row and adopts it. `upsert` says "the row MY `where` names",
    // and the own-write preflight (ATOM §4) rejects any item whose selector could name
    // a row an earlier item wrote — so every item that reaches here selects a row no
    // earlier item created. A ledger keyed on the create arms would therefore only
    // ever fire on items whose SELECTORS are provably disjoint, and would apply this
    // item's update to a row it never named: the wrong-row doctrine's exact failure.
    // See the N3-U2 -> N7-U-C record in `tests/query-engine-v2/route-inventory.test.ts`.
    for (const slot of this.upserts) {
      const memberRows = known[planningKey(slot.membershipProbeId, "rows")];
      if (Array.isArray(memberRows) && memberRows.length > 0) {
        const memberPk = this.pkOf(memberRows[0]);
        if (!this.config.txMode) {
          steps.push(
            this.upsertMemberGuard(
              slot,
              this.membershipLiteral(known),
              memberPk
            )
          );
        }
        // Update arm (a scalar SET only when non-empty; a relation-only update arm
        // writes just its child Parts — mechanism 1 reused at the arm level).
        if (Object.keys(slot.update).length > 0) {
          steps.push(
            this.childUpdate(
              slot.updateId,
              { [this.targetPkField]: memberPk },
              slot.update
            )
          );
        }
        emitChildren(slot.updateChildParts);
        continue;
      }
      const globalRows = known[planningKey(slot.globalProbeId, "rows")];
      if (Array.isArray(globalRows) && globalRows.length > 0) {
        // Exists globally but is not a member of this parent — the correlated
        // upsert cannot adopt a foreign row: V1's verbatim V7001 (ATOM §4).
        throw new NestedWriteError(
          upsertTargetNotFoundForParent(this.config.relationName),
          this.config.relationName
        );
      }
      steps.push(...this.upsertCreateArm(scope, slot, parent, known));
    }
    return steps;
  }

  /**
   * E5-U1 — the m2m `upsert` under a parent this operation is MAKING (the create root,
   * and any fresh target below it).
   *
   * The correlated three-way above has no third branch here. Its middle branch —
   * "exists globally, but is not a member of THIS parent" — is the only branch an
   * existing row can take when the parent is fresh, so keeping the V7001 would refuse
   * every existing target: the shape would be spellable and never satisfiable. The
   * parse boundary already documents the semantics this takes instead (a deliberate
   * Prisma superset, `src/validation/relations/create.ts`): GLOBAL LOOKUP, then
   * ADOPT-AND-UPDATE.
   *
   * So the donor is the ADOPT slot ({@link compileConnectOrCreate}), not the member arm
   * — and deliberately not the member arm, whose found branch writes NO join row (a
   * member already has one) and skips an empty UPDATE. Reused verbatim, that arm would
   * make this a silent no-op: the adopt, which is the whole point of the shape, would
   * never be written. Here the join row is written on BOTH branches, and an empty or
   * relation-only update payload still adopts.
   *
   * No same-operation dedup ledger, for `compileUpsert`'s reason (an `upsert` item names
   * the row ITS `where` names) — and the own-write preflight is stricter still at a
   * create root: it rejects ANY second `upsert` item on one many-to-many relation, and
   * an `upsert` beside a `connectOrCreate`, before this Part is built (measured; pinned
   * in `create-junction-upsert-behavior.ts`).
   */
  private compileFreshUpsert(
    scope: StepScope,
    parent: unknown,
    known: PlanningKnown
  ): readonly OperationStep[] {
    const steps: OperationStep[] = [];
    for (const slot of this.upserts) {
      const globalRows = known[planningKey(slot.globalProbeId, "rows")];
      if (!(Array.isArray(globalRows) && globalRows.length > 0)) {
        steps.push(...this.upsertCreateArm(scope, slot, parent, known));
        continue;
      }
      const foundPk = this.pkOf(globalRows[0]);
      if (!this.config.txMode) {
        // The adopt family's found premise: the row the probe locked is STILL the one
        // the selector names (split-witness correlation), pinned `raceable: false` and
        // worded for THIS operation ({@link adoptFoundGuard}).
        steps.push(this.adoptFoundGuard(slot, foundPk));
      }
      if (Object.keys(slot.update).length > 0) {
        steps.push(
          this.childUpdate(
            slot.updateId,
            { [this.targetPkField]: foundPk },
            slot.update
          )
        );
      }
      for (const child of slot.updateChildParts) {
        steps.push(...child.compile(scope, known));
      }
      // ALWAYS, and last: the membership add is what the found branch is FOR. The join
      // row is idempotent (junction-PK skip), so a target that somehow already belonged
      // to this fresh parent — it cannot — would still be one row.
      steps.push(this.joinInsert(slot.joinId, parent, foundPk));
    }
    return steps;
  }

  /** The upsert create arm — INSERT the target (or run its delegated subtree), then the
   *  join row, then the fresh target's own relations. One home, because the correlated
   *  three-way and the fresh-parent two-way take the same arm when nothing was found. */
  private upsertCreateArm(
    scope: StepScope,
    slot: UpsertSlot,
    parent: unknown,
    known: PlanningKnown
  ): readonly OperationStep[] {
    if (slot.createDelegated) {
      // X1c: the fresh create-arm target delegates its whole create to
      // `CreateOperation` (a parent-held to-one folds into its OWN INSERT); the
      // subtree runs BEFORE the join so the target exists first.
      return [
        ...slot.createDelegated.compile(scope, known),
        this.joinInsert(slot.joinId, parent, slot.createPk),
      ];
    }
    const steps: OperationStep[] = [
      this.childInsert(
        slot.childId,
        slot.create,
        slot.where,
        slot.generatedField
      ),
      this.joinInsert(slot.joinId, parent, slot.createPk),
    ];
    // Create arm (mechanism 2): the fresh target's relations, emitted after its
    // INSERT + join, correlated to its explicit literal PK.
    for (const child of slot.createChildParts) {
      steps.push(...child.compile(scope, known));
    }
    return steps;
  }

  // -------------------------------------------------------------------------
  // Slot construction (all step ids scope-allocated once, at construction).
  // -------------------------------------------------------------------------
  private buildTargetSlot(
    scope: StepScope,
    where: Record<string, unknown>,
    index: number
  ): TargetSlot {
    const { kind, childName } = this.config;
    const connected = kind === "delete" || kind === "update";
    const probeId =
      this.config.targetProbeIds?.[index] ??
      scope.allocate(`${childName}.find`);
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
    // N4-U1: a slot whose deeper edges `planned`-read this probe must publish the
    // captured target primary key as a `firstRowField`, and — because that extraction
    // is eager and would otherwise abort with an internal wording — carry this
    // family's own not-a-member message as the read's postcondition. Byte-identical to
    // `requireTarget`'s compile-time throw, moved one phase earlier (still before any
    // write, on both substrates).
    const publishesPk = this.config.targetPublishesPk?.[index] === true;
    const probe: ReadStep = {
      id: probeId,
      kind: "read",
      statement,
      outputs: publishesPk
        ? {
            rows: { kind: "rows" },
            [this.targetPkField]: {
              kind: "firstRowField",
              field: this.targetPkField,
            },
          }
        : { rows: { kind: "rows" } },
      ...(publishesPk
        ? {
            expects: exactlyOneRow(
              nestedWriteFailure(
                relationTargetNotFound(this.config.relationInfo, "update"),
                this.config.relationName,
                false
              )
            ),
          }
        : {}),
    };
    return {
      where,
      probeId,
      guardId: scope.allocate(`${childName}.guard.exists`),
      writeId: scope.allocate(`${childName}.${kind}`),
      childId: scope.allocate(`${childName}.delete.child`),
      probe,
      childParts:
        kind === "update" ? (this.config.updateChildParts?.[index] ?? []) : [],
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

  private buildCreateSlot(
    scope: StepScope,
    create: Record<string, unknown>,
    index: number
  ): CreateSlot {
    const { childName } = this.config;
    const childId = scope.allocate(`${childName}.create`);
    const resolved =
      this.config.createIdentity?.[index] ??
      this.resolveCreatePk(create, childId);
    return {
      create,
      createPk: resolved.pk,
      ...(resolved.generatedField
        ? { generatedField: resolved.generatedField }
        : {}),
      childId,
      joinId: scope.allocate(`${childName}.junction.insert`),
      childParts: this.config.createChildParts?.[index] ?? [],
      delegated: this.config.createDelegated?.[index],
    };
  }

  private buildAdoptSlot(
    scope: StepScope,
    item: { where: Record<string, unknown>; create: Record<string, unknown> },
    index: number
  ): AdoptSlot {
    const { childName } = this.config;
    const probeId = scope.allocate(`${childName}.find`);
    const childId = scope.allocate(`${childName}.create`);
    const resolved =
      this.config.adoptIdentity?.[index] ??
      this.resolveCreatePk(item.create, childId);
    return {
      where: item.where,
      create: item.create,
      createPk: resolved.pk,
      ...(resolved.generatedField
        ? { generatedField: resolved.generatedField }
        : {}),
      probeId,
      guardId: scope.allocate(`${childName}.guard.exists`),
      childId,
      joinId: scope.allocate(`${childName}.junction.insert`),
      childParts: this.config.adoptCreateChildParts?.[index] ?? [],
      delegated: this.config.adoptCreateDelegated?.[index],
      // Global lookup-and-adopt: an uncorrelated probe by the child unique.
      probe: {
        id: probeId,
        kind: "read",
        statement: buildFindUnique(this.childScope, {
          where: item.where,
          select: { [this.targetPkField]: true },
          forUpdate: this.config.txMode,
        }),
        outputs: { rows: { kind: "rows" } },
      },
    };
  }

  private buildUpsertSlot(
    scope: StepScope,
    item: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    },
    index: number
  ): UpsertSlot {
    const { childName } = this.config;
    // E6.1 — the builder pre-allocates both ids when the arm addresses the key one of
    // them captures; the fallback keeps every other caller's ids unchanged.
    const allocated = this.config.upsertProbeIds?.[index];
    const membershipProbeId =
      allocated?.member ?? scope.allocate(`${childName}.member`);
    const globalProbeId =
      allocated?.global ?? scope.allocate(`${childName}.find`);
    const childId = scope.allocate(`${childName}.create`);
    // N7-U-C: ONE identity resolver for every junction create arm. The upsert arm
    // used to have its own, because its dedup ledger needed a compile-time `where`
    // for the just-created row on top of the join value; with the ledger deleted the
    // arm needs exactly what `create` / `connectOrCreate` / `createMany` need — the
    // join row's value — so it asks the same question in the same place.
    const identity =
      this.config.upsertCreateIdentity?.[index] ??
      this.resolveCreatePk(item.create, childId);
    return {
      where: item.where,
      create: item.create,
      createPk: identity.pk,
      ...(identity.generatedField
        ? { generatedField: identity.generatedField }
        : {}),
      update: item.update,
      membershipProbeId,
      globalProbeId,
      guardId: scope.allocate(`${childName}.guard.member`),
      childId,
      updateId: scope.allocate(`${childName}.update`),
      joinId: scope.allocate(`${childName}.junction.insert`),
      createChildParts: this.config.upsertCreateChildParts?.[index] ?? [],
      updateChildParts: this.config.upsertUpdateChildParts?.[index] ?? [],
      createDelegated: this.config.upsertCreateDelegated?.[index],
      // Two widened probes (technique #2): whether the target is a member of this
      // parent (correlated by a SQL Ref) AND whether it exists globally. `compile`
      // decides member / exists-not-member / absent from both.
      //
      // E5-U1 — a FRESH parent builds only the global one. The membership read has no
      // question to ask (nothing can belong to a row this operation is making) and no
      // way to ask it (`parentRef` needs a `planned` or `literal` parent; a create root
      // with a DB-generated key supplies a `ref`).
      ...(this.config.freshParent
        ? {}
        : {
            membershipProbe: {
              id: membershipProbeId,
              kind: "read" as const,
              statement: this.membershipRead({
                parentValue: this.parentRef(),
                whereUnique: item.where,
                take: 1,
              }),
              outputs: this.upsertArmProbeOutputs(index, membershipProbeId),
            },
          }),
      globalProbe: {
        id: globalProbeId,
        kind: "read",
        statement: buildFindUnique(this.childScope, {
          where: item.where,
          select: { [this.targetPkField]: true },
          forUpdate: this.config.txMode,
        }),
        outputs: this.upsertArmProbeOutputs(index, globalProbeId),
      },
    };
  }

  /**
   * E6.1 — one upsert probe's outputs: always its rows, plus the captured target primary
   * key when THIS is the probe the update arm addresses
   * ({@link RelationJunctionConfig.upsertArmProbeIds}).
   *
   * `optional`, and that is the whole difference from {@link buildTargetSlot}'s
   * publication. A nested `update` that finds no member is a not-found, so its probe
   * carries the eager `exactlyOneRow` postcondition; an upsert that finds nothing is
   * taking its CREATE arm, and on that decision no update-arm child compiles, so the
   * value has no consumer. A REQUIRED output here would abort the planning pass on the
   * arm that is meant to be taken — measured, before this wire existed, as the delegated
   * target's own `Cannot update relation … for this parent` on a create-arm upsert.
   */
  private upsertArmProbeOutputs(
    index: number,
    probeId: string
  ): ReadStep["outputs"] {
    if (this.config.upsertArmProbeIds?.[index] !== probeId) {
      return { rows: { kind: "rows" } };
    }
    return {
      rows: { kind: "rows" },
      [this.targetPkField]: {
        kind: "firstRowField",
        field: this.targetPkField,
        optional: true,
      },
    };
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
    );
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
        this.config.relationInfo,
        operation,
        args
      ),
      outputs: {},
    };
  }

  /** UPDATE the target addressed by a COMPILE-TIME `where` — the located member's
   *  captured primary key, or (N3-U2, a duplicate item under a generated PK) the
   *  create-data unique that names the row this operation's own INSERT wrote. Never
   *  a `Ref`: the identity is always a literal by construction. */
  private childUpdate(
    id: string,
    where: Record<string, unknown>,
    data: Record<string, unknown>
  ): WriteStep {
    return {
      id,
      kind: "write",
      statement: buildUpdate(this.childScope, {
        where,
        data,
        select: { [this.targetPkField]: true },
      }),
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

  /** INSERT the fresh child row. A `where` present (connectOrCreate/upsert create
   *  arm) means the missing premise is enforced by the child unique constraint —
   *  its violation is the raceable signal (racePin), never a notExists guard.
   *  A `generatedField` (DB-generated target PK, {@link resolveCreatePk}) makes
   *  the INSERT produce the identity the join row references: `firstRowField`
   *  via `INSERT … RETURNING` on a returning driver in tx mode, the driver
   *  `insertId` otherwise (scratch-threaded in batch mode by the executor). */
  private childInsert(
    id: string,
    create: Record<string, unknown>,
    where?: Record<string, unknown>,
    generatedField?: string
  ): WriteStep {
    const returningTx =
      this.config.txMode &&
      this.config.engine.adapter.capabilities.supportsReturning;
    // N3-U1 — a `createMany` row's INSERT carries the dialect's duplicate skip. It is
    // built by the SAME `buildCreateMany` the root and child-held `createMany` families
    // use, so the per-dialect split is decided in one place: dialects whose skip IS a
    // SQL leaf get `ON CONFLICT DO NOTHING` / `INSERT OR IGNORE` in the statement, and
    // a `recoverableUniqueError` dialect (MySQL) gets a plain INSERT plus the
    // savepoint-wrapped executor effect below. `buildCreateMany` also runs V1's
    // portability guard (`assertPortableCreateManySkip`) on the row — the sole check
    // for the inexpressible default-only-row shape, raised at compile, before any write.
    const skipDuplicates = this.config.skipDuplicates === true;
    const recoverUnique =
      skipDuplicates &&
      this.config.engine.adapter.mutations.skipDuplicatesStrategy ===
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

  /**
   * The created child's primary key for the join row (create / connectOrCreate
   * slots). A compile-time literal the create data carries is used as-is. When
   * the target PK is a DB-generated auto-increment the data omits, the child
   * INSERT *produces* it: the slot's `childId` step declares an `id` output
   * (`firstRowField` via `INSERT … RETURNING` on a returning driver in tx mode,
   * the driver `insertId` otherwise — batch mode threads it through the
   * adapter's insertId scratch store, exactly as the create root's generated
   * identity), and the join row references it by a backward `Ref` wrapped in
   * the destination cast ({@link referenceSql}). Any other absent PK (an
   * explicit `null`, a non-increment generated PK) keeps the typed refusal.
   */
  private resolveCreatePk(
    create: Record<string, unknown>,
    childId: string
  ): { pk: unknown; generatedField?: string } {
    const pk = create[this.targetPkField];
    if (pk !== undefined && pk !== null) return { pk };
    const scalar = this.childScope.model["~"].state.scalars[this.targetPkField];
    if (pk === undefined && scalar?.["~"].state.autoGenerate === "increment") {
      // N3-U1 — the produced identity and a skip LEAF are mutually exclusive, and this
      // is the one place that can say so. A skipped INSERT writes no row, so it produces
      // no identity: PostgreSQL's `ON CONFLICT DO NOTHING … RETURNING` yields zero rows,
      // while SQLite's `INSERT OR IGNORE` and MySQL's rolled-back savepoint leave
      // `insertId` at the PREVIOUS insert's value — a live key belonging to another row.
      // The join row would then link the parent to that row, silently, with no constraint
      // able to notice (the wrong-row doctrine). Refused, never guessed.
      //
      // E6.8 NARROWED WHAT REACHES HERE. The shape is no longer refused as a whole: a
      // target with no unique besides this generated key drops the flag (nothing to
      // conflict on), and rows spelling exactly one complete unique are rewritten as
      // `connectOrCreate` adopts before construction — see
      // {@link skipDuplicatesDisposition}. What still arrives is the case that genuinely
      // has no identity: no single unique names the row a skip would skip ON, so no probe
      // can find it. Same sentence, now for that case alone.
      if (this.config.skipDuplicates) {
        throw new UnsupportedOperationError(
          `query-engine-v2 createMany-through-junction for relation '${this.config.relationName}' cannot use 'skipDuplicates' when the target primary key '${this.targetPkField}' is database-generated: a skipped row produces no identity for its join row. Supply '${this.targetPkField}' in the createMany data, or drop 'skipDuplicates'.`
        );
      }
      return {
        pk: referenceSql(
          this.config.engine,
          this.childScope.model,
          this.targetPkField,
          ref(childId, "id")
        ),
        generatedField: this.targetPkField,
      };
    }
    // Unreachable by construction (N7-U-A, the X1c disposition). Re-measured across every
    // way a junction target's primary key can be spelled: a PK carrying a default (the
    // `s.string().id()` ulid, and — the case the earlier probe had NOT constructed — a
    // `s.dateTime().id().now()` whose `autoGenerate` is `now`) is FILLED by the parse
    // boundary, so `pk` is defined; a PK with no default (`s.int().id()`,
    // `s.bigInt().id()`) is REQUIRED, so the boundary answers `ValidationError: Missing
    // required field: id`; an explicit `null` fails the non-nullable PK schema
    // (`ValidationError: Expected integer`); and `increment` takes the produced-identity
    // branch above. No payload arrives with an absent or null target PK.
    throw new QueryEngineError(
      `query-engine-v2 internal: the create-through-junction arm for relation '${this.config.relationName}' reached identity resolution with no value for the target primary key '${this.targetPkField}'.`
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
    capturedPk: unknown
  ): GuardStep {
    return presenceGuard(
      slot.guardId,
      this.capturedSelectorRead(slot.where, capturedPk),
      nestedWriteFailure(
        nestedReplacement(
          this.config.kind === "upsert" ? "upsert" : "connectOrCreate"
        ),
        this.config.relationName,
        false
      )
    );
  }

  /**
   * `SELECT pk FROM child WHERE <selector> AND pk = <capturedPk>` (limit 1): the
   * row the planning probe locked must STILL be the one the user selector names.
   * This is V1's captured-PK+selector correlation lowered to SQL — the guard fails
   * closed when a split-witness moves the selector to a replacement row.
   *
   * N6-U1: "the user selector" is the WHOLE extended selector, filter half included
   * ({@link uniqueSelectorConjuncts}). The membership read that located the row
   * already compiles both halves (`buildWhereUnique` in the membership read), so
   * anything less here would re-assert a weaker premise than the one the probe made.
   */
  private capturedSelectorRead(
    where: Record<string, unknown>,
    capturedPk: unknown
  ) {
    return buildFind(
      this.childScope,
      {
        where: {
          AND: [
            ...uniqueSelectorConjuncts(this.childScope, where),
            { [this.targetPkField]: { equals: capturedPk } },
          ],
        },
        select: { [this.targetPkField]: true },
      },
      { limit: 1 }
    );
  }

  /** upsert member premise (batch): the target is still a member of this parent
   *  AND still the captured PK (split-witness correlation). Existing-row premise,
   *  pinned raceable:false, V1's replacement wording. */
  private upsertMemberGuard(
    slot: UpsertSlot,
    parent: unknown,
    capturedPk: unknown
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
          take: 1,
        }),
      },
      failure: nestedWriteFailure(
        nestedReplacement("upsert"),
        this.config.relationName,
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
    op: "connect" | "set",
    capturedPk: unknown
  ): GuardStep {
    return presenceGuard(
      target.guardId,
      // Split-witness correlation: the captured target must still match the
      // selector, so `set`/`connect` cannot adopt a replacement that inherited it.
      this.capturedSelectorRead(target.where, capturedPk),
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
    op: "delete" | "update",
    capturedPk: unknown
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
   * E2-U3: this is the READ side, so it takes {@link
   * RelationJunctionConfig.membershipReadSource} when the two sides differ — the one
   * situation where the key existing join rows carry is not the key new ones must.
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
      this.config.relationName,
      "junction",
      (reference) =>
        referenceSql(
          this.config.engine,
          this.config.parentScope.model,
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
      this.config.relationName,
      "junction"
    );
  }

  private parentWriteMember(): ForeignKeyMember {
    return {
      foreignField: this.sourceFieldName,
      referencedField: this.sourcePkField,
      writeSource: this.config.parentId,
    };
  }

  private membershipMember(): CorrelatedForeignKeyMember {
    const readSource = this.config.membershipReadSource ?? this.config.parentId;
    return {
      ...this.parentWriteMember(),
      readSource: planningSourceFromFinal(
        readSource,
        this.config.relationName,
        "junction"
      ),
      writeSource: this.config.parentId,
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
// carries or — for a DB-generated auto-increment target — the child INSERT's
// produced identity, referenced backward by the join row (resolveCreatePk).
// The upsert create arm still requires the literal (requireCreatePk).
// ---------------------------------------------------------------------------

export function buildJunctionParts(input: {
  scope: StepScope;
  engine: QueryEngine;
  parentScope: QueryScope;
  relationName: string;
  relationInfo: RelationInfo;
  program: RelationMutationProgram;
  parentId: FinalReferenceSource;
  /** E2-U3: the membership-READ parent value when it differs from the written one —
   *  see {@link RelationJunctionConfig.membershipReadSource}. */
  membershipReadSource?: FinalReferenceSource;
  /** E5-U1 — see {@link RelationJunctionConfig.freshParent}. Threaded by the CREATE
   *  root, the one caller whose parent row does not exist yet. */
  freshParent?: boolean;
  txMode: boolean;
  /** T3b-2: the depth-recursive child-Part builder (mechanism 2 / mechanism 1
   *  reuse). REQUIRED — every `buildJunctionParts` caller threads it: the root
   *  (UpdateOperation.ts:977, CreateOperation.ts:653) and depth
   *  (nested-target-parts.ts:164). A relation-carrying create/update/upsert target
   *  folds those relations one level deeper through it; the type makes threading it
   *  mandatory so no caller can silently fall back to a scalar-only boundary. */
  nestedBuilder: NestedChildBuilder;
}): RelationJunctionPart[] {
  const {
    scope,
    engine,
    parentScope,
    relationName,
    relationInfo,
    program,
    parentId,
    txMode,
  } = input;
  const childName = getStepModelName(relationInfo.targetModel, relationName);
  const childScope = createQueryScope(engine.adapter, relationInfo.targetModel);
  const targetPkField = getManyToManyJoinInfo(
    parentScope,
    relationInfo
  ).targetPkField;
  const base = {
    engine,
    parentScope,
    relationName,
    relationInfo,
    childName,
    parentId,
    membershipReadSource: input.membershipReadSource,
    freshParent: input.freshParent,
    txMode,
  } as const;
  // T3b-2 — fold a create/update/upsert-arm target payload into (scalar SET, deeper
  // child Parts). A scalar-only payload keeps the pre-T3b-2 behavior (empty child
  // Parts); a relation-carrying one folds those relations one level deeper against
  // the target's literal PK through the shared `nestedBuilder`, which every caller
  // threads — its non-optional type (interface note above) makes it mandatory, so no
  // caller can silently fall back to a scalar-only boundary.
  const foldTarget = (
    data: Record<string, unknown>,
    resolveParentId: () => FinalReferenceSource
  ): { scalar: Record<string, unknown>; childParts: readonly Part[] } => {
    const { scalarData, relations } = buildParsedRelationPrograms(
      childScope,
      data
    );
    if (Object.keys(relations).length === 0) {
      return { scalar: scalarData, childParts: [] };
    }
    return {
      scalar: scalarData,
      childParts: input.nestedBuilder(
        childScope,
        resolveParentId(),
        relations,
        txMode
      ),
    };
  };
  /**
   * Where a relation-carrying update/upsert target's own primary key — the value the
   * deeper foreign keys reference — comes from.
   *
   * N4-U1: for a nested `update` the answer is no longer "only the `where`". The
   * junction's target slot ALREADY locates the row: its membership read selects the
   * target primary key and `requireTarget` spends it on the join-row write. So when
   * some OTHER unique names the target, the deeper edges take a `planned` source into
   * that same membership read — the row the slot ACTED ON — and only the `where`'s own
   * literal is skipped, not the capability.
   *
   * E6.1: the same is now true of the UPSERT arms, and the refusal that stood here is
   * gone. Its recorded justification was the created-earlier branch — an update arm
   * reached with the global probe having run BEFORE this operation's own INSERT, so no
   * row existed for a `planned` source to read. N7-U-C DELETED that branch: the junction
   * upsert keeps no same-operation dedup ledger, because an `upsert` item names the row
   * ITS `where` names and the own-write preflight rejects any item whose selector could
   * name a row an earlier item wrote (the argument is in {@link compileUpsert}). What was
   * left behind was a wiring gap and not a wall — the `update` kind pre-allocated its
   * probe ids and the upsert fold passed `undefined`. Every arm that reaches here acts on
   * a row ONE of its own probes located, so `probeId` is always a value.
   */
  const updateTargetParentId = (
    where: Record<string, unknown>,
    probeId: string
  ): FinalReferenceSource => {
    const entry = getWhereUniqueEntries(childScope, where).find(
      (candidate) => candidate.fieldName === targetPkField
    );
    if (entry !== undefined) return literalParentId(entry.value);
    return plannedParentId(probeId);
  };
  /**
   * E4-U3 — how a FRESH junction target and its own relations are written, in one
   * decision for every arm that makes a row (`create` / `createMany` /
   * `connectOrCreate` / the upsert create arm).
   *
   * Three shapes, and the difference between them is only where the target's identity
   * comes from:
   *
   *  1. **scalar-only** — the slot writes its own `childInsert` and the join row takes
   *     the literal PK, or the `Ref` that INSERT produces (`resolveCreatePk`).
   *     Untouched.
   *  2. **relations over a LITERAL PK** — mechanism 2: the deeper edges fold against
   *     that compile-time value through the shared `nestedBuilder`, emitted after the
   *     INSERT + join.
   *  3. **relations over a PRODUCED PK, or a payload that needs the whole-create
   *     delegation** — the arm becomes a create SUBTREE. Its root INSERT produces the
   *     identity, its own grandchildren `Ref` that identity (N4-U4, inside the
   *     subtree), and the JOIN ROW `Ref`s it too. This is the shape that used to be a
   *     refusal: the deeper edges needed a compile-time literal, and a produced key is
   *     a backward `Ref` — true of the fold, never true of the create root, which has
   *     threaded produced identities to its children since N4-U4.
   *
   * The `racePin` is what makes (3) legal on an arm with a missing premise. The subtree
   * REPLACES the arm's `childInsert`, and with it the pin that arm's premise is enforced
   * by (the Pin Rule: a unique constraint, never a notExists guard) — so the pin rides
   * the subtree's root INSERT instead, through {@link buildNestedTargetFreshCreatePart}.
   * E2 refused the delegation rather than make that trade silently; this is the wire it
   * named.
   */
  const freshTargetFold = (
    create: Record<string, unknown>,
    foldKind: string,
    racePin?: TargetConstraintPin
  ): {
    scalar: Record<string, unknown>;
    childParts: readonly Part[];
    delegated: Part | undefined;
    /** Set only when the subtree owns the INSERT: the join row's target value, and
     *  the generated-field marker the dedup ledger keys on. */
    identity: JunctionCreateIdentity | undefined;
  } => {
    const { scalarData, relations } = buildParsedRelationPrograms(
      childScope,
      create
    );
    const spelledPk = create[targetPkField];
    const pkIsLiteral = spelledPk !== undefined && spelledPk !== null;
    if (Object.keys(relations).length === 0) {
      return {
        scalar: scalarData,
        childParts: [],
        delegated: undefined,
        identity: undefined,
      };
    }
    if (pkIsLiteral && !targetNeedsFullUpdate(childScope, create)) {
      return {
        scalar: scalarData,
        childParts: input.nestedBuilder(
          childScope,
          literalParentId(spelledPk),
          relations,
          txMode
        ),
        delegated: undefined,
        identity: undefined,
      };
    }
    const subtree = buildNestedTargetFreshCreatePart({
      scope,
      engine,
      targetModel: relationInfo.targetModel,
      data: create,
      ...(racePin ? { racePin } : {}),
    });
    if (pkIsLiteral) {
      return {
        scalar: scalarData,
        childParts: [],
        delegated: subtree.part,
        identity: undefined,
      };
    }
    const produced = subtree.rootReferenced(targetPkField);
    if (produced === undefined) {
      // The subtree cannot name its own row either: the primary key is neither spelled,
      // nor generated by the INSERT, nor knowable from the create data (an `Sql`
      // operand, a non-increment generated key). The join row would reference a value
      // that does not exist, so the arm still refuses — the same sentence, now for the
      // one case that is genuinely without an identity rather than for every generated
      // key.
      throw new UnsupportedOperationError(
        `query-engine-v2 create-through-junction for relation '${relationName}' requires the target primary key '${targetPkField}' in the create data (${foldKind}).`
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
      scalar: scalarData,
      childParts: [],
      delegated: subtree.part,
      identity: {
        pk,
        ...(hasGeneratedIdentity ? { generatedField: targetPkField } : {}),
      },
    };
  };
  /**
   * E6.8 — what `skipDuplicates` MEANS on a junction `createMany` whose target primary
   * key the database makes.
   *
   * N3-U1 refused the pair outright, and its reason was sound for the mechanism it had:
   * the join row references the identity the child INSERT produced, and a skipped INSERT
   * produces none (`ON CONFLICT DO NOTHING … RETURNING` yields no row; `INSERT OR IGNORE`
   * and a rolled-back savepoint leave `insertId` on the PREVIOUS row — a live key
   * belonging to somebody else). What that argument establishes is that the SKIP LEAF has
   * no identity, not that the SHAPE has none.
   *
   * The maintainer's decision (recorded in expressible-shapes-plan.md, Risks item 3):
   * **adopt-equivalence defines skip for generated-key rows.** The pinned semantics of a
   * skip here is "the row that was already there stays untouched and is still linked to
   * this parent" (the note on the `createMany` factory case below) — and that is exactly
   * what `connectOrCreate` does, with an identity: probe by the unique, adopt the found
   * row's captured primary key for the join, or INSERT and reference what the INSERT made.
   * So two sub-shapes stop being refusals:
   *
   *  - **`vacuous`** — the target model declares NO unique constraint at all besides its
   *    own generated primary key, which no row spells: no `.unique()` scalar, no compound
   *    unique, no `.index(…, { unique: true })`. Nothing an INSERT of these rows can
   *    violate exists, so the flag cannot change a single outcome: it is dropped and the
   *    rows take the ordinary produced-identity create path. Decided from the SCHEMA, which
   *    is the whole of what this engine knows about constraints — a unique index created in
   *    the database behind the schema's back is outside that knowledge, and this decision
   *    (like the `push`ed DDL itself) is wrong about such a database. A model whose only
   *    declared unique is a PARTIAL index (`{ where }`) is NOT vacuous: it is counted like
   *    any other, so the flag survives and the refusal below still answers.
   *  - **`adopt`** — every row spells exactly ONE complete unique constraint a
   *    `whereUnique` can NAME. That constraint names the row a skip would have skipped ON,
   *    so the probe can find it and the arm becomes `connectOrCreate` verbatim: found →
   *    join to the probe's captured key; absent → INSERT (its missing premise enforced by
   *    that same constraint, racePin, never a guard) → join to the produced `Ref`; a
   *    duplicate WITHIN the payload adopts the earlier item's row through the
   *    first-create-wins ledger.
   *
   * **The authorized divergence.** On the `adopt` sub-shape a conflict on a DIFFERENT
   * unique than the probed one is no longer silently skipped — the INSERT meets that other
   * constraint and raises the typed unique violation. It is reachable exactly where a
   * constraint exists that no selector can name: a `.index(…, { unique: true })`, which the
   * database enforces and `whereUnique` cannot spell. That is the deliberate semantics
   * change the maintainer accepted ("the multi-unique failure mode deliberately changes
   * from silent skip to a typed unique violation"), and it is pinned as a test. It is never
   * a wrong row — the alternative it replaces was silence, not correctness.
   *
   * **What stays refused, re-proven.** A row spelling two or more complete NAMEABLE
   * uniques: no single probe names the row the constraint would have fired on, so the adopt
   * could join the parent to a row the skip never selected — the wrong-row doctrine. A row
   * spelling none of them (a compound unique with a NULL member is not "spelled": NULL is
   * distinct from NULL in a unique index, so the probe finds nothing where the constraint
   * also fires nothing — and a dialect that treated NULLs as equal would make the two
   * disagree). Those keep `resolveCreatePk`'s message, verbatim.
   *
   * Note the substrate: an adopt carries NO `onUniqueConflict` effect, so it does not
   * lower a savepoint into an atomic batch — it never meets the wall at
   * `OperationExecutor.compileToEntries` ("carries an onUniqueConflict skip effect that has
   * no atomic-batch lowering"). The wall is bypassed, not weakened; the `leaf` disposition
   * still hits it, and the batch witness still asserts it.
   */
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
  // X1c — a junction target whose data carries the parent-held to-one projection (or a
  // D4 edge) is not folded in place; its WHOLE target write delegates to the update /
  // create ROOT. An UPDATE target delegates to `UpdateOperation`, returned as an empty
  // scalar + the delegated Part in child Parts (the slot skips its empty self-UPDATE). A
  // CREATE target (a fresh row, its parent-held FK folded into its OWN INSERT — X1b's
  // fresh mechanism) delegates to `CreateOperation`, carried as `delegated` so the slot
  // skips its `childInsert`.
  //
  // E6.1 — the delegated target is addressed by the KEY THE SLOT'S PROBE CAPTURED, never
  // by the selector again. It used to hand `UpdateOperation` the same `where` the probe
  // had already spent: two locates, two chances to name a different row, while the join
  // row and the arm's guard address the probe's key. That is the wrong-row doctrine's own
  // failure — an identity comes from the row a step acted on — and on an upsert's CREATE
  // arm it was not even latent: the second locate found nothing and raised the target's
  // own not-found, aborting the arm that was meant to be taken (measured). The selector's
  // filters are not lost with it; the probe reads the WHOLE `where`, so they are enforced
  // once, where the row is chosen.
  const foldOrDelegateUpdate = (
    data: Record<string, unknown>,
    where: Record<string, unknown>,
    probeId: string,
    /** True for an UPSERT arm: an empty probe is the CREATE decision, so the delegated
     *  locate must not raise its own not-found on the arm that is not taken. */
    missingIsABranch: boolean
  ): {
    scalar: Record<string, unknown>;
    childParts: readonly Part[];
    usesLocatedPk: boolean;
  } => {
    if (!targetNeedsFullUpdate(childScope, data)) {
      let usesLocatedPk = false;
      const folded = foldTarget(data, () => {
        const source = updateTargetParentId(where, probeId);
        usesLocatedPk = isPlanningFieldSource(source);
        return source;
      });
      return { ...folded, usesLocatedPk };
    }
    return {
      scalar: {},
      usesLocatedPk: true,
      childParts: [
        buildNestedTargetUpdatePart({
          scope,
          engine,
          targetModel: relationInfo.targetModel,
          data,
          locate: {
            parentId: plannedParentId(probeId),
            childFields: [targetPkField],
            parentFields: [targetPkField],
            relationName,
            notFoundMessage: relationTargetNotFound(relationInfo, "update"),
          },
          ...(missingIsABranch ? { locateNotFoundOptional: true } : {}),
        }),
      ],
    };
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
            wheres: entry.targets,
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
            wheres: entry.target.targets,
          })
        );
        break;
      }
      case "set":
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "set",
            wheres: entry.targets,
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
            wheres: entry.target.targets,
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
        const wheres = entry.items.map((item) => {
          if (item.target.kind !== "unique") {
            throw new QueryEngineError(
              `query-engine-v2 internal: many-to-many update for relation '${relationName}' requires a unique target.`
            );
          }
          return item.target.where;
        });
        // T3b-2 mechanism 1 reuse: a relation-carrying update target folds its own
        // relations one level deeper against its located PK; a scalar-only target
        // keeps its empty child Parts (the pre-T3b-2 behavior). N4-U1: the target's
        // membership probe id is allocated HERE, before the fold, so a target named by
        // a non-primary-key unique can hand the deeper edges a `planned` read of it.
        const targetProbeIds = wheres.map(() =>
          scope.allocate(`${childName}.find`)
        );
        const folded = entry.items.map((item, index) =>
          // A nested `update` that finds no member is a not-found, not a branch.
          foldOrDelegateUpdate(
            item.data,
            wheres[index]!,
            targetProbeIds[index]!,
            false
          )
        );
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "update",
            wheres,
            targetProbeIds,
            targetPublishesPk: folded.map((f) => f.usesLocatedPk),
            data: folded.map((f) => f.scalar),
            updateChildParts: folded.map((f) => f.childParts),
          })
        );
        break;
      }
      case "updateMany": {
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "updateMany",
            filters: entry.items.map((item) => item.where ?? {}),
            data: entry.items.map((item) =>
              scalarOnly(childScope, item.data, relationName, entry.kind)
            ),
          })
        );
        break;
      }
      case "create": {
        // INSERT the fresh child, then the join row (V1's
        // `ManyToManyMemberships.create`). T3b-2 mechanism 2: deeper nested relations
        // in the create data fold one level deeper against the fresh target's
        // explicit literal PK, emitted after its INSERT + join (fresh-parent elision,
        // ATOM §4); a scalar-only create keeps its empty child Parts.
        const folded = entry.items.map((create) =>
          freshTargetFold(create, "create")
        );
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "create",
            creates: folded.map((f) => f.scalar),
            createChildParts: folded.map((f) => f.childParts),
            createDelegated: folded.map((f) => f.delegated),
            createIdentity: folded.map((f) => f.identity),
          })
        );
        break;
      }
      case "createMany": {
        // N3-U1 — `createMany` through a junction is `create` through a junction, per
        // row, plus the duplicate skip. No new mechanism: the same slot (child INSERT
        // then join row), the same produced-identity `Ref` when the target primary key
        // is DB-generated, the same one-level-deeper fold. The two differences are the
        // ones `createMany` names anywhere else: the data is SCALAR-ONLY (the relation
        // schema enforces it, so the fold below always yields empty child Parts), and
        // `skipDuplicates` rides each row's INSERT.
        //
        // SEMANTICS, pinned deliberately because Prisma has no M2M `createMany` to
        // match: `skipDuplicates` skips the CHILD ROW's insert. The JOIN ROW is a
        // different row — never itself a duplicate of what the data spells — and is
        // written for every item (idempotently, via the junction PK). So a skipped
        // item still links its parent to the row that was already there. The rejected
        // alternative (skip the join too) cannot be decided at compile without a probe,
        // and would make a duplicate item silently do NOTHING — unobservable to the
        // caller. Witnessed by `junction-create-many-behavior.ts`.
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
                adopts: rows.map((_, index) => ({
                  where: disposition.wheres[index]!,
                  create: armed[index]!.scalar,
                })),
                adoptCreateChildParts: armed.map((f) => f.childParts),
                adoptCreateDelegated: armed.map((f) => f.delegated),
                adoptIdentity: armed.map((f) => f.identity),
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
              creates: foldedMany.map((f) => f.scalar),
              createChildParts: foldedMany.map((f) => f.childParts),
              createDelegated: foldedMany.map((f) => f.delegated),
              createIdentity: foldedMany.map((f) => f.identity),
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
            adopts: items.map((item, index) => ({
              where: item.where,
              create: armed[index]!.scalar,
            })),
            adoptCreateChildParts: armed.map((f) => f.childParts),
            adoptCreateDelegated: armed.map((f) => f.delegated),
            adoptIdentity: armed.map((f) => f.identity),
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
        const foldedCreates = items.map((item) =>
          freshTargetFold(
            item.create,
            "create",
            childRacePin(childScope, item.where)
          )
        );
        // E6.1 — the slot's two probe ids, allocated HERE (before the arms fold) for the
        // reason the `update` kind allocates its own: a final source is a value, so
        // the id has to exist before a payload can be folded against it. Allocated in
        // the order the slot itself would, so no step id moves.
        const upsertProbeIds = items.map(() => ({
          member: scope.allocate(`${childName}.member`),
          global: scope.allocate(`${childName}.find`),
        }));
        // WHICH probe the arm addresses is the choice `compile` already makes: a fresh
        // parent decides its two-way from the global probe and spends that key on the
        // arm's UPDATE ({@link compileFreshUpsert}); a correlated parent decides its
        // three-way from the membership probe and spends THAT one ({@link compileUpsert}).
        const armProbeIds = upsertProbeIds.map((ids) =>
          input.freshParent ? ids.global : ids.member
        );
        const foldedUpdates = items.map((item, index) =>
          foldOrDelegateUpdate(
            item.update,
            item.where,
            armProbeIds[index]!,
            true
          )
        );
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "upsert",
            upserts: items.map((item, index) => ({
              where: item.where,
              create: foldedCreates[index]!.scalar,
              update: foldedUpdates[index]!.scalar,
            })),
            upsertProbeIds,
            upsertArmProbeIds: foldedUpdates.map((fold, index) =>
              fold.usesLocatedPk ? armProbeIds[index] : undefined
            ),
            upsertCreateChildParts: foldedCreates.map((f) => f.childParts),
            upsertUpdateChildParts: foldedUpdates.map((f) => f.childParts),
            upsertCreateDelegated: foldedCreates.map((f) => f.delegated),
            upsertCreateIdentity: foldedCreates.map((f) => f.identity),
          })
        );
        break;
      }
      default: {
        // Every relation mutation entry now has a junction arm (N3-U1 closed the last
        // one, `createMany`), so this is an internal exhaustiveness check, not a
        // capability boundary: no user payload reaches it. It was an
        // `UnsupportedOperationError` refusal until N3-U1 — census 77 -> 76.
        const exhaustive: never = entry;
        throw new QueryEngineError(
          `query-engine-v2 junction part has no builder for '${String(exhaustive)}'.`
        );
      }
    }
  }
  return parts;
}

/**
 * Every unique constraint the schema declares for a model EXCEPT its primary key,
 * split by whether a `whereUnique` can NAME it (E6.8).
 *
 * - `probeable` — the `.unique()` scalars and the declared compound uniques. A
 *   `whereUnique` spells these (`{ slug: … }`, `{ nameAndOrg: { … } }`), so a probe can
 *   read the exact row an INSERT would conflict with.
 * - `indexOnly` — `.index(fields, { unique: true })`. The database enforces it, the
 *   migration creates it, and NO selector names it: it is a constraint an INSERT can
 *   violate but no probe can address. It is counted (a model carrying one has something
 *   to conflict on) and never used as a selector.
 *
 * The primary key is excluded because the one caller asks only about rows that do not
 * spell it. This is the whole of what the engine knows about unique constraints: an index
 * created in the database behind the schema's back is outside it, exactly as the `push`ed
 * DDL is.
 */
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

/**
 * The compile-time identity key of a connectOrCreate target for the same-op
 * dedup ledger. A literal create PK keys by its value (the pre-existing
 * behavior); a DB-generated PK has no literal, so same-target items are the
 * ones naming the same unique selector — key by the sorted `where` entries.
 */
function adoptDedupKey(slot: {
  readonly where: Record<string, unknown>;
  readonly createPk: unknown;
  readonly generatedField?: string;
}): string {
  if (!slot.generatedField) return `pk:${pkKey(slot.createPk)}`;
  return `where:${stableKey(slot.where)}`;
}

/** A field-order-independent string for a compile-time `where` record — the shape a
 *  dedup ledger keys on when the identity is a unique selector rather than a single
 *  primary-key value. `bigint` is tagged because `JSON.stringify` cannot encode it. */
function stableKey(record: Record<string, unknown>): string {
  const entries = Object.keys(record)
    .sort()
    .map((field) => [field, record[field]] as const);
  return JSON.stringify(entries, (_key, value) =>
    typeof value === "bigint" ? `${value}n` : value
  );
}

/**
 * The `updateMany` data boundary — the one payload position on this relation that stays
 * scalar, and the reason is the ENGINE's, not Prisma's (M4, re-justified by E2-U2 when
 * the sibling `connectOrCreate` position lifted).
 *
 * `updateMany` compiles to ONE set-based `UPDATE … WHERE <membership> AND <filter>`. It
 * never learns which rows it touched, so a deeper edge in that data has no identity to
 * reference: a child FK would need the primary key of EACH matched row, and the only way
 * to produce those is to stop being a set-based write — read the set, then write per row,
 * which is a different operation with different semantics under concurrency (the set can
 * change between the read and the writes). Nothing about the child payload decides this;
 * the absence of a per-row identity does. The measured Prisma 7.9.1 behavior (a type +
 * parser refusal for every multiplicity) corroborates the boundary; it does not justify
 * it, and a Prisma that accepted the shape would not make it expressible here.
 *
 * Reachability, measured live: at the UPDATE ROOT the CLASS V legality check answers
 * first (`assertUpdateManyRelationsAreCompilable` — `NestedWriteError: Nested relation
 * writes inside updateMany data for relation '…' are not supported.`); this throw is what
 * a nested target's own `updateMany` meets one level deeper, where that root check does
 * not run. Both refuse before any effect.
 */
function scalarOnly(
  childScope: QueryScope,
  data: Record<string, unknown>,
  relationName: string,
  kind: string
): Record<string, unknown> {
  const { scalarData, relations } = buildParsedRelationPrograms(
    childScope,
    data
  );
  if (Object.keys(relations).length > 0) {
    throw new UnsupportedOperationError(
      `query-engine-v2 nested '${kind}' on many-to-many relation '${relationName}' does not support nested relation writes in its data.`
    );
  }
  return scalarData;
}
