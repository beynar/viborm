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

  if (relationInfo.type === "manyToMany") {
    // Many-to-many is not special (WHY §4.3): junction as ordinary Parts, correlated
    // to the located target's literal PK (its membership reads inline the literal —
    // RelationJunctionPart.parentRef).
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

  const childScope = createQueryScope(engine.adapter, relationInfo.targetModel);
  const childPrimaryKeys = getPrimaryKeyFields(childScope.model);
  if (childPrimaryKeys.length !== 1) {
    throw new UnsupportedOperationError(
      `query-engine-v2 update requires a child with one primary key for relation '${relationName}' one level deeper.`
    );
  }
  const childName = getStepModelName(relationInfo.targetModel, relationName);
  // The recursion seam: a nested `update` whose located target data carries its own
  // relations folds them one level deeper through this same builder, with the scope
  // and engine of the enclosing operation captured here.
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
      parts.push(
        buildLiteralParentCreatePart({
          scope,
          engine,
          childScope,
          childName,
          relationName,
          fk,
          parentId,
          creates: normalizeItems(parsedRelation.create, relationName),
        })
      );
      return;
    case "createMany":
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

function buildLiteralParentCreatePart(input: {
  scope: StepScope;
  engine: QueryEngine;
  childScope: QueryScope;
  childName: string;
  relationName: string;
  fk: ReturnType<typeof getFkDirection>;
  parentId: ParentIdSource;
  creates: readonly Record<string, unknown>[];
}): Part {
  const { scope, engine, childScope, childName, relationName, fk, parentId } =
    input;
  const inject = literalFkInject(
    engine,
    childScope,
    fk,
    relationName,
    parentId
  );
  const steps: OperationStep[] = input.creates.map((create) => {
    const { scalarData, relations } = separateData(childScope, create);
    if (Object.keys(relations).length > 0) {
      // A relation-carrying create arm one level deeper is create-context depth
      // (fresh-parent recursion, a later mechanism) — route the whole tree to V1.
      throw new UnsupportedOperationError(
        `query-engine-v2 update does not support nested relation writes in the create data of relation '${relationName}' one level deeper.`
      );
    }
    return {
      id: scope.allocate(`${childName}.create`),
      kind: "write" as const,
      statement: buildInsert(childScope, getTableName(childScope.model), {
        ...scalarData,
        ...inject,
      }),
      outputs: {},
    };
  });
  return new LiteralParentWriteParts(steps);
}

function buildLiteralParentCreateManyPart(input: {
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
