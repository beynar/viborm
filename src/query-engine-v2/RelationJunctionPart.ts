// biome-ignore-all lint/style/useFilenamingConvention: RelationJunctionPart is the architecture name.
import { NestedWriteError, QueryEngineError } from "@errors";
import { getManyToManyJoinInfo } from "../query-engine/builders/many-to-many-utils";
import {
  type RelationMutation,
  separateData,
} from "../query-engine/builders/relation-data-builder";
import { getRelationMutationKinds } from "../query-engine/builders/relation-mutation-parser";
import { buildInsert } from "../query-engine/builders/values-builder";
import { getWhereUniqueEntries } from "../query-engine/builders/where-unique-builder";
import {
  createQueryScope,
  getTableName,
} from "../query-engine/context/query-scope";
import { ManyToManyStatements } from "../query-engine/ManyToManyStatements";
import { manyToManyStatement } from "../query-engine/many-to-many-statement";
import {
  buildDelete,
  buildDeleteMany,
  buildFind,
  buildFindUnique,
  buildUpdate,
} from "../query-engine/operations";
import type { QueryEngine } from "../query-engine/query-engine";
import type { QueryScope, RelationInfo } from "../query-engine/types";
import {
  childRacePin,
  nestedWriteFailure,
  presenceGuard,
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
  ref,
  type StatementStep,
} from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { planningKey } from "./Part";
import { literalParentId, type ParentIdSource } from "./RelationUpsertPart";
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
  | "connectOrCreate"
  | "create"
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
  readonly parentId: ParentIdSource;
  readonly txMode: boolean;
  /** connect/disconnect/set/delete/update: the child unique locator(s). */
  readonly wheres?: readonly Record<string, unknown>[];
  /** update/updateMany: the validated scalar data, aligned to `wheres`/`filters`. */
  readonly data?: readonly Record<string, unknown>[];
  /** deleteMany/updateMany: the correlated filter(s). */
  readonly filters?: readonly Record<string, unknown>[];
  /** create: the child create data (scalar only) for each item. */
  readonly creates?: readonly Record<string, unknown>[];
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
  // X1c — a FRESH create/upsert-create junction target whose data carries the
  // parent-held to-one projection (its FK folds into the target's OWN INSERT — X1b's
  // fresh mechanism) delegates its whole create to `CreateOperation`. When present at an
  // index, the delegated Part REPLACES the slot's `childInsert` (it does the target
  // INSERT and its before-parent writes); the join row references the target's literal
  // PK after. Aligned to `creates` / `upserts`; `undefined` for a scalar-only or
  // located-update-projection target.
  readonly createDelegated?: readonly (Part | undefined)[];
  readonly upsertCreateDelegated?: readonly (Part | undefined)[];
}

/** A per-target probe slot (connect/set/delete/update) with its write ids. */
interface TargetSlot {
  readonly where: Record<string, unknown>;
  readonly probeId: string;
  readonly guardId: string;
  readonly writeId: string;
  readonly childId: string;
  readonly probe: StatementStep;
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
  readonly read: StatementStep;
}

/** A probe-less slot (disconnect/updateMany) — a single write id per item. */
interface BareSlot {
  readonly where: Record<string, unknown>;
  readonly writeId: string;
  readonly data?: Record<string, unknown>;
}

/** A `create` slot — INSERT the fresh child, then INSERT the join row. The
 *  target PK is validated present in the create data at construction (an
 *  auto-generated identity routes the whole tree to V1). */
interface CreateSlot {
  readonly create: Record<string, unknown>;
  readonly createPk: unknown;
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
  readonly probeId: string;
  readonly guardId: string;
  readonly childId: string;
  readonly joinId: string;
  readonly probe: StatementStep;
}

/** An `upsert` slot — a membership probe + a global probe decide the three-way. */
interface UpsertSlot {
  readonly where: Record<string, unknown>;
  readonly create: Record<string, unknown>;
  readonly createPk: unknown;
  readonly update: Record<string, unknown>;
  readonly membershipProbeId: string;
  readonly globalProbeId: string;
  readonly guardId: string;
  readonly childId: string;
  readonly updateId: string;
  readonly joinId: string;
  readonly membershipProbe: StatementStep;
  readonly globalProbe: StatementStep;
  /** upsert arms (mechanism 2 / mechanism 1 reuse): the create-arm and update-arm
   *  nested child Parts, folded one level deeper against the target's literal PK
   *  (`create` PK / `where` PK — validated equal). Emitted branch-specifically:
   *  create-arm on the absent decision, update-arm on the member / created-earlier
   *  decision. Empty for a scalar-only arm. */
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
      kind === "create"
        ? (config.creates ?? []).map((create, index) =>
            this.buildCreateSlot(scope, create, index)
          )
        : [];
    this.adopts =
      kind === "connectOrCreate"
        ? (config.adopts ?? []).map((item) => this.buildAdoptSlot(scope, item))
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

  planning(scope: StepScope): readonly OperationStep[] {
    const steps: OperationStep[] = [];
    for (const target of this.targets) {
      steps.push(target.probe);
      // Depth (T3b-2): the located update target's own child Parts plan their probes
      // here, one level deeper — the unconditional planning superset (ATOM §3
      // technique 2), identical to the root and the child-held recursion.
      for (const child of target.childParts)
        steps.push(...child.planning(scope));
    }
    for (const bulk of this.bulks) steps.push(bulk.read);
    for (const adopt of this.adopts) steps.push(adopt.probe);
    for (const create of this.creates) {
      // X1c: a delegated fresh-create target plans its whole `CreateOperation` subtree
      // (its before-parent writes / generated-PK probes) one level deeper.
      if (create.delegated) steps.push(...create.delegated.planning(scope));
      for (const child of create.childParts)
        steps.push(...child.planning(scope));
    }
    for (const upsert of this.upserts) {
      steps.push(upsert.membershipProbe, upsert.globalProbe);
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
        return this.compileUpdate(scope, parent, known);
      case "updateMany":
        return this.compileUpdateMany(parent);
      case "create":
        return this.compileCreate(scope, parent, known);
      case "connectOrCreate":
        return this.compileConnectOrCreate(parent, known);
      case "upsert":
        return this.compileUpsert(scope, parent, known);
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
        steps.push(this.targetPresenceGuard(target, "connect", targetPk));
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
          this.connectedPresenceGuard(target, parent, "delete", targetPk)
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
    scope: StepScope,
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
        guards.push(
          this.connectedPresenceGuard(target, parent, "update", targetPk)
        );
      }
      // The self-UPDATE lands only when the payload carries scalar assignments; a
      // relation-only nested update (`data: { tags: { create } }`) writes no target
      // row, only its child Parts (mechanism 1). Membership is still validated by
      // `requireTarget`/the presence guard above.
      const scalar = data[index] ?? {};
      if (Object.keys(scalar).length > 0) {
        writes.push(this.childUpdate(target.writeId, targetPk, scalar));
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
      steps.push(this.childInsert(slot.childId, slot.create));
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
    parent: unknown,
    known: PlanningKnown
  ): readonly OperationStep[] {
    const steps: OperationStep[] = [];
    // Targets an earlier array item already created in THIS operation. V1
    // processes the array sequentially (branch ledger: "merge input N before
    // deciding input N+1"), so a duplicate target adopts the just-created row
    // instead of re-creating it. V2 decides that at compile from the fixed order.
    const created = new Set<string>();
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
      if (created.has(pkKey(slot.createPk))) {
        // Created by an earlier same-target item — adopt (the join is idempotent).
        steps.push(this.joinInsert(slot.joinId, parent, slot.createPk));
        continue;
      }
      created.add(pkKey(slot.createPk));
      steps.push(
        this.childInsert(slot.childId, slot.create, slot.where),
        this.joinInsert(slot.joinId, parent, slot.createPk)
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
    known: PlanningKnown
  ): readonly OperationStep[] {
    const steps: OperationStep[] = [];
    const emitChildren = (parts: readonly Part[]) => {
      for (const child of parts) steps.push(...child.compile(scope, known));
    };
    // Targets an earlier array item already created+joined in THIS operation: it
    // is now a member, so a duplicate item updates it (V1's sequential merge).
    const created = new Set<string>();
    for (const slot of this.upserts) {
      const memberRows = known[planningKey(slot.membershipProbeId, "rows")];
      if (Array.isArray(memberRows) && memberRows.length > 0) {
        const memberPk = this.pkOf(memberRows[0]);
        if (!this.config.txMode) {
          steps.push(this.upsertMemberGuard(slot, parent, memberPk));
        }
        // Update arm (a scalar SET only when non-empty; a relation-only update arm
        // writes just its child Parts — mechanism 1 reused at the arm level).
        if (Object.keys(slot.update).length > 0) {
          steps.push(this.childUpdate(slot.updateId, memberPk, slot.update));
        }
        emitChildren(slot.updateChildParts);
        continue;
      }
      if (created.has(pkKey(slot.createPk))) {
        // Created+joined by an earlier same-target item — now a member (no guard;
        // our own earlier insert guarantees its presence). Update it.
        if (Object.keys(slot.update).length > 0) {
          steps.push(
            this.childUpdate(slot.updateId, slot.createPk, slot.update)
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
      created.add(pkKey(slot.createPk));
      if (slot.createDelegated) {
        // X1c: the fresh create-arm target delegates its whole create to
        // `CreateOperation` (a parent-held to-one folds into its OWN INSERT); the
        // subtree runs BEFORE the join so the target exists first.
        steps.push(...slot.createDelegated.compile(scope, known));
        steps.push(this.joinInsert(slot.joinId, parent, slot.createPk));
        continue;
      }
      steps.push(
        this.childInsert(slot.childId, slot.create, slot.where),
        this.joinInsert(slot.joinId, parent, slot.createPk)
      );
      // Create arm (mechanism 2): the fresh target's relations, emitted after its
      // INSERT + join, correlated to its explicit literal PK.
      emitChildren(slot.createChildParts);
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
    return {
      create,
      createPk: this.requireCreatePk(create),
      childId: scope.allocate(`${childName}.create`),
      joinId: scope.allocate(`${childName}.junction.insert`),
      childParts: this.config.createChildParts?.[index] ?? [],
      delegated: this.config.createDelegated?.[index],
    };
  }

  private buildAdoptSlot(
    scope: StepScope,
    item: { where: Record<string, unknown>; create: Record<string, unknown> }
  ): AdoptSlot {
    const { childName } = this.config;
    const probeId = scope.allocate(`${childName}.find`);
    return {
      where: item.where,
      create: item.create,
      createPk: this.requireCreatePk(item.create),
      probeId,
      guardId: scope.allocate(`${childName}.guard.exists`),
      childId: scope.allocate(`${childName}.create`),
      joinId: scope.allocate(`${childName}.junction.insert`),
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
    const membershipProbeId = scope.allocate(`${childName}.member`);
    const globalProbeId = scope.allocate(`${childName}.find`);
    return {
      where: item.where,
      create: item.create,
      createPk: this.requireCreatePk(item.create),
      update: item.update,
      membershipProbeId,
      globalProbeId,
      guardId: scope.allocate(`${childName}.guard.member`),
      childId: scope.allocate(`${childName}.create`),
      updateId: scope.allocate(`${childName}.update`),
      joinId: scope.allocate(`${childName}.junction.insert`),
      createChildParts: this.config.upsertCreateChildParts?.[index] ?? [],
      updateChildParts: this.config.upsertUpdateChildParts?.[index] ?? [],
      createDelegated: this.config.upsertCreateDelegated?.[index],
      // Two widened probes (technique #2): whether the target is a member of this
      // parent (correlated by a SQL Ref) AND whether it exists globally. `compile`
      // decides member / exists-not-member / absent from both.
      membershipProbe: {
        id: membershipProbeId,
        kind: "read",
        statement: this.membershipRead({
          parentValue: this.parentRef(),
          whereUnique: item.where,
          take: 1,
        }),
        outputs: { rows: { kind: "rows" } },
      },
      globalProbe: {
        id: globalProbeId,
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

  /** The idempotent join-row insert (junction-PK skip) for a target PK. */
  private joinInsert(id: string, parent: unknown, targetValue: unknown) {
    return this.junctionWrite(id, "junctionInsert", {
      parentValue: parent,
      targetValue,
    });
  }

  /** INSERT the fresh child row. A `where` present (connectOrCreate/upsert create
   *  arm) means the missing premise is enforced by the child unique constraint —
   *  its violation is the raceable signal (racePin), never a notExists guard. */
  private childInsert(
    id: string,
    create: Record<string, unknown>,
    where?: Record<string, unknown>
  ): StatementStep {
    const step: StatementStep = {
      id,
      kind: "write",
      statement: buildInsert(
        this.childScope,
        getTableName(this.childScope.model),
        create
      ),
      outputs: {},
    };
    return where
      ? { ...step, racePin: childRacePin(this.childScope, where) }
      : step;
  }

  /** The created child's primary key for the join row — a compile-time literal
   *  the create data must carry (the M2M target unique). An auto-generated child
   *  PK (absent from the create data) is create-through-junction with a produced
   *  identity — V1's runtime; route the whole tree to V1. */
  private requireCreatePk(create: Record<string, unknown>): unknown {
    const pk = create[this.targetPkField];
    if (pk === undefined || pk === null) {
      throw new UnsupportedOperationError(
        `query-engine-v2 create-through-junction for relation '${this.config.relationName}' requires the target primary key '${this.targetPkField}' in the create data.`
      );
    }
    return pk;
  }

  /** connectOrCreate found premise (batch): the adopted target still exists AND
   *  the captured PK still matches the selector (split-witness correlation — a
   *  concurrent move of the selector onto a replacement leaves no such row, so the
   *  join never links the replacement). Existing-row premise, raceable:false. */
  private adoptFoundGuard(slot: AdoptSlot, capturedPk: unknown): GuardStep {
    return presenceGuard(
      slot.guardId,
      this.capturedSelectorRead(slot.where, capturedPk),
      nestedWriteFailure(
        nestedReplacement("connectOrCreate"),
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
            ...getWhereUniqueEntries(this.childScope, where).map(
              ({ fieldName, value }) => ({ [fieldName]: { equals: value } })
            ),
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
   */
  private parentRef(): unknown {
    const source = this.config.parentId;
    if (source.kind === "literal") return source.value;
    if (source.kind !== "planned") {
      throw new QueryEngineError(
        `query-engine-v2 junction for relation '${this.config.relationName}' requires a planned or literal parent id to correlate its membership reads.`
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
// (connect/disconnect/set/delete/deleteMany/update/updateMany, plus the adopt
// family create/connectOrCreate/upsert) becomes one Part carrying every item of
// that kind; several kinds coexist on one relation as several Parts in the
// linear fragment. The adopt family's create arm is INSERT-child + INSERT-join
// (V1's junction SQL as leaves); its child PK must be carried in the create data
// (an auto-generated identity is create-through-junction with a produced value —
// still V1's, routed via UnsupportedOperationError).
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
    mutation,
    parsedRelation,
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
    resolvePk: () => unknown
  ): { scalar: Record<string, unknown>; childParts: readonly Part[] } => {
    const { scalarData, relations } = separateData(childScope, data);
    if (Object.keys(relations).length === 0) {
      return { scalar: scalarData, childParts: [] };
    }
    return {
      scalar: scalarData,
      childParts: input.nestedBuilder(
        childScope,
        literalParentId(resolvePk()),
        relations,
        txMode
      ),
    };
  };
  // The literal PK a relation-carrying update/upsert target is located by (the
  // deeper FK references it, so it must be a compile-time constant — mechanism 1's
  // precondition). A non-PK `where` with nested relations routes to V1.
  const requireWherePk = (
    where: Record<string, unknown>,
    foldKind: string
  ): unknown => {
    const entry = getWhereUniqueEntries(childScope, where).find(
      (candidate) => candidate.fieldName === targetPkField
    );
    if (entry === undefined) {
      throw new UnsupportedOperationError(
        `query-engine-v2 nested '${foldKind}' on many-to-many relation '${relationName}' carries nested relation writes; it must locate the target by its primary key '${targetPkField}'.`
      );
    }
    return entry.value;
  };
  // The literal PK a relation-carrying create arm supplies (mechanism 2's fresh
  // target; an auto-generated identity routes to V1, as the scalar create already does).
  const requireCreatePkValue = (
    create: Record<string, unknown>,
    foldKind: string
  ): unknown => {
    const pk = create[targetPkField];
    if (pk === undefined || pk === null) {
      throw new UnsupportedOperationError(
        `query-engine-v2 create-through-junction for relation '${relationName}' requires the target primary key '${targetPkField}' in the create data (${foldKind}).`
      );
    }
    return pk;
  };
  // X1c — a junction target whose data carries the parent-held to-one projection (or a
  // D4 edge) is not folded in place; its WHOLE target write delegates to the update /
  // create ROOT. An UPDATE target (located by its `where` PK, membership verified by the
  // junction slot's own probe/guard) delegates to `UpdateOperation`, returned as an empty
  // scalar + the delegated Part in child Parts (the slot skips its empty self-UPDATE). A
  // CREATE target (a fresh row, its parent-held FK folded into its OWN INSERT — X1b's
  // fresh mechanism) delegates to `CreateOperation`, carried as `delegated` so the slot
  // skips its `childInsert`.
  const foldOrDelegateUpdate = (
    data: Record<string, unknown>,
    where: Record<string, unknown>
  ): { scalar: Record<string, unknown>; childParts: readonly Part[] } => {
    if (!targetNeedsFullUpdate(childScope, data)) {
      return foldTarget(data, () => requireWherePk(where, "update"));
    }
    return {
      scalar: {},
      childParts: [
        buildNestedTargetUpdatePart({
          scope,
          engine,
          targetModel: relationInfo.targetModel,
          data,
          locate: {
            where,
            parentId: literalParentId(requireWherePk(where, "update")),
            childFields: [],
            parentFields: [],
            relationName,
            notFoundMessage: relationTargetNotFound(relationInfo, "update"),
          },
        }),
      ],
    };
  };
  const foldOrDelegateCreate = (
    create: Record<string, unknown>
  ): {
    scalar: Record<string, unknown>;
    childParts: readonly Part[];
    delegated: Part | undefined;
  } => {
    if (!targetNeedsFullUpdate(childScope, create)) {
      const folded = foldTarget(create, () =>
        requireCreatePkValue(create, "create")
      );
      return { ...folded, delegated: undefined };
    }
    // Validate the fresh target's PK is present (a delegated create still keys the join
    // row by the literal PK; an auto-generated identity routes to V1, as scalar does).
    requireCreatePkValue(create, "create");
    return {
      scalar: separateData(childScope, create).scalarData,
      childParts: [],
      delegated: buildNestedTargetFreshCreatePart({
        scope,
        engine,
        targetModel: relationInfo.targetModel,
        data: create,
      }),
    };
  };
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
        const wheres = items.map((item) => {
          if (!item.where) {
            throw new QueryEngineError(
              `query-engine-v2 update for relation '${relationName}' requires a where.`
            );
          }
          return item.where;
        });
        // T3b-2 mechanism 1 reuse: a relation-carrying update target folds its own
        // relations one level deeper against its located (literal `where`) PK; a
        // scalar-only target keeps its empty child Parts (the pre-T3b-2 behavior).
        const folded = items.map((item, index) =>
          foldOrDelegateUpdate(item.data, wheres[index]!)
        );
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "update",
            wheres,
            data: folded.map((f) => f.scalar),
            updateChildParts: folded.map((f) => f.childParts),
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
      case "create": {
        // INSERT the fresh child, then the join row (V1's
        // `ManyToManyMemberships.create`). T3b-2 mechanism 2: deeper nested relations
        // in the create data fold one level deeper against the fresh target's
        // explicit literal PK, emitted after its INSERT + join (fresh-parent elision,
        // ATOM §4); a scalar-only create keeps its empty child Parts.
        const folded = normalizeCreates(parsedRelation.create, relationName).map(
          (create) => foldOrDelegateCreate(create)
        );
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "create",
            creates: folded.map((f) => f.scalar),
            createChildParts: folded.map((f) => f.childParts),
            createDelegated: folded.map((f) => f.delegated),
          })
        );
        break;
      }
      case "connectOrCreate":
        parts.push(
          new RelationJunctionPart(scope, {
            ...base,
            kind: "connectOrCreate",
            adopts: normalizeWhereCreate(
              parsedRelation.connectOrCreate,
              relationName,
              kind
            ).map((item) => ({
              where: item.where,
              create: scalarOnly(childScope, item.create, relationName, kind),
            })),
          })
        );
        break;
      case "upsert": {
        // T3b-2: both arms fold their own relations one level deeper against the
        // target's literal PK — the create arm (mechanism 2, fresh target) against
        // its `create` PK, the update arm (mechanism 1 reuse) against its `where` PK.
        // Each arm's child Parts are emitted branch-specifically by `compileUpsert`.
        const items = normalizeUpserts(parsedRelation.upsert, relationName);
        const foldedCreates = items.map((item) =>
          foldOrDelegateCreate(item.create)
        );
        const foldedUpdates = items.map((item) =>
          foldOrDelegateUpdate(item.update, item.where)
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
            upsertCreateChildParts: foldedCreates.map((f) => f.childParts),
            upsertUpdateChildParts: foldedUpdates.map((f) => f.childParts),
            upsertCreateDelegated: foldedCreates.map((f) => f.delegated),
          })
        );
        break;
      }
      default:
        // createMany and any other kind not enumerated stay V1's surface — route
        // the whole tree to V1.
        throw new UnsupportedOperationError(
          `query-engine-v2 does not support nested '${kind}' on many-to-many relation '${relationName}'.`
        );
    }
  }
  return parts;
}

function normalizeCreates(
  value: unknown,
  relation: string
): Record<string, unknown>[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (!(item && typeof item === "object")) {
      throw new QueryEngineError(
        `query-engine-v2 create for relation '${relation}' requires a create object.`
      );
    }
    return item as Record<string, unknown>;
  });
}

function normalizeWhereCreate(
  value: unknown,
  relation: string,
  kind: string
): { where: Record<string, unknown>; create: Record<string, unknown> }[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (!(item && typeof item === "object")) {
      throw new QueryEngineError(
        `query-engine-v2 ${kind} for relation '${relation}' requires a { where, create } object.`
      );
    }
    const record = item as Record<string, unknown>;
    const where = requireObject(record.where, relation, kind, "where");
    const create = requireObject(record.create, relation, kind, "create");
    return { where, create };
  });
}

function normalizeUpserts(
  value: unknown,
  relation: string
): {
  where: Record<string, unknown>;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (!(item && typeof item === "object")) {
      throw new QueryEngineError(
        `query-engine-v2 upsert for relation '${relation}' requires a { where, create, update } object.`
      );
    }
    const record = item as Record<string, unknown>;
    return {
      where: requireObject(record.where, relation, "upsert", "where"),
      create: requireObject(record.create, relation, "upsert", "create"),
      update: requireObject(record.update, relation, "upsert", "update"),
    };
  });
}

function requireObject(
  value: unknown,
  relation: string,
  kind: string,
  field: string
): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new QueryEngineError(
    `query-engine-v2 ${kind} for relation '${relation}' requires a '${field}' object.`
  );
}

/** A stable key for a target primary key value (dedup of same-op created targets). */
function pkKey(value: unknown): string {
  return typeof value === "bigint" ? value.toString() : JSON.stringify(value);
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
