import { QueryEngineError } from "@errors";
import { getPrimaryKeyFields } from "../query-engine/builders/correlation-utils";
import {
  getFkDirection,
  type RelationMutation,
  separateData,
} from "../query-engine/builders/relation-data-builder";
import { getRelationMutationKinds } from "../query-engine/builders/relation-mutation-parser";
import { buildInsert } from "../query-engine/builders/values-builder";
import {
  createQueryScope,
  getTableName,
} from "../query-engine/context/query-scope";
import { buildCreateManyPlan } from "../query-engine/operations/create";
import type { QueryEngine } from "../query-engine/query-engine";
import type { QueryScope } from "../query-engine/types";
import { referenceSql } from "./fragment-builders";
import type { OperationStep } from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { referencedFieldValue } from "./parent-reference";
import { buildJunctionParts } from "./RelationJunctionPart";
import { buildToManyLinkParts } from "./RelationLinkPart";
import {
  buildConnectOrCreateParts,
  buildToManyUpsertParts,
  literalParentId,
  type ParentIdSource,
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
 * `ParentIdSource` (a compile-time literal here, a planned locate read at the root):
 * one architecture, one vocabulary, depth adds list entries and one parent-id value.
 *
 * A **parent-held FK to-one at depth** (the located target itself holds an FK it would
 * rewrite in its own SET) needs child-SET folding this depth builder does not carry;
 * it throws {@link UnsupportedOperationError} so the whole tree routes to V1 — a
 * documented narrower boundary (no family-B/A-remainder census shape reaches it).
 */

/** How a located-by-PK target's relations are folded one level deeper — the
 *  recursion seam {@link RelationWritePart} calls without importing this module at
 *  runtime (an erased type import breaks the cycle). */
export type NestedChildBuilder = (
  targetScope: QueryScope,
  parentId: ParentIdSource,
  relations: Record<string, RelationMutation>,
  txMode: boolean
) => readonly Part[];

/**
 * Fold every relation mutation in a located-by-PK target's data into deeper Parts,
 * correlated to the target's own (literal) primary key. The `parentId` is a
 * {@link literalParentId} in the child-held case (the located target's `where` PK)
 * and a planned source in the parent-held case (the parent-held probe's captured id).
 */
export function buildNestedTargetChildParts(
  scope: StepScope,
  engine: QueryEngine,
  targetScope: QueryScope,
  relations: Record<string, RelationMutation>,
  parentId: ParentIdSource,
  txMode: boolean
): readonly Part[] {
  const parts: Part[] = [];
  for (const [relationName, mutation] of Object.entries(relations)) {
    foldOneNestedRelation({
      scope,
      engine,
      targetScope,
      relationName,
      mutation,
      parentId,
      txMode,
      parts,
    });
  }
  return parts;
}

function foldOneNestedRelation(input: {
  scope: StepScope;
  engine: QueryEngine;
  targetScope: QueryScope;
  relationName: string;
  mutation: RelationMutation;
  parentId: ParentIdSource;
  txMode: boolean;
  parts: Part[];
}): void {
  const {
    scope,
    engine,
    targetScope,
    relationName,
    mutation,
    parentId,
    txMode,
  } = input;
  const relationInfo = mutation.relationInfo;
  const parsedRelation = mutation as unknown as Record<string, unknown>;

  // The recursion seam threaded to every kind that may carry its own relations one
  // level deeper (the m2m junction here; the child-held write/link/adopt families
  // via `writeBase` below): the same builder, one operation's scope + engine
  // captured, depth adding list entries and one parent-id value (WHY §4.2).
  const deeperBuilder: NestedChildBuilder = (
    deeperScope,
    deeperParentId,
    deeperRelations,
    deeperTxMode
  ) =>
    buildNestedTargetChildParts(
      scope,
      engine,
      deeperScope,
      deeperRelations,
      deeperParentId,
      deeperTxMode
    );

  if (relationInfo.type === "manyToMany") {
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
        relationName,
        relationInfo,
        mutation,
        parsedRelation,
        parentId,
        txMode,
        nestedBuilder: deeperBuilder,
      })
    );
    return;
  }

  const fk = getFkDirection(targetScope, relationInfo);
  if (fk.holdsFK) {
    // The located target holds this FK — a same-row change it would fold into its own
    // SET (a deeper parent-held to-one). Out of the update-arm literal-parent surface;
    // route the whole tree to V1.
    throw new UnsupportedOperationError(
      `query-engine-v2 update does not support a nested parent-held to-one write on relation '${relationName}' one level deeper.`
    );
  }

  const isInverseToOne = relationInfo.isToOne;
  if (!(isInverseToOne || relationInfo.type === "oneToMany")) {
    throw new UnsupportedOperationError(
      `query-engine-v2 update supports only child-held one-to-many or inverse-side one-to-one relations one level deeper; relation '${relationName}' is '${relationInfo.type}'.`
    );
  }

  // T3b-2 (named reorder obligation, TO-ONE.md §7.7): the deeper FK must reference the
  // located target's OWN single primary key. The literal/planned parent id carries the
  // target's PK per-field, so a **D4-style deeper edge referencing a non-PK unique** (or
  // a compound-arity reference) would be mis-injected with the PK value AND would miss
  // the PK-only reorder check — so route it to V1 instead of diverging silently. The
  // root threads a non-PK reference from its located row (D4 at the root, family E); the
  // literal-parent depth builder cannot, so this is a documented narrower boundary. No
  // absorbed census key reaches it (every deeper edge references the target PK). Witness:
  // nested-update-d4-deep-nonpk-reference.test.ts.
  const targetPrimaryKeys = getPrimaryKeyFields(targetScope.model);
  const referencesTargetPk =
    targetPrimaryKeys.length === 1 &&
    fk.pkFields.length === 1 &&
    fk.pkFields[0] === targetPrimaryKeys[0];
  if (!referencesTargetPk) {
    throw new UnsupportedOperationError(
      `query-engine-v2 update does not support a nested relation on '${relationName}' whose foreign key references a non-primary-key column of the target one level deeper.`
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
    relationName,
    relationInfo,
    childName,
    childScope,
    fkFields: fk.fkFields,
    referencedFields: fk.pkFields,
    childPrimaryKey: childPrimaryKeys[0]!,
    parentId,
    txMode,
    nestedBuilder: deeperBuilder,
  } as const;

  for (const kind of getRelationMutationKinds(mutation)) {
    foldOneChildHeldKind({
      kind,
      isInverseToOne,
      relationName,
      relationInfo,
      parsedRelation,
      childScope,
      childName,
      fk,
      writeBase,
      scope,
      engine,
      targetScope,
      parentId,
      txMode,
      parts: input.parts,
    });
  }
}

function foldOneChildHeldKind(args: {
  kind: string;
  isInverseToOne: boolean;
  relationName: string;
  relationInfo: RelationMutation["relationInfo"];
  parsedRelation: Record<string, unknown>;
  childScope: QueryScope;
  childName: string;
  fk: ReturnType<typeof getFkDirection>;
  writeBase: Parameters<typeof buildToManyUpdateParts>[0];
  scope: StepScope;
  engine: QueryEngine;
  targetScope: QueryScope;
  parentId: ParentIdSource;
  txMode: boolean;
  parts: Part[];
}): void {
  const {
    kind,
    isInverseToOne,
    relationName,
    relationInfo,
    parsedRelation,
    childScope,
    childName,
    fk,
    writeBase,
    scope,
    engine,
    targetScope,
    parentId,
    txMode,
    parts,
  } = args;
  const push = (built: readonly Part[]) => parts.push(...built);

  switch (kind) {
    case "connect":
    case "disconnect":
      push(
        buildToManyLinkParts(
          scope,
          engine,
          relationName,
          relationInfo,
          childName,
          childScope,
          fk.fkFields,
          fk.pkFields,
          writeBase.childPrimaryKey,
          kind,
          isInverseToOne && kind === "disconnect" ? true : parsedRelation[kind],
          parentId,
          txMode
        )
      );
      return;
    case "connectOrCreate":
      push(
        buildConnectOrCreateParts(
          scope,
          targetScope,
          engine,
          relationName,
          relationInfo,
          normalizeItems(parsedRelation.connectOrCreate, relationName),
          parentId,
          txMode
        )
      );
      return;
    case "upsert":
      if (isInverseToOne) {
        parts.push(
          buildInverseToOneUpsertPart(writeBase, parsedRelation.upsert)
        );
        return;
      }
      push(
        buildToManyUpsertParts(
          scope,
          targetScope,
          engine,
          relationName,
          relationInfo,
          normalizeItems(parsedRelation.upsert, relationName),
          parentId,
          "correlated",
          txMode
        )
      );
      return;
    case "update":
      if (isInverseToOne) {
        parts.push(buildToOneUpdatePart(writeBase, parsedRelation.update));
        return;
      }
      push(buildToManyUpdateParts(writeBase, parsedRelation.update));
      return;
    case "updateMany":
      push(buildToManyUpdateManyParts(writeBase, parsedRelation.updateMany));
      return;
    case "delete":
      if (isInverseToOne) {
        if (parsedRelation.delete !== true) {
          throw new UnsupportedOperationError(
            `query-engine-v2 update supports only 'delete: true' on the inverse-side to-one relation '${relationName}' one level deeper.`
          );
        }
        push(buildToManyDeleteManyParts(writeBase, {}));
        return;
      }
      push(buildToManyDeleteParts(writeBase, parsedRelation.delete));
      return;
    case "deleteMany":
      push(buildToManyDeleteManyParts(writeBase, parsedRelation.deleteMany));
      return;
    case "set":
      parts.push(buildToManySetPart(writeBase, parsedRelation.set));
      return;
    case "create":
      // A child-held `create` leaf under a located target. A LITERAL parent id (a
      // child-held nested update located by its `where` PK) resolves its FK at
      // construction; a PLANNED parent id (a parent-held to-one `update` target,
      // located by this operation's planning read) resolves its FK at COMPILE — the
      // created row's FK carries the target's captured PK, inlined from the located
      // planning row exactly as the root's depth recursion threads a first-class
      // parent value (T4a CLASS VI, one step past the literal-parent reach).
      parts.push(
        ...(parentId.kind === "literal"
          ? buildLiteralParentCreatePart({
              scope,
              engine,
              childScope,
              childName,
              relationName,
              fk,
              parentId,
              txMode,
              creates: normalizeItems(parsedRelation.create, relationName),
            })
          : buildPlannedParentCreatePart({
              scope,
              engine,
              childScope,
              childName,
              relationName,
              fk,
              parentId,
              txMode,
              creates: normalizeItems(parsedRelation.create, relationName),
            }))
      );
      return;
    case "createMany":
      if (parentId.kind !== "literal") {
        // A `createMany` under a PLANNED parent-held target (a parent-held to-one
        // `update` whose target bulk-creates a to-many child) is a documented finer
        // boundary one step past the CLASS VI create leaf: no estate scenario reaches
        // it, so it is left measured-not-curated and routes the whole tree to V1. The
        // single-`create` planned leaf above is the exact CLASS VI absorption.
        throw new UnsupportedOperationError(
          `query-engine-v2 update does not support a nested createMany on relation '${relationName}' under a parent-held target one level deeper.`
        );
      }
      parts.push(
        buildLiteralParentCreateManyPart({
          scope,
          engine,
          childScope,
          childName,
          relationName,
          fk,
          parentId,
          createManyInput: parsedRelation.createMany,
        })
      );
      return;
    default:
      throw new UnsupportedOperationError(
        `query-engine-v2 update does not support nested '${kind}' on relation '${relationName}' one level deeper.`
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
  planning(): readonly OperationStep[] {
    return [];
  }
  compile(_scope: StepScope, _known: PlanningKnown): readonly OperationStep[] {
    return this.steps;
  }
}

/** The child FK columns a LITERAL-parent create/createMany leaf writes, resolved at
 *  construction — the located target's own `where` PK is a compile-time constant, so
 *  `referencedFieldValue` returns it directly (no planning row needed). Dispatched only
 *  for `parentId.kind === "literal"`; the planned case uses {@link plannedFkInject}. */
function literalFkInject(
  engine: QueryEngine,
  childScope: QueryScope,
  fk: ReturnType<typeof getFkDirection>,
  relationName: string,
  parentId: ParentIdSource
): Record<string, unknown> {
  const inject: Record<string, unknown> = {};
  for (let index = 0; index < fk.fkFields.length; index += 1) {
    const fkField = fk.fkFields[index]!;
    inject[fkField] = referenceSql(
      engine,
      childScope.model,
      fkField,
      referencedFieldValue(
        parentId,
        fk.pkFields[index]!,
        undefined,
        relationName,
        "create"
      )
    );
  }
  return inject;
}

export function buildLiteralParentCreatePart(input: {
  scope: StepScope;
  engine: QueryEngine;
  childScope: QueryScope;
  childName: string;
  relationName: string;
  fk: ReturnType<typeof getFkDirection>;
  parentId: ParentIdSource;
  txMode: boolean;
  creates: readonly Record<string, unknown>[];
}): readonly Part[] {
  const {
    scope,
    engine,
    childScope,
    childName,
    relationName,
    fk,
    parentId,
    txMode,
  } = input;
  const inject = literalFkInject(
    engine,
    childScope,
    fk,
    relationName,
    parentId
  );
  // Loop 1: the fresh child INSERTs. Allocation is IDENTICAL to the pre-X1
  // scalar-only leaf (one id per item, in order), so no create-context grandchild
  // shifts an existing scalar-only oracle's step ids.
  const items = input.creates.map((create) => {
    const { scalarData, relations } = separateData(childScope, create);
    return {
      scalarData,
      relations,
      step: {
        id: scope.allocate(`${childName}.create`),
        kind: "write" as const,
        statement: buildInsert(childScope, getTableName(childScope.model), {
          ...scalarData,
          ...inject,
        }),
        outputs: {},
      } satisfies OperationStep,
    };
  });
  const parts: Part[] = [
    new LiteralParentWriteParts(items.map((item) => item.step)),
  ];
  // Loop 2 (X1 depth lift): each fresh child that carries its own nested writes
  // folds its create-context grandchildren one level deeper, correlated to the
  // fresh child's OWN literal primary key — the same seam, no counter.
  for (const item of items) {
    if (Object.keys(item.relations).length > 0) {
      parts.push(
        ...buildFreshCreateGrandchildParts({
          scope,
          engine,
          childScope,
          relationName,
          scalarData: item.scalarData,
          relations: item.relations,
          txMode,
        })
      );
    }
  }
  return parts;
}

/**
 * X1 depth lift — a fresh nested `create` arm's create-context grandchildren.
 *
 * A `create` under a located target may itself carry nested `create`/`createMany`
 * relations (a create SUBTREE). The fresh child's own primary key is a
 * construction-time literal (validation materializes generated string defaults),
 * so it is a LITERAL PARENT for its grandchildren — the SAME
 * {@link buildNestedTargetChildParts} seam, one level deeper, bounded only by the
 * payload: a nested-create chain of any depth folds into a plain list of INSERTs,
 * each grandchild's FK inlined from its parent's literal PK. No depth counter, no
 * one-more-level special case — level N and level N+1 run identical code.
 *
 * Pure CREATE-CONTEXT only. A fresh parent has no committed children, so the adopt
 * family (connect/connectOrCreate/upsert/set) would need CreateOperation's GLOBAL
 * fresh-parent elision, not the correlated probe this seam builds; those — plus an
 * m2m or parent-held-FK grandchild, and a compound-PK or database-generated
 * (auto-increment) fresh child, whose PK is not a construction-time literal — stay
 * declined as documented narrower boundaries (each a real seam difference, not a
 * depth boundary).
 */
function buildFreshCreateGrandchildParts(input: {
  scope: StepScope;
  engine: QueryEngine;
  childScope: QueryScope;
  relationName: string;
  scalarData: Record<string, unknown>;
  relations: Record<string, RelationMutation>;
  txMode: boolean;
}): readonly Part[] {
  const {
    scope,
    engine,
    childScope,
    relationName,
    scalarData,
    relations,
    txMode,
  } = input;
  const primaryKeys = getPrimaryKeyFields(childScope.model);
  if (primaryKeys.length !== 1) {
    // A compound-PK fresh child cannot be a single-field {@link literalParentId};
    // its grandchildren need per-field literal folding this seam does not carry.
    throw new UnsupportedOperationError(
      `query-engine-v2 update does not support a nested create carrying its own relations on relation '${relationName}' when the created row has a compound primary key one level deeper.`
    );
  }
  const pkField = primaryKeys[0]!;
  if (!Object.hasOwn(scalarData, pkField)) {
    // A database-generated (auto-increment) fresh child has no construction-time
    // PK literal; its grandchildren would need a backward Ref (CreateOperation's
    // root create-tree mechanism), which this fresh-parent leaf does not thread.
    throw new UnsupportedOperationError(
      `query-engine-v2 update does not support a nested create carrying its own relations on relation '${relationName}' when the created row's primary key '${pkField}' is database-generated one level deeper.`
    );
  }
  assertFreshCreateContext(childScope, relations, relationName);
  return buildNestedTargetChildParts(
    scope,
    engine,
    childScope,
    relations,
    literalParentId(scalarData[pkField]),
    txMode
  );
}

/** Every relation on a fresh nested `create` arm must be a child-held to-many /
 *  inverse-side to-one carrying only `create`/`createMany` (a pure create-context
 *  subtree). Any adopt-family kind, m2m, or parent-held-FK edge needs a mechanism the
 *  fresh-parent create seam does not carry and stays a declined narrower boundary. The
 *  guard is re-asserted at every level (each recursion re-enters this leaf), so the
 *  whole subtree is create-context — no correlated probe ever runs under a fresh row. */
function assertFreshCreateContext(
  childScope: QueryScope,
  relations: Record<string, RelationMutation>,
  relationName: string
): void {
  for (const [childRelation, mutation] of Object.entries(relations)) {
    const relationInfo = mutation.relationInfo;
    if (relationInfo.type === "manyToMany") {
      throw new UnsupportedOperationError(
        `query-engine-v2 update does not support a nested many-to-many write in the create data of relation '${relationName}' one level deeper.`
      );
    }
    if (getFkDirection(childScope, relationInfo).holdsFK) {
      throw new UnsupportedOperationError(
        `query-engine-v2 update does not support a nested parent-held to-one write in the create data of relation '${relationName}' one level deeper.`
      );
    }
    for (const kind of getRelationMutationKinds(mutation)) {
      if (kind !== "create" && kind !== "createMany") {
        throw new UnsupportedOperationError(
          `query-engine-v2 update does not support a nested '${kind}' on relation '${childRelation}' in the create data of relation '${relationName}' one level deeper.`
        );
      }
    }
  }
}

export function buildLiteralParentCreateManyPart(input: {
  scope: StepScope;
  engine: QueryEngine;
  childScope: QueryScope;
  childName: string;
  relationName: string;
  fk: ReturnType<typeof getFkDirection>;
  parentId: ParentIdSource;
  createManyInput: unknown;
}): Part {
  const { scope, engine, childScope, childName, relationName, fk, parentId } =
    input;
  const createMany = requireRecord(
    input.createManyInput,
    `${relationName}.createMany`
  );
  if (createMany.skipDuplicates === true) {
    throw new UnsupportedOperationError(
      `query-engine-v2 update does not support nested createMany skipDuplicates on relation '${relationName}' one level deeper.`
    );
  }
  const inject = literalFkInject(
    engine,
    childScope,
    fk,
    relationName,
    parentId
  );
  const rows = normalizeItems(createMany.data, relationName).map((row) => ({
    ...row,
    ...inject,
  }));
  if (rows.length === 0) return new LiteralParentWriteParts([]);
  const plan = buildCreateManyPlan(childScope, { data: rows }, false);
  const steps: OperationStep[] = plan.statements.map((statement) => ({
    id: scope.allocate(`${childName}.createMany`),
    kind: "write" as const,
    statement: statement.sql,
    outputs: {},
  }));
  return new LiteralParentWriteParts(steps);
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
  planning(): readonly OperationStep[] {
    return [];
  }
  compile(_scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    return this.build(known);
  }
}

/** The child FK columns a planned-parent create leaf writes, resolved at COMPILE: the
 *  located target's referenced PK value is read from `known` and inlined as a literal.
 *  One entry per (single-field, here) FK column. */
function plannedFkInject(
  engine: QueryEngine,
  childScope: QueryScope,
  fk: ReturnType<typeof getFkDirection>,
  relationName: string,
  parentId: ParentIdSource,
  known: PlanningKnown
): Record<string, unknown> {
  const inject: Record<string, unknown> = {};
  for (let index = 0; index < fk.fkFields.length; index += 1) {
    const fkField = fk.fkFields[index]!;
    inject[fkField] = referenceSql(
      engine,
      childScope.model,
      fkField,
      referencedFieldValue(
        parentId,
        fk.pkFields[index]!,
        known,
        relationName,
        "create"
      )
    );
  }
  return inject;
}

export function buildPlannedParentCreatePart(input: {
  scope: StepScope;
  engine: QueryEngine;
  childScope: QueryScope;
  childName: string;
  relationName: string;
  fk: ReturnType<typeof getFkDirection>;
  parentId: ParentIdSource;
  txMode: boolean;
  creates: readonly Record<string, unknown>[];
}): readonly Part[] {
  const {
    scope,
    engine,
    childScope,
    childName,
    relationName,
    fk,
    parentId,
    txMode,
  } = input;
  // Separate + validate + allocate ids at construction; resolve the FK at compile.
  // Allocation is IDENTICAL to the pre-X1 leaf (one id per item, in order).
  const items = input.creates.map((create) => {
    const { scalarData, relations } = separateData(childScope, create);
    return { scalarData, relations, id: scope.allocate(`${childName}.create`) };
  });
  const parts: Part[] = [
    new PlannedParentCreatePart((known) => {
      const inject = plannedFkInject(
        engine,
        childScope,
        fk,
        relationName,
        parentId,
        known
      );
      return items.map((item) => ({
        id: item.id,
        kind: "write" as const,
        statement: buildInsert(childScope, getTableName(childScope.model), {
          ...item.scalarData,
          ...inject,
        }),
        outputs: {},
      }));
    }),
  ];
  // X1 depth lift: create-context grandchildren correlate to the fresh child's own
  // literal PK (from its create data — independent of the planned parent), so the
  // whole subtree is construction-time, one step past the planned-parent leaf.
  for (const item of items) {
    if (Object.keys(item.relations).length > 0) {
      parts.push(
        ...buildFreshCreateGrandchildParts({
          scope,
          engine,
          childScope,
          relationName,
          scalarData: item.scalarData,
          relations: item.relations,
          txMode,
        })
      );
    }
  }
  return parts;
}

function normalizeItems(
  value: unknown,
  relation: string
): Record<string, unknown>[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (!(item && typeof item === "object")) {
      throw new QueryEngineError(
        `query-engine-v2 update requires an object item for relation '${relation}' one level deeper.`
      );
    }
    return item as Record<string, unknown>;
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new QueryEngineError(`'${label}' must be an object.`);
}
