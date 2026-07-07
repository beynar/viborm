import type { Model } from "@schema/model";
import { type Sql, sql } from "@sql";
import {
  buildConnectedUniqueWhere,
  buildJunctionDeleteCondition,
  buildJunctionInsert,
  buildJunctionMembership,
  buildJunctionParentValue,
  buildJunctionSourceMatch,
  buildJunctionTargetIn,
  buildJunctionTargetValue,
  buildTargetPkSubquery,
  getManyToManyJoinInfo,
  type ManyToManyJoinInfo,
} from "../../builders/many-to-many-utils";
import {
  type ConnectOrCreateInput,
  type NestedUpdateManyInput,
  type NestedUpsertInput,
  type RelationMutation,
  separateData,
} from "../../builders/relation-data-builder";
import {
  buildScalarSqlValue,
  isBatchValueRef,
} from "../../builders/values-builder";
import { buildWhere } from "../../builders/where-builder";
import { buildWhereUnique } from "../../builders/where-unique-builder";
import { getTableName } from "../../context";
import {
  NestedWriteError,
  type QueryContext,
  type RelationInfo,
} from "../../types";
import type { GuardFailure } from "./effects";
import { interpretCreate } from "./interpret-create-family";
import {
  childCtx,
  connectOrCreateFoundPin,
  emitGuard,
  emitTargetExistsGuard,
  existsGuard,
  identityCarrierRecord,
} from "./interpret-shared";
import { interpretConnectedChildUpdate } from "./interpret-update-family";
import type { Interp } from "./interpreter";
import {
  assertUpdateManyDataHasNoRelations,
  normalizeNestedUpdateInputs,
  normalizeNestedUpdateManyInputs,
} from "./legality";
import { recordNotFoundError } from "./record-access";
import {
  assertManyToManyStepCombinationIsSupported,
  normalizeArray,
  normalizeRecordArray,
  planRelationMutationSteps,
} from "./semantic-plan";

// ===========================================================================
// M9 — many-to-many through the interpreter (§9 m2m rows, §11 M9). ONE decision
// body for every m2m kind: junction effects carry fully-lowered raw `Sql`
// (the shared `many-to-many-utils` builders resolve parent/target values through
// `buildScalarSqlValue`, so a produced-PK symbol is already a JS literal in live
// mode or a `batchRefs.read` subquery in planned mode). Association changes go
// through junction rows; child rows are only touched by create/delete/deleteMany.
// The three-way membership upsert is the same body as the to-many relation
// upsert, specialized only by membership predicate (map-shared §D.10 duplication
// eliminated). Filtered deleteMany pins its materialized membership set with the
// symmetric-difference guards (planned, raceable — §5.5 Rule 3, §9); the
// deleteMany-combination ban is kept (§6.2.2a).
// ===========================================================================

/**
 * Dispatch one many-to-many relation's steps. Junction rows reference the parent
 * row, so nothing runs before the parent exists — this is called only in the
 * after-parent / update timing. `parentData` is the raw carrier record (its PK
 * field a literal, a produced-PK symbol carrier, or a Sql), from which
 * `buildJunctionParentValue` lowers the junction source value.
 */
export async function interpretManyToMany(
  interp: Interp,
  ctx: QueryContext,
  relationName: string,
  mutation: RelationMutation,
  parentData: Record<string, unknown>
): Promise<void> {
  const { relationInfo } = mutation;
  assertManyToManyStepCombinationIsSupported(relationName, mutation);
  const joinInfo = getManyToManyJoinInfo(ctx, relationInfo);
  const parentValue = buildJunctionParentValue(
    ctx,
    joinInfo,
    parentData,
    relationName
  );

  for (const step of planRelationMutationSteps(
    relationName,
    mutation,
    "after"
  )) {
    switch (step.kind) {
      case "create":
        for (const createData of step.inputs) {
          await interpretM2mChildCreate(
            interp,
            ctx,
            relationInfo,
            joinInfo,
            createData,
            parentValue
          );
        }
        break;

      case "connect":
        for (const connectInput of step.inputs) {
          await interpretM2mConnect(
            interp,
            ctx,
            relationInfo,
            joinInfo,
            connectInput,
            parentValue
          );
        }
        break;

      case "connectOrCreate":
        for (const input of step.inputs) {
          await interpretM2mConnectOrCreate(
            interp,
            ctx,
            relationInfo,
            joinInfo,
            input,
            parentValue
          );
        }
        break;

      case "disconnect":
        await interpretM2mDisconnect(
          interp,
          ctx,
          relationInfo,
          joinInfo,
          step.input,
          parentValue
        );
        break;

      case "set":
        await interpretM2mSet(
          interp,
          ctx,
          relationInfo,
          joinInfo,
          step.input,
          parentValue
        );
        break;

      case "delete":
        await interpretM2mDelete(
          interp,
          ctx,
          relationInfo,
          joinInfo,
          step.input,
          parentValue
        );
        break;

      case "deleteMany":
        for (const input of normalizeRecordArray(step.input)) {
          await interpretM2mDeleteMany(
            interp,
            ctx,
            relationInfo,
            joinInfo,
            parentData,
            parentValue,
            input,
            relationName
          );
        }
        break;

      case "update":
        for (const input of normalizeNestedUpdateInputs(step.input)) {
          await interpretM2mChildUpdate(
            interp,
            ctx,
            relationInfo,
            joinInfo,
            parentValue,
            input.where,
            input.data
          );
        }
        break;

      case "updateMany":
        for (const input of normalizeNestedUpdateManyInputs(step.input)) {
          await interpretM2mUpdateMany(
            interp,
            ctx,
            relationInfo,
            joinInfo,
            parentValue,
            input
          );
        }
        break;

      case "upsert":
        for (const input of normalizeArray(step.input)) {
          await interpretM2mUpsert(
            interp,
            ctx,
            relationInfo,
            joinInfo,
            parentValue,
            input
          );
        }
        break;

      default:
        throw new NestedWriteError(
          `Nested operation '${step.kind}' is not supported for many-to-many relation '${relationName}'.`,
          relationName,
          { meta: { operation: step.kind } }
        );
    }
  }
}

/** m2m create-through-junction: insert the child (recursively — FK-only closure),
 *  then insert the junction row keyed by the child's (possibly symbolic) PK. */
async function interpretM2mChildCreate(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  createData: Record<string, unknown>,
  parentValue: Sql
): Promise<void> {
  const target = childCtx(ctx, relationInfo);
  const child = await interpretCreate(interp, target, createData);
  // The child PK is an `Expr` (a `generatedPk` symbol or a literal); lower it to
  // the junction target value via the mode's Axis-A carrier so the junction
  // insert reads a JS literal (live) or a batchRefs.read subquery (planned).
  const targetValue = buildJunctionTargetValue(
    ctx,
    relationInfo,
    joinInfo,
    identityCarrierRecord(interp.mode, child.finalWhere),
    relationInfo.name
  );
  await interp.emit({
    kind: "junction",
    statement: buildJunctionInsert(ctx, joinInfo, parentValue, targetValue),
  });
}

/** m2m connect: assert the target exists (standalone guard, kind:target), then
 *  insert an idempotent junction row via a target-PK subquery. */
async function interpretM2mConnect(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  connectInput: Record<string, unknown>,
  parentValue: Sql
): Promise<void> {
  await emitTargetExistsGuard(
    interp,
    ctx,
    relationInfo,
    connectInput,
    "connect"
  );
  await interp.emit({
    kind: "junction",
    statement: buildJunctionInsert(
      ctx,
      joinInfo,
      parentValue,
      buildTargetPkSubquery(ctx, relationInfo, joinInfo, connectInput)
    ),
  });
}

/**
 * m2m connectOrCreate: probe the target by where-unique. Found → assert-exists
 * pin + junction insert via target-PK subquery. Missing → create the child +
 * junction insert. Pin Rule 2 (§5.5): the missing branch is NOT pinned — the
 * child INSERT's unique constraint enforces it, its violation the retryable
 * signal (F1 fix). Inputs are already deduped first-create-wins (§6.2.1).
 */
async function interpretM2mConnectOrCreate(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  input: ConnectOrCreateInput,
  parentValue: Sql
): Promise<void> {
  const target = relationInfo.targetModel;
  const targetCtx = childCtx(ctx, relationInfo);
  const whereSql = buildWhereUnique(
    targetCtx,
    input.where,
    getTableName(target)
  );

  const probe = await interp.mode.probe(ctx, {
    model: target,
    where: whereSql,
    select: "exists",
    pin: {
      whenFound: connectOrCreateFoundPin(relationInfo, whereSql),
    },
  });

  if (probe.found) {
    await emitGuard(interp, probe.guard);
    await interp.emit({
      kind: "junction",
      statement: buildJunctionInsert(
        ctx,
        joinInfo,
        parentValue,
        buildTargetPkSubquery(ctx, relationInfo, joinInfo, input.where)
      ),
    });
    return;
  }

  await emitGuard(interp, probe.guard); // undefined by Pin Rule 2 — a no-op.
  await interpretM2mChildCreate(
    interp,
    ctx,
    relationInfo,
    joinInfo,
    input.create,
    parentValue
  );
}

/** m2m disconnect: delete junction rows only (the child survives). `true` drops
 *  every junction row from this parent; an explicit where drops the matched
 *  target's junction row. */
async function interpretM2mDisconnect(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  input: boolean | Record<string, unknown> | Record<string, unknown>[],
  parentValue: Sql
): Promise<void> {
  const junctionTable = ctx.adapter.identifiers.escape(
    joinInfo.junctionTableName
  );
  const sourceMatch = buildJunctionSourceMatch(ctx, joinInfo, parentValue);
  if (input === true) {
    await interp.emit({
      kind: "junction",
      statement: ctx.adapter.mutations.delete(junctionTable, sourceMatch),
    });
    return;
  }
  for (const item of normalizeRecordArray(
    input as Record<string, unknown> | Record<string, unknown>[]
  )) {
    const targetIn = buildJunctionTargetIn(
      ctx,
      joinInfo,
      buildTargetPkSubquery(ctx, relationInfo, joinInfo, item)
    );
    await interp.emit({
      kind: "junction",
      statement: ctx.adapter.mutations.delete(
        junctionTable,
        ctx.adapter.operators.and(sourceMatch, targetIn)
      ),
    });
  }
}

/** m2m set: wholesale replace — resolve every member first (assert exists), drop
 *  every junction row from this parent, then insert one junction row per member.
 *  One order for both modes; effects are disjoint on success (§9 set, m2m). */
async function interpretM2mSet(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  setItems: Record<string, unknown>[],
  parentValue: Sql
): Promise<void> {
  const target = relationInfo.targetModel;
  const targetCtx = childCtx(ctx, relationInfo);

  // Drop the current set, then re-add each member behind an exists guard.
  await interp.emit({
    kind: "junction",
    statement: ctx.adapter.mutations.delete(
      ctx.adapter.identifiers.escape(joinInfo.junctionTableName),
      buildJunctionSourceMatch(ctx, joinInfo, parentValue)
    ),
  });
  for (const item of setItems) {
    const whereSql = buildWhereUnique(targetCtx, item, getTableName(target));
    await interp.emit({
      kind: "guard",
      guard: existsGuard(
        target,
        whereSql,
        () =>
          recordNotFoundError({
            relationName: relationInfo.name,
            operation: "set",
            kind: "target",
          }),
        false
      ),
    });
    await interp.emit({
      kind: "junction",
      statement: buildJunctionInsert(
        ctx,
        joinInfo,
        parentValue,
        buildTargetPkSubquery(ctx, relationInfo, joinInfo, item)
      ),
    });
  }
}

/**
 * m2m delete: remove the connected child row and every junction row pointing at
 * it (junction-first, so the child DELETE cannot trip an FK constraint).
 * `true` → materialize every connected PK and delete by PK-in. Explicit where →
 * per item: assert connected (correlated) + junction delete + child delete by
 * its own where-unique (no subquery on the child table — MySQL rejects a
 * mutation target appearing in its own subquery).
 */
async function interpretM2mDelete(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  input: boolean | Record<string, unknown> | Record<string, unknown>[],
  parentValue: Sql
): Promise<void> {
  if (input === true) {
    const pks = await resolveConnectedTargetPks(
      interp,
      ctx,
      relationInfo,
      joinInfo,
      parentValue,
      undefined
    );
    await emitJunctionAndChildDeletes(interp, ctx, relationInfo, joinInfo, pks);
    return;
  }
  for (const item of normalizeRecordArray(
    input as Record<string, unknown> | Record<string, unknown>[]
  )) {
    await interpretM2mDeleteOne(
      interp,
      ctx,
      relationInfo,
      joinInfo,
      parentValue,
      item
    );
  }
}

/** m2m delete of a single where-unique target: assert it is connected to this
 *  parent (correlated guard), delete its junction rows, then delete the child by
 *  its own where-unique. */
async function interpretM2mDeleteOne(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  parentValue: Sql,
  uniqueInput: Record<string, unknown>
): Promise<void> {
  const target = relationInfo.targetModel;
  const targetCtx = childCtx(ctx, relationInfo);
  const connectedWhere = buildConnectedUniqueWhere(
    ctx,
    targetCtx,
    joinInfo,
    parentValue,
    uniqueInput
  );
  // The row must be connected to this parent (correlated). Live: SELECT-then-throw
  // (standalone premise); planned: an exists assertion.
  await interp.emit({
    kind: "guard",
    guard: existsGuard(
      target,
      connectedWhere,
      () =>
        new NestedWriteError(
          `Cannot delete relation '${relationInfo.name}': target record was not found for this parent.`,
          relationInfo.name
        ),
      false
    ),
  });

  const targetPkSubquery = buildTargetPkSubquery(
    ctx,
    relationInfo,
    joinInfo,
    uniqueInput
  );
  await interp.emit({
    kind: "junction",
    statement: ctx.adapter.mutations.delete(
      ctx.adapter.identifiers.escape(joinInfo.junctionTableName),
      buildJunctionDeleteCondition(
        ctx,
        relationInfo,
        joinInfo,
        targetPkSubquery
      )
    ),
  });
  await interp.emit({
    kind: "delete",
    model: target,
    where: buildWhereUnique(targetCtx, uniqueInput, getTableName(target)),
    requireAffected: false,
  });
}

/**
 * m2m filtered deleteMany (§9 deleteMany m2m). Materialize the connected PKs
 * matching the filter, then delete junction rows (junction-first) and children.
 *
 * Planned mode: the membership set was read at plan time, so its staleness is
 * closed FAIL-CLOSED by two symmetric-difference guards (raceable — §5.5 Rule 3,
 * §1.2 A6): (i) no CURRENTLY-connected, filter-matching target is missing from
 * the resolved set; (ii) no target in the resolved set has become disconnected
 * or stopped matching the filter. A concurrent membership change aborts the
 * atomic unit, and the retry re-plans against fresh membership and converges.
 * Live mode reads the set on the tx driver (own writes visible), so the guards
 * realize as no-ops there.
 */
async function interpretM2mDeleteMany(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  parentData: Record<string, unknown>,
  parentValue: Sql,
  filter: Record<string, unknown>,
  relationName: string
): Promise<void> {
  // Legality: the parent PK must be a known literal so the filtered membership
  // read at plan time is not correlated against this operation's own writes
  // (§6.2). A deferred (symbol carrier) parent PK is rejected, typed.
  const rawParentPk =
    parentData[joinInfo.sourcePkField] ?? parentData[joinInfo.sourcePkColumn];
  if (!interp.mode.canObserveOwnWrites && isCarrierDeferred(rawParentPk)) {
    throw new NestedWriteError(
      `Nested 'deleteMany' on many-to-many relation '${relationName}' requires the parent primary key to be known before execution.`,
      relationName,
      { meta: { operation: "deleteMany" } }
    );
  }

  const target = relationInfo.targetModel;
  const child = childCtx(ctx, relationInfo);
  const filterWhere = buildWhere(
    { ...child, mutationTable: joinInfo.targetTableName },
    filter,
    joinInfo.targetTableName
  );
  const membership = buildJunctionMembership(
    ctx,
    joinInfo,
    parentValue,
    joinInfo.targetTableName
  );
  const connectedFilterWhere = filterWhere
    ? ctx.adapter.operators.and(membership, filterWhere)
    : membership;

  const pks = await resolveConnectedTargetPks(
    interp,
    ctx,
    relationInfo,
    joinInfo,
    parentValue,
    filterWhere
  );

  // Fail-closed staleness guards for the plan-time membership set (planned mode;
  // no-ops in live mode where the read observed own writes). Emitted BEFORE the
  // deletes so a stale set aborts the atomic unit. Raceable → the retry re-plans.
  if (!interp.mode.canObserveOwnWrites) {
    await emitDeleteManyStalenessGuards(
      interp,
      ctx,
      target,
      relationName,
      connectedFilterWhere,
      pks,
      joinInfo
    );
  }

  await emitJunctionAndChildDeletes(interp, ctx, relationInfo, joinInfo, pks);
}

/**
 * The two symmetric-difference guards pinning a plan-time m2m deleteMany
 * membership set (§9, §5.5 Rule 3). `connectedFilterWhere` is the target-table
 * predicate "currently connected to this parent AND matches the filter"; `pks`
 * is the materialized set the deletes target. Both guards are RACEABLE — a
 * concurrent membership change aborts the atomic unit and the retry re-plans
 * against fresh membership and converges (§1.2 A6).
 *
 * (i) No currently-connected, filter-matching target sits OUTSIDE the resolved
 *     set (a member was added after planning) → notExists(connectedFilter ∧
 *     pk NOT IN pks).
 * (ii) No target in the resolved set has become disconnected or stopped matching
 *      (a member was removed / mutated after planning) → notExists(pk IN pks ∧
 *      NOT connectedFilter).
 */
async function emitDeleteManyStalenessGuards(
  interp: Interp,
  ctx: QueryContext,
  target: Model<any>,
  relationName: string,
  connectedFilterWhere: Sql,
  pks: Sql[],
  joinInfo: ManyToManyJoinInfo
): Promise<void> {
  const { adapter } = ctx;
  const pkCol = adapter.identifiers.column(
    joinInfo.targetTableName,
    joinInfo.targetPkColumn
  );
  const pkList = pks.length > 0 ? sql`(${sql.join(pks, ", ")})` : undefined;

  const raceableFailure: GuardFailure = {
    error: () =>
      new NestedWriteError(
        `Concurrent membership change during 'deleteMany' on many-to-many relation '${relationName}': retry to converge.`,
        relationName,
        { meta: { operation: "deleteMany" } }
      ),
    raceable: true,
  };

  // (i) added-member guard: a currently-connected, filter-matching row NOT in
  //     the resolved set. When the set is empty, ANY currently-connected,
  //     filter-matching row is an addition, so the guard is the bare predicate.
  const addedWhere = pkList
    ? adapter.operators.and(
        connectedFilterWhere,
        adapter.operators.notIn(pkCol, pkList)
      )
    : connectedFilterWhere;
  await interp.emit({
    kind: "guard",
    guard: {
      premise: { kind: "notExists", model: target, where: addedWhere },
      failure: raceableFailure,
    },
  });

  // (ii) removed-member guard: a resolved-set row that is no longer connected or
  //      no longer matches the filter. Vacuous when the set is empty.
  if (pkList) {
    await interp.emit({
      kind: "guard",
      guard: {
        premise: {
          kind: "notExists",
          model: target,
          where: adapter.operators.and(
            adapter.operators.in(pkCol, pkList),
            adapter.operators.not(connectedFilterWhere)
          ),
        },
        failure: raceableFailure,
      },
    });
  }
}

/** Resolve the PK values of target rows connected to the parent, optionally
 *  restricted by an extra target-table condition. The read fires at the mode's
 *  decision time (live: tx driver, own writes; planned: base driver, committed
 *  state — its staleness closed by the deleteMany guards). */
async function resolveConnectedTargetPks(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  parentValue: Sql,
  extraWhere: Sql | undefined
): Promise<Sql[]> {
  const { adapter } = ctx;
  const membership = buildJunctionMembership(
    ctx,
    joinInfo,
    parentValue,
    joinInfo.targetTableName
  );
  const whereClause = extraWhere
    ? adapter.operators.and(membership, extraWhere)
    : membership;
  const pkCol = adapter.identifiers.column(
    joinInfo.targetTableName,
    joinInfo.targetPkColumn
  );
  const rows = await interp.mode.probeRows(
    childCtx(ctx, relationInfo),
    relationInfo.targetModel,
    whereClause,
    pkCol
  );
  return rows.map((row) =>
    buildScalarSqlValue(
      ctx,
      relationInfo.targetModel,
      joinInfo.targetPkField,
      row[joinInfo.targetPkColumn] ?? row[joinInfo.targetPkField]
    )
  );
}

/** Delete every junction row pointing at the given target PKs (from any parent,
 *  and the self-ref source side), then delete the child rows by PK-in.
 *  Junction-first for FK safety. A no-op when the set is empty. */
async function emitJunctionAndChildDeletes(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  pks: Sql[]
): Promise<void> {
  if (pks.length === 0) {
    return;
  }
  const { adapter } = ctx;
  const pkList = sql`(${sql.join(pks, ", ")})`;
  await interp.emit({
    kind: "junction",
    statement: adapter.mutations.delete(
      adapter.identifiers.escape(joinInfo.junctionTableName),
      buildJunctionDeleteCondition(ctx, relationInfo, joinInfo, pkList)
    ),
  });
  await interp.emit({
    kind: "junction",
    statement: adapter.mutations.delete(
      adapter.identifiers.escape(joinInfo.targetTableName),
      adapter.operators.in(
        adapter.identifiers.escape(joinInfo.targetPkColumn),
        pkList
      )
    ),
  });
}

/** m2m nested update: match a CONNECTED child (unique ∧ membership) and apply the
 *  scalar update + nested relations (recursively). Correlated `requireAffected`. */
async function interpretM2mChildUpdate(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  parentValue: Sql,
  where: Record<string, unknown>,
  data: Record<string, unknown>
): Promise<void> {
  const target = relationInfo.targetModel;
  const child = childCtx(ctx, relationInfo);
  const whereSql = buildConnectedUniqueWhere(
    ctx,
    child,
    joinInfo,
    parentValue,
    where
  );
  await interpretConnectedChildUpdate(
    interp,
    child,
    relationInfo,
    target,
    whereSql,
    data
  );
}

/** m2m nested updateMany: set-based UPDATE over membership ∧ filter, scalar-only
 *  data (nested relations rejected). `requireAffected: false`. */
async function interpretM2mUpdateMany(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  parentValue: Sql,
  input: NestedUpdateManyInput
): Promise<void> {
  const target = relationInfo.targetModel;
  const child = childCtx(ctx, relationInfo);
  const { scalarData, relations } = separateData(child, input.data);
  assertUpdateManyDataHasNoRelations(relationInfo.name, relations);
  if (Object.keys(scalarData).length === 0) {
    return;
  }
  const membership = buildJunctionMembership(
    ctx,
    joinInfo,
    parentValue,
    joinInfo.targetTableName
  );
  const filterWhere = buildWhere(
    { ...child, mutationTable: joinInfo.targetTableName },
    input.where,
    joinInfo.targetTableName
  );
  await interp.emit({
    kind: "update",
    model: target,
    set: {},
    rawSet: scalarData,
    where: filterWhere
      ? ctx.adapter.operators.and(membership, filterWhere)
      : membership,
    requireAffected: false,
    produces: [],
  });
}

/**
 * m2m upsert — the SAME three-way membership decision as the to-many relation
 * upsert (§6.1, map-shared §D.10 duplication eliminated), specialized by the
 * membership predicate (junction membership vs FK match). Connected → update the
 * connected child (Pin Rule 1). Uncorrelated-but-exists → typed `correlated`
 * reject (both modes, immediate). Absent → create the child + junction insert
 * (Pin Rule 2, no pin — the child INSERT's constraint is the enforcer).
 */
async function interpretM2mUpsert(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  joinInfo: ManyToManyJoinInfo,
  parentValue: Sql,
  input: NestedUpsertInput
): Promise<void> {
  if (!input.where) {
    throw new NestedWriteError(
      `Nested operation 'upsert' on many-to-many relation '${relationInfo.name}' requires 'where'.`,
      relationInfo.name,
      { meta: { operation: "upsert", field: "where" } }
    );
  }
  const target = relationInfo.targetModel;
  const child = childCtx(ctx, relationInfo);
  const connectedWhere = buildConnectedUniqueWhere(
    ctx,
    child,
    joinInfo,
    parentValue,
    input.where
  );

  const connected = await interp.mode.probe(child, {
    model: target,
    where: connectedWhere,
    select: "exists",
  });
  if (connected.found) {
    await interpretConnectedChildUpdate(
      interp,
      child,
      relationInfo,
      target,
      connectedWhere,
      input.update
    );
    return;
  }

  // Not connected: a row matching the unique key but not this parent means the
  // upsert-create would collide with another parent's row — Prisma rejects it
  // (typed `correlated`, both modes, immediate).
  const uncorrelatedWhere = buildWhereUnique(
    child,
    input.where,
    getTableName(target)
  );
  const uncorrelated = await interp.mode.probe(child, {
    model: target,
    where: uncorrelatedWhere,
    select: "exists",
  });
  if (uncorrelated.found) {
    throw recordNotFoundError({
      relationName: relationInfo.name,
      operation: "upsert",
      kind: "correlated",
    });
  }

  // Absent → create the child + junction insert (Pin Rule 2, no pin).
  await interpretM2mChildCreate(
    interp,
    ctx,
    relationInfo,
    joinInfo,
    input.create,
    parentValue
  );
}

/** True iff a raw parent-carrier value is a deferred symbol carrier (planned
 *  mode's `BatchValueRef`) rather than a known literal — used by the m2m
 *  deleteMany legality check (§6.2). A Sql fragment (a connect subquery) is not
 *  a deferred PK for this purpose; only the batch-ref carrier is. */
function isCarrierDeferred(value: unknown): boolean {
  return isBatchValueRef(value);
}
