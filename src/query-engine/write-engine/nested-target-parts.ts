import { QueryEngineError } from "@errors";
import { getPrimaryKeyFields } from "../builders/correlation-utils";
import type { PolymorphicStorageValue } from "../builders/polymorphic-mutation";
import {
  bindRelation,
  type ChildHeldRelation,
  hasPolymorphicMembership,
  membershipReferencedFields,
  type PolymorphicChildHeldRelation,
} from "../builders/relation-data-builder";
import {
  type ParsedRelationMutation,
  type RelationMutationEntry,
  type RelationMutationProgram,
  polymorphicCollectionArms,
  relationMutationPrograms,
} from "../builders/relation-mutation-parser";
import { buildValueGroups } from "../builders/values-builder";
import { createQueryScope } from "../context/query-scope";
import { buildCreateManyPlan } from "../operations/create";
import { assertPortableCreateManySkip } from "../operations/create-many-portability";
import type { QueryEngine } from "../query-engine";
import type { QueryScope } from "../types";
import {
  buildFreshRecordSeriesPart,
  createManyCarriesRelations,
} from "./FreshRecordSeriesPart";
import { referenceScalarSql, referenceSql } from "./fragment-builders";
import type { OperationStep, StatementStep } from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import type { RecordCompilerSeam } from "./RecordUpdateCompiler";
import { buildPolymorphicCollectionPart } from "./PolymorphicCollectionPart";
import { buildJunctionParts } from "./RelationJunctionPart";
import { buildToManyLinkParts } from "./RelationLinkPart";
import {
  buildConnectOrCreateParts,
  buildCorrelatedToManyUpsertParts,
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
import {
  bindRelationMembership,
  type FinalReferenceSource,
  type ForeignKeyMember,
  foreignKeyWriteValue,
  linkedPolymorphicStorage,
  literalReferenceSource,
  pairCorrelatedForeignKeyMembers,
  pairForeignKeyMembers,
  planningSourceFromFinal,
  resolvePolymorphicStorageValue,
} from "./relation-membership";
import type { StepScope } from "./StepScope";
import { getStepModelName } from "./shared";
import { buildTargetProjection } from "./target-projection";

/** Located-target relation composition below the selected-record compiler. */

/**
 * How a located-by-PK target's relations are folded one level deeper — the recursion
 * seam {@link RelationWritePart} calls without importing this module at runtime (an
 * erased type import breaks the cycle).
 *
 * `membershipReadSource` names the value EXISTING membership is read by, beside the
 * `parentId` new membership is written with. It is REQUIRED, and every caller
 * states its own answer: they are the same source wherever the parent's referenced
 * value is not in transition, and defaulting one to the other is exactly the
 * old-from-new inference this seam refuses.
 *
 * DELIBERATELY TWO POSITIONAL SOURCES rather than one
 * source-bound membership, for the reason recorded on `WritePartBase.membershipReadSource`:
 * the read source's narrowing is lazy and kind-named, so binding it once per edge
 * would move a refusal and rewrite its sentence.
 */
export type JunctionTargetRelationsBuilder = (
  targetScope: QueryScope,
  parentId: FinalReferenceSource,
  relations: readonly ParsedRelationMutation[],
  txMode: boolean,
  membershipReadSource: FinalReferenceSource
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
  relations: readonly ParsedRelationMutation[],
  parentId: FinalReferenceSource,
  txMode: boolean,
  recordCompilers: RecordCompilerSeam,
  membershipReadSource: FinalReferenceSource
): readonly Part[] {
  const parts: Part[] = [];
  for (const program of relationMutationPrograms(relations)) {
    foldJunctionTargetRelation({
      scope,
      engine,
      targetScope,
      program,
      parentId,
      recordCompilers,
      membershipReadSource,
      txMode,
      parts,
    });
  }
  // MOUNT 3 of 3 — a direct polymorphic collection nested under a junction
  // target's create/update. VISITED, not skipped: `relationMutationPrograms` is
  // deliberately a positive filter now, so this arm is invisible to the loop
  // above, and letting it stay invisible here is precisely the silent-drop class
  // this estate keeps recording.
  for (const arm of polymorphicCollectionArms(relations)) {
    parts.push(
      buildPolymorphicCollectionPart({
        scope,
        engine,
        parentScope: targetScope,
        arm,
        parentId: singleFieldOwnerSources(targetScope, arm.name, parentId),
        membershipReadSource: singleFieldOwnerSources(
          targetScope,
          arm.name,
          membershipReadSource
        ),
        txMode,
        recordCompilers,
        nestedBuilder: (
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
            recordCompilers,
            deeperCorrelationParentId
          ),
      })
    );
  }
  return parts;
}

/**
 * Broadcast this seam's ONE positional parent source over the owner's row key.
 *
 * The seam carries a single `FinalReferenceSource` by construction, so a
 * compound-keyed owner is refused here for the same reason and in the same voice
 * as the compound junction parent above: the complete record compiler owns that
 * target, and inventing a second source for the missing members would be a guess.
 */
function singleFieldOwnerSources(
  targetScope: QueryScope,
  relationKey: string,
  source: FinalReferenceSource
): Record<string, FinalReferenceSource> {
  const ownerFields = getPrimaryKeyFields(targetScope.model);
  const ownerField = ownerFields[0];
  if (ownerFields.length !== 1 || !ownerField) {
    throw new QueryEngineError(
      `query-engine-v2 internal: a compound-keyed owner reached the scalar nested-target seam for polymorphic collection '${relationKey}'; the complete record compiler must own that target.`
    );
  }
  return { [ownerField]: source };
}

function foldJunctionTargetRelation(input: {
  scope: StepScope;
  engine: QueryEngine;
  targetScope: QueryScope;
  program: RelationMutationProgram;
  parentId: FinalReferenceSource;
  recordCompilers: RecordCompilerSeam;
  /** What EXISTING membership is read by; equal to `parentId` with no transition. */
  membershipReadSource: FinalReferenceSource;
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
  // captured, depth adding list entries and one parent-id value.
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
      input.recordCompilers,
      deeperCorrelationParentId
    );

  if (relation.position === "junction") {
    if (relation.membership.source.members.length !== 1) {
      throw new QueryEngineError(
        `query-engine-v2 internal: a compound junction parent reached the scalar nested-target seam for relation '${relationName}'; the complete record compiler must own that target.`
      );
    }
    const sourceField = relation.membership.source.members[0]?.referencedField;
    if (!sourceField) {
      throw new QueryEngineError(
        `query-engine-v2 internal: junction relation '${relationName}' has no source row-key member.`
      );
    }
    const parentSources = { [sourceField]: parentId };
    const readSources = {
      [sourceField]: input.membershipReadSource,
    };
    // Junction targets recurse through the same relation builder.
    input.parts.push(
      ...buildJunctionParts({
        scope,
        engine,
        parentScope: targetScope,
        relation,
        program,
        parentId: parentSources,
        membershipReadSource: readSources,
        txMode,
        recordCompilers: input.recordCompilers,
        nestedBuilder: deeperBuilder,
      })
    );
    return;
  }

  if (relation.position === "parentHeld") {
    // A parent-held edge must already have folded into the selected record's SET.
    throw new QueryEngineError(
      `query-engine-v2 internal: a parent-held to-one on relation '${relationName}' reached the junction target relation builder; it requires the whole fresh-record compiler.`
    );
  }

  // Non-PK references require the selected-record compiler's captured projection;
  // this lower builder can consume only the target's single primary key.
  const targetPrimaryKeys = getPrimaryKeyFields(targetScope.model);
  const referenced = membershipReferencedFields(relation.membership);
  const referencesTargetPk =
    targetPrimaryKeys.length === 1 &&
    referenced.length === 1 &&
    referenced[0] === targetPrimaryKeys[0];
  if (!referencesTargetPk) {
    throw new QueryEngineError(
      `query-engine-v2 internal: a non-primary-key referenced edge on relation '${relationName}' reached the junction target relation builder; it requires the whole fresh-record compiler.`
    );
  }

  const childScope = createQueryScope(engine.adapter, relationInfo.targetModel);
  const childName = getStepModelName(relationInfo.targetModel, relationName);
  const writeBase = {
    scope,
    engine,
    relation,
    childName,
    childScope,
    // Every targeted arm below addresses its child by the complete row key this
    // projection publishes, so a compound-keyed child needs no separate route.
    targetProjection: buildTargetProjection(childScope.model),
    parentId,
    membershipReadSource: input.membershipReadSource,
    txMode,
    nestedBuilder: deeperBuilder,
    recordCompilers: input.recordCompilers,
  } as const;

  for (const entry of program.entries) {
    foldJunctionChildHeldEntry({
      entry,
      recordCompilers: input.recordCompilers,
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
  recordCompilers: RecordCompilerSeam;
  childScope: QueryScope;
  childName: string;
  relation: ChildHeldRelation;
  writeBase: Parameters<typeof buildToManyUpdateParts>[0];
  scope: StepScope;
  engine: QueryEngine;
  parentId: FinalReferenceSource;
  txMode: boolean;
  parts: Part[];
}): void {
  const {
    entry,
    recordCompilers,
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
  const isInverseToOne = relation.cardinality === "one";
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
          writeBase.targetProjection,
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
          entry.items,
          bindRelationMembership(relation, parentId),
          txMode,
          recordCompilers
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
      if (hasPolymorphicMembership(relation)) {
        // A GLOBAL adopt, not a correlated one: every target this builder folds under
        // is a row the enclosing statement is INSERTing, so there is no committed
        // membership for a correlated probe to find. That is the documented rule for a
        // fresh parent (query-engine/AGENTS.md, "For inverse writes … A fresh-parent
        // upsert also adopts globally").
        // A correlated twin stood here behind `if (membershipReadSource)` and is
        // deleted. Presence of a read source was never the question
        // this position asks — freshness is — and with the source now required the
        // branch would have flipped every fresh polymorphic upsert to a correlated
        // probe. It had been unreachable since it was written: `nestedBuilder` has one
        // invocation (`RelationJunctionPart`'s inline fresh-target insert) and it
        // supplied no read source.
        push(
          buildToManyUpsertParts(
            scope,
            engine,
            entry.items,
            bindRelationMembership(relation, parentId),
            txMode,
            recordCompilers
          )
        );
        return;
      }
      const boundMembers = relation.membership.members;
      const members = pairCorrelatedForeignKeyMembers(
        boundMembers,
        boundMembers.map(() =>
          planningSourceFromFinal(parentId, relationName, "upsert")
        ),
        boundMembers.map(() => parentId)
      );
      push(
        buildCorrelatedToManyUpsertParts(
          scope,
          engine,
          entry.items,
          { kind: "foreignKey", relation, members },
          txMode,
          recordCompilers
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
        // Prisma's no-op, dropped from the kind list).
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
      parts.push(
        ...entry.items.map((data) =>
          recordCompilers.createFresh(scope, {
            childScope,
            data,
            incomingMembership: bindRelationMembership(relation, parentId),
            relationName,
          })
        )
      );
      return;
    }
    case "createMany": {
      if (createManyCarriesRelations(childScope, entry)) {
        parts.push(
          buildFreshRecordSeriesPart({
            scope,
            engine,
            childScope,
            childName,
            relationName,
            rows: entry.rows,
            incomingMembership: bindRelationMembership(relation, parentId),
            skipDuplicates: entry.skipDuplicates === true,
            createFresh: recordCompilers.createFresh,
          })
        );
        return;
      }
      // Literal parents inject now; planned parents inject the captured value at
      // compile. Skip semantics are independent of that provenance.
      if (hasPolymorphicMembership(relation)) {
        parts.push(
          buildPolymorphicParentCreateManyPart({
            scope,
            engine,
            childScope,
            childName,
            relation,
            parentId,
            createManyEntry: entry,
          })
        );
        return;
      }
      const boundMembers = relation.membership.members;
      const members = pairForeignKeyMembers(
        boundMembers,
        boundMembers.map(() => parentId)
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
      // Every parsed to-many entry has a case above.
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

/** Plan nested createMany before parent FK injection. Duplicate skipping uses the
 * same SQL leaf or recoverable-conflict effect as the root createMany path. */
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
  const userRows = input.createManyEntry.rows.map((row) => row.parsed);
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
    false,
    undefined,
    engine.maxBindParametersPerStatement
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

/** Planned-parent createMany resolves captured FK values at compile. IDs are
 * allocated from a shape-only placeholder plan; compile verifies that injection
 * preserves the statement count before pairing IDs with statements. */
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
    false,
    undefined,
    engine.maxBindParametersPerStatement
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
      false,
      undefined,
      engine.maxBindParametersPerStatement
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

export function buildPolymorphicParentCreateManyPart(input: {
  scope: StepScope;
  engine: QueryEngine;
  childScope: QueryScope;
  childName: string;
  relation: PolymorphicChildHeldRelation;
  parentId: FinalReferenceSource;
  createManyEntry: Extract<RelationMutationEntry, { kind: "createMany" }>;
}): Part {
  const { scope, engine, childScope, childName, relation, parentId } = input;
  const { userRows, skipDuplicates, recoverUnique } = planNestedCreateMany({
    engine,
    childScope,
    relationName: relation.relationInfo.name,
    createManyEntry: input.createManyEntry,
  });
  if (userRows.length === 0) return new LiteralParentWriteParts([]);
  const shapeStorage: PolymorphicStorageValue<unknown> = {
    ...linkedPolymorphicStorage(relation.membership, parentId),
    id: referenceScalarSql(
      engine,
      relation.membership.storage.idColumn.scalar,
      relation.membership.storage.idColumn.name,
      null
    ),
  };
  const stepIds = buildCreateManyPlan(
    childScope,
    { data: userRows, skipDuplicates },
    false,
    shapeStorage,
    engine.maxBindParametersPerStatement
  ).statements.map(() => scope.allocate(`${childName}.createMany`));
  return new PlannedParentCreatePart((known) => {
    const storage = resolvePolymorphicStorageValue(
      engine,
      linkedPolymorphicStorage(relation.membership, parentId),
      known,
      "create"
    );
    const plan = buildCreateManyPlan(
      childScope,
      { data: userRows, skipDuplicates },
      false,
      storage,
      engine.maxBindParametersPerStatement
    );
    if (plan.statements.length !== stepIds.length) {
      throw new QueryEngineError(
        `query-engine-v2 polymorphic createMany on relation '${relation.relationInfo.name}' compiled ${plan.statements.length} statements for ${stepIds.length} allocated step ids.`
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

/** A compile-time leaf whose captured parent FK is known only after planning.
 * Final SQL inlines that value; it never references a discarded planning step. */
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
