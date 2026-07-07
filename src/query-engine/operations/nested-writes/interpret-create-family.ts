import type { Model } from "@schema/model";
import { getPrimaryKeyFields } from "../../builders/correlation-utils";
import { isGeneratedIncrementDefault } from "../../builders/generated-scalar";
import {
  type ConnectOrCreateInput,
  type FkDirection,
  getFkDirection,
  type RelationMutation,
  separateData,
} from "../../builders/relation-data-builder";
import { buildWhereUnique } from "../../builders/where-unique-builder";
import { getTableName } from "../../context";
import {
  NestedWriteError,
  type QueryContext,
  type RelationInfo,
} from "../../types";
import { assertSingleRelationInput } from "./assertions";
import type { Expr, WriteSymbol } from "./expr";
import { interpretManyToMany } from "./interpret-m2m";
import {
  childCtx,
  connectOrCreateFoundPin,
  correlatedFailure,
  emitGuard,
  emitTargetExistsGuard,
  identityCarrierRecord,
  parentFkExprsFromConnect,
  parentFkExprsFromIdentity,
  parentFkExprsFromRecord,
} from "./interpret-shared";
import type { Interp } from "./interpreter";
import {
  planRelationMutationSteps,
  splitRelationMutationsByFk,
} from "./semantic-plan";

// ===========================================================================
// The create family (§9 create / createMany / connect / connectOrCreate).
// Before-parent (current-holds-FK) steps resolve the child and fold its PK into
// the parent's FK columns; after-parent (related-holds-FK / m2m) steps stamp
// the parent PK Expr into each child. These bodies are also the create branches
// that update/upsert/m2m trees recurse into.
// ===========================================================================

export interface CreateOutcome {
  /** The parent identity (PK), possibly symbolic, for the final result read. */
  finalWhere: Record<string, Expr>;
  /** The top-level create's own inserted row, held by the substrate that has
   *  it (Live) for a scalar-only result (§8.2). Set only for the outermost
   *  `interpretCreate` (`isRoot`); `undefined` for nested creates and in
   *  planned mode, which refetches by `finalWhere` instead. */
  record?: Record<string, unknown>;
}

/**
 * Interpret one create tree into effects (§9 create rows). FK split (I4):
 * currentHoldsFk resolves before the parent insert (child PK → parent FK);
 * relatedHoldsFk + junction after. The parent PK becomes an `Expr` — a literal
 * when provided, a `generatedPk` symbol when auto-incremented.
 */
export async function interpretCreate(
  interp: Interp,
  ctx: QueryContext,
  data: Record<string, unknown>,
  injectedFk?: Record<string, Expr>,
  isRoot = false
): Promise<CreateOutcome> {
  const { scalarData, relations } = separateData(ctx, data);
  const parentData = toLiteralExprs(ctx.model, scalarData);
  // FK Exprs stamped by an ancestor (related-holds-FK) — a parent PK symbol or
  // subquery — are injected as real Exprs so they lower through the value
  // substrate (batchRefs.read in planned mode) instead of a double-wrapped
  // literal.
  if (injectedFk) {
    for (const [field, expr] of Object.entries(injectedFk)) {
      parentData[field] = expr;
    }
  }

  const { currentHoldsFk, relatedHoldsFk } = splitRelationMutationsByFk(
    ctx,
    relations
  );

  // Before-parent: relations whose FK sits on the parent row. Resolve each and
  // fold the child PK into the parent's FK columns.
  for (const [relationName, mutation] of currentHoldsFk) {
    await interpretBeforeParent(
      interp,
      ctx,
      relationName,
      mutation,
      parentData
    );
  }

  const { produces, identity } = mintParentIdentity(interp, ctx, parentData);

  const parentRecord = await interp.emit({
    kind: "insert",
    model: ctx.model,
    data: parentData,
    produces,
  });

  // After-parent: relations whose FK sits on the child row. The parent PK Expr
  // stamps each child's FK.
  for (const [relationName, mutation] of relatedHoldsFk) {
    await interpretAfterParent(interp, ctx, relationName, mutation, identity);
  }

  // The top-level create's own row is the scalar-only result (§8.2). Only the
  // outermost `interpretCreate` keeps it — nested creates (before/after-parent,
  // connectOrCreate) return their child rows, which are never the result. This
  // is threaded structurally by call position, so a self-referential FK create
  // (a same-model child inserted before the parent) cannot misattribute it.
  return { finalWhere: identity, record: isRoot ? parentRecord : undefined };
}

/**
 * A before-parent (current-holds-FK) relation step: create/connect/
 * connectOrCreate resolve the target and bind its PK into the parent's FK
 * columns via `parentData`.
 */
async function interpretBeforeParent(
  interp: Interp,
  ctx: QueryContext,
  relationName: string,
  mutation: RelationMutation,
  parentData: Record<string, Expr>
): Promise<void> {
  const { relationInfo } = mutation;
  const fkDir = getFkDirection(ctx, relationInfo);
  if (!fkDir.holdsFK) {
    throw new NestedWriteError(
      `Relation '${relationName}' does not store foreign keys on the parent model.`,
      relationName
    );
  }

  for (const step of planRelationMutationSteps(
    relationName,
    mutation,
    "before"
  )) {
    switch (step.kind) {
      case "create": {
        if (relationInfo.isToOne) {
          assertSingleRelationInput(relationName, "create", step.inputs);
        }
        const child = await interpretCreate(
          interp,
          childCtx(ctx, relationInfo),
          step.inputs[0]!
        );
        bindParentFkFromIdentity(fkDir, child.finalWhere, parentData);
        break;
      }

      case "connect": {
        if (relationInfo.isToOne) {
          assertSingleRelationInput(relationName, "connect", step.inputs);
        }
        // Standalone guard (target exists, kind:target) + FK from
        // buildConnectFkValues (literal or subquery Expr) — §9 create/connect.
        await emitTargetExistsGuard(
          interp,
          ctx,
          relationInfo,
          step.inputs[0]!,
          "connect"
        );
        bindParentFkFromConnect(ctx, relationInfo, step.inputs[0]!, parentData);
        break;
      }

      case "connectOrCreate": {
        if (relationInfo.isToOne) {
          assertSingleRelationInput(
            relationName,
            "connectOrCreate",
            step.inputs.map((input) => input.where)
          );
        }
        await interpretConnectOrCreateBeforeParent(
          interp,
          ctx,
          relationInfo,
          fkDir,
          step.inputs[0]!,
          parentData
        );
        break;
      }

      default:
        throwUnsupportedNestedCreate(relationName);
    }
  }
}

/**
 * A connectOrCreate resolved before the parent insert (current holds FK).
 * Probe committed/live state; found → connect (bind the found PK); missing →
 * create the child and bind its PK. Pin Rule 2 (§5.5): the "missing" branch is
 * NOT pinned — the DB unique constraint over the where-unique key enforces it
 * at INSERT, and its violation is the retryable signal (F1 fix).
 */
async function interpretConnectOrCreateBeforeParent(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  fkDir: FkDirection,
  input: ConnectOrCreateInput,
  parentData: Record<string, Expr>
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
    select: "record",
    pin: {
      // found → target-exists pin (kind by direction: parent holds FK ⇒
      // target). missing → NO pin (Pin Rule 2).
      whenFound: connectOrCreateFoundPin(relationInfo, whereSql),
    },
  });

  if (probe.found) {
    await emitGuard(interp, probe.guard);
    bindParentFkFromRecord(fkDir, probe.record, parentData, relationInfo.name);
    return;
  }

  // Missing: create the child (recursively interpreted), bind its PK. No pin.
  await emitGuard(interp, probe.guard); // undefined by Pin Rule 2 — a no-op.
  const child = await interpretCreate(interp, targetCtx, input.create);
  bindParentFkFromIdentity(fkDir, child.finalWhere, parentData);
}

/**
 * An after-parent (related-holds-FK / to-many) relation step. The parent PK
 * `Expr` stamps each child's FK column.
 */
async function interpretAfterParent(
  interp: Interp,
  ctx: QueryContext,
  relationName: string,
  mutation: RelationMutation,
  parentIdentity: Record<string, Expr>
): Promise<void> {
  const { relationInfo } = mutation;
  // M2M junction rows reference the parent row and write after it exists, like
  // related-holds-FK steps. `getFkDirection` throws on m2m, so dispatch it here
  // first, lowering the parent identity Exprs to the raw carrier record the
  // junction builders consume (§9 m2m). The parent PK is a `generatedPk` symbol
  // (auto-increment) or a literal; its Axis-A carrier threads into the junction
  // source value in both modes.
  if (relationInfo.type === "manyToMany") {
    const parentData = identityCarrierRecord(interp.mode, parentIdentity);
    await interpretManyToMany(interp, ctx, relationName, mutation, parentData);
    return;
  }
  const fkDir = getFkDirection(ctx, relationInfo);

  for (const step of planRelationMutationSteps(
    relationName,
    mutation,
    "after"
  )) {
    switch (step.kind) {
      case "create": {
        for (const createData of step.inputs) {
          await interpretRelatedCreate(
            interp,
            ctx,
            relationInfo,
            fkDir,
            createData,
            parentIdentity
          );
        }
        break;
      }

      case "createMany": {
        await emitCreateMany(
          interp,
          relationInfo,
          fkDir,
          step.input.data,
          step.input.skipDuplicates,
          parentIdentity
        );
        break;
      }

      case "connect": {
        for (const connectInput of step.inputs) {
          await interpretRelatedConnect(
            interp,
            ctx,
            relationInfo,
            fkDir,
            connectInput,
            parentIdentity
          );
        }
        break;
      }

      case "connectOrCreate": {
        for (const input of step.inputs) {
          await interpretConnectOrCreateAfterParent(
            interp,
            ctx,
            relationInfo,
            fkDir,
            input,
            parentIdentity
          );
        }
        break;
      }

      default:
        throwUnsupportedNestedCreate(relationName);
    }
  }
}

/** A related-holds-FK nested create: stamp the FK from the parent identity and
 *  interpret the child (recursively, for deeper create trees). */
export async function interpretRelatedCreate(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  fkDir: FkDirection,
  createData: Record<string, unknown>,
  parentIdentity: Record<string, Expr>
): Promise<void> {
  const target = childCtx(ctx, relationInfo);
  const injectedFk = fkAssignmentExprs(fkDir, parentIdentity);
  await interpretCreate(interp, target, createData, injectedFk);
}

/** createMany (related holds FK only): one insertMany with the FK stamped per
 *  row. FK-holder ⇒ typed error; m2m rejected (unreachable — m2m not eligible). */
export async function emitCreateMany(
  interp: Interp,
  relationInfo: RelationInfo,
  fkDir: FkDirection,
  data: Record<string, unknown>[],
  skipDuplicates: boolean | undefined,
  parentIdentity: Record<string, Expr>
): Promise<void> {
  if (fkDir.holdsFK) {
    throw new NestedWriteError(
      `Cannot use createMany for relation '${relationInfo.name}' - ` +
        "createMany is only supported for to-many relations where the related model holds the FK.",
      relationInfo.name
    );
  }
  if (data.length === 0) {
    return;
  }
  const rows = data.map((record) => {
    const row = toLiteralExprs(relationInfo.targetModel, record);
    stampRelatedFkExprs(fkDir, row, parentIdentity);
    return row;
  });
  await interp.emit({
    kind: "insertMany",
    model: relationInfo.targetModel,
    rows,
    skipDuplicates,
  });
}

/** A related-holds-FK connect: UPDATE the child's FK to the parent PK, matched
 *  by the child's where-unique. requireAffected: correlated (§5.3). */
export async function interpretRelatedConnect(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  fkDir: FkDirection,
  connectInput: Record<string, unknown>,
  parentIdentity: Record<string, Expr>
): Promise<void> {
  const target = relationInfo.targetModel;
  const targetCtx = childCtx(ctx, relationInfo);
  const whereSql = buildWhereUnique(
    targetCtx,
    connectInput,
    getTableName(target)
  );
  const set = fkAssignmentExprs(fkDir, parentIdentity);
  await interp.emit({
    kind: "update",
    model: target,
    set,
    where: whereSql,
    requireAffected: correlatedFailure(relationInfo.name, "connect"),
    produces: [],
  });
}

/**
 * A connectOrCreate resolved after the parent insert (related holds FK). Found
 * → connect (UPDATE the found child's FK). Missing → create the child with the
 * parent FK stamped. Pin Rule 2: missing is unpinned.
 */
export async function interpretConnectOrCreateAfterParent(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  fkDir: FkDirection,
  input: ConnectOrCreateInput,
  parentIdentity: Record<string, Expr>
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
    select: "record",
    pin: {
      whenFound: connectOrCreateFoundPin(relationInfo, whereSql),
    },
  });

  if (probe.found) {
    await emitGuard(interp, probe.guard);
    await interpretRelatedConnect(
      interp,
      ctx,
      relationInfo,
      fkDir,
      input.where,
      parentIdentity
    );
    return;
  }

  await emitGuard(interp, probe.guard); // undefined (Pin Rule 2).
  const injectedFk = fkAssignmentExprs(fkDir, parentIdentity);
  await interpretCreate(interp, targetCtx, input.create, injectedFk);
}

// --- FK / identity plumbing -------------------------------------------------

/** Mint the parent identity: a `generatedPk` symbol for an auto-increment PK,
 *  a literal for a provided PK. The insert omits a generated PK column so the
 *  DB assigns it. */
function mintParentIdentity(
  interp: Interp,
  ctx: QueryContext,
  parentData: Record<string, Expr>
): { produces: WriteSymbol[]; identity: Record<string, Expr> } {
  const model = ctx.model;
  const pkFields = getPrimaryKeyFields(model);
  const produces: WriteSymbol[] = [];
  const identity: Record<string, Expr> = {};

  for (const pkField of pkFields) {
    const provided = parentData[pkField];
    const scalar = model["~"].state.scalars[pkField];
    const providedValue =
      provided && provided.kind === "lit" ? provided.value : undefined;
    const isGeneratedIncrement =
      scalar?.["~"].state.autoGenerate === "increment" &&
      (provided === undefined ||
        isGeneratedIncrementDefault(scalar, providedValue));

    if (provided !== undefined && !isGeneratedIncrement) {
      identity[pkField] = provided;
      continue;
    }

    if (isGeneratedIncrement) {
      if (pkFields.length !== 1) {
        throw new NestedWriteError(
          "Batch-only nested create cannot propagate generated compound primary keys.",
          getTableName(model)
        );
      }
      const symbol: WriteSymbol = {
        id: interp.nextSymbolId(),
        model,
        field: pkField,
        origin: { kind: "generatedPk" },
      };
      // The generated PK column is not inserted; the DB assigns it.
      delete parentData[pkField];
      produces.push(symbol);
      identity[pkField] = { kind: "sym", sym: symbol };
      continue;
    }

    throw new NestedWriteError(
      `Nested create requires primary key field '${pkField}' to be known before execution.`,
      getTableName(model)
    );
  }

  return { produces, identity };
}

/** Scalar data → literal Exprs. Relations are already stripped by separateData.
 *  A generated-increment field left at its default is skipped so the DB assigns
 *  it (mirrors `buildValues`) — the create-family symbol substrate then mints a
 *  `generatedPk` symbol for the PK case. */
function toLiteralExprs(
  model: Model<any>,
  scalarData: Record<string, unknown>
): Record<string, Expr> {
  const out: Record<string, Expr> = {};
  for (const [field, value] of Object.entries(scalarData)) {
    if (value === undefined) {
      continue;
    }
    const scalar = model["~"].state.scalars[field];
    if (isGeneratedIncrementDefault(scalar, value)) {
      continue;
    }
    out[field] = { kind: "lit", value };
  }
  return out;
}

/** Bind the parent's FK columns from a resolved child identity (before-parent
 *  create / connectOrCreate-create). */
function bindParentFkFromIdentity(
  fkDir: FkDirection,
  childIdentity: Record<string, Expr>,
  parentData: Record<string, Expr>
): void {
  Object.assign(parentData, parentFkExprsFromIdentity(fkDir, childIdentity));
}

/** Bind the parent's FK columns from a probe record (connectOrCreate found). */
function bindParentFkFromRecord(
  fkDir: FkDirection,
  record: Readonly<Record<string, unknown>>,
  parentData: Record<string, Expr>,
  relationName: string
): void {
  Object.assign(
    parentData,
    parentFkExprsFromRecord(fkDir, record, relationName)
  );
}

/** Bind the parent's FK columns from a connect where-unique (literal or
 *  subquery). Uses `buildConnectFkValues` (parent holds FK). */
function bindParentFkFromConnect(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  connectInput: Record<string, unknown>,
  parentData: Record<string, Expr>
): void {
  Object.assign(
    parentData,
    parentFkExprsFromConnect(ctx, relationInfo, connectInput)
  );
}

/** Stamp a related child's FK column(s) as Exprs (createMany row builder). */
function stampRelatedFkExprs(
  fkDir: FkDirection,
  row: Record<string, Expr>,
  parentIdentity: Record<string, Expr>
): void {
  for (let i = 0; i < fkDir.fkFields.length; i++) {
    const fkField = fkDir.fkFields[i]!;
    const pkField = fkDir.pkFields[i]!;
    const parentExpr = parentIdentity[pkField];
    if (parentExpr === undefined) {
      throw new NestedWriteError(
        `Cannot create related rows: parent is missing primary key field '${pkField}'.`,
        fkField
      );
    }
    row[fkField] = parentExpr;
  }
}

/** FK assignment Exprs for an UPDATE set (related-holds-FK connect). */
function fkAssignmentExprs(
  fkDir: FkDirection,
  parentIdentity: Record<string, Expr>
): Record<string, Expr> {
  const set: Record<string, Expr> = {};
  for (let i = 0; i < fkDir.fkFields.length; i++) {
    const fkField = fkDir.fkFields[i]!;
    const pkField = fkDir.pkFields[i]!;
    const parentExpr = parentIdentity[pkField];
    if (parentExpr === undefined) {
      throw new NestedWriteError(
        `Cannot connect relation: parent is missing primary key field '${pkField}'.`,
        fkField
      );
    }
    set[fkField] = parentExpr;
  }
  return set;
}

function throwUnsupportedNestedCreate(relationName: string): never {
  throw new NestedWriteError(
    `Unsupported nested create operation on relation '${relationName}'.`,
    relationName
  );
}
