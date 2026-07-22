import { QueryEngineError } from "@errors";
import { getPrimaryKeyFields } from "../query-engine/builders/correlation-utils";
import {
  getFkDirection,
  type RelationMutation,
  separateData,
} from "../query-engine/builders/relation-data-builder";
import { getRelationMutationKinds } from "../query-engine/builders/relation-mutation-parser";
import {
  buildInsert,
  buildValueGroups,
} from "../query-engine/builders/values-builder";
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
      // A child-held create leaf under a located target. A LITERAL parent id (a
      // child-held nested update located by its `where` PK) resolves its FK at
      // construction; a PLANNED parent id (a parent-held to-one `update` target,
      // located by a planning read) or a `ref` (a fresh create-context parent)
      // resolves its FK at COMPILE — the created row's FK carries the captured id,
      // exactly as the root's depth recursion threads a first-class parent value
      // (T4a CLASS VI, one step past the literal-parent reach).
      parts.push(
        parentId.kind === "literal"
          ? buildLiteralParentCreatePart({
              scope,
              engine,
              childScope,
              childName,
              relationName,
              fk,
              parentId,
              creates: normalizeItems(parsedRelation.create, relationName),
            })
          : buildDeferredParentCreatePart({
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
        parentId.kind === "literal"
          ? buildLiteralParentCreateManyPart({
              scope,
              engine,
              childScope,
              childName,
              relationName,
              fk,
              parentId,
              createManyInput: parsedRelation.createMany,
            })
          : buildDeferredParentCreateManyPart({
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
  if (parentId.kind !== "literal") {
    // Defensive contract check: this construction-time inline path is dispatched only
    // for a compile-time literal parent id (a child-held nested update located by its
    // `where` PK). A `planned`/`ref` parent id is routed upstream to the DEFERRED leaf
    // ({@link buildDeferredParentCreatePart}), which resolves the FK from `known` at
    // compile (T4a CLASS VI). Reaching here with a non-literal id is an internal error.
    throw new UnsupportedOperationError(
      `query-engine-v2 update does not support a nested create/createMany on relation '${relationName}' under a parent-held target one level deeper.`
    );
  }
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
 * The DEFERRED child-held straight-write leaf (T4a CLASS VI): a `create`/`createMany`
 * under a target located by a PLANNED id (a parent-held to-one `update` target, read at
 * planning) or a `ref` (a fresh create-context parent). Its step ids are allocated at
 * construction (stable, no planning read of its own — the enclosing operation already
 * plans the target's locate probe), but its INSERT statements are built at COMPILE: the
 * grandchild FK carries the captured parent id — inlined from the located planning row
 * (`planned`, ATOM §9 inv. 2) or a backward `Ref` (`ref`) — exactly as the root's depth
 * recursion threads a first-class parent value. A relation-carrying create arm (deeper
 * create-context) still routes to V1, byte-identical to the literal leaf.
 */
class DeferredParentWriteParts implements Part {
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

/** The child FK columns a deferred leaf writes, resolved at compile: a `planned`
 *  parent id inlines the located row's referenced value from `known`; a `ref` parent
 *  id is a symbolic backward `Ref`. One entry per (single-field, here) FK column. */
function deferredFkInject(
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
    const value =
      parentId.kind === "ref"
        ? parentId.ref
        : referencedFieldValue(
            parentId,
            fk.pkFields[index]!,
            known,
            relationName,
            "create"
          );
    inject[fkField] = referenceSql(engine, childScope.model, fkField, value);
  }
  return inject;
}

export function buildDeferredParentCreatePart(input: {
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
  // Separate + validate + allocate ids at construction; resolve the FK at compile.
  const items = input.creates.map((create) => {
    const { scalarData, relations } = separateData(childScope, create);
    if (Object.keys(relations).length > 0) {
      // A relation-carrying create arm one level deeper is deeper create-context —
      // route the whole tree to V1, byte-identical to the literal leaf.
      throw new UnsupportedOperationError(
        `query-engine-v2 update does not support nested relation writes in the create data of relation '${relationName}' one level deeper.`
      );
    }
    return { scalarData, id: scope.allocate(`${childName}.create`) };
  });
  return new DeferredParentWriteParts((known) => {
    const inject = deferredFkInject(
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
  });
}

export function buildDeferredParentCreateManyPart(input: {
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
    // Nested `skipDuplicates` one level deeper under a planned/ref target needs the
    // dialect ON CONFLICT / recoverable-unique wiring, a documented narrower boundary
    // (byte-identical to the literal leaf) — route the whole tree to V1.
    throw new UnsupportedOperationError(
      `query-engine-v2 update does not support nested createMany skipDuplicates on relation '${relationName}' one level deeper.`
    );
  }
  const userRows = normalizeItems(createMany.data, relationName);
  if (userRows.length === 0) return new DeferredParentWriteParts(() => []);
  // The FK injection is uniform across rows, so it never re-partitions the contiguous
  // same-shape grouping — the statement count is knowable at construction, so allocate
  // one stable id per group now and build the FK-injected plan at compile.
  const ids = buildValueGroups(childScope, userRows).map(() =>
    scope.allocate(`${childName}.createMany`)
  );
  return new DeferredParentWriteParts((known) => {
    const inject = deferredFkInject(
      engine,
      childScope,
      fk,
      relationName,
      parentId,
      known
    );
    const rows = userRows.map((row) => ({ ...row, ...inject }));
    const plan = buildCreateManyPlan(childScope, { data: rows }, false);
    if (plan.statements.length !== ids.length) {
      throw new QueryEngineError(
        `query-engine-v2 update nested createMany on relation '${relationName}' produced an unexpected statement count one level deeper.`
      );
    }
    return plan.statements.map((statement, index) => ({
      id: ids[index]!,
      kind: "write" as const,
      statement: statement.sql,
      outputs: {},
    }));
  });
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
