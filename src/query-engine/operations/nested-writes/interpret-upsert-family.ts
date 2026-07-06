import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import {
  type FkDirection,
  type NestedUpsertInput,
  separateData,
} from "../../builders/relation-data-builder";
import { buildWhereUnique } from "../../builders/where-unique-builder";
import { getTableName } from "../../context";
import {
  NestedWriteError,
  type QueryContext,
  type RelationInfo,
} from "../../types";
import { getPrimaryKeyWhereFromRecord } from "../mutation-returns";
import type { Guard, GuardFailure } from "./effects";
import type { Expr } from "./expr";
import { buildFkMatchCondition, combineWithParentCorrelation } from "./fk";
import {
  interpretCreate,
  interpretRelatedCreate,
} from "./interpret-create-family";
import {
  childCtx,
  emitGuard,
  existsGuard,
  isPlainRecord,
} from "./interpret-shared";
import {
  applyScalarUpdateAndRelations,
  interpretNestedUpdate,
  interpretParentHoldsFkCreate,
  type UpdateOutcome,
} from "./interpret-update-family";
import type { Interp } from "./interpreter";
import {
  assertNestedUpdatePlanIsExecutable,
  assertNoPlannedNestedMutationExecution,
} from "./legality";
import { buildUniqueWithWhere, recordNotFoundError } from "./record-access";
import {
  hasRecordKeys,
  normalizeArray,
  planExistingUpsertBranch,
} from "./semantic-plan";

// ===========================================================================
// M6 — the upsert family (§9, §11 M6). Top-level upsert (create / update /
// targetWhere-skip / setWhere-skip) and nested to-one/to-many upsert over
// FK-only trees, both modes. `planExistingUpsertBranch` is reused verbatim
// (§6.1); `forUpdate` locks the live top-level probe; Pin Rule 1 pins the
// existing-row premises, Pin Rule 2 leaves the create-branch missing premise
// unpinned (the DB unique constraint is the enforcer — F1 fix, §5.5).
// ===========================================================================

/**
 * A top-level upsert (§9 upsert top-level). Probe the target by `where`
 * (FOR UPDATE in live mode); found → `planExistingUpsertBranch` decides a skip
 * (targetWhere/setWhere no-match — a silent no-op returning the existing row)
 * or the update branch (scalar update + nested relations); missing → the create
 * branch. Pin Rule 1 pins the existing-row premise; Pin Rule 2 leaves the
 * missing-branch premise unpinned so a concurrent create surfaces as a retryable
 * `UniqueConstraintError` (F1 fix). `finalWhere` is the (possibly PK-changed)
 * post-branch identity.
 */
export async function interpretTopLevelUpsert(
  interp: Interp,
  ctx: QueryContext,
  args: Record<string, unknown>
): Promise<UpdateOutcome> {
  const where = args.where as Record<string, unknown>;
  const targetWhere = args.targetWhere as Record<string, unknown> | undefined;
  const setWhere = args.setWhere as Record<string, unknown> | undefined;
  const whereSql = buildWhereUnique(ctx, where, getTableName(ctx.model));

  // Locate the target: FOR UPDATE in live mode so the row cannot be modified
  // between the existence decision and the update/skip write (Pin Rule 1). The
  // found premise is pinned (planned: an assertion; live: a no-op under the
  // lock); the missing premise is NOT pinned (Pin Rule 2) — the create branch's
  // own INSERT raises the constraint violation, the retryable signal.
  const probe = await interp.mode.probe(ctx, {
    model: ctx.model,
    where: whereSql,
    select: "record",
    forUpdate: true,
    pin: {
      whenFound: existsGuard(
        ctx.model,
        whereSql,
        () =>
          new NestedWriteError(
            "Record was deleted by another transaction during upsert",
            getTableName(ctx.model)
          ),
        false
      ),
    },
  });

  if (!probe.found) {
    // Missing → create branch. Validate the I6 upsertCreate closure in the
    // taken arm (the frozen `executeMissingUpsert` does this before creating —
    // the branch-scoped check the legality carve-out defers to M6). No pin
    // (Pin Rule 2). The child identity is the final identity.
    const createData = args.create as Record<string, unknown>;
    const { relations } = separateData(ctx, createData);
    assertNoPlannedNestedMutationExecution(relations, "upsertCreate");
    await emitGuard(interp, probe.guard); // undefined by Pin Rule 2.
    const created = await interpretCreate(
      interp,
      ctx,
      createData,
      undefined,
      /* isRoot */ true
    );
    return { finalWhere: created.finalWhere };
  }

  await emitGuard(interp, probe.guard);
  return interpretExistingUpsertBranch(
    interp,
    ctx,
    args,
    probe.record,
    whereSql,
    targetWhere,
    setWhere
  );
}

/**
 * The found branch of a top-level upsert: `planExistingUpsertBranch` (verbatim,
 * §6.1) decides a targetWhere/setWhere skip or the update branch, from
 * plan-time/live probes of the where-scoped predicates. Skips emit only their
 * `uniqueWithWhereMissing` pin and return the existing PK (a silent no-op,
 * §7.5). The update branch emits the `uniqueWithWhereExists` pins, then applies
 * the scalar update + nested relations.
 */
async function interpretExistingUpsertBranch(
  interp: Interp,
  ctx: QueryContext,
  args: Record<string, unknown>,
  existingRecord: Readonly<Record<string, unknown>>,
  whereSql: Sql,
  targetWhere: Record<string, unknown> | undefined,
  setWhere: Record<string, unknown> | undefined
): Promise<UpdateOutcome> {
  const pkWhere = buildPrimaryKeyIdentity(ctx.model, existingRecord);

  // Probe the where-scoped predicates over the located row (targetWhere first,
  // setWhere only if targetWhere did not fail — the frozen short-circuit). Each
  // probe carries BOTH pins so the ProbeResult hands back the guard for the
  // outcome that occurred (matched → exists pin; unmatched → notExists pin) —
  // probe-backed, so live mode no-ops it and planned mode asserts it (§5.4).
  const target = hasRecordKeys(targetWhere)
    ? await probeUniqueWithWhere(interp, ctx, pkWhere, targetWhere)
    : undefined;
  const set =
    target?.matched !== false && hasRecordKeys(setWhere)
      ? await probeUniqueWithWhere(interp, ctx, pkWhere, setWhere)
      : undefined;

  const branch = planExistingUpsertBranch({
    model: ctx.model,
    existingRecord: { ...existingRecord },
    pkWhere,
    targetWhere,
    targetWhereMatched: target?.matched,
    setWhere,
    setWhereMatched: set?.matched,
  });

  if (branch.kind !== "update") {
    // A targetWhere/setWhere no-match: a silent no-op returning the existing
    // record (§7.5). Emit only the skipping where's `notExists` pin (Pin Rule 1
    // — a premise about an existing row) and return the existing PK. The pin is
    // the probe-backed guard of whichever where did not match.
    const skipGuard =
      branch.kind === "targetWhereSkipped" ? target?.guard : set?.guard;
    await emitGuard(interp, skipGuard);
    return { finalWhere: identityFromPkWhere(pkWhere) };
  }

  // The update branch runs: pin the matched targetWhere/setWhere premises with
  // their probe-backed `exists` guards, then apply the scalar update + nested
  // relations. `requireAffected: false` — the parent existence is already pinned
  // by the FOR UPDATE probe / `whenFound` pin, exactly as the top-level update.
  if (branch.targetWhereGuard) {
    await emitGuard(interp, target?.guard);
  }
  if (branch.setWhereGuard) {
    await emitGuard(interp, set?.guard);
  }

  const updateData = args.update as Record<string, unknown>;
  const { scalarData, relations } = separateData(ctx, updateData);
  // Validate the update branch's nested plan in the taken arm (the frozen
  // `executeExistingUpsert` runs `assertNestedUpdatePlanIsExecutable` before the
  // update — the branch-scoped check the legality carve-out defers to M6).
  assertNestedUpdatePlanIsExecutable(ctx, relations);
  return applyScalarUpdateAndRelations(
    interp,
    ctx,
    existingRecord,
    whereSql,
    scalarData,
    relations,
    /* requireAffected */ false
  );
}

/**
 * Probe a where-scoped predicate over the located row (targetWhere/setWhere).
 * Returns whether it matched and the probe-backed guard for the outcome: a
 * matched predicate yields an `exists(unique ∧ where)` pin (the update branch
 * re-asserts the row still matches); an unmatched one yields a
 * `notExists(unique ∧ where)` pin (the skip branch re-asserts it still does
 * not). Both are Pin Rule 1 existing-row premises — live no-ops them (the row
 * is FOR UPDATE locked), planned asserts them.
 */
async function probeUniqueWithWhere(
  interp: Interp,
  ctx: QueryContext,
  uniqueWhere: Record<string, unknown>,
  where: Record<string, unknown>
): Promise<{ matched: boolean; guard: Guard | undefined }> {
  const whereSql = buildUniqueWithWhere(ctx, ctx.model, uniqueWhere, where);
  const failure: GuardFailure = {
    error: () =>
      new NestedWriteError(
        `Upsert precondition failed for model '${getTableName(ctx.model)}'.`,
        getTableName(ctx.model)
      ),
    raceable: false,
  };
  const probe = await interp.mode.probe(ctx, {
    model: ctx.model,
    where: whereSql,
    select: "exists",
    pin: {
      whenFound: {
        premise: { kind: "exists", model: ctx.model, where: whereSql },
        failure,
      },
      whenMissing: {
        premise: { kind: "notExists", model: ctx.model, where: whereSql },
        failure,
      },
    },
  });
  return { matched: probe.found, guard: probe.guard };
}

/** The primary-key selector record for a located row (the frozen `pkWhere`),
 *  wrapping the flat PK values in the model's whereUnique shape. */
function buildPrimaryKeyIdentity(
  model: Model<any>,
  record: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return getPrimaryKeyWhereFromRecord(
    model,
    { ...record },
    model["~"].names.ts ?? getTableName(model)
  );
}

/** Convert a whereUnique-shaped PK selector into `finalWhere` Exprs. A single PK
 *  is a flat `{ id: v }`; a compound PK is `{ a_b: { a, b } }` — unwrap it back
 *  to per-field literal Exprs for the result read. */
function identityFromPkWhere(
  pkWhere: Record<string, unknown>
): Record<string, Expr> {
  const identity: Record<string, Expr> = {};
  for (const [key, value] of Object.entries(pkWhere)) {
    if (isPlainRecord(value)) {
      for (const [inner, innerValue] of Object.entries(value)) {
        identity[inner] = { kind: "lit", value: innerValue };
      }
    } else {
      identity[key] = { kind: "lit", value };
    }
  }
  return identity;
}

/**
 * A nested to-one/to-many `upsert` (§9 upsert to-one / to-many). Reuses the
 * three-way decision body: to-one probes the FK-matched slot; to-many probes
 * unique ∧ correlation, and on a correlated miss probes the uncorrelated unique
 * to distinguish absent (→ create) from foreign-owned (→ typed `correlated`
 * reject, both modes). Found → the nested update branch (which re-probes and
 * pins, Pin Rule 1); absent → the create branch (Pin Rule 2, no pin).
 */
export async function interpretNestedUpsert(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  fkDir: FkDirection,
  input: NestedUpsertInput | NestedUpsertInput[],
  parentData: Record<string, unknown>,
  parentIdentity: Record<string, Expr>
): Promise<void> {
  const inputs = normalizeArray(input);
  if (relationInfo.isToOne && inputs.length > 1) {
    throw new NestedWriteError(
      `Cannot use multiple 'upsert' inputs for to-one relation '${relationInfo.name}'.`,
      relationInfo.name,
      { meta: { operation: "upsert" } }
    );
  }
  for (const one of inputs) {
    if (relationInfo.isToOne) {
      await interpretToOneUpsert(
        interp,
        ctx,
        relationInfo,
        fkDir,
        one,
        parentData,
        parentIdentity
      );
      continue;
    }
    await interpretToManyUpsert(
      interp,
      ctx,
      relationInfo,
      fkDir,
      one,
      parentData,
      parentIdentity
    );
  }
}

/** A nested to-one upsert: probe the FK-matched target. Found → nested update
 *  (input.update). Missing → create the child with FK-direction timing (parent
 *  holds FK ⇒ create child then UPDATE parent FK; child holds FK ⇒ stamp the
 *  FK). No pin on the missing branch (Pin Rule 2). */
async function interpretToOneUpsert(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  fkDir: FkDirection,
  input: NestedUpsertInput,
  parentData: Record<string, unknown>,
  parentIdentity: Record<string, Expr>
): Promise<void> {
  const target = relationInfo.targetModel;
  const child = childCtx(ctx, relationInfo);
  const matchWhere = buildFkMatchCondition(ctx, fkDir, target, parentData);

  const probe = await interp.mode.probe(child, {
    model: target,
    where: matchWhere,
    select: "exists",
  });

  if (probe.found) {
    // Found: the nested update branch re-probes and pins the existing row
    // (Pin Rule 1) via `interpretNestedUpdate`.
    await interpretNestedUpdate(
      interp,
      ctx,
      relationInfo,
      fkDir,
      input.update,
      parentData
    );
    return;
  }

  // Missing → create (Pin Rule 2, no pin), with FK-direction timing.
  if (fkDir.holdsFK) {
    await interpretParentHoldsFkCreate(
      interp,
      ctx,
      relationInfo,
      fkDir,
      input.create,
      parentData,
      parentIdentity
    );
    return;
  }
  await interpretRelatedCreate(
    interp,
    ctx,
    relationInfo,
    fkDir,
    input.create,
    parentIdentity
  );
}

/** A nested to-many upsert: probe unique ∧ correlation. Found → nested update
 *  (Pin Rule 1, via the update branch's own probe/pin). Correlated miss → probe
 *  the uncorrelated unique: a foreign-owned match throws the typed `correlated`
 *  reject (both modes, immediate); absent → create (Pin Rule 2, no pin). */
async function interpretToManyUpsert(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  fkDir: FkDirection,
  input: NestedUpsertInput,
  parentData: Record<string, unknown>,
  parentIdentity: Record<string, Expr>
): Promise<void> {
  if (!input.where) {
    throw new NestedWriteError(
      `Nested operation 'upsert' on to-many relation '${relationInfo.name}' requires 'where'.`,
      relationInfo.name,
      { meta: { operation: "upsert", field: "where" } }
    );
  }
  const target = relationInfo.targetModel;
  const child = childCtx(ctx, relationInfo);
  const uniqueWhere = buildWhereUnique(
    child,
    input.where,
    getTableName(target)
  );
  const correlatedWhere = combineWithParentCorrelation(
    ctx,
    fkDir,
    target,
    uniqueWhere,
    parentData
  );

  const correlated = await interp.mode.probe(child, {
    model: target,
    where: correlatedWhere,
    select: "exists",
  });

  if (correlated.found) {
    await interpretNestedUpdate(
      interp,
      ctx,
      relationInfo,
      fkDir,
      { where: input.where, data: input.update },
      parentData
    );
    return;
  }

  // Not correlated: distinguish absent from foreign-owned. A row matching the
  // unique key but not this parent means the upsert-create would collide with
  // another parent's row — Prisma rejects it (typed `correlated`, both modes).
  const uncorrelated = await interp.mode.probe(child, {
    model: target,
    where: uniqueWhere,
    select: "exists",
  });
  if (uncorrelated.found) {
    throw recordNotFoundError({
      relationName: relationInfo.name,
      operation: "upsert",
      kind: "correlated",
    });
  }

  // Absent → create (Pin Rule 2, no pin). To-many is always related-holds-FK.
  await interpretRelatedCreate(
    interp,
    ctx,
    relationInfo,
    fkDir,
    input.create,
    parentIdentity
  );
}
