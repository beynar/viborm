import type { AnyDriver } from "@drivers";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import { getPrimaryKeyFields } from "../../builders/correlation-utils";
import { isGeneratedIncrementDefault } from "../../builders/generated-scalar";
import {
  buildConnectFkValues,
  type ConnectOrCreateInput,
  type FkDirection,
  getFkDirection,
  type RelationMutation,
  separateData,
} from "../../builders/relation-data-builder";
import { buildWhereUnique } from "../../builders/where-unique-builder";
import { createChildContext, getTableName } from "../../context";
import {
  type BatchPreparationContext,
  NestedWriteError,
  type Operation,
  type QueryContext,
  QueryEngineError,
  type RelationInfo,
} from "../../types";
import { assertSingleRelationInput } from "./assertions";
import type { Guard, GuardFailure } from "./effects";
import type { Expr, WriteSymbol } from "./expr";
import { LiveMode } from "./live-mode";
import type { Emit, Mode, NestedWriteResult } from "./mode";
import { PlannedMode } from "./planned-mode";
import { recordNotFoundError } from "./record-access";
import {
  planRelationMutationSteps,
  splitRelationMutationsByFk,
} from "./semantic-plan";

/**
 * The only capability fork (§8.1). Capability precedence preserved exactly: a
 * driver supporting both transactions and batch takes LiveMode (map-oracle §A);
 * a batch-only driver takes PlannedMode; a driver with neither (d1-http) falls
 * to the throw — the same "cannot execute atomically" rejection the old
 * `runNestedMutationAtomically` raised, with `meta.strategy: "unsupported"`
 * (capability honesty, map-batch-refs §6.2).
 *
 * `operation` is threaded through so the neither-capability rejection is
 * byte-identical to the frozen old path (`atomic-runner.ts`): message
 * `cannot execute nested ${operation} writes atomically …` and
 * `meta.operation`. §8.1's `selectMode(driver, shared?)` signature omitted
 * `operation`; §11 M1 / §10 D9 / §7.1 require the d1-http rejection message to
 * survive verbatim, so the parameter is restored here (design/reality conflict
 * resolved in favor of the normative preservation demand — see report).
 */
export function selectMode(
  driver: AnyDriver,
  operation: Operation,
  shared?: BatchPreparationContext
): Mode {
  if (driver.supportsTransactions) {
    return new LiveMode(driver);
  }
  if (driver.supportsBatch) {
    return new PlannedMode(driver, shared);
  }
  throw new QueryEngineError(
    `Driver '${driver.driverName}' cannot execute nested ${operation} writes atomically because it supports neither callback transactions nor atomic batch execution.`,
    {
      meta: {
        driver: driver.driverName,
        operation,
        strategy: "unsupported",
      },
    }
  );
}

/**
 * The interpreter entry (§2, §8.6). Owns every semantic decision once and
 * consults a `Mode` for substrate mechanics.
 *
 * M3 scope (§11): the create family (create / createMany / connect /
 * connectOrCreate) over FK-only trees, in both modes. Update/upsert/m2m trees
 * are not eligible yet and never reach here (`isTreeEligible`, §11).
 */
export function runInterpreter<T>(
  ctx: QueryContext,
  operation: Operation,
  args: Record<string, unknown>,
  mode: Mode
): Promise<T> {
  if (operation !== "create") {
    // Only the create family is migrated at M3; the routing predicate
    // guarantees no other top-level operation reaches here.
    throw new QueryEngineError(
      `The nested-write interpreter does not handle operation '${operation}' yet; only create-family trees are eligible at milestone M3.`
    );
  }

  bindContext(mode, ctx);
  const data = args.data as Record<string, unknown>;
  const refetch = Boolean(args.select || args.include);
  const selectInclude =
    args.select || args.include
      ? { select: args.select, include: args.include }
      : undefined;

  return mode.scope.run<T>(async (emit) => {
    const interp = createInterp(mode, emit);
    const outcome = await interpretCreate(interp, ctx, data);
    return {
      finalWhere: outcome.finalWhere,
      refetch,
      selectInclude,
      record: outcome.record,
    } satisfies NestedWriteResult;
  });
}

/** Bind the top-level query context to the mode so its effect execution and
 *  result assembly reuse the query-engine machinery. Both modes expose
 *  `bindContext`; the union keeps `Mode` free of it (it is substrate setup). */
function bindContext(mode: Mode, ctx: QueryContext): void {
  if (mode instanceof LiveMode || mode instanceof PlannedMode) {
    mode.bindContext(ctx);
  }
}

/**
 * The per-operation interpreter bundle: the mode, its effect sink, and a
 * monotonic symbol minter. One instance threads the whole tree so `WriteSymbol`
 * ids are unique across sibling inserts of the same model (map-batch-refs §5:
 * the value-ref namespace is monotonic, never per-record).
 */
interface Interp {
  readonly mode: Mode;
  readonly emit: Emit;
  readonly nextSymbolId: () => string;
}

function createInterp(mode: Mode, emit: Emit): Interp {
  let counter = 0;
  return {
    mode,
    emit,
    nextSymbolId: () => `sym_${counter++}`,
  };
}

interface CreateOutcome {
  /** The parent identity (PK), possibly symbolic, for the final result read. */
  finalWhere: Record<string, Expr>;
  /** Live mode holds the parent record for a scalar-only result. */
  record?: Record<string, unknown>;
}

/**
 * Interpret one create tree into effects (§9 create rows). FK split (I4):
 * currentHoldsFk resolves before the parent insert (child PK → parent FK);
 * relatedHoldsFk + junction after. The parent PK becomes an `Expr` — a literal
 * when provided, a `generatedPk` symbol when auto-incremented.
 */
async function interpretCreate(
  interp: Interp,
  ctx: QueryContext,
  data: Record<string, unknown>,
  injectedFk?: Record<string, Expr>
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

  await interp.emit({
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

  return { finalWhere: identity, record: undefined };
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
      whenFound: existsGuard(
        target,
        whereSql,
        () =>
          recordNotFoundError({
            relationName: relationInfo.name,
            operation: "connectOrCreate",
            kind: "target",
          }),
        false
      ),
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
async function interpretRelatedCreate(
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
function emitCreateMany(
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
    return Promise.resolve();
  }
  const rows = data.map((record) => {
    const row = toLiteralExprs(relationInfo.targetModel, record);
    stampRelatedFkExprs(fkDir, row, parentIdentity);
    return row;
  });
  return interp.emit({
    kind: "insertMany",
    model: relationInfo.targetModel,
    rows,
    skipDuplicates,
  });
}

/** A related-holds-FK connect: UPDATE the child's FK to the parent PK, matched
 *  by the child's where-unique. requireAffected: correlated (§5.3). */
function interpretRelatedConnect(
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
  return interp.emit({
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
async function interpretConnectOrCreateAfterParent(
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
      whenFound: existsGuard(
        target,
        whereSql,
        () =>
          recordNotFoundError({
            relationName: relationInfo.name,
            operation: "connectOrCreate",
            kind: "target",
          }),
        false
      ),
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
  for (let i = 0; i < fkDir.fkFields.length; i++) {
    const fkField = fkDir.fkFields[i]!;
    const pkField = fkDir.pkFields[i]!;
    const value = childIdentity[pkField];
    if (value === undefined) {
      throw new NestedWriteError(
        `Cannot connect relation: child is missing primary key field '${pkField}'.`,
        fkField
      );
    }
    parentData[fkField] = value;
  }
}

/** Bind the parent's FK columns from a probe record (connectOrCreate found). */
function bindParentFkFromRecord(
  fkDir: FkDirection,
  record: Readonly<Record<string, unknown>>,
  parentData: Record<string, Expr>,
  relationName: string
): void {
  for (let i = 0; i < fkDir.fkFields.length; i++) {
    const fkField = fkDir.fkFields[i]!;
    const pkField = fkDir.pkFields[i]!;
    const value = record[pkField];
    if (value === undefined) {
      throw new NestedWriteError(
        `Cannot connect relation '${relationName}': target record is missing primary key field '${pkField}'.`,
        relationName
      );
    }
    parentData[fkField] = { kind: "lit", value };
  }
}

/** Bind the parent's FK columns from a connect where-unique (literal or
 *  subquery). Uses `buildConnectFkValues` (parent holds FK). */
function bindParentFkFromConnect(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  connectInput: Record<string, unknown>,
  parentData: Record<string, Expr>
): void {
  const fkValues = buildConnectFkValues(ctx, relationInfo, connectInput);
  for (const [field, valueSql] of Object.entries(fkValues)) {
    parentData[field] = { kind: "sql", sql: valueSql };
  }
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

// --- guards -----------------------------------------------------------------

function existsGuard(
  model: Model<any>,
  where: Sql,
  error: () => NestedWriteError,
  raceable: boolean
): Guard {
  return {
    premise: { kind: "exists", model, where },
    failure: { error, raceable },
  };
}

function emitTargetExistsGuard(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  connectInput: Record<string, unknown>,
  operation: string
): Promise<void> {
  const target = relationInfo.targetModel;
  const targetCtx = childCtx(ctx, relationInfo);
  const whereSql = buildWhereUnique(
    targetCtx,
    connectInput,
    getTableName(target)
  );
  return interp.emit({
    kind: "guard",
    guard: existsGuard(
      target,
      whereSql,
      () =>
        recordNotFoundError({
          relationName: relationInfo.name,
          operation,
          kind: "target",
        }),
      false
    ),
  });
}

function emitGuard(interp: Interp, guard: Guard | undefined): Promise<void> {
  if (guard) {
    return interp.emit({ kind: "guard", guard });
  }
  return Promise.resolve();
}

function correlatedFailure(
  relationName: string,
  operation: string
): GuardFailure {
  return {
    error: () =>
      recordNotFoundError({ relationName, operation, kind: "correlated" }),
    raceable: false,
  };
}

// --- small helpers ----------------------------------------------------------

function childCtx(ctx: QueryContext, relationInfo: RelationInfo): QueryContext {
  return createChildContext(ctx, relationInfo.targetModel, ctx.nextAlias());
}

function throwUnsupportedNestedCreate(relationName: string): never {
  throw new NestedWriteError(
    `Unsupported nested create operation on relation '${relationName}'.`,
    relationName
  );
}
