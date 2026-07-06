import type { AnyDriver } from "@drivers";
import type { Model } from "@schema/model";
import { isSql, type Sql } from "@sql";
import { getPrimaryKeyFields } from "../../builders/correlation-utils";
import { isGeneratedIncrementDefault } from "../../builders/generated-scalar";
import {
  buildConnectFkValues,
  type ConnectOrCreateInput,
  type FkDirection,
  getFkDirection,
  type NestedUpdateInput,
  type NestedUpdateManyInput,
  type RelationMutation,
  separateData,
} from "../../builders/relation-data-builder";
import {
  buildScalarSqlValue,
  getScalarCastType,
} from "../../builders/values-builder";
import { buildWhere } from "../../builders/where-builder";
import { buildWhereUnique } from "../../builders/where-unique-builder";
import { createChildContext, getColumnName, getTableName } from "../../context";
import {
  type BatchPreparationContext,
  NestedWriteError,
  type Operation,
  type QueryContext,
  QueryEngineError,
  type RelationInfo,
} from "../../types";
import {
  assertFkCanBeSetNull,
  assertSingleRelationInput,
  getNonNullableFkFields,
} from "./assertions";
import { overlayUpdatedParentData } from "./batch-updated-primary-keys";
import type { Guard, GuardFailure } from "./effects";
import type { Expr, WriteSymbol } from "./expr";
import {
  buildCurrentRecordMatchCondition,
  buildFkMatchCondition,
  combineWithParentCorrelation,
} from "./fk";
import { LiveMode } from "./live-mode";
import type { Emit, Mode, NestedWriteResult } from "./mode";
import { PlannedMode } from "./planned-mode";
import { recordNotFoundError } from "./record-access";
import {
  normalizeArray,
  planRelationMutationSteps,
  splitRelationMutationsByFk,
} from "./semantic-plan";
import { buildDepartingRowsCondition } from "./set";
import { normalizeNestedUpdateInputs } from "./update-plan";

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
  if (operation !== "create" && operation !== "update") {
    // Create (M3) and update (M5) families are migrated; the routing predicate
    // guarantees no other top-level operation reaches here (upsert lands at M6).
    throw new QueryEngineError(
      `The nested-write interpreter does not handle operation '${operation}' yet.`
    );
  }

  bindContext(mode, ctx);
  const refetch = Boolean(args.select || args.include);
  const selectInclude =
    args.select || args.include
      ? { select: args.select, include: args.include }
      : undefined;

  return mode.scope.run<T>(async (emit) => {
    const interp = createInterp(mode, emit);
    if (operation === "create") {
      const outcome = await interpretCreate(
        interp,
        ctx,
        args.data as Record<string, unknown>,
        undefined,
        /* isRoot */ true
      );
      return {
        finalWhere: outcome.finalWhere,
        refetch,
        selectInclude,
        record: outcome.record,
      } satisfies NestedWriteResult;
    }
    const outcome = await interpretTopLevelUpdate(interp, ctx, args);
    // An update always refetches by the (possibly PK-changed) final identity —
    // the tx engine re-SELECTs the row, the batch engine appends a findUnique,
    // and both return scalars when no select/include is present (Prisma parity).
    return {
      finalWhere: outcome.finalWhere,
      refetch: true,
      selectInclude,
      record: undefined,
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
async function interpretCreate(
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
async function emitCreateMany(
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
async function interpretRelatedConnect(
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

async function emitTargetExistsGuard(
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
  await interp.emit({
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

async function emitGuard(
  interp: Interp,
  guard: Guard | undefined
): Promise<void> {
  if (guard) {
    await interp.emit({ kind: "guard", guard });
  }
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

// ===========================================================================
// M5 — the update family (§9, §11 M5). update / updateMany / disconnect /
// delete / deleteMany / set over FK-only trees, both modes. The nested-relation
// conditions and assignments reuse the shared FK builders (`buildFkMatchCondition`,
// `combineWithParentCorrelation`, `buildDepartingRowsCondition`, `buildSet` …),
// which consume a raw `parentData: Record<string, unknown>` whose values are
// `BatchResolvableValue` (literal / Sql / BatchValueRef). The interpreter carries
// the parent identity as `Expr`s and lowers them to that carrier form via
// `parentCarrierData` (the mode's `symbolCarrier` supplies the Axis-A carrier),
// so correlation reads the rebound value in BOTH modes — closing D4 and
// DIVERGENCE-PARENTDATA-MUTATION by construction.
// ===========================================================================

interface UpdateOutcome {
  /** The parent identity (PK), possibly PK-changed, for the final result read. */
  finalWhere: Record<string, Expr>;
}

/**
 * A top-level update tree (§9 update row). Locate the target, apply the scalar
 * update (tracking a PK change as a literal or computedPk symbol), then process
 * every nested relation with the overlaid (D4-rebound) parent data.
 */
async function interpretTopLevelUpdate(
  interp: Interp,
  ctx: QueryContext,
  args: Record<string, unknown>
): Promise<UpdateOutcome> {
  const data = args.data as Record<string, unknown>;
  const where = args.where as Record<string, unknown>;
  const { scalarData, relations } = separateData(ctx, data);

  const whereSql = buildWhereUnique(ctx, where, getTableName(ctx.model));

  // Locate the target: required (throws typed in both modes) and pinned exists
  // (Pin Rule 1 — the row is held under the open tx in live mode; planned pins
  // it as an assertion). The record supplies the before-values the PK change
  // and D4 overlay read.
  const probe = await interp.mode.probe(ctx, {
    model: ctx.model,
    where: whereSql,
    select: "record",
    required: {
      error: () =>
        recordNotFoundError({
          relationName: getTableName(ctx.model),
          operation: "update",
          kind: "nested-write",
        }),
      raceable: false,
    },
    pin: {
      whenFound: existsGuard(
        ctx.model,
        whereSql,
        () =>
          recordNotFoundError({
            relationName: getTableName(ctx.model),
            operation: "update",
            kind: "nested-write",
          }),
        false
      ),
    },
  });
  if (!probe.found) {
    // Unreachable: `required` throws on absence. Narrow for the type checker.
    throw new QueryEngineError(
      "Update target vanished after a required probe."
    );
  }
  await emitGuard(interp, probe.guard);

  return applyScalarUpdateAndRelations(
    interp,
    ctx,
    probe.record,
    whereSql,
    scalarData,
    relations,
    /* requireAffected */ false
  );
}

/**
 * Shared body for a located parent: mint the (possibly PK-changed) identity,
 * emit the scalar UPDATE, build the overlaid parent data, and process every
 * nested relation. `requireAffected` is `false` for the top-level update (the
 * pin/probe already asserted existence) and a correlated failure for a nested
 * child update matched by correlation.
 */
async function applyScalarUpdateAndRelations(
  interp: Interp,
  ctx: QueryContext,
  beforeRecord: Readonly<Record<string, unknown>>,
  whereSql: Sql,
  scalarData: Record<string, unknown>,
  relations: Record<string, RelationMutation>,
  requireAffected: RequireAffectedInput
): Promise<UpdateOutcome> {
  const { identity, produces } = computeUpdatedIdentity(
    interp,
    ctx,
    beforeRecord,
    scalarData
  );

  if (Object.keys(scalarData).length > 0) {
    // `produces` (computedPk symbols) is always empty when scalarData is empty:
    // a PK arithmetic update carries the PK op in scalarData, so the update
    // effect and its store are emitted together here.
    await interp.emit({
      kind: "update",
      model: ctx.model,
      set: {},
      rawSet: scalarData,
      where: whereSql,
      requireAffected:
        requireAffected === false
          ? false
          : correlatedFailure(
              requireAffected.relationName,
              requireAffected.operation
            ),
      produces,
    });
  }

  // Build the parent data the nested-relation builders consume: the before
  // record overlaid with the updated PK carriers and every updated non-PK
  // literal column (D4 static over-approximation) — resolved to carriers now,
  // AFTER the update effect emitted (so a computedPk symbol is resolved in live
  // mode and its ref allocated in planned mode).
  const parentData = buildOverlaidParentData(
    interp.mode,
    ctx.model,
    beforeRecord,
    identity,
    scalarData
  );

  // The identity used to inject FKs into nested create/connect steps must carry
  // EVERY referenced column, not just the PK — a child FK may `.references()` a
  // non-PK unique column changed mid-update (D4). Convert the overlaid parent
  // data to Exprs, then override the PK fields with the (possibly computedPk
  // symbolic) identity so `finalWhere` and refetch stay correct.
  const relationIdentity: Record<string, Expr> = {};
  for (const [field, value] of Object.entries(parentData)) {
    relationIdentity[field] = carrierToExpr(value);
  }
  for (const [pkField, expr] of Object.entries(identity)) {
    relationIdentity[pkField] = expr;
  }

  await interpretRelations(
    interp,
    ctx,
    relations,
    relationIdentity,
    parentData
  );

  return { finalWhere: identity };
}

/** Nullable marker for a correlated requireAffected on a nested child update. */
type RequireAffectedInput =
  | false
  | { readonly relationName: string; readonly operation: string };

/**
 * Process a top-level/parent's after-parent relations in declaration order.
 * `identity` carries the parent PK as Exprs (for nested create/connect FK
 * injection); `parentData` carries the overlaid raw parent values (for the
 * shared FK correlation builders).
 */
async function interpretRelations(
  interp: Interp,
  ctx: QueryContext,
  relations: Record<string, RelationMutation>,
  identity: Record<string, Expr>,
  parentData: Record<string, unknown>
): Promise<void> {
  for (const [relationName, mutation] of Object.entries(relations)) {
    await interpretUpdateRelation(
      interp,
      ctx,
      relationName,
      mutation,
      identity,
      parentData
    );
  }
}

/** Dispatch one relation's steps for the update family (mirrors the shared
 *  `appendRelationMutation` / `processRelationMutation`, after-parent timing). */
async function interpretUpdateRelation(
  interp: Interp,
  ctx: QueryContext,
  relationName: string,
  mutation: RelationMutation,
  parentIdentity: Record<string, Expr>,
  parentData: Record<string, unknown>
): Promise<void> {
  const fkDir = getFkDirection(ctx, mutation.relationInfo);

  for (const step of planRelationMutationSteps(
    relationName,
    mutation,
    "after"
  )) {
    const { relationInfo } = step.context;
    switch (step.kind) {
      case "create":
        for (const createData of step.inputs) {
          if (fkDir.holdsFK) {
            await interpretParentHoldsFkCreate(
              interp,
              ctx,
              relationInfo,
              fkDir,
              createData,
              parentData,
              parentIdentity
            );
          } else {
            await interpretRelatedCreate(
              interp,
              ctx,
              relationInfo,
              fkDir,
              createData,
              parentIdentity
            );
          }
        }
        break;

      case "createMany":
        await emitCreateMany(
          interp,
          relationInfo,
          fkDir,
          step.input.data,
          step.input.skipDuplicates,
          parentIdentity
        );
        break;

      case "connect":
        for (const connectInput of step.inputs) {
          if (fkDir.holdsFK) {
            await interpretParentHoldsFkConnect(
              interp,
              ctx,
              relationInfo,
              fkDir,
              connectInput,
              parentData,
              parentIdentity
            );
          } else {
            await interpretRelatedConnect(
              interp,
              ctx,
              relationInfo,
              fkDir,
              connectInput,
              parentIdentity
            );
          }
        }
        break;

      case "connectOrCreate":
        for (const input of step.inputs) {
          if (fkDir.holdsFK) {
            await interpretParentHoldsFkConnectOrCreate(
              interp,
              ctx,
              relationInfo,
              fkDir,
              input,
              parentData,
              parentIdentity
            );
          } else {
            await interpretConnectOrCreateAfterParent(
              interp,
              ctx,
              relationInfo,
              fkDir,
              input,
              parentIdentity
            );
          }
        }
        break;

      case "disconnect":
        await interpretDisconnect(
          interp,
          ctx,
          relationInfo,
          fkDir,
          step.input,
          parentData,
          parentIdentity
        );
        break;

      case "delete":
        await interpretDelete(
          interp,
          ctx,
          relationInfo,
          fkDir,
          step.input,
          parentData,
          parentIdentity
        );
        break;

      case "deleteMany":
        await interpretDeleteMany(
          interp,
          ctx,
          relationInfo,
          fkDir,
          step.input,
          parentData
        );
        break;

      case "set":
        await interpretSet(
          interp,
          ctx,
          relationInfo,
          fkDir,
          step.input,
          parentData
        );
        break;

      case "update":
        await interpretNestedUpdate(
          interp,
          ctx,
          relationInfo,
          fkDir,
          step.input,
          parentData
        );
        break;

      case "updateMany":
        await interpretUpdateMany(
          interp,
          ctx,
          relationInfo,
          fkDir,
          step.input,
          parentData
        );
        break;

      default:
        throw new NestedWriteError(
          `Unsupported nested update operation '${step.kind}' on relation '${relationName}'.`,
          relationName
        );
    }
  }
}

// --- nested update / updateMany --------------------------------------------

/**
 * A nested `update` of a related row (§9 update). To-one: match by FK. To-many:
 * match by unique ∧ parent correlation. Assert existence (probe/pin), apply the
 * scalar update with `requireAffected: correlated`, rebind the updated PK and
 * every updated column, then recurse into nested relations.
 */
async function interpretNestedUpdate(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  fkDir: FkDirection,
  input: Record<string, unknown> | NestedUpdateInput | NestedUpdateInput[],
  parentData: Record<string, unknown>
): Promise<void> {
  const target = relationInfo.targetModel;
  const child = childCtx(ctx, relationInfo);

  const inputs: Array<{
    where?: Record<string, unknown>;
    data: Record<string, unknown>;
  }> = relationInfo.isToOne
    ? [{ data: input as Record<string, unknown> }]
    : normalizeNestedUpdateInputs(
        input as NestedUpdateInput | NestedUpdateInput[]
      );

  for (const one of inputs) {
    const whereSql = relationInfo.isToOne
      ? buildFkMatchCondition(ctx, fkDir, target, parentData)
      : combineWithParentCorrelation(
          ctx,
          fkDir,
          target,
          buildWhereUnique(child, one.where!, getTableName(target)),
          parentData
        );

    const { scalarData, relations } = separateData(child, one.data);
    const needsBeforeImage =
      hasPrimaryKeyUpdate(target, scalarData) ||
      Object.keys(relations).length > 0;

    // Locate the child: required + pinned exists (correlated). The before-image
    // is read only when a downstream consumer exists (the PK change or a nested
    // relation) — a scalar-only leaf update skips it (§6.2 over-approximation).
    const probe = await interp.mode.probe(child, {
      model: target,
      where: whereSql,
      select: needsBeforeImage ? "record" : "exists",
      required: correlatedFailure(relationInfo.name, "update"),
      pin: {
        whenFound: existsGuard(
          target,
          whereSql,
          () =>
            recordNotFoundError({
              relationName: relationInfo.name,
              operation: "update",
              kind: "correlated",
            }),
          false
        ),
      },
    });
    if (!probe.found) {
      throw correlatedFailure(relationInfo.name, "update").error();
    }
    await emitGuard(interp, probe.guard);

    if (!needsBeforeImage) {
      // Scalar-only leaf update, no PK change, no nested relations: emit the
      // correlated UPDATE directly. Its identity is never consumed (only the
      // top-level update refetches by identity), so no before-image is needed.
      if (Object.keys(scalarData).length > 0) {
        await interp.emit({
          kind: "update",
          model: target,
          set: {},
          rawSet: scalarData,
          where: whereSql,
          requireAffected: correlatedFailure(relationInfo.name, "update"),
          produces: [],
        });
      }
      continue;
    }

    await applyScalarUpdateAndRelations(
      interp,
      child,
      probe.record ?? {},
      whereSql,
      scalarData,
      relations,
      { relationName: relationInfo.name, operation: "update" }
    );
  }
}

/** A nested `updateMany` (§9 updateMany): set-based UPDATE over
 *  parentFk ∧ filter, `requireAffected: false` (never rows-required). */
async function interpretUpdateMany(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  fkDir: FkDirection,
  input: NestedUpdateManyInput | NestedUpdateManyInput[],
  parentData: Record<string, unknown>
): Promise<void> {
  if (relationInfo.isToOne) {
    throw new NestedWriteError(
      `Nested operation 'updateMany' is not supported for to-one relation '${relationInfo.name}'.`,
      relationInfo.name,
      { meta: { operation: "updateMany" } }
    );
  }
  const target = relationInfo.targetModel;
  const child = childCtx(ctx, relationInfo);

  for (const one of normalizeArray(input)) {
    const { scalarData } = separateData(child, one.data);
    if (Object.keys(scalarData).length === 0) {
      continue;
    }
    const whereSql = buildManyWhere(
      ctx,
      child,
      relationInfo,
      fkDir,
      one.where,
      parentData
    );
    await interp.emit({
      kind: "update",
      model: target,
      set: {},
      rawSet: scalarData,
      where: whereSql,
      requireAffected: false,
      produces: [],
    });
  }
}

// --- parent-holds-FK create/connect/connectOrCreate (update context) -------
// In an update tree the parent row already exists, so a parent-holds-FK
// create/connect/connectOrCreate resolves the target then UPDATEs the parent's
// FK column (unlike the create path, which folds the child PK into the parent
// INSERT before-parent). The parent's FK identity Exprs are rebound so a later
// relation correlates against the new FK.

/** Parent-holds-FK nested `create` in an update tree: create the child, then
 *  UPDATE the parent's FK to the child PK and rebind the parent identity. */
async function interpretParentHoldsFkCreate(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  fkDir: FkDirection,
  createData: Record<string, unknown>,
  parentData: Record<string, unknown>,
  parentIdentity: Record<string, Expr>
): Promise<void> {
  if (relationInfo.isToOne) {
    assertSingleRelationInput(relationInfo.name, "create", [createData]);
  }
  const child = await interpretCreate(
    interp,
    childCtx(ctx, relationInfo),
    createData
  );
  const fkExprs = parentFkExprsFromIdentity(fkDir, child.finalWhere);
  await emitParentFkUpdate(interp, ctx, relationInfo, fkExprs, parentData);
  rebindParentFk(fkDir, fkExprs, parentData, parentIdentity, interp.mode);
}

/** Parent-holds-FK nested `connect` in an update tree: assert the target exists,
 *  then UPDATE the parent's FK to the connect target and rebind the identity. */
async function interpretParentHoldsFkConnect(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  fkDir: FkDirection,
  connectInput: Record<string, unknown>,
  parentData: Record<string, unknown>,
  parentIdentity: Record<string, Expr>
): Promise<void> {
  await emitTargetExistsGuard(
    interp,
    ctx,
    relationInfo,
    connectInput,
    "connect"
  );
  const fkExprs = parentFkExprsFromConnect(ctx, relationInfo, connectInput);
  await emitParentFkUpdate(interp, ctx, relationInfo, fkExprs, parentData);
  rebindParentFk(fkDir, fkExprs, parentData, parentIdentity, interp.mode);
}

/** Parent-holds-FK nested `connectOrCreate` in an update tree. */
async function interpretParentHoldsFkConnectOrCreate(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  fkDir: FkDirection,
  input: ConnectOrCreateInput,
  parentData: Record<string, unknown>,
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

  let fkExprs: Record<string, Expr>;
  if (probe.found) {
    await emitGuard(interp, probe.guard);
    fkExprs = parentFkExprsFromRecord(fkDir, probe.record, relationInfo.name);
  } else {
    await emitGuard(interp, probe.guard); // undefined by Pin Rule 2.
    const child = await interpretCreate(interp, targetCtx, input.create);
    fkExprs = parentFkExprsFromIdentity(fkDir, child.finalWhere);
  }
  await emitParentFkUpdate(interp, ctx, relationInfo, fkExprs, parentData);
  rebindParentFk(fkDir, fkExprs, parentData, parentIdentity, interp.mode);
}

/** UPDATE the current parent row's FK columns, correlated by the parent PK. */
async function emitParentFkUpdate(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  fkExprs: Record<string, Expr>,
  parentData: Record<string, unknown>
): Promise<void> {
  await interp.emit({
    kind: "update",
    model: ctx.model,
    set: fkExprs,
    where: buildCurrentRecordMatchCondition(ctx, parentData),
    requireAffected: correlatedFailure(relationInfo.name, "connect"),
    produces: [],
  });
}

/** Rebind the parent's FK columns in both the identity Exprs (for a later
 *  parent-holds-FK relation) and the raw parent data (for correlation builders),
 *  resolving each FK Expr to its carrier. */
function rebindParentFk(
  fkDir: FkDirection,
  fkExprs: Record<string, Expr>,
  parentData: Record<string, unknown>,
  parentIdentity: Record<string, Expr>,
  mode: Mode
): void {
  for (const fkField of fkDir.fkFields) {
    const expr = fkExprs[fkField];
    if (expr === undefined) {
      continue;
    }
    parentIdentity[fkField] = expr;
    parentData[fkField] = exprToCarrier(mode, expr);
  }
}

function parentFkExprsFromIdentity(
  fkDir: FkDirection,
  childIdentity: Record<string, Expr>
): Record<string, Expr> {
  const fkExprs: Record<string, Expr> = {};
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
    fkExprs[fkField] = value;
  }
  return fkExprs;
}

function parentFkExprsFromRecord(
  fkDir: FkDirection,
  record: Readonly<Record<string, unknown>>,
  relationName: string
): Record<string, Expr> {
  const fkExprs: Record<string, Expr> = {};
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
    fkExprs[fkField] = { kind: "lit", value };
  }
  return fkExprs;
}

function parentFkExprsFromConnect(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  connectInput: Record<string, unknown>
): Record<string, Expr> {
  const fkValues = buildConnectFkValues(ctx, relationInfo, connectInput);
  const fkExprs: Record<string, Expr> = {};
  for (const [field, valueSql] of Object.entries(fkValues)) {
    fkExprs[field] = { kind: "sql", sql: valueSql };
  }
  return fkExprs;
}

// --- disconnect / delete / deleteMany --------------------------------------

/** A nested `disconnect` (§9 disconnect). */
async function interpretDisconnect(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  fkDir: FkDirection,
  input: boolean | Record<string, unknown> | Record<string, unknown>[],
  parentData: Record<string, unknown>,
  parentIdentity: Record<string, Expr>
): Promise<void> {
  assertFkCanBeSetNull(relationInfo.name, fkDir);

  if (fkDir.holdsFK) {
    // Parent holds the FK: null it on the parent row and rebind the parent's FK
    // identity Exprs to null so downstream correlation reads the disconnected
    // value (DIVERGENCE-PARENTDATA-MUTATION closed).
    await interp.emit({
      kind: "update",
      model: ctx.model,
      set: fkNullSet(fkDir),
      where: buildCurrentRecordMatchCondition(ctx, parentData),
      requireAffected: correlatedFailure(relationInfo.name, "disconnect"),
      produces: [],
    });
    rebindParentFkToNull(fkDir, parentData, parentIdentity);
    return;
  }

  // Child holds the FK: null it on the child. `disconnect: true` is lax (nulls
  // every correlated child); an explicit where is strict (correlated).
  const target = relationInfo.targetModel;
  if (input === true) {
    await interp.emit({
      kind: "update",
      model: target,
      set: fkNullSet(fkDir),
      where: buildFkMatchCondition(ctx, fkDir, target, parentData),
      requireAffected: false,
      produces: [],
    });
    return;
  }

  const whereSql = buildExplicitTargetWhere(
    ctx,
    relationInfo,
    fkDir,
    input,
    parentData
  );
  await interp.emit({
    kind: "update",
    model: target,
    set: fkNullSet(fkDir),
    where: whereSql,
    requireAffected: correlatedFailure(relationInfo.name, "disconnect"),
    produces: [],
  });
}

/** A nested `delete` (§9 delete). Parent-holds-FK: null the parent FK first (as
 *  disconnect) then delete the child; else delete the child. `true` is lax; an
 *  explicit where is correlated. */
async function interpretDelete(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  fkDir: FkDirection,
  input: boolean | Record<string, unknown> | Record<string, unknown>[],
  parentData: Record<string, unknown>,
  parentIdentity: Record<string, Expr>
): Promise<void> {
  const target = relationInfo.targetModel;
  const explicit = input !== true;
  const whereSql =
    input === true
      ? buildFkMatchCondition(ctx, fkDir, target, parentData)
      : buildExplicitTargetWhere(ctx, relationInfo, fkDir, input, parentData);

  if (fkDir.holdsFK) {
    // FK-null-before-child-delete: the parent references the child, so break the
    // link on the parent row first, then delete the child.
    assertFkCanBeSetNull(relationInfo.name, fkDir);
    await interp.emit({
      kind: "update",
      model: ctx.model,
      set: fkNullSet(fkDir),
      where: buildCurrentRecordMatchCondition(ctx, parentData),
      requireAffected: false,
      produces: [],
    });
    rebindParentFkToNull(fkDir, parentData, parentIdentity);
  }

  await interp.emit({
    kind: "delete",
    model: target,
    where: whereSql,
    requireAffected: explicit
      ? correlatedFailure(relationInfo.name, "delete")
      : false,
  });
}

/** A nested `deleteMany` (§9 deleteMany): set-based DELETE over
 *  parentFk ∧ filter (per item). */
async function interpretDeleteMany(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  fkDir: FkDirection,
  input: Record<string, unknown> | Record<string, unknown>[],
  parentData: Record<string, unknown>
): Promise<void> {
  if (relationInfo.isToOne) {
    throw new NestedWriteError(
      `Nested operation 'deleteMany' is not supported for to-one relation '${relationInfo.name}'.`,
      relationInfo.name,
      { meta: { operation: "deleteMany" } }
    );
  }
  const target = relationInfo.targetModel;
  const child = childCtx(ctx, relationInfo);
  for (const one of normalizeArray(input)) {
    const whereSql = buildManyWhere(
      ctx,
      child,
      relationInfo,
      fkDir,
      one,
      parentData
    );
    await interp.emit({
      kind: "delete",
      model: target,
      where: whereSql,
      requireAffected: false,
    });
  }
}

// --- set -------------------------------------------------------------------

/**
 * A nested `set` (§9 set) on an FK to-many relation. One order for both modes:
 * assert members exist (probe required) → handle departing rows (required FK →
 * orphan guard; nullable → null-out UPDATE) → connect each non-already-connected
 * member. Already-connected members are skipped in both modes from the probe
 * record, replaced by a pinned exists(unique ∧ fkMatch) guard (§1.2 A13).
 */
async function interpretSet(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  fkDir: FkDirection,
  setItems: Record<string, unknown>[],
  parentData: Record<string, unknown>
): Promise<void> {
  if (fkDir.holdsFK) {
    throw new NestedWriteError(
      `'set' operation is not supported for relation '${relationInfo.name}' where current model holds FK. ` +
        "Use 'connect' instead for to-one relations.",
      relationInfo.name
    );
  }
  for (const pkField of fkDir.pkFields) {
    if (parentData[pkField] === undefined || parentData[pkField] === null) {
      throw new NestedWriteError(
        `Cannot execute 'set' for relation '${relationInfo.name}': parent record is missing primary key field '${pkField}'. ` +
          "Ensure the parent record is saved before performing nested operations.",
        relationInfo.name
      );
    }
  }

  const target = relationInfo.targetModel;
  const child = childCtx(ctx, relationInfo);

  // Resolve every member up front: assert existence (required) and read its
  // record so already-connected members can be skipped (both modes, §1.2 A13).
  const memberRecords: Readonly<Record<string, unknown>>[] = [];
  for (const setItem of setItems) {
    const memberWhere = buildWhereUnique(child, setItem, getTableName(target));
    const probe = await interp.mode.probe(child, {
      model: target,
      where: memberWhere,
      select: "record",
      required: {
        error: () =>
          recordNotFoundError({
            relationName: relationInfo.name,
            operation: "set",
            kind: "target",
          }),
        raceable: false,
      },
      pin: {
        whenFound: existsGuard(
          target,
          memberWhere,
          () =>
            recordNotFoundError({
              relationName: relationInfo.name,
              operation: "set",
              kind: "target",
            }),
          false
        ),
      },
    });
    if (!probe.found) {
      throw recordNotFoundError({
        relationName: relationInfo.name,
        operation: "set",
        kind: "target",
      });
    }
    await emitGuard(interp, probe.guard);
    memberRecords.push(probe.record);
  }

  // Departing rows: connected to this parent but NOT in the new set.
  const departingWhere = buildDepartingRowsCondition(
    ctx,
    fkDir,
    relationInfo,
    setItems,
    parentData,
    child
  );
  const requiredFkFields = getNonNullableFkFields(fkDir);
  if (requiredFkFields.length > 0) {
    // Required FK: departing rows cannot be orphaned. Guard fires only when rows
    // would actually depart — a no-op set succeeds (Prisma parity).
    await interp.emit({
      kind: "guard",
      guard: {
        premise: { kind: "notExists", model: target, where: departingWhere },
        failure: {
          error: () =>
            new NestedWriteError(
              `Cannot set relation '${relationInfo.name}' because foreign key field(s) ${requiredFkFields.join(
                ", "
              )} are required: rows removed from the set cannot be disconnected. Delete them instead.`,
              relationInfo.name
            ),
          raceable: false,
        },
      },
    });
  } else {
    await interp.emit({
      kind: "update",
      model: target,
      set: fkNullSet(fkDir),
      where: departingWhere,
      requireAffected: false,
      produces: [],
    });
  }

  // Connect each member. Skip already-connected members (from the probe record):
  // rewriting them is wasted work and MySQL reports a no-change UPDATE as 0 rows,
  // which would trip the correlated guard. A skipped member is replaced by a
  // pinned exists(unique ∧ fkMatch) guard ("still connected") — a no-op in live
  // mode, an assertion in planned mode.
  for (let index = 0; index < setItems.length; index++) {
    const memberWhere = buildWhereUnique(
      child,
      setItems[index]!,
      getTableName(target)
    );
    if (isAlreadyConnected(fkDir, memberRecords[index]!, parentData)) {
      const connectedWhere = combineWithParentCorrelation(
        ctx,
        fkDir,
        target,
        memberWhere,
        parentData
      );
      await interp.emit({
        kind: "guard",
        guard: existsGuard(
          target,
          connectedWhere,
          () =>
            recordNotFoundError({
              relationName: relationInfo.name,
              operation: "set",
              kind: "correlated",
            }),
          false
        ),
      });
      continue;
    }
    await interp.emit({
      kind: "update",
      model: target,
      set: fkValueSet(fkDir, parentData),
      where: memberWhere,
      requireAffected: correlatedFailure(relationInfo.name, "set"),
      produces: [],
    });
  }
}

// --- update-family plumbing ------------------------------------------------

/**
 * Compute the parent identity after a scalar update: each PK field is a literal
 * Expr (unchanged, or a literal/`{set}` update) or a `computedPk` symbol (PK
 * arithmetic). The computed value's `valueSql` is the adapter arithmetic over
 * the before-value — the DB (planned) or a scalar SELECT (live) resolves it.
 */
function computeUpdatedIdentity(
  interp: Interp,
  ctx: QueryContext,
  beforeRecord: Readonly<Record<string, unknown>>,
  scalarData: Record<string, unknown>
): { identity: Record<string, Expr>; produces: WriteSymbol[] } {
  const identity: Record<string, Expr> = {};
  const produces: WriteSymbol[] = [];
  const model = ctx.model;

  for (const pkField of getPrimaryKeyFields(model)) {
    const beforeValue = getRequiredBeforePk(model, beforeRecord, pkField);

    if (scalarData[pkField] === undefined) {
      identity[pkField] = { kind: "lit", value: beforeValue };
      continue;
    }

    const updated = classifyPkUpdate(
      ctx,
      pkField,
      beforeValue,
      scalarData[pkField]
    );
    if (updated.kind === "literal") {
      identity[pkField] = { kind: "lit", value: updated.value };
      continue;
    }

    const symbol: WriteSymbol = {
      id: interp.nextSymbolId(),
      model,
      field: pkField,
      origin: { kind: "computedPk", valueSql: updated.valueSql },
    };
    produces.push(symbol);
    identity[pkField] = { kind: "sym", sym: symbol };
  }

  return { identity, produces };
}

type PkUpdate =
  | { kind: "literal"; value: unknown }
  | { kind: "computed"; valueSql: Sql };

/** Classify a PK-field update value: literal / `{set}` → literal; numeric op →
 *  computed arithmetic Sql. Non-literal/unsafe values are rejected at the
 *  legality gate before this runs, so the residual cases here are exhaustive. */
function classifyPkUpdate(
  ctx: QueryContext,
  pkField: string,
  beforeValue: unknown,
  updateValue: unknown
): PkUpdate {
  if (!isPlainRecord(updateValue)) {
    return { kind: "literal", value: updateValue };
  }
  const opKeys = Object.keys(updateValue).filter(
    (key) => updateValue[key] !== undefined
  );
  if (opKeys.length !== 1) {
    throw new NestedWriteError(
      `Batch-only nested update cannot update primary key field '${pkField}' with operation envelope '${opKeys.join(", ")}'.`,
      getTableName(ctx.model)
    );
  }
  const op = opKeys[0]!;
  const operand = updateValue[op];
  if (op === "set") {
    return { kind: "literal", value: operand };
  }
  const oldSql = buildPkArithmeticOperand(ctx, pkField, beforeValue);
  const operandSql = buildPkArithmeticOperand(ctx, pkField, operand);
  switch (op) {
    case "increment":
      return {
        kind: "computed",
        valueSql: ctx.adapter.expressions.add(oldSql, operandSql),
      };
    case "decrement":
      return {
        kind: "computed",
        valueSql: ctx.adapter.expressions.subtract(oldSql, operandSql),
      };
    case "multiply":
      return {
        kind: "computed",
        valueSql: ctx.adapter.expressions.multiply(oldSql, operandSql),
      };
    case "divide":
      return {
        kind: "computed",
        valueSql: ctx.adapter.expressions.divide(oldSql, operandSql),
      };
    default:
      throw new NestedWriteError(
        `Batch-only nested update cannot update primary key field '${pkField}' with unsupported operation '${op}'.`,
        getTableName(ctx.model)
      );
  }
}

function buildPkArithmeticOperand(
  ctx: QueryContext,
  pkField: string,
  value: unknown
): Sql {
  const valueSql = buildScalarSqlValue(ctx, ctx.model, pkField, value);
  const castType = getScalarCastType(ctx.model, pkField);
  return castType ? ctx.adapter.expressions.cast(valueSql, castType) : valueSql;
}

function getRequiredBeforePk(
  model: Model<any>,
  beforeRecord: Readonly<Record<string, unknown>>,
  pkField: string
): unknown {
  const value =
    beforeRecord[pkField] ?? beforeRecord[getColumnName(model, pkField)];
  if (value === undefined || value === null || isSql(value)) {
    throw new NestedWriteError(
      `Batch-only nested update requires primary key field '${pkField}' to be known before execution.`,
      getTableName(model)
    );
  }
  return value;
}

function hasPrimaryKeyUpdate(
  model: Model<any>,
  data: Record<string, unknown>
): boolean {
  return getPrimaryKeyFields(model).some(
    (pkField) => data[pkField] !== undefined
  );
}

// --- FK assignment / condition helpers (Expr + carrier plumbing) -----------

/** FK-null assignment Exprs for an update effect `set` (disconnect / departing
 *  rows). Column names resolve in lowering via `getColumnName`. */
function fkNullSet(
  fkDir: FkDirection
): Record<string, Expr | { readonly op: Sql }> {
  const set: Record<string, Expr> = {};
  for (const fkField of fkDir.fkFields) {
    set[fkField] = { kind: "lit", value: null };
  }
  return set;
}

/** FK-value assignment Exprs (connect a member to the parent PK). The parent PK
 *  carrier (literal / Sql / BatchValueRef) lowers through buildScalarSqlValue
 *  for the child FK column. */
function fkValueSet(
  fkDir: FkDirection,
  parentData: Record<string, unknown>
): Record<string, Expr | { readonly op: Sql }> {
  const set: Record<string, Expr> = {};
  for (let i = 0; i < fkDir.fkFields.length; i++) {
    const fkField = fkDir.fkFields[i]!;
    const pkField = fkDir.pkFields[i]!;
    set[fkField] = carrierToExpr(parentData[pkField]);
  }
  return set;
}

function rebindParentFkToNull(
  fkDir: FkDirection,
  parentData: Record<string, unknown>,
  parentIdentity: Record<string, Expr>
): void {
  for (const fkField of fkDir.fkFields) {
    parentData[fkField] = null;
    parentIdentity[fkField] = { kind: "lit", value: null };
  }
}

function buildExplicitTargetWhere(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  fkDir: FkDirection,
  input: boolean | Record<string, unknown> | Record<string, unknown>[],
  parentData: Record<string, unknown>
): Sql {
  const target = relationInfo.targetModel;
  const child = childCtx(ctx, relationInfo);
  const inputs = Array.isArray(input) ? input : [input];
  const conditions: Sql[] = [];
  for (const one of inputs) {
    if (typeof one === "object" && one !== null) {
      conditions.push(buildWhereUnique(child, one, getTableName(target)));
    }
  }
  if (conditions.length === 0) {
    throw new NestedWriteError(
      `Invalid input for relation '${relationInfo.name}'`,
      relationInfo.name
    );
  }
  const targetWhere =
    conditions.length === 1
      ? conditions[0]!
      : ctx.adapter.operators.or(...conditions);
  return combineWithParentCorrelation(
    ctx,
    fkDir,
    target,
    targetWhere,
    parentData
  );
}

function buildManyWhere(
  ctx: QueryContext,
  child: QueryContext,
  relationInfo: RelationInfo,
  fkDir: FkDirection,
  where: Record<string, unknown> | undefined,
  parentData: Record<string, unknown>
): Sql {
  const target = relationInfo.targetModel;
  const parentWhere = buildFkMatchCondition(ctx, fkDir, target, parentData);
  const targetTable = getTableName(target);
  const childWhere = buildWhere(
    { ...child, mutationTable: targetTable },
    where,
    targetTable
  );
  return childWhere
    ? ctx.adapter.operators.and(parentWhere, childWhere)
    : parentWhere;
}

/** A raw parent carrier value (literal / Sql / BatchValueRef) as an Expr for
 *  the effect `set` lowering. A Sql passes through as a `sql` Expr; everything
 *  else (including a BatchValueRef, which buildScalarSqlValue lowers) as `lit`. */
function carrierToExpr(value: unknown): Expr {
  if (isSql(value)) {
    return { kind: "sql", sql: value };
  }
  return { kind: "lit", value };
}

/** Convert the parent identity Exprs (+ D4 non-PK overlay) into the raw
 *  `parentData` the shared FK builders consume. A `sym` Expr resolves to its
 *  Axis-A carrier (JS value in live mode, BatchValueRef in planned mode). */
function buildOverlaidParentData(
  mode: Mode,
  model: Model<any>,
  beforeRecord: Readonly<Record<string, unknown>>,
  identity: Record<string, Expr>,
  scalarData: Record<string, unknown>
): Record<string, unknown> {
  const pkCarriers: Record<string, unknown> = {};
  for (const [field, expr] of Object.entries(identity)) {
    pkCarriers[field] = exprToCarrier(mode, expr);
  }
  // overlayUpdatedParentData overlays the PK carriers and every updated non-PK
  // literal column onto the before record (D4 static over-approximation).
  return overlayUpdatedParentData(
    model,
    { ...beforeRecord },
    pkCarriers,
    scalarData
  );
}

function exprToCarrier(mode: Mode, expr: Expr): unknown {
  switch (expr.kind) {
    case "lit":
      return expr.value;
    case "sql":
      return expr.sql;
    case "sym":
      return mode.symbolCarrier(expr.sym);
    default: {
      const exhaustive: never = expr;
      return exhaustive;
    }
  }
}

function isAlreadyConnected(
  fkDir: FkDirection,
  targetRecord: Readonly<Record<string, unknown>>,
  parentData: Record<string, unknown>
): boolean {
  return fkDir.fkFields.every((fkField, index) => {
    const currentValue = targetRecord[fkField];
    const parentValue = parentData[fkDir.pkFields[index]!];
    if (currentValue === null || currentValue === undefined) {
      return false;
    }
    if (parentValue === null || parentValue === undefined) {
      return false;
    }
    return (
      currentValue === parentValue ||
      String(currentValue) === String(parentValue)
    );
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
