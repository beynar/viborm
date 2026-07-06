import type { Model } from "@schema/model";
import { isSql, type Sql, sql } from "@sql";
import { getPrimaryKeyFields } from "../../builders/correlation-utils";
import { isGeneratedIncrementDefault } from "../../builders/generated-scalar";
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
  buildConnectFkValues,
  type ConnectOrCreateInput,
  type FkDirection,
  getFkDirection,
  type NestedUpdateInput,
  type NestedUpdateManyInput,
  type NestedUpsertInput,
  type RelationMutation,
  separateData,
} from "../../builders/relation-data-builder";
import {
  buildScalarSqlValue,
  getScalarCastType,
  isBatchValueRef,
} from "../../builders/values-builder";
import { buildWhere } from "../../builders/where-builder";
import { buildWhereUnique } from "../../builders/where-unique-builder";
import { createChildContext, getColumnName, getTableName } from "../../context";
import {
  NestedWriteError,
  type Operation,
  type QueryContext,
  QueryEngineError,
  type RelationInfo,
} from "../../types";
import { getPrimaryKeyWhereFromRecord } from "../mutation-returns";
import {
  assertFkCanBeSetNull,
  assertSingleRelationInput,
  getNonNullableFkFields,
} from "./assertions";
import type { Guard, GuardFailure } from "./effects";
import type { Expr, WriteSymbol } from "./expr";
import {
  buildCurrentRecordMatchCondition,
  buildDepartingRowsCondition,
  buildFkMatchCondition,
  combineWithParentCorrelation,
  overlayUpdatedParentData,
} from "./fk";
import {
  assertNestedUpdatePlanIsExecutable,
  assertNoPlannedNestedMutationExecution,
  assertUpdateManyDataHasNoRelations,
  normalizeNestedUpdateInputs,
  normalizeNestedUpdateManyInputs,
} from "./legality";
import { LiveMode } from "./live-mode";
import type { Emit, Mode, NestedWriteResult } from "./mode";
import { PlannedMode } from "./planned-mode";
import { buildUniqueWithWhere, recordNotFoundError } from "./record-access";
import {
  assertManyToManyStepCombinationIsSupported,
  hasRecordKeys,
  normalizeArray,
  normalizeRecordArray,
  planExistingUpsertBranch,
  planRelationMutationSteps,
  splitRelationMutationsByFk,
} from "./semantic-plan";

// The capability fork `selectMode` (§8.1) lives in `mode.ts` — the single place
// a driver's atomic-strategy capabilities are read (grep gate 1). It is
// re-exported here so callers keep importing it from the interpreter entry.
export { selectMode } from "./mode";

/**
 * The interpreter entry (§2, §8.6). Owns every semantic decision once and
 * consults a `Mode` for substrate mechanics.
 *
 * Every create/update/upsert nested-write tree — every mutation kind, over FK
 * and m2m relations alike — runs here in both modes (§11 M9). The migration
 * routing seam and the frozen legacy engines are gone (§11 M10).
 */
export function runInterpreter<T>(
  ctx: QueryContext,
  operation: Operation,
  args: Record<string, unknown>,
  mode: Mode
): Promise<T> {
  if (
    operation !== "create" &&
    operation !== "update" &&
    operation !== "upsert"
  ) {
    // Create (M3), update (M5) and upsert (M6) families are migrated; the
    // routing predicate guarantees no other top-level operation reaches here
    // (m2m lands at M9).
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
    if (operation === "upsert") {
      const outcome = await interpretTopLevelUpsert(interp, ctx, args);
      // An upsert always refetches by the final identity — every branch
      // (create / update / targetWhere-skip / setWhere-skip) resolves to a
      // findUnique by the resolved PK, returning scalars when no select/include
      // is present (Prisma parity; refetch-by-PK with no projection yields
      // exactly the scalar set a held record would).
      return {
        finalWhere: outcome.finalWhere,
        refetch: true,
        selectInclude,
        record: undefined,
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
  // M2M has no FK direction (`getFkDirection` throws on it): dispatch it to the
  // dedicated junction body before the direction oracle is consulted (§9 m2m).
  if (mutation.relationInfo.type === "manyToMany") {
    await interpretManyToMany(interp, ctx, relationName, mutation, parentData);
    return;
  }
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

      case "upsert":
        await interpretNestedUpsert(
          interp,
          ctx,
          relationInfo,
          fkDir,
          step.input,
          parentData,
          parentIdentity
        );
        break;

      default: {
        // Exhaustive: every NestedWriteStep kind is handled above (create /
        // createMany / connect / connectOrCreate / disconnect / delete /
        // deleteMany / set / update / updateMany / upsert). A new kind surfaces
        // here as a compile error, not a silent fall-through.
        const exhaustive: never = step;
        throw new NestedWriteError(
          `Unsupported nested update operation on relation '${relationName}'.`,
          relationName,
          { meta: { step: exhaustive } }
        );
      }
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
async function interpretTopLevelUpsert(
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
async function interpretNestedUpsert(
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
async function interpretManyToMany(
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

/**
 * Apply a scalar update + nested relations to a child matched by an already-built
 * correlated `whereSql` (shared by m2m update and m2m upsert's found branch).
 * Probe-and-pin the connected child (correlated), then reuse
 * `applyScalarUpdateAndRelations` (the same body FK updates use) so nested
 * relations under the m2m child recurse through the one interpreter.
 */
async function interpretConnectedChildUpdate(
  interp: Interp,
  child: QueryContext,
  relationInfo: RelationInfo,
  target: Model<any>,
  whereSql: Sql,
  data: Record<string, unknown>
): Promise<void> {
  const { scalarData, relations } = separateData(child, data);
  const needsBeforeImage =
    hasPrimaryKeyUpdate(target, scalarData) ||
    Object.keys(relations).length > 0;

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
    return;
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

/** Lower an identity Expr map to a raw carrier record keyed by field name, so the
 *  junction builders read each value as a JS literal (live mode) or a
 *  BatchValueRef carrier (planned mode) through `buildScalarSqlValue`. Used to
 *  thread both the parent PK (junction source) and a created child PK (junction
 *  target) into junction writes (§9 m2m). */
function identityCarrierRecord(
  mode: Mode,
  identity: Record<string, Expr>
): Record<string, unknown> {
  const carrier: Record<string, unknown> = {};
  for (const [field, expr] of Object.entries(identity)) {
    carrier[field] = exprToCarrier(mode, expr);
  }
  return carrier;
}

/** True iff a raw parent-carrier value is a deferred symbol carrier (planned
 *  mode's `BatchValueRef`) rather than a known literal — used by the m2m
 *  deleteMany legality check (§6.2). A Sql fragment (a connect subquery) is not
 *  a deferred PK for this purpose; only the batch-ref carrier is. */
function isCarrierDeferred(value: unknown): boolean {
  return isBatchValueRef(value);
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
