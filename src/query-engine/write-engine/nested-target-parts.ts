import { QueryEngineError } from "@errors";
import type { Model } from "@schema/model";
import { getPrimaryKeyFields } from "../builders/correlation-utils";
import {
  bindRelation,
  type ChildHeldToMany,
  type ChildHeldToOne,
} from "../builders/relation-data-builder";
import {
  buildParsedRelationPrograms,
  type RelationMutationEntry,
  type RelationMutationProgram,
} from "../builders/relation-mutation-parser";
import { buildValueGroups } from "../builders/values-builder";
import { createQueryScope } from "../context/query-scope";
import { buildCreateManyPlan } from "../operations/create";
import { assertPortableCreateManySkip } from "../operations/create-many-portability";
import type { QueryEngine } from "../query-engine";
import type { QueryScope } from "../types";
import { CreateOperation } from "./CreateOperation";
import {
  type FinalReferenceSource,
  type ForeignKeyMember,
  foreignKeyWriteValue,
  literalReferenceSource,
  pairCorrelatedForeignKeyMembers,
  pairForeignKeyMembers,
  planningSourceFromFinal,
} from "./foreign-key-reference";
import { referenceSql } from "./fragment-builders";
import type {
  OperationStep,
  StatementStep,
  TargetConstraintPin,
} from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { buildJunctionParts } from "./RelationJunctionPart";
import { buildToManyLinkParts } from "./RelationLinkPart";
import {
  type ArmSeam,
  buildConnectOrCreateParts,
  buildToManyUpsertParts,
} from "./RelationUpsertPart";
import {
  buildInverseToOneUpsertPart,
  buildToManyDeleteManyParts,
  buildToManyDeleteParts,
  buildToManySetPart,
  buildToManyUpdateManyParts,
  buildToManyUpdateParts,
  buildToOneUpdatePart,
} from "./RelationWritePart";
import type { StepScope } from "./StepScope";
import { getStepModelName, UnsupportedOperationError } from "./shared";

/**
 * T3b mechanism 1 — update-arm literal-parent recursion (TO-ONE.md §7.7).
 *
 * A nested `update`'s target payload builds its OWN child Parts exactly as a root
 * update does — the `RelationUpsertPart.buildArmChildParts` precedent generalized
 * from `upsert`/`connectOrCreate` to the full nested-write surface. The target has
 * already been located by its unique `where` (a to-many/to-one nested update), so
 * its primary key is a compile-time literal ({@link literalParentId}); every child
 * FK edge one level deeper is therefore a known value, not an arm-dependent produced
 * one — the linearity precondition (WHY §4.2) that keeps depth a plain list splice.
 *
 * This is the child-Part builder both {@link RelationWritePart} (a child-held nested
 * update) and the parent-held to-one update arm (family A-remainder, its parent-held
 * projection) call for their located target's data relations. It reuses the SAME
 * per-kind builders the root's `interpretRelation` uses — m2m junction, the correlated
 * write/link/adopt families, the inverse-side to-one — differing only in the
 * final reference source (a compile-time literal here, a planned locate read at the root):
 * one architecture, one vocabulary, depth adds list entries and one parent-id value.
 *
 * A **parent-held FK to-one at depth** (the located target itself holds an FK it would
 * rewrite in its own SET) needs child-SET folding this in-place builder does not carry;
 * Selected-record updates now compile through `RecordUpdateCompiler`. This file keeps
 * only the explicit junction-create ordering that cannot be absorbed without moving
 * the join write after the fresh target's descendants.
 */

/**
 * How a located-by-PK target's relations are folded one level deeper — the recursion
 * seam {@link RelationWritePart} calls without importing this module at runtime (an
 * erased type import breaks the cycle).
 *
 * `membershipReadSource` is N5-U1's two-source split carried to
 * depth: the value existing rows are READ by, when that is not the value new ones are
 * WRITTEN with. They differ in exactly one situation — a target whose own SET moves the
 * primary key its deeper edges reference, ordered after its self-UPDATE — and only the
 * junction consumes it, because a junction is the one edge kind with a parent-correlated
 * PLANNING read. Absent everywhere else, and then every read takes `parentId`.
 */
export type JunctionTargetRelationsBuilder = (
  targetScope: QueryScope,
  parentId: FinalReferenceSource,
  relations: Record<string, RelationMutationProgram>,
  txMode: boolean,
  membershipReadSource?: FinalReferenceSource
) => readonly Part[];

/**
 * Fold every relation mutation in a located-by-PK target's data into deeper Parts,
 * correlated to the target's own (literal) primary key. The `parentId` is a
 * {@link literalParentId} in the child-held case (the located target's `where` PK)
 * and a planned source in the parent-held case (the parent-held probe's captured id).
 */
export function buildJunctionTargetRelationParts(
  scope: StepScope,
  engine: QueryEngine,
  targetScope: QueryScope,
  relations: Record<string, RelationMutationProgram>,
  parentId: FinalReferenceSource,
  txMode: boolean,
  membershipReadSource?: FinalReferenceSource
): readonly Part[] {
  const parts: Part[] = [];
  for (const program of Object.values(relations)) {
    foldJunctionTargetRelation({
      scope,
      engine,
      targetScope,
      program,
      parentId,
      membershipReadSource,
      txMode,
      parts,
    });
  }
  return parts;
}

/**
 * X1c — whether a located UPDATE target's data carries the located-target projection
 * of mechanism 1/2 that the in-place child-Part builder cannot fold: a **parent-held
 * to-one write** (the target holds the FK, so a deeper create/connect/update folds its
 * identity into the target's OWN update SET — child-SET folding, not a child edge) or a
 * **non-PK / compound referenced edge** (D4 — the deeper FK references a column the
 * literal/planned parent id does not carry). Either delegates the WHOLE target UPDATE to
 * {@link UpdateOperation} (which does child-SET folding + before-root writes + reorder +
 * the D4 located-row reference at the ROOT); the common child-held-to-PK / m2m / create
 * target stays on the proven {@link RelationWritePart} path.
 */
export function requiresWholeFreshRecordCompiler(
  targetScope: QueryScope,
  data: Record<string, unknown>
): boolean {
  const { relations } = buildParsedRelationPrograms(targetScope, data);
  const targetPrimaryKeys = getPrimaryKeyFields(targetScope.model);
  for (const mutation of Object.values(relations)) {
    const relation = bindRelation(targetScope, mutation.relationInfo);
    if (relation.kind === "junction") continue;
    if (relation.kind === "parentHeldToOne") return true;
    const referencesTargetPk =
      targetPrimaryKeys.length === 1 &&
      relation.referencedFields.length === 1 &&
      relation.referencedFields[0] === targetPrimaryKeys[0];
    if (!referencesTargetPk) return true;
  }
  return false;
}

/**
 * X1c — a FRESH m2m junction target whose create data carries the parent-held to-one
 * projection (child-SET folding on a fresh row — the FK folds into the target's OWN
 * INSERT, X1b's fresh mechanism) delegates its whole create to {@link CreateOperation}
 * `nestedFresh`. The junction target holds NO foreign key to the enclosing parent (its
 * membership is the join row, written by the junction Part), so the root FK inject is
 * empty — the create subtree is a standalone row keyed by its explicit literal PK, the
 * same PK the junction row references. Reuses the create ROOT for the whole fresh
 * subtree exactly as the located-update reuse does for the update root.
 */
export function buildNestedTargetFreshCreatePart(input: {
  scope: StepScope;
  engine: QueryEngine;
  targetModel: Model<any>;
  data: Record<string, unknown>;
  /**
   * E4-U3 — the missing-premise pin the arm's own INSERT carried before the whole
   * create was delegated. The subtree REPLACES that INSERT, so without threading the
   * pin the delegation would trade a race protection for a shape; `nestedFresh`
   * already knows how to put it on the subtree's ROOT insert (`rootRacePin`), the same
   * channel the before-root target subtree uses. Absent for an unconditional `create`
   * arm, which has no premise to miss.
   */
  racePin?: TargetConstraintPin;
}): {
  readonly part: Part;
  /**
   * E4-U3 — one referenced value of the row this subtree's ROOT makes: a backward
   * `Ref` when its primary key is database-generated, a literal when the create data
   * spells it, `undefined` when it is neither (the caller's typed refusal). The join
   * row spends it, which is why the subtree has to hand it back rather than keep it.
   */
  readonly rootReferenced: (field: string) => FinalReferenceSource | undefined;
} {
  const op = new CreateOperation(
    input.engine,
    input.targetModel,
    {},
    {
      scope: input.scope,
      skipOwnWrite: true,
      nestedFresh: {
        data: input.data,
        incomingForeignKey: [],
        relationName: "",
        ...(input.racePin ? { rootRacePin: input.racePin } : {}),
      },
    }
  );
  return {
    part: new NestedFreshCreatePart(op),
    rootReferenced: (field) => op.freshRootReferenced(field),
  };
}

/**
 * E1 U3 — the BEFORE-ROOT to-one target of an update root. The enclosing record
 * holds the foreign key, so the target is written FIRST and the enclosing UPDATE's
 * SET reads its key: the identity flows the OPPOSITE way from every other nested
 * fresh subtree, where the parent's key flows down into the child.
 *
 * That reversal is why this returns the OPERATION rather than a {@link Part}. The
 * caller needs two things a Part cannot give it: the subtree root's referenced value
 * ({@link CreateOperation.freshRootReferenced}) at CONSTRUCTION, so the FK fold can
 * be built; and the freedom to compile the subtree only in the arm that is TAKEN,
 * because one `buildBeforeTarget` serves three arms and two of them choose at
 * compile. The root FK inject is empty — the subtree owes the enclosing record
 * nothing.
 */
export function buildBeforeRootTargetSubtree(input: {
  scope: StepScope;
  engine: QueryEngine;
  targetModel: Model<any>;
  data: Record<string, unknown>;
  rootRacePin?: TargetConstraintPin;
}): CreateOperation {
  return new CreateOperation(
    input.engine,
    input.targetModel,
    {},
    {
      scope: input.scope,
      skipOwnWrite: true,
      nestedFresh: {
        data: input.data,
        incomingForeignKey: [],
        relationName: "",
        ...(input.rootRacePin ? { rootRacePin: input.rootRacePin } : {}),
      },
    }
  );
}

function foldJunctionTargetRelation(input: {
  scope: StepScope;
  engine: QueryEngine;
  targetScope: QueryScope;
  program: RelationMutationProgram;
  parentId: FinalReferenceSource;
  /** The junction-only READ source under a post-transition ordering (E2-U3); see
   *  {@link JunctionTargetRelationsBuilder}. */
  membershipReadSource?: FinalReferenceSource;
  txMode: boolean;
  parts: Part[];
}): void {
  const { scope, engine, targetScope, program, parentId, txMode } = input;
  const relationInfo = program.relationInfo;
  const relationName = relationInfo.name;
  const relation = bindRelation(targetScope, relationInfo);

  // The recursion seam threaded to every kind that may carry its own relations one
  // level deeper (the m2m junction here; the child-held write/link/adopt families
  // via `writeBase` below): the same builder, one operation's scope + engine
  // captured, depth adding list entries and one parent-id value (WHY §4.2).
  const deeperBuilder: JunctionTargetRelationsBuilder = (
    deeperScope,
    deeperParentId,
    deeperRelations,
    deeperTxMode,
    deeperCorrelationParentId
  ) =>
    buildJunctionTargetRelationParts(
      scope,
      engine,
      deeperScope,
      deeperRelations,
      deeperParentId,
      deeperTxMode,
      deeperCorrelationParentId
    );

  if (relation.kind === "junction") {
    // Many-to-many is not special (WHY §4.3): junction as ordinary Parts, correlated
    // to the located target's literal PK (its membership reads inline the literal —
    // RelationJunctionPart.parentRef). A junction create/update/upsert target whose
    // data carries its own relations folds them one level deeper through the same
    // seam (T3b-2 family C at depth).
    input.parts.push(
      ...buildJunctionParts({
        scope,
        engine,
        parentScope: targetScope,
        relation,
        program,
        parentId,
        membershipReadSource: input.membershipReadSource,
        txMode,
        nestedBuilder: deeperBuilder,
      })
    );
    return;
  }

  if (relation.kind === "parentHeldToOne") {
    // X1c LIFTED (the located-target parent-held-to-one, child-SET folding). A located
    // target that holds this FK — a deeper parent-held to-one whose identity folds into
    // the target's OWN update SET — no longer reaches this in-place child-Part builder:
    // Selected-record updates route the whole target to the record compiler, so the
    // target's SET absorbs the fold at the update root. This branch is therefore
    // unreachable by construction — a fail-closed internal invariant, not a route.
    throw new QueryEngineError(
      `query-engine-v2 internal: a parent-held to-one on relation '${relationName}' reached the junction target relation builder; it requires the whole fresh-record compiler.`
    );
  }

  // X1c LIFTED (the located-target D4 projection): the deeper FK must reference the
  // located target's OWN single primary key. A **D4-style deeper edge referencing a
  // non-PK unique of the located target** needs the located row's non-PK referenced
  // column threaded from a locate read — which the update root exposes via `locateFields`
  // firstRowField outputs. Selected-record updates use their compiler-owned projection,
  // so this junction-create builder never sees a non-PK reference;
  // the branch is a fail-closed internal invariant, not a route. (Witness:
  // nested-update-d4-deep-nonpk-reference.test.ts — the create-arm non-PK reference is the
  // update root's own family-E boundary, byte-identical at depth.)
  const targetPrimaryKeys = getPrimaryKeyFields(targetScope.model);
  const referencesTargetPk =
    targetPrimaryKeys.length === 1 &&
    relation.referencedFields.length === 1 &&
    relation.referencedFields[0] === targetPrimaryKeys[0];
  if (!referencesTargetPk) {
    throw new QueryEngineError(
      `query-engine-v2 internal: a non-primary-key referenced edge on relation '${relationName}' reached the junction target relation builder; it requires the whole fresh-record compiler.`
    );
  }

  const childScope = createQueryScope(engine.adapter, relationInfo.targetModel);
  const childPrimaryKeys = getPrimaryKeyFields(childScope.model);
  if (childPrimaryKeys.length !== 1) {
    throw new UnsupportedOperationError(
      `query-engine-v2 update requires a child with one primary key for relation '${relationName}' one level deeper.`
    );
  }
  const childName = getStepModelName(relationInfo.targetModel, relationName);
  const writeBase = {
    scope,
    engine,
    relation,
    childName,
    childScope,
    childPrimaryKey: childPrimaryKeys[0]!,
    parentId,
    txMode,
    nestedBuilder: deeperBuilder,
    /** ONE home for the fresh-arm seam. `connectOrCreate` and `upsert` both hand it
     *  to their part builders below; bound here so a change to what a fresh arm
     *  builds has a single place to happen. */
    freshArm: (freshInput: Parameters<FreshArmBuilder>[0]) =>
      buildFreshArmPart(scope, engine, freshInput),
  } as const;

  // E3 — the adopt family's two injected builders, bound together here because this is
  // the one place both halves exist: the fresh CREATE arm's create subtree and the
  // located UPDATE arm's deeper child Parts (this same recursion, one level on).
  const armSeam: ArmSeam = {
    freshArm: writeBase.freshArm,
  };

  for (const entry of program.entries) {
    foldJunctionChildHeldEntry({
      entry,
      armSeam,
      childScope,
      childName,
      relation,
      writeBase,
      scope,
      engine,
      parentId,
      txMode,
      parts: input.parts,
    });
  }
}

function foldJunctionChildHeldEntry(args: {
  entry: RelationMutationEntry;
  armSeam: ArmSeam;
  childScope: QueryScope;
  childName: string;
  relation: ChildHeldToOne | ChildHeldToMany;
  writeBase: Parameters<typeof buildToManyUpdateParts>[0];
  scope: StepScope;
  engine: QueryEngine;
  parentId: FinalReferenceSource;
  txMode: boolean;
  parts: Part[];
}): void {
  const {
    entry,
    armSeam,
    childScope,
    childName,
    relation,
    writeBase,
    scope,
    engine,
    parentId,
    txMode,
    parts,
  } = args;
  const isInverseToOne = relation.kind === "childHeldToOne";
  const relationName = relation.relationInfo.name;
  const push = (built: readonly Part[]) => parts.push(...built);

  switch (entry.kind) {
    case "connect":
    case "disconnect":
      push(
        buildToManyLinkParts(
          scope,
          engine,
          relation,
          childName,
          childScope,
          writeBase.childPrimaryKey,
          entry,
          parentId,
          txMode
        )
      );
      return;
    case "connectOrCreate":
      push(
        buildConnectOrCreateParts(
          scope,
          engine,
          relation,
          entry.items,
          pairForeignKeyMembers(
            relation.foreignFields,
            relation.referencedFields,
            relation.referencedFields.map(() => parentId)
          ),
          txMode,
          armSeam
        )
      );
      return;
    case "upsert": {
      if (isInverseToOne) {
        const item = entry.items[0];
        if (!item) {
          throw new QueryEngineError(
            `query-engine-v2 internal: to-one upsert for relation '${relationName}' has no item.`
          );
        }
        parts.push(buildInverseToOneUpsertPart(writeBase, item));
        return;
      }
      const members = pairCorrelatedForeignKeyMembers(
        relation.foreignFields,
        relation.referencedFields,
        relation.referencedFields.map(() =>
          planningSourceFromFinal(parentId, relationName, "upsert")
        ),
        relation.referencedFields.map(() => parentId)
      );
      push(
        buildToManyUpsertParts(
          scope,
          engine,
          relation,
          entry.items,
          members,
          members,
          txMode,
          armSeam
        )
      );
      return;
    }
    case "update":
      if (isInverseToOne) {
        parts.push(buildToOneUpdatePart(writeBase, entry));
        return;
      }
      push(buildToManyUpdateParts(writeBase, entry));
      return;
    case "updateMany":
      push(buildToManyUpdateManyParts(writeBase, entry));
      return;
    case "delete":
      if (isInverseToOne) {
        // `delete: true` — the arm's only reachable value at this seam too (the parse
        // boundary types an inverse-side to-one `delete` as `v.boolean()`; `false` is
        // Prisma's no-op, dropped from the kind list, N7-U-B).
        push(
          buildToManyDeleteManyParts(writeBase, {
            kind: "deleteMany",
            filters: [{}],
          })
        );
        return;
      }
      push(buildToManyDeleteParts(writeBase, entry));
      return;
    case "deleteMany":
      push(buildToManyDeleteManyParts(writeBase, entry));
      return;
    case "set":
      parts.push(buildToManySetPart(writeBase, entry));
      return;
    case "create": {
      // Every non-bulk fresh record is a CreateOperation subtree. Its field-bound
      // incoming members resolve literal and planned parents through the same compiler.
      const members = pairForeignKeyMembers(
        relation.foreignFields,
        relation.referencedFields,
        relation.referencedFields.map(() => parentId)
      );
      parts.push(
        ...buildFreshRecordParts({
          scope,
          engine,
          childScope,
          relationName,
          members,
          creates: entry.items,
        })
      );
      return;
    }
    case "createMany": {
      // N4-U3 — the bulk arm of the same dispatch the single `create` above makes.
      // A LITERAL parent id (a child-held nested update located by its `where` PK)
      // resolves the injected foreign key at construction; a PLANNED one (a
      // parent-held to-one `update` target, located by this operation's planning
      // read) resolves it at COMPILE from the row the locate ACTED ON. N1-U1 already
      // built the planned bulk leaf for the ROOT's `createMany`
      // ({@link buildPlannedParentCreateManyPart}); the site that used to refuse here
      // was the one caller that had not been handed it. Nothing about `skipDuplicates`
      // changes with provenance: the leaf's statement-count alignment between the
      // construction-time shape plan and the compile-time plan is ASSERTED inside that
      // builder, and the skip disposition is a function of the dialect and the rows,
      // not of where the foreign key's value comes from.
      const members = pairForeignKeyMembers(
        relation.foreignFields,
        relation.referencedFields,
        relation.referencedFields.map(() => parentId)
      );
      parts.push(
        literalReferenceSource(parentId)
          ? buildLiteralParentCreateManyPart({
              scope,
              engine,
              childScope,
              childName,
              relationName,
              members,
              createManyEntry: entry,
            })
          : buildPlannedParentCreateManyPart({
              scope,
              engine,
              childScope,
              childName,
              relationName,
              members,
              createManyEntry: entry,
            })
      );
      return;
    }
    default:
      // Unreachable by construction (N7-U-A, the X1c disposition): measured, all ELEVEN
      // to-many keys have a case above (the two that answer differently — `set` and
      // `disconnect` without a planned parent id — reach their OWN `QueryEngineError`
      // inside the built Part, not this switch). An engine invariant, not a route.
      throw new QueryEngineError(
        `query-engine-v2 internal: unsupported entry reached the deeper nested dispatch on relation '${relationName}'; the parse boundary admits only the eleven to-many kinds, all of which are handled above.`
      );
  }
}

/**
 * The child-held straight-write leaf family (`create`/`createMany` under a located
 * target): fully built at construction (the parent id is a compile-time literal, so
 * the FK is inlined and nothing is decided from planning). No planning read, no
 * probe — a nested create/createMany is an unconditional INSERT (its unique
 * violation is a genuine error, never a raceable probe-missing signal).
 */
class LiteralParentWriteParts implements Part {
  private readonly steps: readonly OperationStep[];
  constructor(steps: readonly OperationStep[]) {
    this.steps = steps;
  }
  planning(): readonly StatementStep[] {
    return [];
  }
  compile(_scope: StepScope, _known: PlanningKnown): readonly OperationStep[] {
    return this.steps;
  }
}

/** Write one child FK column per field-bound member. Literal sources resolve at
 *  construction; planning and transitioned sources resolve from `known` at compile. */
function foreignKeyInject(
  engine: QueryEngine,
  childScope: QueryScope,
  relationName: string,
  members: readonly ForeignKeyMember[],
  known?: PlanningKnown
): Record<string, unknown> {
  const inject: Record<string, unknown> = {};
  for (const member of members) {
    inject[member.foreignField] = referenceSql(
      engine,
      childScope.model,
      member.foreignField,
      foreignKeyWriteValue(member, known, relationName, "create")
    );
  }
  return inject;
}

export function buildFreshRecordParts(input: {
  scope: StepScope;
  engine: QueryEngine;
  childScope: QueryScope;
  relationName: string;
  members: readonly ForeignKeyMember[];
  creates: readonly Record<string, unknown>[];
}): readonly Part[] {
  return input.creates.map((create) =>
    buildFreshRecordPart({ ...input, create })
  );
}

/**
 * X1b — a relation-carrying fresh nested `create` at DEPTH is a create SUBTREE.
 *
 * The fresh child, with every relation it carries, is exactly what a `create` ROOT
 * builds — so it is delegated to {@link CreateOperation} in its `nestedFresh` mode,
 * sharing the enclosing operation's scope (no step-id collision), skipping the
 * whole-args re-parse (the enclosing operation already validated the tree) and the
 * terminal read (the enclosing operation owns the result), and folding the located
 * parent's field-bound FK members into its root INSERT.
 *
 * Every mechanism the create root already supports falls out unchanged at any depth:
 * a parent-held-FK to-one grandchild (a before-parent create whose id the fresh
 * child's own FK references — the T1 pattern, recursive), a database-generated /
 * compound PK (the produced id threaded as a backward `Ref` / per-field identity to
 * its grandchildren), the fresh-parent adopt family (connect/connectOrCreate/upsert/
 * set under the GLOBAL fresh-parent elision, ATOM §4) and M2M through the junction.
 * The semantic refusals the create root raises (a nested `update`/`delete` in create
 * data, an M2M `upsert` under create, …) now fire byte-identically at depth — one
 * home for the create tree, not two.
 */
class NestedFreshCreatePart implements Part {
  private readonly op: CreateOperation;
  constructor(op: CreateOperation) {
    this.op = op;
  }
  planning(): readonly StatementStep[] {
    return this.op.planning().steps;
  }
  compile(_scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    return this.op.compile(known).steps;
  }
}

/**
 * N4-U2 — the seam an ADOPT arm's fresh row is built through, injected as a function
 * so `RelationUpsertPart` / `RelationWritePart` reach the create root without importing
 * this module at runtime (the {@link JunctionTargetRelationsBuilder} convention: an erased type
 * import breaks the cycle).
 *
 * A nested `upsert`/`connectOrCreate` whose probe finds nothing INSERTs a fresh row —
 * which is what a `create` root builds. Before this seam the arm emitted one hand-rolled
 * INSERT and refused every relation its payload carried beyond a single parent-held
 * to-one `connect`; now the whole arm is a create SUBTREE, so a deeper m2m, a
 * before-parent to-one `create`, a `createMany`, a globally-adopting `connect` /
 * `connectOrCreate` / `upsert`, a database-generated primary key threaded to its own
 * grandchildren, and any depth below all fall out of the create root unchanged.
 */
export type FreshArmBuilder = (input: {
  readonly childScope: QueryScope;
  readonly data: Record<string, unknown>;
  readonly incomingForeignKey: readonly ForeignKeyMember[];
  readonly relationName: string;
  readonly racePin?: TargetConstraintPin;
}) => Part;

/** The {@link FreshArmBuilder} implementation — one home for the adopt arm's fresh
 *  subtree, shared by every caller that folds an adopt family. */
export function buildFreshArmPart(
  scope: StepScope,
  engine: QueryEngine,
  input: Parameters<FreshArmBuilder>[0]
): Part {
  return new NestedFreshCreatePart(
    new CreateOperation(
      engine,
      input.childScope.model,
      {},
      {
        scope,
        skipOwnWrite: true,
        nestedFresh: {
          data: input.data,
          incomingForeignKey: input.incomingForeignKey,
          relationName: input.relationName,
          ...(input.racePin ? { rootRacePin: input.racePin } : {}),
        },
      }
    )
  );
}

function buildFreshRecordPart(input: {
  scope: StepScope;
  engine: QueryEngine;
  childScope: QueryScope;
  relationName: string;
  members: readonly ForeignKeyMember[];
  create: Record<string, unknown>;
}): Part {
  const { scope, engine, childScope, relationName, members, create } = input;
  const op = new CreateOperation(
    engine,
    childScope.model,
    {},
    {
      scope,
      skipOwnWrite: true,
      nestedFresh: {
        data: create,
        incomingForeignKey: members,
        relationName,
      },
    }
  );
  return new NestedFreshCreatePart(op);
}

/**
 * The construction-time half a nested `createMany` leaf shares across both parent-id
 * provenances: the user rows, the skipDuplicates disposition, and V1's portability
 * guard on the PRE-injection rows.
 *
 * X1b mechanism 3 — createMany skipDuplicates at depth. The composed skip leaf
 * (T4a CLASS VI, generalized one level past the create root): the skip rides the
 * plan (a dialect whose skip IS a SQL leaf carries `ON CONFLICT DO NOTHING` /
 * `INSERT OR IGNORE`; a `recoverableUniqueError` dialect — MySQL — has no leaf,
 * so each per-row statement carries the savepoint-wrapped `onUniqueConflict: skip`
 * executor effect). Byte-identical to `CreateOperation.foldCreateMany`.
 */
function planNestedCreateMany(input: {
  engine: QueryEngine;
  childScope: QueryScope;
  relationName: string;
  createManyEntry: Extract<RelationMutationEntry, { kind: "createMany" }>;
}): {
  userRows: readonly Record<string, unknown>[];
  skipDuplicates: boolean;
  recoverUnique: boolean;
} {
  const { engine, childScope } = input;
  const skipDuplicates = input.createManyEntry.skipDuplicates === true;
  const userRows = input.createManyEntry.rows;
  if (skipDuplicates) {
    // V1's portability guard, on the PRE-injection user rows (construction time): a
    // skipDuplicates createMany carrying a default-only row (no explicit user scalar
    // — the injected FK is system-derived, so it does not count) is inexpressible.
    // The FK-injected plan below never trips its OWN internal check (every row carries
    // the injected FK column), so this pre-injection check is the sole V1-parity gate
    // for the default-only shape — exactly as `foldCreateMany` runs it.
    const groups = buildValueGroups(childScope, userRows);
    assertPortableCreateManySkip(
      true,
      groups.some((group) => group.columns.length === 0)
    );
  }
  return {
    userRows,
    skipDuplicates,
    recoverUnique:
      skipDuplicates &&
      engine.adapter.mutations.skipDuplicatesStrategy ===
        "recoverableUniqueError",
  };
}

export function buildLiteralParentCreateManyPart(input: {
  scope: StepScope;
  engine: QueryEngine;
  childScope: QueryScope;
  childName: string;
  relationName: string;
  members: readonly ForeignKeyMember[];
  createManyEntry: Extract<RelationMutationEntry, { kind: "createMany" }>;
}): Part {
  const { scope, engine, childScope, childName, relationName, members } = input;
  const { userRows, skipDuplicates, recoverUnique } = planNestedCreateMany({
    engine,
    childScope,
    relationName,
    createManyEntry: input.createManyEntry,
  });
  const inject = foreignKeyInject(engine, childScope, relationName, members);
  const rows = userRows.map((row) => ({ ...row, ...inject }));
  if (rows.length === 0) return new LiteralParentWriteParts([]);
  const plan = buildCreateManyPlan(
    childScope,
    { data: rows, skipDuplicates },
    false
  );
  const steps: OperationStep[] = plan.statements.map((statement) => ({
    id: scope.allocate(`${childName}.createMany`),
    kind: "write" as const,
    statement: statement.sql,
    outputs: {},
    ...(recoverUnique ? { onUniqueConflict: "skip" as const } : {}),
  }));
  return new LiteralParentWriteParts(steps);
}

/**
 * N1-U1 — the PLANNED-parent `createMany` leaf: the same bulk plan the literal leaf
 * builds, with the located parent's referenced column(s) resolved at COMPILE from the
 * planning row ({@link foreignKeyInject}) instead of at construction. This is the
 * located-parent Ref applied to the bulk arm — `update({ where: { email }, data: {
 * posts: { createMany } } })` compiles to the SAME statements as the `where: { id }`
 * spelling, differing only in where the foreign key's value comes from.
 *
 * Step ids are allocated at CONSTRUCTION (the {@link Part} contract: ids are allocated
 * once, `compile` is a deterministic construction over them). The plan's statement
 * count is a function of which COLUMNS each row carries — `buildValueGroups` runs
 * maximal contiguous same-shape runs, and `shouldOmitInsertValue` omits only
 * `undefined` — never of their VALUES, and the injected foreign key is an `Sql`
 * fragment under both provenances. So a construction-time shape plan built with a
 * placeholder foreign key yields exactly the statements compile rebuilds; the
 * alignment is ASSERTED at compile, never assumed.
 */
export function buildPlannedParentCreateManyPart(input: {
  scope: StepScope;
  engine: QueryEngine;
  childScope: QueryScope;
  childName: string;
  relationName: string;
  members: readonly ForeignKeyMember[];
  createManyEntry: Extract<RelationMutationEntry, { kind: "createMany" }>;
}): Part {
  const { scope, engine, childScope, childName, relationName, members } = input;
  const { userRows, skipDuplicates, recoverUnique } = planNestedCreateMany({
    engine,
    childScope,
    relationName,
    createManyEntry: input.createManyEntry,
  });
  if (userRows.length === 0) return new LiteralParentWriteParts([]);
  const shapeInject = Object.fromEntries(
    members.map((member) => [
      member.foreignField,
      referenceSql(engine, childScope.model, member.foreignField, null),
    ])
  );
  const stepIds = buildCreateManyPlan(
    childScope,
    {
      data: userRows.map((row) => ({ ...row, ...shapeInject })),
      skipDuplicates,
    },
    false
  ).statements.map(() => scope.allocate(`${childName}.createMany`));
  return new PlannedParentCreatePart((known) => {
    const inject = foreignKeyInject(
      engine,
      childScope,
      relationName,
      members,
      known
    );
    const plan = buildCreateManyPlan(
      childScope,
      {
        data: userRows.map((row) => ({ ...row, ...inject })),
        skipDuplicates,
      },
      false
    );
    if (plan.statements.length !== stepIds.length) {
      throw new QueryEngineError(
        `query-engine-v2 planned-parent createMany on relation '${relationName}' compiled ${plan.statements.length} statements for ${stepIds.length} allocated step ids.`
      );
    }
    return plan.statements.map((statement, index) => ({
      id: stepIds[index]!,
      kind: "write" as const,
      statement: statement.sql,
      outputs: {},
      ...(recoverUnique ? { onUniqueConflict: "skip" as const } : {}),
    }));
  });
}

/**
 * The PLANNED-parent child-held `create` leaf (T4a CLASS VI): a `create` under a target
 * located by a PLANNED id — a parent-held to-one `update` target read by this operation's
 * own locate probe (family A-remainder). Its step ids are allocated at construction
 * (stable; the leaf owns no planning read — the enclosing operation already plans the
 * target's locate), but its INSERT statements are built at COMPILE, when the located row
 * is in `known`: the grandchild FK carries the target's captured PK, inlined as a literal
 * from that row (`planned`, ATOM §9 inv. 2 forbids a final step reffing a planning step,
 * so the value is inlined, never a SQL `Ref`) — exactly as the root's depth recursion
 * threads a first-class parent value, one step past the literal-parent reach. A
 * relation-carrying create arm (deeper create-context) still routes to V1, byte-identical
 * to the literal leaf. The leaf never becomes a correlation axis (leaf-never-axis): it is
 * an unconditional INSERT with no probe, guard, or racePin.
 */
class PlannedParentCreatePart implements Part {
  private readonly build: (known: PlanningKnown) => readonly OperationStep[];
  constructor(build: (known: PlanningKnown) => readonly OperationStep[]) {
    this.build = build;
  }
  planning(): readonly StatementStep[] {
    return [];
  }
  compile(_scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    return this.build(known);
  }
}
