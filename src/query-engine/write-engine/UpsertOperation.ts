// biome-ignore-all lint/style/useFilenamingConvention: UpsertOperation is the architecture name.
import { QueryEngineError } from "@errors";
import type { Model } from "@schema/model";
import {
  buildPrimaryKeyWhereUnique,
  getPrimaryKeyFields,
} from "../builders/correlation-utils";
import { separateData } from "../builders/relation-data-builder";
import { buildInsert } from "../builders/values-builder";
import {
  getWhereUniqueEntries,
  partitionWhereUnique,
} from "../builders/where-unique-builder";
import {
  createQueryScope,
  getDefaultScalarFieldNames,
  getTableName,
} from "../context/query-scope";
import { assertCreateOwnWriteSafety } from "../OwnWriteAnalyzer";
import {
  buildCreate,
  buildFind,
  buildFindUnique,
  buildUpdate,
  buildUpsert,
} from "../operations";
import { getUpdatedPrimaryKeyWhere } from "../operations/mutation-identity";
import type { QueryEngine } from "../query-engine";
import { ResultParser } from "../result/ResultParser";
import type { QueryScope } from "../types";
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
  type PlanningFragment,
  type ReadStep,
  ref,
  type StatementStep,
  type WriteStep,
} from "./OperationFragment";
import { planningKey, planningOutputs } from "./Part";
import { parseValidated } from "./parse-boundary";
import { StepScope } from "./StepScope";
import {
  createDataUniqueWhere,
  getStepModelName,
  isRecord,
  projectionNamesNoRelation,
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
 * - `generated` — exactly ONE primary-key member is missing from the create data
 *   and that member is a DB-generated identity (`increment`), AND the create data
 *   spells no other complete unique. The INSERT CAPTURES the value the database
 *   produced for `field`; the remaining members are `literals` the create data
 *   already spells. The read-back is the ⊎ of the two: a complete primary key,
 *   every part of it derived from the row this statement made or wrote.
 *   A single-column primary key is the `literals = {}` case of the same shape.
 *
 * There is deliberately no third shape: any other create payload names no row the
 * upsert can read back, and `createArmIdentity` refuses instead of guessing.
 */
type CreateArmIdentity =
  | { readonly kind: "known"; readonly where: Record<string, unknown> }
  | {
      readonly kind: "generated";
      readonly field: string;
      readonly literals: Readonly<Record<string, unknown>>;
    };

/** A validated conditional filter on the located row (`targetWhere`/`setWhere`). */
interface Conditional {
  readonly field: "setWhere" | "targetWhere";
  readonly where: Record<string, unknown>;
  readonly probeId: string;
  readonly guardId: string;
  readonly probe: ReadStep;
}

/**
 * The root (top-level) `upsert` (PLAN P2b/T3c), **probe-first per ATOM §2/§4** —
 * except through the one narrow door ATOM §4 draws for it, which PLAN Decision 7.1
 * takes: see {@link UpsertOperation.buildOnConflictFold}. Outside that door a
 * locate read decides create-vs-update at planning, and every
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
  /**
   * Whether the `where`'s DISCRIMINATOR names exactly one unique constraint —
   * its own keys counted, so a compound (one key, several columns) counts once
   * and two independent single-field uniques count twice. Only the ON CONFLICT
   * fold reads it; see {@link UpsertOperation.buildOnConflictFold} conjunct 5.
   */
  private readonly whereNamesOneConstraint: boolean;
  private readonly parentPrimaryKeys: readonly string[];
  private readonly createData: Record<string, unknown>;
  private readonly updateData: Record<string, unknown>;
  private readonly conditionals: readonly Conditional[];
  private readonly locate: ReadStep;
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
  // PHASE 7 / Decision 7.1 — the ON CONFLICT door. When the whole upsert reduces
  // to ONE `INSERT … ON CONFLICT (target) DO UPDATE … RETURNING`, this holds that
  // statement and the operation has EMPTY planning: no locate, no arms, no
  // terminal read. `undefined` keeps the probe-first sequence byte-identical.
  // See {@link UpsertOperation.buildOnConflictFold} for every conjunct.
  private readonly onConflictFold: WriteStep | undefined;
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

    // E5-U3 — upsert's ENVELOPE now has one home, the parse boundary
    // (`upsertEnvelopeSchema`, wired at `routing.ts`): the three required keys, the five
    // optional names, and the object-ness of the arms. What X2 kept in the engine was
    // right about the ARMS and only the arms — they are delegated to
    // CreateOperation/UpdateOperation sub-ops that parse the RAW payload FRESH (so the
    // envelope hands them back BY REFERENCE, never a transformed copy), and the update
    // arm's structure stays deferred to the taken branch (`deferArmLegality`), so the
    // envelope reads nothing inside either arm. The narrowing below is what remains of
    // the three `requireRecord` gates: an engine invariant, not a user boundary.
    const where = envelopeRecord(args.where, "where");
    const create = envelopeRecord(args.create, "create");
    const update = envelopeRecord(args.update, "update");
    this.rawCreate = create;
    const parent = createQueryScope(engine.adapter, model);

    const parentPrimaryKeys = getPrimaryKeyFields(model);
    if (parentPrimaryKeys.length === 0) {
      // Unreachable by construction (N7-U-A, the X1c disposition): `requireRecord` above
      // hands `args.where` to the where-unique parse, and a PK-less model's whereUnique
      // has no discriminator — so `ValidationError: Missing required field: one of …`
      // answers first, measured. §3.A A16 states every model must have a PK.
      throw new QueryEngineError(
        "query-engine-v2 internal: upsert reached a model with no primary key; the where-unique parse admits none."
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
    // ONE split answers both questions the fold asks of the selector: whether it
    // carries a filter half, and how many constraints its discriminator names.
    const whereParts = partitionWhereUnique(parent, this.parentWhere);
    this.whereFilters = whereParts.filters;
    this.whereNamesOneConstraint =
      Object.keys(whereParts.discriminator).length === 1;
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
    // `_count` counts as a relation projection here too: it is not a `relationSet`
    // member, and a folded update arm answered it from a RETURNING subquery whose
    // outer reference binds by name (`selectProjectsRelation`).
    // `projectionNamesNoRelation` is the ONE spelling of "scalars only" — both
    // halves (`select` naming a relation or `_count`, and `include` at all) in a
    // single predicate.
    this.canFoldUpdateArm =
      !updateHasRelations &&
      engine.adapter.capabilities.supportsReturning &&
      projectionNamesNoRelation(model, this.parsedSelect, this.parsedInclude);

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

    // Decided LAST: the fold reads the parsed arms, the projection, the
    // conditionals and the extended-where half, all of which are settled above.
    this.onConflictFold = this.buildOnConflictFold(parent);
  }

  planning(): PlanningFragment {
    // The folded upsert asks the database nothing before it writes: `ON CONFLICT`
    // IS the create-vs-update decision. Empty planning is also what routes the
    // operation through `OperationExecutor.statementAtomicPlan` — one round trip,
    // no transaction envelope.
    if (this.onConflictFold) return { steps: [], outputs: {} };
    const steps: StatementStep[] = [this.locate];
    for (const conditional of this.conditionals) steps.push(conditional.probe);
    // The delegated arms plan their whole superset one level in (ATOM §3 technique
    // 2): both arms' probes run before any write regardless of which the locate
    // later selects. Only the taken arm's writes compile.
    if (this.updateArmOp) steps.push(...this.updateArmOp.planning().steps);
    if (this.createArmOp) steps.push(...this.createArmOp.planning().steps);
    return { steps, outputs: planningOutputs(steps) };
  }

  compile(known: Readonly<Record<string, unknown>>): OperationFragment {
    if (this.onConflictFold) {
      return {
        steps: [this.onConflictFold],
        outputs: { result: ref(this.onConflictFold.id, "result") },
      };
    }
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

  /**
   * PHASE 7 / Decision 7.1 — the ON CONFLICT door, taken.
   *
   * `INSERT … ON CONFLICT (target) DO UPDATE SET … RETURNING <select>` is ONE
   * statement that means exactly what a top-level scalar upsert means: "write
   * this row; if the constraint the caller named already holds it, update it
   * instead." ATOM §4 permits it for precisely this shape and no other, and calls
   * it a NARROW DOOR drawn by semantics rather than syntax. Every conjunct below
   * is the door's frame; a shape that misses any of them keeps the probe-first
   * sequence byte-identically.
   *
   * The conjuncts, each with the coverage no other one has:
   *
   * 1. **{@link UpsertOperation.canFoldUpdateArm}** — already the update arm's own
   *    fold gate, and it carries three of this fold's preconditions with it: a
   *    RETURNING driver (the one statement has to hand the row back, since there
   *    is no terminal read left to run), a SCALAR update arm, and a scalar-only
   *    projection with no `include` (a relation projection needs lateral joins an
   *    `INSERT … RETURNING` cannot carry, and `_count` read off a RETURNING
   *    subquery binds by name — the P3 `_count` defect). Reusing it is deliberate:
   *    it keeps `supportsReturning` read in ONE place in this class.
   * 2. **{@link DatabaseAdapterCapabilities.supportsTargetedUpsert}** — MySQL's
   *    `ON DUPLICATE KEY UPDATE` fires on ANY unique collision, so an unrelated
   *    collision would silently adopt a row the caller never named. Measured, and
   *    falsified by a witness that swaps in that emitter.
   * 3. **no `targetWhere` / `setWhere` conditional** — their contract is V1's
   *    SILENT NO-OP: no write, and the terminal read still answers with the
   *    unchanged row. `DO UPDATE … WHERE <no match>` returns ZERO rows (measured
   *    on PG 17), so the folded statement would answer nothing where the contract
   *    says it answers the row.
   * 4. **a plain unique `where`** — an extended selector's FILTER half decides
   *    WHICH row the operation means, and `ON CONFLICT` has nowhere to put it: the
   *    conflict would arbitrate on the unique half alone and adopt the very row
   *    the filter EXCLUDED. This is the same rule {@link childRacePin} already
   *    applies when it withholds the create arm's race pin for an extended
   *    selector — an excluded row's violation is a genuine conflict, not a race.
   * 5. **the `where` names exactly ONE constraint** — see
   *    {@link UpsertOperation.whereNamesOneConstraint}. `ON CONFLICT` takes ONE
   *    arbiter index, and the target is spelled from every column the
   *    discriminator constrains. Two INDEPENDENT single-field uniques in one
   *    selector (`{ id, email }`) are both DISCRIMINATORS, so conjunct 4 sees no
   *    filter half and conjunct 6 is satisfied the moment the create data spells
   *    both — the natural spelling. The emitted `ON CONFLICT ("id", "email")` is
   *    a column pair with no unique index behind it: PostgreSQL `42P10`,
   *    measured, on BOTH arms, for a selector `findUnique` and `update` answer.
   * 6. **the create data spells the conflict target, with the `where`'s values** —
   *    see {@link UpsertOperation.createDataSpellsConflictTarget}. Prisma does not
   *    require `create` to satisfy `where`, and `ON CONFLICT` arbitrates on the
   *    VALUES row, not on the caller's `where` (measured). Without this the fold
   *    would ask a different question from the one the caller asked.
   * 7. **a `set`-only update payload** — see {@link isPlainSetUpdate}. Atomic
   *    arithmetic and `push`/`unshift` reference the column on BOTH sides of the
   *    assignment, and inside `DO UPDATE SET` PostgreSQL rejects every spelling
   *    `buildSet` can produce: bare on both sides is `42702` "column reference is
   *    ambiguous", and qualifying the target is `42703`. Only "bare target,
   *    qualified source" parses, and no existing emitter spells that.
   *
   * **The divergence this fold ACCEPTS**, stated against the oracle and pinned by
   * tests rather than by this comment: on the UPDATE path the statement still
   * evaluates the INSERT's column defaults before it detects the conflict, so a
   * database-generated identity the create data omits BURNS one sequence value
   * that probe-first never consumed (measured: PostgreSQL `last_value` 100 → 101,
   * SQLite `sqlite_sequence` 2 → 3). Sequence values are explicitly not
   * gap-free on either dialect, and ATOM §4 names this burn as the divergence a
   * written disposition covers. See the plan doc's Decision 7.1 record.
   */
  private buildOnConflictFold(parent: QueryScope): WriteStep | undefined {
    const permitted =
      this.canFoldUpdateArm &&
      this.engine.adapter.capabilities.supportsTargetedUpsert &&
      this.conditionals.length === 0 &&
      this.whereFilters === undefined &&
      this.whereNamesOneConstraint &&
      this.createDataSpellsConflictTarget(parent) &&
      isPlainSetUpdate(this.updateData);
    if (!permitted) return undefined;
    return {
      id: this.scope.allocate(
        `${getStepModelName(this.model, "parent")}.upsert`
      ),
      kind: "write",
      statement: buildUpsert(parent, {
        where: this.parentWhere,
        create: this.createData,
        update: this.updateData,
        select: this.parsedSelect,
      }),
      outputs: { result: { kind: "rows" } },
    };
  }

  /**
   * Conjunct 6: every column of the conflict target appears in the CREATE DATA
   * holding the same value the `where` names.
   *
   * `ON CONFLICT (cols)` arbitrates on the row the `VALUES` clause proposes, not
   * on the caller's `where` — measured directly: `where: { id: 10 }` with
   * `create: { id: 20, … }` conflicts on 20, so it inserts a second row while
   * probe-first would have updated row 10. Prisma does not require `create` to
   * satisfy `where`, so the two genuinely can differ and the fold has to check
   * rather than assume.
   *
   * Only PRIMITIVE key values are foldable. This is a PRECONDITION of the
   * comparison, not a guard against observed input: the check is `Object.is` on
   * two independently parsed values, and identity is not equality for a `Date`, a
   * `Decimal` or a byte array. The same reasoning `groupLinkTargets` clause 3
   * already states for the link fold.
   *
   * **This conjunct also answers a RELATION-BEARING CREATE ARM**, and it is the
   * only thing that does. `this.createData` is `{}` whenever the create payload
   * carries relations — the constructor leaves the whole payload to the delegated
   * {@link CreateOperation} — so every conflict-target column reads `undefined`
   * here and the fold declines. A separate `!createHasRelations` conjunct was
   * written first and then removed: falsification found NOTHING in the estate
   * that could tell the two apart, which is a check whose unique coverage cannot
   * be named. The coupling is recorded here rather than defended twice: anyone
   * who makes `createData` hold the scalar half of a relation-bearing payload
   * must restore that conjunct in the same edit, or a fold will silently drop the
   * relation writes.
   */
  private createDataSpellsConflictTarget(parent: QueryScope): boolean {
    const entries = getWhereUniqueEntries(parent, this.parentWhere);
    if (entries.length === 0) return false;
    return entries.every(({ fieldName, value }) => {
      const created = this.createData[fieldName];
      // Checking `value` alone suffices: when it is a foldable primitive and
      // `Object.is(created, value)` holds, `created` IS that primitive — a
      // second `isFoldableKeyValue(created)` can never be the deciding conjunct
      // (P7 review: removing it changes no test; the one-guard ban applies).
      return isFoldableKeyValue(value) && Object.is(created, value);
    });
  }

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
    const create: WriteStep = {
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
   * `where`. The extended-selector withholding (an excluded row's violation is a
   * genuine conflict, not a race) is `childRacePin`'s own rule, decided in the one
   * function that mints these pins — see {@link childRacePin}.
   */
  private createArmRacePin(parent: QueryScope): {
    racePin?: ReturnType<typeof childRacePin>;
  } {
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
      const folded: WriteStep = {
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
    const update: WriteStep = {
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

  private buildTerminal(where: Record<string, unknown>): ReadStep {
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
   * 3. **a PRODUCED identity — the captured member ⊎ the spelled ones** — exactly
   *    one primary-key member is absent from the create data and that member is an
   *    `increment`, so the INSERT captures what the database produced for it (see
   *    {@link UpsertOperation.createArmInsert}) and the read-back references it,
   *    exactly as {@link CreateOperation}'s root create does. The remaining members
   *    are the literals the create data spells, and the read-back is their union: a
   *    complete primary key whose every part comes from the row this statement made
   *    or wrote. A single-column PK is the degenerate case (the union is empty), and
   *    a COMPOUND PK with one generated member is the general one — the shape M9
   *    measured reaching the refusal below. Two absent members cannot both be
   *    produced (one INSERT publishes ONE generated identity), and an absent member
   *    that is not an `increment` is not produced at all (a column DEFAULT is
   *    evaluated by the database and published nowhere) — both stay refused.
   *
   * Rungs (1) and (3) inline create-data values into the read-back `where`, so a
   * NON-literal there would be evaluated a second time and could name a different
   * row than the INSERT wrote. Rung (2) states that requirement itself
   * ({@link createDataUniqueWhere}'s `isAddressableLiteral`); (1) and (3) do not,
   * because for them the PARSE BOUNDARY is the one home: an `Sql` operand in a
   * primary-key column of `create` is a `ValidationError` before this method runs
   * (measured on both the compound and the single-column shape — "Validation
   * failed for upsert: Expected string"). No engine guard duplicates it.
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
    // Reaching here, at least one primary-key member is absent from the create
    // data (the literal-PK rung above took the case where none is).
    const absent = this.parentPrimaryKeys.filter(
      (pk) => this.createData[pk] === undefined
    );
    const [produced] = absent;
    if (
      absent.length === 1 &&
      produced !== undefined &&
      this.model["~"].state.scalars[produced]?.["~"].state.autoGenerate ===
        "increment"
    ) {
      return {
        kind: "generated",
        field: produced,
        literals: Object.fromEntries(
          this.parentPrimaryKeys
            .filter((pk) => pk !== produced)
            .map((pk) => [pk, this.createData[pk]])
        ),
      };
    }
    throw new UnsupportedOperationError(
      `query-engine-v2 upsert cannot read back the row its create arm inserts for '${getStepModelName(this.model, "record")}': the create data carries neither a complete primary key ('${this.parentPrimaryKeys.join(", ")}') nor any complete unique constraint of the model, and its absent primary-key members are not a single database-generated identity the INSERT can capture.`
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
  ): Pick<WriteStep, "statement" | "outputs"> {
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

  /**
   * The create arm's terminal where: the literal primary key the create data
   * carries, or the PRODUCED primary key — a backward reference to the identity
   * the INSERT captured, joined with the members the create data spelled.
   *
   * Both halves come from the write, never from the `where`: the captured member
   * is what the database assigned to the row this INSERT made, and the literal
   * members are what the same INSERT wrote into it. On a single-column primary
   * key the literal half is empty and `buildPrimaryKeyWhereUnique` returns the
   * flat `{ pk: <ref> }` this method has always produced; on a compound one it
   * returns the constraint's own `{ a_b: { … } }` spelling, so the read-back is a
   * COMPLETE discriminator and never a half-specified compound.
   */
  private createArmTerminalWhere(
    identity: CreateArmIdentity
  ): Record<string, unknown> {
    if (identity.kind === "known") return identity.where;
    return buildPrimaryKeyWhereUnique(this.model, {
      ...identity.literals,
      [identity.field]: referenceSql(
        this.engine,
        this.model,
        identity.field,
        ref(this.createId, "id")
      ),
    });
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

/**
 * A conflict-target value the fold can compare by identity — see
 * {@link UpsertOperation.createDataSpellsConflictTarget}.
 */
function isFoldableKeyValue(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  );
}

/**
 * Conjunct 7 of the ON CONFLICT fold: every assignment in the update payload is a
 * plain `set` (or a bare `null`), so the SET clause never reads the column it
 * writes.
 *
 * `buildSet` spells atomic arithmetic and `push`/`unshift` as `col = <col> op x`,
 * using ONE column expression on both sides. Inside `ON CONFLICT … DO UPDATE`
 * PostgreSQL accepts neither spelling that expression can take: unqualified is
 * `42702` (ambiguous — the proposed row and the existing row both offer the name),
 * and qualifying it makes the assignment target `42703`. Only "bare target,
 * qualified source" parses there, and no emitter in this codebase writes that. So
 * the fold states what it can spell instead of guessing; the payload keeps the
 * probe-first path, which is correct on every dialect.
 *
 * An EMPTY payload is also excluded: `buildSet` throws `No fields to update` on
 * one, and the probe path reaches that throw through its own arm.
 */
function isPlainSetUpdate(data: Record<string, unknown>): boolean {
  const assignments = Object.values(data).filter(
    (value) => value !== undefined
  );
  if (assignments.length === 0) return false;
  return assignments.every(
    (value) =>
      value === null ||
      (isRecord(value) && "set" in value && value.set !== undefined)
  );
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

/**
 * E5-U3 — what is left of the three `requireRecord` gates after the envelope moved to
 * the parse boundary: a NARROWING, and the invariant behind it is the boundary's.
 *
 * `upsertEnvelopeSchema` proves the three arms are records before this operation is
 * built (`routing.ts`, the one construction path a client payload takes), but the
 * constructor's parameter is still an untyped bag, so TypeScript needs the narrowing
 * spelled. Its failure is therefore an ENGINE fault — a caller that skipped the
 * boundary — not a user one, and it says so: a `QueryEngineError`, and its wording sits
 * deliberately OUTSIDE the shape-check phrase family the parse-boundary gate ratchets
 * on, because this is no longer one of those checks. The gate's ceiling drops by one in
 * the same commit.
 */
function envelopeRecord(
  value: unknown,
  key: "create" | "update" | "where"
): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new QueryEngineError(
    `query-engine-v2 internal: upsert reached the operation with a non-record '${key}'; the envelope schema at the construction path admits records only.`
  );
}
