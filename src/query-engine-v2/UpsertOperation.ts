// biome-ignore-all lint/style/useFilenamingConvention: UpsertOperation is the architecture name.
import { QueryEngineError } from "@errors";
import type { Model } from "@schema/model";
import {
  buildPrimaryKeyWhereUnique,
  getPrimaryKeyFields,
} from "../query-engine/builders/correlation-utils";
import { separateData } from "../query-engine/builders/relation-data-builder";
import { buildInsert } from "../query-engine/builders/values-builder";
import {
  getWhereUniqueEntries,
  getWhereUniqueFilters,
} from "../query-engine/builders/where-unique-builder";
import {
  createQueryScope,
  getDefaultScalarFieldNames,
  getTableName,
} from "../query-engine/context/query-scope";
import {
  assertCreateOwnWriteSafety,
  assertUpdateOwnWriteSafety,
} from "../query-engine/OwnWriteAnalyzer";
import {
  buildCreate,
  buildFind,
  buildFindUnique,
  buildUpdate,
} from "../query-engine/operations";
import { getUpdatedPrimaryKeyWhere } from "../query-engine/operations/mutation-identity";
import type { QueryEngine } from "../query-engine/query-engine";
import { ResultParser } from "../query-engine/result/ResultParser";
import type { QueryScope } from "../query-engine/types";
import { CreateOperation } from "./CreateOperation";
import {
  absenceGuard,
  affectedRows,
  childRacePin,
  exactlyOneRow,
  notFoundFailure,
  presenceGuard,
  queryFailure,
  raceableQueryFailure,
  referenceSql,
} from "./fragment-builders";
import { upsertSkipPremiseChanged } from "./messages";
import {
  isOperationValueReference,
  type OperationFragment,
  type OperationStep,
  ref,
  type StatementStep,
} from "./OperationFragment";
import { planningKey, planningOutputs } from "./Part";
import { parseValidated } from "./parse-boundary";
import { StepScope } from "./StepScope";
import {
  createDataUniqueWhere,
  getStepModelName,
  isRecord,
  type SubOperationOptions,
  selectExecutionMode,
  UnsupportedOperationError,
} from "./shared";
import { UpdateOperation } from "./UpdateOperation";

type ExecutionMode = "transaction" | "batch";

/** A compiled arm's steps plus the id of the step exposing the `result` output —
 *  the terminal read, or the folded `UPDATE … RETURNING` when it stands in for it,
 *  or a delegated create/update sub-arm's own result step (T3c). */
interface ArmResult {
  readonly steps: OperationStep[];
  readonly resultId: string;
}

/**
 * How the scalar create arm addresses the row its INSERT actually writes.
 *
 * - `known` — the CREATE DATA already spells a complete unique identity: every
 *   primary-key field as a literal, or every column of some other unique
 *   constraint of the model. The read-back targets that `whereUnique` directly and
 *   the INSERT captures nothing.
 * - `generated` — the model's single primary key is a DB-generated identity
 *   (`increment`) the create data omits AND the create data spells no other
 *   complete unique, so the INSERT must CAPTURE the value the database produced
 *   and the read-back addresses the row by it.
 *
 * There is deliberately no third shape: any other create payload names no row the
 * upsert can read back, and `createArmIdentity` refuses instead of guessing.
 */
type CreateArmIdentity =
  | { readonly kind: "known"; readonly where: Record<string, unknown> }
  | { readonly kind: "generated"; readonly field: string };

/** A validated conditional filter on the located row (`targetWhere`/`setWhere`). */
interface Conditional {
  readonly field: "setWhere" | "targetWhere";
  readonly where: Record<string, unknown>;
  readonly probeId: string;
  readonly guardId: string;
  readonly probe: StatementStep;
}

/**
 * The root (top-level) `upsert` (PLAN P2b/T3c), **probe-first per ATOM §2/§4** — the
 * `ON CONFLICT` narrow door is deliberately NOT taken (see the P2b report's
 * disposition): a locate read decides create-vs-update at planning, and every
 * premise is pinned to the vocabulary the update/delete family already uses. It
 * locates the row by any unique `where`; absent → the create arm (constraint +
 * `racePin`, never a guard); present → the update arm, unless a `targetWhere` /
 * `setWhere` conditional does not match, in which case V1's silent no-op skip
 * fires — pinned by the **retained `notExists`** guard (ATOM §2, `raceable:
 * true`).
 *
 * **T3c — the arms compose the create-root / update-root machinery (TO-ONE.md
 * §7.8).** A **scalar** create/update arm stays fully inline (the proven scalar
 * path, unchanged): a plain INSERT (racePin) or `UPDATE … [RETURNING]`. A
 * **relation-bearing** arm delegates to a {@link CreateOperation} / {@link
 * UpdateOperation} constructed as a sub-operation (mechanism 2, fresh-parent
 * elision / mechanism 1, `buildNestedTargetChildParts`): it shares this upsert's
 * {@link StepScope}, defers its own-write barrier to this operation's per-arm
 * compile (V1 checks each arm's barrier inside its own branch — the D4/D5
 * create-branch-barrier witnesses), and — for the update arm — drops its locate's
 * not-found postcondition (a located-miss is this upsert's CREATE decision). The
 * delegated arms plan their whole superset (ATOM §3 technique 2); only the taken
 * arm's writes compile. The arm the locate selects, the conditional skip pins, and
 * the create-branch racePin all compose with each arm's own child Parts.
 */
export class UpsertOperation {
  readonly mode: ExecutionMode;

  private readonly engine: QueryEngine;
  private readonly model: Model<any>;
  private readonly scope: StepScope;
  private readonly resultArgs: Record<string, unknown>;
  private readonly parentWhere: Record<string, unknown>;
  /**
   * The extended `where`'s FILTER half (Prisma >= 4.5), or `undefined` for a
   * plain unique `where`. Its presence changes one thing beyond the SQL the
   * builder already emits: the create arm loses its `racePin` — see
   * {@link UpsertOperation.createArmRacePin}.
   */
  private readonly whereFilters: Record<string, unknown> | undefined;
  private readonly parentPrimaryKeys: readonly string[];
  private readonly createData: Record<string, unknown>;
  private readonly updateData: Record<string, unknown>;
  private readonly conditionals: readonly Conditional[];
  private readonly locate: StatementStep;
  private readonly createId: string;
  private readonly updateId: string;
  private readonly terminalId: string;
  private readonly foundGuardId: string;
  private readonly parsedSelect: Record<string, unknown>;
  private readonly parsedInclude: Record<string, unknown> | undefined;
  // The update-arm RETURNING fold (finding 4 / PERF.md P5): on a RETURNING driver
  // with a scalar-only projection the scalar update arm folds its terminal refetch
  // into the mutation. `false` for a non-returning driver, a relation projection,
  // or a relation-bearing update arm (which delegates to UpdateOperation).
  private readonly canFoldUpdateArm: boolean;
  // T3c — the create arm carries nested relation writes: delegate to a
  // CreateOperation sub-op (mechanism 2). `undefined` for a scalar create arm
  // (the inline INSERT path stays).
  private readonly createArmOp?: CreateOperation;
  // The FULL create record (scalar ∪ relations), retained so the create arm can run
  // V1's own-write barrier at compile (deferred per-arm — the whenFalse branch).
  private readonly rawCreate: Record<string, unknown>;
  // T3c — the update arm carries nested relation writes: delegate to an
  // UpdateOperation sub-op (mechanism 1). `undefined` for a scalar update arm.
  private readonly updateArmOp?: UpdateOperation;
  // The FULL update record (scalar ∪ relations), retained so the found branch can
  // run V1's own-write barrier at compile (deferred per-arm — the whenTrue branch).
  private readonly rawUpdate: Record<string, unknown>;

  constructor(
    engine: QueryEngine,
    model: Model<any>,
    args: Record<string, unknown>
  ) {
    this.engine = engine;
    this.model = model;
    this.mode = selectExecutionMode(engine, "upsert");
    const txMode = this.mode === "transaction";
    this.scope = new StepScope();
    const scope = this.scope;

    // Upsert is the ONE write op that keeps its key gate + raw-narrowing requireRecords
    // (X2 conflict — see PLAN "X2"). It has no whole-args parse: its create/update arms
    // are delegated to CreateOperation/UpdateOperation sub-ops that parse the RAW payload
    // FRESH, so the arms must receive the raw `args.create`/`args.update`, NOT a
    // parseValidated OUTPUT — re-parsing the schema's transformed output regresses on a
    // non-idempotent transform (`nested-create-many` "Expected string"). And the update
    // arm's structure MUST stay deferred to the taken branch (`deferArmLegality`): an
    // invalid UNTAKEN update branch must not reject the whole tree. A whole-args
    // `parseValidated(args.upsert)` would both feed the arms a transformed payload AND
    // validate the untaken arm upfront — two behavior changes — so upsert's front line is
    // the key gate + requireRecord, kept deliberately.
    assertUpsertKeys(args);
    const where = requireRecord(args.where, "upsert.where");
    const create = requireRecord(args.create, "upsert.create");
    const update = requireRecord(args.update, "upsert.update");
    this.rawCreate = create;
    this.rawUpdate = update;
    const parent = createQueryScope(engine.adapter, model);

    const parentPrimaryKeys = getPrimaryKeyFields(model);
    if (parentPrimaryKeys.length === 0) {
      throw new UnsupportedOperationError(
        "query-engine-v2 upsert requires a parent with a primary key."
      );
    }
    // Compound primary keys are supported: every probe/guard selects each PK
    // field; the create/update arms target the parsed compound where-unique, and
    // `childRacePin`/`getWhereUniqueEntries` already expand the compound key.
    this.parentPrimaryKeys = parentPrimaryKeys;

    // T3c: a scalar arm stays inline; a relation-bearing arm delegates to the
    // create-root / update-root machinery. Separate each arm to decide.
    const createSep = separateData(parent, create);
    const updateSep = separateData(parent, update);
    const createHasRelations = Object.keys(createSep.relations).length > 0;
    const updateHasRelations = Object.keys(updateSep.relations).length > 0;

    // CLASS IV (T4c): a **parent-held to-one** relation in the update arm builds a
    // probe correlated to the located parent's FK (a `firstRowField` of the delegated
    // update sub-op's locate). When the CREATE arm is taken the parent is ABSENT, so
    // that FK does not exist — but the delegated arm's locate carries `locateNotFound-
    // Optional`, which makes its firstRowField outputs OPTIONAL: the superset probe
    // plans against an empty locate (resolving the FK to `undefined`) instead of
    // aborting, and the untaken arm's writes never compile. When the update arm IS
    // taken (found), `compileFoundArm` runs its deferred payload legality — V1's
    // update-branch validation, only-when-taken — so an invalid update branch rejects
    // byte-identical and a missing-target upsert taking the create arm never does. No
    // decline needed; the shape is native.

    const parentSchemas = engine.schemaRegistry.getModelSchemas(model);
    this.parentWhere = parseValidated(
      parentSchemas.core.whereUniqueExtended,
      where,
      "upsert",
      "where"
    );
    this.whereFilters = getWhereUniqueFilters(parent, this.parentWhere);
    // The scalar arms parse their own scalar data here; the delegated arms leave
    // it empty (the sub-op validates and builds the FULL payload itself).
    this.createData = createHasRelations
      ? {}
      : parseValidated(
          parentSchemas.core.scalarCreate,
          createSep.scalarData,
          "upsert",
          "create"
        );
    this.updateData = updateHasRelations
      ? {}
      : parseValidated(
          parentSchemas.core.scalarUpdate,
          updateSep.scalarData,
          "upsert",
          "update"
        );
    // The projection is parsed as ONE object rather than key by key, because
    // `omit` is only meaningful next to `select`: the schema refuses the pair and
    // rewrites a surviving `omit` into the `select` it denotes
    // (@validation/model/args/omit). Everything else about upsert's deliberate
    // no-whole-args-parse stance is unchanged — this schema carries the three
    // projection keys and nothing else, so neither arm is validated here.
    const projection = parseValidated(
      parentSchemas.core.upsertProjection,
      {
        select: args.select,
        include: args.include,
        omit: args.omit,
      },
      "upsert",
      ""
    );
    this.parsedSelect = isRecord(projection?.select)
      ? projection.select
      : defaultSelect(model);
    // `include` rides alongside the projection (the `create`/`update` surface). A
    // relation projection forces the terminal-read path (lateral joins), never the
    // scalar RETURNING fold, on both the scalar and delegated arms.
    this.parsedInclude = isRecord(projection?.include)
      ? projection.include
      : undefined;
    this.resultArgs = {
      select: this.parsedSelect,
      ...(this.parsedInclude ? { include: this.parsedInclude } : {}),
    };
    const selectIsScalarOnly = !Object.keys(this.parsedSelect).some((field) =>
      model["~"].relationSet.has(field)
    );
    this.canFoldUpdateArm =
      !updateHasRelations &&
      engine.adapter.capabilities.supportsReturning &&
      selectIsScalarOnly &&
      !this.parsedInclude;

    const parentName = getStepModelName(model, "parent");
    const locateId = scope.allocate(`${parentName}.locate`);
    this.createId = scope.allocate(`${parentName}.create`);
    this.updateId = scope.allocate(`${parentName}.update`);
    this.terminalId = scope.allocate(`${parentName}.select`);
    this.foundGuardId = scope.allocate(`${parentName}.guard.exists`);

    // The conditional filters (`targetWhere`/`setWhere`) each become one widened
    // planning probe: `where ∧ conditional`. compile evaluates them in JS (SQL
    // did the matching) and pins the taken outcome.
    this.conditionals = this.buildConditionals(parent, parentSchemas, {
      targetWhere: args.targetWhere,
      setWhere: args.setWhere,
    });

    // The locate read decides create-vs-update. It carries NO postcondition — a
    // missing row is the create arm, not a not-found error (upsert's contract).
    this.locate = {
      id: locateId,
      kind: "read",
      statement: buildFindUnique(parent, {
        where: this.parentWhere,
        select: this.pkSelect(),
        forUpdate: txMode,
      }),
      outputs: { rows: { kind: "rows" } },
    };

    // T3c — the relation-bearing arms delegate to the create-root / update-root
    // machinery, sharing this scope so no two arms collide on a step id. Each
    // defers its own-write barrier to compile (V1's per-branch timing); the update
    // arm drops its locate postcondition (absent → this upsert's create arm). The
    // `create`/`update` sub-ops carry the FULL payload; a shape neither root owns
    // still throws `UnsupportedOperationError`, which PROPAGATES as a typed refusal
    // (post-P6: no V1 fallback) exactly as a standalone create/update would — the
    // already-audited decline surface.
    // The delegated arms shape their own terminal read, so they carry the same
    // `select`/`include` this upsert would apply (an explicit select, else the
    // sub-op defaults the scalar projection; `include` rides alongside).
    // `select` is forwarded whenever the CALLER asked for a projection — either
    // spelling. `omit` never reaches an arm as itself: it was already desugared
    // into `this.parsedSelect`, so forwarding that is what makes an omit-only
    // upsert project the same columns on both arms. Without a caller projection
    // the key stays absent and each arm defaults its own scalar list, exactly as
    // before.
    const callerProjected =
      args.select !== undefined || args.omit !== undefined;
    const subSelect: Record<string, unknown> = {
      ...(callerProjected && this.parsedSelect
        ? { select: this.parsedSelect }
        : {}),
      ...(this.parsedInclude ? { include: this.parsedInclude } : {}),
    };
    const subOptions: SubOperationOptions = { scope, skipOwnWrite: true };
    this.createArmOp = createHasRelations
      ? new CreateOperation(
          engine,
          model,
          { data: create, ...subSelect },
          subOptions
        )
      : undefined;
    this.updateArmOp = updateHasRelations
      ? new UpdateOperation(
          engine,
          model,
          { where, data: update, ...subSelect },
          {
            ...subOptions,
            locateNotFoundOptional: true,
            deferArmLegality: true,
          }
        )
      : undefined;
  }

  planning(): OperationFragment {
    const steps: OperationStep[] = [this.locate];
    for (const conditional of this.conditionals) steps.push(conditional.probe);
    // The delegated arms plan their whole superset one level in (ATOM §3 technique
    // 2): both arms' probes run before any write regardless of which the locate
    // later selects. Only the taken arm's writes compile.
    if (this.updateArmOp) steps.push(...this.updateArmOp.planning().steps);
    if (this.createArmOp) steps.push(...this.createArmOp.planning().steps);
    return { steps, outputs: planningOutputs(steps) };
  }

  compile(known: Readonly<Record<string, unknown>>): OperationFragment {
    const locateRows = known[planningKey(this.locate.id, "rows")];
    if (!Array.isArray(locateRows)) {
      throw new QueryEngineError(
        "query-engine-v2 upsert planning did not expose the locate rows."
      );
    }
    const arm =
      locateRows.length === 0
        ? this.compileCreateArm(known)
        : this.compileFoundArm(known, locateRows[0] as Record<string, unknown>);
    return {
      steps: arm.steps,
      outputs: { result: ref(arm.resultId, "result") },
    };
  }

  parse<T>(outputs: Readonly<Record<string, unknown>>): T {
    if (!Object.hasOwn(outputs, "result")) {
      throw new QueryEngineError(
        "query-engine-v2 upsert did not expose its result."
      );
    }
    return new ResultParser(
      this.engine.adapter,
      this.model,
      this.engine.driver,
      this.engine.decimalDecode
    ).parse<T>("upsert", outputs.result, this.resultArgs);
  }

  // -------------------------------------------------------------------------

  /** Absent → CREATE (constraint + `racePin`, never a guard) then terminal read. */
  private compileCreateArm(
    known: Readonly<Record<string, unknown>>
  ): ArmResult {
    if (this.createArmOp) {
      // T3c: a relation-bearing create arm. V1 runs the create-branch own-write
      // barrier INSIDE the whenFalse branch only (the create-then-connect insert
      // barrier, D4/D5) — a barrier violation must reject only when the create arm
      // is taken. Run it here, per-arm; a `NestedWriteError` is V1's byte-identical
      // reject — a real parity failure that propagates, distinct from V2's typed
      // UnsupportedOperationError decline (both propagate post-P6; neither has a fallback).
      assertCreateOwnWriteSafety(
        createQueryScope(this.engine.adapter, this.model),
        this.rawCreate
      );
      const fragment = this.createArmOp.compile(known);
      // The create root's INSERT carries no racePin; the upsert's missing premise
      // IS raceable (a concurrent create loser retries into the update arm), so
      // annotate the root INSERT with the same `childRacePin` the scalar arm uses.
      const steps = this.annotateCreateRacePin(fragment.steps);
      return { steps, resultId: resultStepId(fragment, "upsert create arm") };
    }
    const parent = createQueryScope(this.engine.adapter, this.model);
    // How this INSERT's row will be addressed afterwards — decided BEFORE the
    // statement is built, because a DB-generated identity changes the statement
    // itself (it has to capture the value the database produces).
    const identity = this.createArmIdentity();
    const create: StatementStep = {
      id: this.createId,
      kind: "write",
      ...this.createArmInsert(parent, identity),
      // The missing premise is enforced by the unique constraint the `where`
      // targets; its violation is the raceable create-branch signal — but only
      // when the locate actually PROVED that premise (see `createArmRacePin`).
      ...this.createArmRacePin(parent),
    };
    // The terminal read addresses the row this INSERT wrote — its literal primary
    // key, or the identity the INSERT captured. Never the `where`: the `where` may
    // target a unique the create data does not reproduce, and then reading by it
    // answers with a DIFFERENT row (or none at all).
    return {
      steps: [
        create,
        this.buildTerminal(this.createArmTerminalWhere(identity)),
      ],
      resultId: this.terminalId,
    };
  }

  /** Add the raceable missing-premise `racePin` to the delegated create root's
   *  INSERT step (T3c) — the scalar arm's `childRacePin`, so a concurrent create
   *  loser's unique violation retries into the update arm. */
  private annotateCreateRacePin(
    steps: readonly OperationStep[]
  ): OperationStep[] {
    const parent = createQueryScope(this.engine.adapter, this.model);
    const pin = this.createArmRacePin(parent);
    if (!pin.racePin) return [...steps];
    const racePin = pin.racePin;
    const rootWriteStepId = this.createArmOp?.rootWriteStepId;
    return steps.map((step) =>
      step.id === rootWriteStepId && step.kind === "write" && !step.racePin
        ? { ...step, racePin }
        : step
    );
  }

  /**
   * The create arm's raceable missing premise — present only for a PLAIN unique
   * `where`.
   *
   * `racePin` claims "the locate proved unique key K was free, so a violation on
   * K means someone else took it between our read and our write — re-plan and
   * adopt". With an extended `where` the locate proves something weaker: no row
   * matches `K ∧ filters`. A row on K may exist and be excluded by the filter,
   * and then the INSERT's violation is a GENUINE CONFLICT, not a race: re-planning
   * re-reads the same excluded row, takes the create arm again, and violates
   * again. Pinning it would buy one pointless retry and mis-attribute a real
   * P2002-equivalent as raceable, so the pin is withheld and the
   * `UniqueConstraintError` surfaces on the first attempt — Prisma's behaviour for
   * the same payload.
   */
  private createArmRacePin(parent: QueryScope): {
    racePin?: ReturnType<typeof childRacePin>;
  } {
    if (this.whereFilters) return {};
    return { racePin: childRacePin(parent, this.parentWhere) };
  }

  /** Present → skip (conditional no-match) or update (all conditionals match). */
  private compileFoundArm(
    known: Readonly<Record<string, unknown>>,
    locatedRow: Record<string, unknown>
  ): ArmResult {
    // V1 runs the update-arm barrier + payload-legality analyses for the WHOLE found
    // branch (its whenTrue), before the conditional skip/update decision — an invalid
    // UNTAKEN update branch (the create arm is taken) never reaches here. A
    // relation-bearing update arm therefore rejects a barrier / legality violation
    // whether it later updates or skips (the D6 own-write witness; the relation-key /
    // PK-portability legality the sub-op deferred at construction).
    if (this.updateArmOp) {
      assertUpdateOwnWriteSafety(
        createQueryScope(this.engine.adapter, this.model),
        this.rawUpdate,
        this.parentWhere
      );
      this.updateArmOp.assertArmLegality();
    }
    const unmatched = this.conditionals.find(
      (conditional) => !this.conditionalMatched(conditional, known)
    );
    if (unmatched) return this.compileSkipArm(unmatched, locatedRow);
    return this.compileUpdateArm(known, locatedRow);
  }

  /**
   * A conditional did not match → silent no-op (V1's contract): no write, just
   * the terminal read of the unchanged row. Batch mode pins the skip premise with
   * the retained `notExists` guard (the row still does NOT match the conditional,
   * `raceable: true`); transaction mode's locked probe pins it, needing no guard.
   */
  private compileSkipArm(
    unmatched: Conditional,
    locatedRow: Record<string, unknown>
  ): ArmResult {
    const terminalWhere = this.locatedTerminalWhere(locatedRow);
    if (this.mode === "transaction") {
      return {
        steps: [this.buildTerminal(terminalWhere)],
        resultId: this.terminalId,
      };
    }
    return {
      steps: [
        absenceGuard(
          unmatched.guardId,
          unmatched.probe.statement,
          raceableQueryFailure(upsertSkipPremiseChanged(unmatched.field))
        ),
        this.buildTerminal(terminalWhere),
      ],
      resultId: this.terminalId,
    };
  }

  /** All conditionals match (or none present) → UPDATE the located row. */
  private compileUpdateArm(
    known: Readonly<Record<string, unknown>>,
    locatedRow: Record<string, unknown>
  ): ArmResult {
    if (this.updateArmOp) {
      // T3c: a relation-bearing update arm delegates to the update-root machinery
      // (its located parent is this row, mechanism 1 / the reorder+cascade root
      // handling). In batch mode the conditional MATCH premise is pinned first (the
      // `exists` guard on `where ∧ conditional`); the sub-op adds its own root
      // presence guard.
      const guards = this.conditionalMatchGuards();
      const fragment = this.updateArmOp.compile(known);
      return {
        steps: [...guards, ...fragment.steps],
        resultId: resultStepId(fragment, "upsert update arm"),
      };
    }
    const parent = createQueryScope(this.engine.adapter, this.model);
    const txMode = this.mode === "transaction";
    const guards: OperationStep[] = [];
    if (!txMode) {
      // Batch pins the update premise inside the atomic unit. Each conditional's
      // match is pinned (exists, `raceable: false`); with none present a plain
      // found premise on `where` catches a concurrent delete (both fail closed —
      // the retry re-plans and converges).
      if (this.conditionals.length === 0) {
        guards.push(
          presenceGuard(
            this.foundGuardId,
            buildFindUnique(parent, {
              where: this.parentWhere,
              select: this.pkSelect(),
            }),
            notFoundFailure(this.locateMissMessage())
          )
        );
      } else {
        guards.push(...this.conditionalMatchGuards());
      }
    }
    const enforceAffected =
      txMode && this.engine.adapter.capabilities.supportsReturning;
    const affected = enforceAffected
      ? { expects: affectedRows(1, notFoundFailure(this.locateMissMessage())) }
      : {};
    // Fold: `UPDATE … RETURNING select` returns the updated row directly (incl.
    // any PK the SET rewrote), so no terminal refetch is needed — one statement
    // fewer. Gated to a RETURNING driver + scalar-only projection.
    if (this.canFoldUpdateArm) {
      const folded: StatementStep = {
        id: this.updateId,
        kind: "write",
        statement: buildUpdate(parent, {
          where: this.parentWhere,
          data: this.updateData,
          select: this.parsedSelect,
        }),
        outputs: { result: { kind: "rows" } },
        ...affected,
      };
      return { steps: [...guards, folded], resultId: this.updateId };
    }
    const update: StatementStep = {
      id: this.updateId,
      kind: "write",
      statement: buildUpdate(parent, {
        where: this.parentWhere,
        data: this.updateData,
        select: this.pkSelect(),
      }),
      outputs: {},
      // Exact-affected is a returning-driver check only (see UpdateOperation): on
      // a non-returning driver the locked locate already proved the row exists, so
      // a no-op UPDATE (0 rows changed) is V1's accepted contract, not a NotFound.
      ...affected,
    };
    // The update arm may rewrite the very field the `where` located the row by
    // (a non-PK unique) or the PK itself. The terminal read must therefore address
    // the row by its POST-update primary key, not the original `where`, exactly as
    // UpdateOperation does — otherwise a renamed row is invisible to its own read.
    return {
      steps: [
        ...guards,
        update,
        this.buildTerminal(this.updatedTerminalWhere(locatedRow)),
      ],
      resultId: this.terminalId,
    };
  }

  /** Batch-mode `exists` guards pinning each conditional's MATCH premise inside the
   *  atomic unit (`raceable: false`); empty in transaction mode (the locked probe
   *  pins it) or when no conditional is present. */
  private conditionalMatchGuards(): OperationStep[] {
    if (this.mode === "transaction") return [];
    return this.conditionals.map((conditional) =>
      presenceGuard(
        conditional.guardId,
        conditional.probe.statement,
        queryFailure(
          `query-engine-v2 top-level upsert ${conditional.field} match premise changed before the atomic batch.`
        )
      )
    );
  }

  private buildTerminal(where: Record<string, unknown>): StatementStep {
    const parent = createQueryScope(this.engine.adapter, this.model);
    const txMode = this.mode === "transaction";
    return {
      id: this.terminalId,
      kind: "read",
      statement: buildFindUnique(parent, {
        where,
        select: this.resultArgs.select as Record<string, unknown>,
        ...(this.parsedInclude ? { include: this.parsedInclude } : {}),
      }),
      outputs: { result: { kind: "rows" } },
      ...(txMode
        ? {
            expects: exactlyOneRow(
              queryFailure(
                "query-engine-v2 upsert terminal read expected exactly one row."
              )
            ),
          }
        : {}),
    };
  }

  /** The terminal where addressing the located (unchanged) row by its PK — the
   *  skip arm reads the row without mutating it. */
  private locatedTerminalWhere(
    locatedRow: Record<string, unknown>
  ): Record<string, unknown> {
    return buildPrimaryKeyWhereUnique(
      this.model,
      Object.fromEntries(
        this.parentPrimaryKeys.map((pk) => [pk, locatedRow[pk]])
      )
    );
  }

  /**
   * The terminal where addressing the located row by its POST-update primary
   * key: the update arm may rewrite a PK field (literal or portable arithmetic),
   * moving the identity the located pre-update row no longer answers to. Reuses
   * V1's `getUpdatedPrimaryKeyWhere` (unchanged located PK when the update leaves
   * it alone; the same typed refusal of an ambiguous PK operation).
   */
  private updatedTerminalWhere(
    locatedRow: Record<string, unknown>
  ): Record<string, unknown> {
    const parent = createQueryScope(this.engine.adapter, this.model);
    return getUpdatedPrimaryKeyWhere(
      parent,
      locatedRow,
      this.updateData,
      getStepModelName(this.model, "record")
    );
  }

  /**
   * How the scalar create arm addresses the row it is about to INSERT — decided
   * from the CREATE DATA, never from the `where`.
   *
   * Prisma does not require `create` to satisfy `where`, so the `where` names a
   * row that may not be the one the INSERT writes. Reading back by it is a silent
   * wrong answer whenever the two diverge: with an extended `where` (unique key
   * matches, filter excludes → create arm) the unique half addresses the very row
   * the filter EXCLUDED, so the upsert would return a pre-existing row it never
   * touched; with a plain `where` it addresses a row that does not exist and the
   * terminal read fails. Both are fixed at the source — by addressing the row that
   * was actually inserted. Three sources can name it, tried in this order:
   *
   * 1. **literal primary key** — every PK field is a literal in the create data;
   * 2. **a COMPLETE unique constraint of the model carried by the create data** —
   *    a single `.unique()` column, or every column of one compound unique. That
   *    constraint names exactly the row this INSERT wrote: the database enforces
   *    that at most one row holds those values, and this statement just wrote a
   *    row holding them. Like (1) it is derived from the create data alone, so it
   *    is immune to the wrong-row bug even when a DIFFERENT live row satisfies
   *    the `where`;
   * 3. **a captured DB-generated identity** — the model's single PK is an
   *    `increment` the create data omits, so the INSERT captures what the database
   *    produced (see {@link UpsertOperation.createArmInsert}) and the read-back
   *    references it, exactly as {@link CreateOperation}'s root create does.
   *
   * **Why (2) outranks (3), uniformly and not just in batch mode.** All three are
   * equally correct; (1) and (2) are additionally CAPTURE-FREE — they compile to a
   * plain INSERT with no output, whereas (3) makes the statement itself depend on
   * the execution mode and the driver (`… RETURNING pk` in a returning-driver
   * transaction, the driver's `insertId` scratch otherwise). That scratch is
   * per-operation state a SHARED driver batch cannot isolate, so an operation that
   * needs it is refused from `$transaction([…])` on a batch-only driver
   * ({@link OperationExecutor.prepareSharedBatch}) — data-dependently, since only
   * the create arm carries it. Compile cannot see whether it will be merged into a
   * shared batch, so a batch-only preference would still leave that refusal
   * reachable for the mainstream `increment` PK + unique-in-create-data model.
   * Preferring the capture-free identity ALWAYS gives one compiled shape per
   * (model, args) pair on every substrate and every driver, and shrinks the
   * refusal to the shapes that genuinely have no other identity.
   *
   * A create payload carrying none of the three names no row this operation can
   * read back, so it is refused rather than guessed at — and only when the create
   * arm is actually TAKEN (this runs at compile), so an upsert that updates is
   * never affected.
   */
  private createArmIdentity(): CreateArmIdentity {
    const literalPrimaryKey = this.parentPrimaryKeys.every(
      (pk) => this.createData[pk] !== undefined
    );
    if (literalPrimaryKey) {
      return {
        kind: "known",
        where: buildPrimaryKeyWhereUnique(
          this.model,
          Object.fromEntries(
            this.parentPrimaryKeys.map((pk) => [pk, this.createData[pk]])
          )
        ),
      };
    }
    const uniqueFromCreateData = createDataUniqueWhere(
      this.model,
      this.createData
    );
    if (uniqueFromCreateData) {
      return { kind: "known", where: uniqueFromCreateData };
    }
    const [only] = this.parentPrimaryKeys;
    if (
      this.parentPrimaryKeys.length === 1 &&
      only !== undefined &&
      this.model["~"].state.scalars[only]?.["~"].state.autoGenerate ===
        "increment"
    ) {
      return { kind: "generated", field: only };
    }
    throw new UnsupportedOperationError(
      `query-engine-v2 upsert cannot read back the row its create arm inserts for '${getStepModelName(this.model, "record")}': the create data carries neither a complete primary key ('${this.parentPrimaryKeys.join(", ")}') nor any complete unique constraint of the model, and the primary key is not a single database-generated identity.`
    );
  }

  /**
   * The create arm's INSERT statement and outputs. A `known` identity is a plain
   * INSERT that produces nothing. A `generated` identity must CAPTURE what the
   * database assigned: `INSERT … RETURNING pk` on a returning driver in
   * transaction mode, else the driver's `insertId` (which the executor threads
   * through its batch-ref scratch store in batch mode) — the same two shapes
   * {@link CreateOperation}'s root INSERT uses.
   */
  private createArmInsert(
    parent: QueryScope,
    identity: CreateArmIdentity
  ): Pick<StatementStep, "statement" | "outputs"> {
    if (identity.kind === "known") {
      return {
        statement: buildInsert(
          parent,
          getTableName(this.model),
          this.createData
        ),
        outputs: {},
      };
    }
    const capture =
      this.mode === "transaction" &&
      this.engine.adapter.capabilities.supportsReturning;
    return {
      statement: capture
        ? buildCreate(parent, {
            data: this.createData,
            select: { [identity.field]: true },
          })
        : buildInsert(parent, getTableName(this.model), this.createData),
      outputs: {
        id: capture
          ? { kind: "firstRowField", field: identity.field }
          : { kind: "insertId" },
      },
    };
  }

  /** The create arm's terminal where: the literal primary key the create data
   *  carries, or a backward reference to the identity the INSERT captured. */
  private createArmTerminalWhere(
    identity: CreateArmIdentity
  ): Record<string, unknown> {
    if (identity.kind === "known") return identity.where;
    return {
      [identity.field]: referenceSql(
        this.engine,
        this.model,
        identity.field,
        ref(this.createId, "id")
      ),
    };
  }

  private pkSelect(): Record<string, boolean> {
    return Object.fromEntries(this.parentPrimaryKeys.map((pk) => [pk, true]));
  }

  private buildConditionals(
    parent: QueryScope,
    parentSchemas: ReturnType<QueryEngine["schemaRegistry"]["getModelSchemas"]>,
    inputs: { targetWhere: unknown; setWhere: unknown }
  ): readonly Conditional[] {
    const txMode = this.mode === "transaction";
    const parentName = getStepModelName(this.model, "parent");
    // The probe asks the SAME question the locate does — `where ∧ conditional` —
    // so an extended `where`'s filter half rides along with the discriminator
    // equalities. (It is a PREDICATE here, which is exactly what a probe wants;
    // it still contributes no pin, because it never reaches `racePin`.)
    const uniqueFilters: Record<string, unknown>[] = getWhereUniqueEntries(
      parent,
      this.parentWhere
    ).map(({ fieldName, value }) => ({ [fieldName]: { equals: value } }));
    if (this.whereFilters) uniqueFilters.push(this.whereFilters);
    const conditionals: Conditional[] = [];
    for (const field of ["targetWhere", "setWhere"] as const) {
      const raw = inputs[field];
      if (!(isRecord(raw) && Object.keys(raw).length > 0)) continue;
      const where = parseValidated(
        parentSchemas.core.where,
        raw,
        "upsert",
        field
      );
      const probeId = this.scope.allocate(`${parentName}.${field}`);
      const guardId = this.scope.allocate(`${parentName}.guard.${field}`);
      conditionals.push({
        field,
        where,
        probeId,
        guardId,
        probe: {
          id: probeId,
          kind: "read",
          statement: buildFind(
            parent,
            {
              where: { AND: [...uniqueFilters, where] },
              select: this.pkSelect(),
              forUpdate: txMode,
            },
            { limit: 1 }
          ),
          outputs: { rows: { kind: "rows" } },
        },
      });
    }
    return conditionals;
  }

  private conditionalMatched(
    conditional: Conditional,
    known: Readonly<Record<string, unknown>>
  ): boolean {
    const rows = known[planningKey(conditional.probeId, "rows")];
    if (!Array.isArray(rows)) {
      throw new QueryEngineError(
        `query-engine-v2 upsert ${conditional.field} probe did not expose rows.`
      );
    }
    return rows.length > 0;
  }

  private locateMissMessage(): string {
    return `query-engine-v2 upsert located no '${getStepModelName(this.model, "record")}' row for its unique where before the atomic batch.`;
  }
}

/** The step id a delegated arm's `result` output points at (its terminal read, or
 *  a folded `… RETURNING`) — the value the outer upsert re-exposes as `result`. */
function resultStepId(fragment: OperationFragment, arm: string): string {
  const result = fragment.outputs.result;
  if (!isOperationValueReference(result)) {
    throw new QueryEngineError(
      `query-engine-v2 ${arm} did not expose a single result reference.`
    );
  }
  return result.step;
}

function defaultSelect(model: Model<any>): Record<string, unknown> {
  // V1's default projection is every scalar EXCEPT `.omit()`-ed fields (a model
  // with an omitted generated PK returns without it). Using the raw scalar names
  // would leak the omitted column — e.g. the captured generated PK on a
  // non-returning upsert create branch, which is internal, not public.
  return Object.fromEntries(
    getDefaultScalarFieldNames(model).map((field: string) => [field, true])
  );
}

function assertUpsertKeys(value: Record<string, unknown>): void {
  const required = ["where", "create", "update"] as const;
  const optional = new Set([
    "select",
    "include",
    "omit",
    "targetWhere",
    "setWhere",
  ]);
  const allowed = new Set<string>([...required, ...optional]);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length === 0 && missing.length === 0) return;
  throw new UnsupportedOperationError(
    `upsert arguments require ${required.join(", ")} (optional select, include, omit, targetWhere, setWhere); received ${Object.keys(value).join(", ") || "none"}.`
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new UnsupportedOperationError(`'${label}' must be an object.`);
}
