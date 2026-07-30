// biome-ignore-all lint/style/useFilenamingConvention: CreateOperation is the architecture name.
import { NestedWriteError, QueryEngineError } from "@errors";
import type { Model } from "@schema/model";
import { isSql, type Sql } from "@sql";
import {
  buildPrimaryKeyWhereUnique,
  getPrimaryKeyFields,
} from "../query-engine/builders/correlation-utils";
import { isMissingGeneratedIncrement } from "../query-engine/builders/generated-scalar";
import {
  buildConnectSubqueryForField,
  type FkDirection,
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
  getDefaultScalarFieldNames,
  getTableName,
} from "../query-engine/context/query-scope";
import {
  buildCreate,
  buildCreateManyPlan,
  buildFindUnique,
  buildUpdate,
} from "../query-engine/operations";
import { assertPortableCreateManySkip } from "../query-engine/operations/create-many-portability";
import { planNestedCreateIdentity } from "../query-engine/operations/mutation-identity";
import type { QueryEngine } from "../query-engine/query-engine";
import { ResultParser } from "../query-engine/result/ResultParser";
import type { QueryScope, RelationInfo } from "../query-engine/types";
import {
  childRacePin,
  exactlyOneRow,
  nestedWriteFailure,
  presenceGuard,
  referenceSql,
} from "./fragment-builders";
import { relationTargetNotFound } from "./messages";
import {
  buildFreshArmPart,
  buildNestedTargetChildParts,
  type FreshArmBuilder,
} from "./nested-target-parts";
import {
  isOperationValueReference,
  type OperationFragment,
  type OperationStep,
  type OperationValueReference,
  ref,
  type StatementStep,
  type TargetConstraintPin,
} from "./OperationFragment";
import { OwnWritePreflight } from "./OwnWritePreflight";
import type { Part, PlanningKnown } from "./Part";
import { planningKey, planningOutputs } from "./Part";
import { parseValidated } from "./parse-boundary";
import { buildJunctionParts } from "./RelationJunctionPart";
import {
  buildConnectOrCreateParts,
  buildToManyUpsertParts,
  literalParentId,
  type ParentIdSource,
  refParentId,
} from "./RelationUpsertPart";
import { StepScope } from "./StepScope";
import {
  getStepModelName,
  isRecord,
  type SubOperationOptions,
  selectExecutionMode,
  UnsupportedOperationError,
} from "./shared";

type ExecutionMode = "transaction" | "batch";

/**
 * A parent-held-FK to-one arm folded into a record's INSERT (WHY §4.2, TO-ONE.md
 * §1.1). The record holds the FK, so the target is a **before-parent write**: its
 * referenced value is in the record's own FK column, so the target write (or the
 * connect's existence pin) must resolve *before* the record INSERT. One of four
 * shapes:
 *
 * - `connect-covered` — the target is created by a *sibling* before-parent `create`
 *   in the same record (the incident's create-then-connect). Existence is our own
 *   write inside the atomic envelope, so this is a pure FK assignment: no probe, no
 *   guard, no pin (TO-ONE.md §2). Resolved at construction by the coverage ledger.
 * - `connect-probe` — an uncovered `connect`: the FK is the connect target's
 *   referenced literal, its existence pinned by a global planning probe (tx:
 *   found-at-compile) plus a batch `exists` guard (`raceable: false`).
 * - `create` — a before-parent `create`: INSERT the target first, the record's FK
 *   referencing its (possibly generated) identity by a backward `Ref`.
 * - `connectOrCreate` — a global probe decides: found → connect (FK ← literal,
 *   `exists` guard); missing → create the target before the parent (FK ← `Ref`),
 *   the target INSERT carrying a `racePin` (Pin Rule class 2, never a guard).
 */
type ParentHeldArm =
  | {
      readonly kind: "connect-covered";
      readonly fkAssign: Record<string, unknown>;
    }
  | {
      readonly kind: "connect-probe";
      readonly relationName: string;
      readonly relationInfo: RelationInfo;
      readonly guardId: string;
      readonly probeId: string;
      readonly guardProbe: Sql;
      readonly fkAssign: Record<string, unknown>;
    }
  | {
      readonly kind: "create";
      readonly before: RecordPlan;
      /** FK column ← the before-parent target's referenced value (a `Ref` or literal). */
      readonly fkAssign: Record<string, unknown>;
    }
  | {
      readonly kind: "connectOrCreate";
      readonly relationName: string;
      readonly relationInfo: RelationInfo;
      readonly probeId: string;
      readonly guardId: string;
      readonly guardProbe: Sql;
      /** Found arm: FK ← the connect target's referenced literal. */
      readonly foundFkAssign: Record<string, unknown>;
      /** Missing arm: the before-parent target create, and the FK ← its `Ref`. */
      readonly before: RecordPlan;
      readonly missingFkAssign: Record<string, unknown>;
      /** Withheld (`undefined`) when the selector could not establish the missing
       *  premise — see {@link childRacePin}. A `connectOrCreate` selector is strict,
       *  so today this is always present here; the type admits the withholding
       *  because the one function that mints the pin owns that decision. */
      readonly racePin: TargetConstraintPin | undefined;
    };

/** A before-parent `create` target key, feeding the sibling-`connect` coverage
 *  ledger (TO-ONE.md §2): a `connect` whose referenced value is created by a
 *  sibling adopts it with no probe. */
interface CreatedTarget {
  readonly model: Model<any>;
  /** Referenced field → the literal the sibling `create` writes for it. */
  readonly key: Record<string, unknown>;
}

/** A child-held-FK nested `create` record spliced AFTER this record's INSERT. */
interface ChildCreate {
  readonly record: RecordPlan;
  /** The FK columns this child writes ← their referenced parent columns. */
  readonly inject: Record<string, unknown>;
}

/**
 * A child-held-FK nested `createMany` spliced AFTER this record's INSERT. The
 * rows are lowered to one-or-more INSERT write steps by `buildCreateManyPlan` —
 * one statement per same-shape group, so a heterogeneous batch (e.g. some rows
 * supplying an increment PK, some omitting it) becomes several contiguous
 * grouped INSERTs, exactly as the root `createMany` family (ATOM §8) and V1's
 * grouped execution do. The steps carry no output (the terminal read fetches the
 * created rows).
 */
interface CreateManyGroup {
  readonly steps: readonly StatementStep[];
}

/**
 * One create record in the tree (the root or any nested `create`). It knows its
 * own scalar INSERT, the parent-held connects folded before it, and the
 * child-held work (nested create/createMany + adopt-family/M2M Parts) spliced
 * after it. A record holds only its children and its own identity — never its
 * parent (WHY §4.2): a child edge is handed a resolved FK value, never the
 * parent object.
 */
interface RecordPlan {
  readonly model: Model<any>;
  readonly childScope: QueryScope;
  readonly scalarData: Record<string, unknown>;
  /** The single auto-increment PK captured from the INSERT, if any. */
  readonly generatedField: string | undefined;
  /** The known PK values (literals); the generated PK is absent here. */
  readonly identity: Record<string, unknown>;
  readonly writeStepId: string;
  readonly parentHeldArms: readonly ParentHeldArm[];
  readonly childCreates: readonly ChildCreate[];
  readonly createManyGroups: readonly CreateManyGroup[];
  readonly afterParts: readonly Part[];
}

/** The record identity a child edge resolves its FK value against. */
interface RecordIdentity {
  readonly writeStepId: string;
  readonly identity: Record<string, unknown>;
  readonly generatedField: string | undefined;
  readonly model: Model<any>;
  /**
   * N4-U4 — the record's own scalar assignments, so a child edge referencing a
   * NON-primary-key column of this fresh record can read the value the record's INSERT
   * is about to write. The primary key is the identity; a referenced unique is still
   * part of what this fresh row IS.
   */
  readonly scalarData: Record<string, unknown>;
}

/**
 * N4-U4 — what a shared-primary-key parent-held edge contributes to its record's
 * identity: the resolved primary-key values (a literal, or a `Ref` to the producing
 * before-parent INSERT) and, for the produced case, the write-step id that INSERT must
 * use so the `Ref` and the statement agree.
 */
interface SharedPkIdentity {
  readonly identity: Record<string, unknown>;
  /** relation name → the pre-allocated before-parent INSERT step id. */
  readonly producedBy: ReadonlyMap<string, string>;
}

/**
 * N4-U4 — one referenced value of a FRESH record, and where it comes from: the
 * record's own INSERT (a backward `Ref`, materialized when that statement runs) or a
 * value already knowable at construction.
 */
type FreshReferenced =
  | { readonly kind: "ref"; readonly ref: OperationValueReference }
  | { readonly kind: "literal"; readonly value: unknown };

/**
 * The root `create` (PLAN P6-prerequisite — the create family, generalized far
 * beyond the P1 nested-upsert proof slice). It INSERTs the parent (capturing a
 * generated auto-increment identity, or addressing a known one), composes any mix
 * of nested writes, and reads the created row back through the same executor,
 * fragment vocabulary, and Part composition the update/upsert families use.
 *
 * **Fresh-parent elision (ATOM §4) is the central technique.** A child of a
 * parent this operation just created cannot pre-exist against, orphan, or collide
 * with committed state — no correlated probe under it can match — so the adopt
 * family runs GLOBAL (connectOrCreate/upsert adopt any matched row), and a nested
 * `create` is an unconditional INSERT (no probe, no `notExists` guard — its unique
 * violation is a genuine error, never a raceable create-branch signal, because it
 * is not a probe's missing arm). racePins still ride the adopt family's create
 * arms (RelationUpsertPart) per the Pin Rule.
 *
 * Supported (constructs on V2):
 * - root scalars + defaults + generated/known PKs; select/include terminal; the
 *   statement-atomic fast path (one `INSERT … RETURNING select` on a returning
 *   driver with a scalar-only projection — no envelope, the PERF fast path);
 * - child-held-FK to-many AND inverse-side to-one: nested `create`/`createMany`/
 *   `connect`/`connectOrCreate`/`upsert` (fresh-parent global adopt), any depth;
 * - **parent-held-FK to-one (the T1 family, TO-ONE.md): `connect`, `create` (a
 *   before-parent INSERT whose identity the record FK references by a backward
 *   `Ref`), and `connectOrCreate`; plus every same-record sibling combination —
 *   a sibling `connect` observing a before-parent `create` is resolved by the
 *   construction-time coverage ledger (the P6-prereq-2 create-then-connect
 *   incident), no probe;**
 * - M2M `connect`/`create`/`connectOrCreate` through the junction.
 *
 * The child-held-FK one-to-many `upsert` is the deliberate P−1.2 Prisma SUPERSET
 * (global lookup, adopt-and-update); V1 rejects it at runtime, so it is the
 * oracle's extension-scenario class, not a V1-parity shape.
 *
 * Routed to V1 with a typed {@link UnsupportedOperationError} (the whole tree):
 * - a nested `update`/`delete`/`set`/… in a create payload (V1 rejects it too,
 *   with its own typed message — routing yields byte-identical behavior);
 * - M2M `upsert`/`disconnect`/`set`/`delete` under create (V1 rejects M2M upsert
 *   in parent create; the junction upsert needs a planned parent id a fresh
 *   parent cannot give);
 * - a to-one `connect` by a non-referenced unique (needs a lookup subquery), and
 *   a shared-primary-key parent-held edge whose fold value is neither a literal nor a
 *   value this fragment PRODUCES — a non-referenced connect's lookup subquery (whose
 *   re-evaluation for the identity would be a second provenance of the row the arm's
 *   probe located) or a `connectOrCreate`'s runtime arm decision. N4-U4 absorbed the
 *   `create` cause under BOTH provenances: a literal target key, and one the database
 *   generates, which the record's identity and its terminal read take as a backward
 *   `Ref` to the before-parent INSERT that produces it;
 * - a compound child edge;
 * - a referenced field that is neither this record's primary key nor a knowable value in
 *   its own create data (N4-U4 widened a fresh record's identity past its primary key:
 *   an edge referencing one of its other uniques reads the value that unique is about to
 *   hold — from the same create data, one column over).
 *
 * A nested `createMany skipDuplicates` is composed (T4a CLASS VI): the plan carries the
 * skip in its SQL leaf (`ON CONFLICT DO NOTHING`/`INSERT OR IGNORE`) or, on a
 * `recoverableUniqueError` dialect, per-row `onUniqueConflict` effects. A default-only
 * row under skipDuplicates stays V1's byte-identical `QueryEngineError`.
 */
export class CreateOperation {
  readonly mode: ExecutionMode;

  private readonly engine: QueryEngine;
  private readonly model: Model<any>;
  private readonly scope: StepScope;
  private readonly resultArgs: Record<string, unknown>;
  private readonly root: RecordPlan;
  private readonly parsedSelect: Record<string, unknown> | undefined;
  private readonly parsedInclude: Record<string, unknown> | undefined;
  private readonly terminalId: string;
  private readonly planningSteps: OperationStep[] = [];
  private readonly registeredParts = new Set<Part>();
  /** The single-step `INSERT … RETURNING select` fold, when eligible. */
  private readonly foldStep: StatementStep | undefined;
  /** X1b — a nested fresh subtree emits no terminal read (the enclosing op owns
   *  the result) and injects the located parent's FK into its root INSERT. */
  private readonly suppressTerminal: boolean;
  private readonly rootFkInject:
    | ((known: Readonly<Record<string, unknown>>) => Record<string, unknown>)
    | undefined;
  /** N4-U2 — the enclosing adopt arm's raceable missing-premise pin, carried by this
   *  subtree's ROOT record INSERT (the statement that was the arm's own create leaf
   *  before the arm became a subtree). */
  private readonly rootRacePin: TargetConstraintPin | undefined;
  /** N4-U2 — the adopt family's fresh-arm seam, bound to this operation's scope and
   *  engine (an arrow field, so `this` survives being passed as a callback). */
  private readonly buildFreshArm: FreshArmBuilder = (input) =>
    buildFreshArmPart(this.scope, this.engine, input);

  constructor(
    engine: QueryEngine,
    model: Model<any>,
    args: Record<string, unknown>,
    options: SubOperationOptions = {}
  ) {
    this.engine = engine;
    this.model = model;
    this.mode = selectExecutionMode(engine, "create");
    const txMode = this.mode === "transaction";
    // T3c: an upsert's create arm reuses this operation as one arm of a larger
    // fragment, sharing the enclosing scope so no two arms collide on a step id.
    this.scope = options.scope ?? new StepScope();

    // X1b — a nested fresh subtree at depth carries its already-validated create
    // data (no re-parse — the enclosing op's whole-args boundary validated the
    // whole tree; a schema's transformed output is non-idempotent under re-parse,
    // X2), emits no terminal read, and folds the located parent's FK into its root
    // INSERT at compile.
    const nestedFresh = options.nestedFresh;
    this.suppressTerminal = nestedFresh !== undefined;
    this.rootFkInject = nestedFresh?.rootFkInject;
    this.rootRacePin = nestedFresh?.rootRacePin;

    let data: Record<string, unknown>;
    if (nestedFresh) {
      data = nestedFresh.data;
      this.parsedInclude = undefined;
      this.parsedSelect = undefined;
      this.resultArgs = {};
    } else {
      const parentSchemas = engine.schemaRegistry.getModelSchemas(model);
      // THE one home for create's legality (X2): the whole-args schema is the front
      // line — an unknown top-level key, a missing `data`, an unknown nested key, a
      // type mismatch, or an omitted-FK violation is a ValidationError with V1's
      // byte-identical message and ordering (there is no pre-validate key gate to
      // shadow it into a coarser UnsupportedOperationError). The parsed value carries
      // every scalar default (ulid/cuid/now) materialized — so a nested child's PK is
      // a known literal, not a DB-side default. `data` is present-and-an-object by
      // `atLeast: ["data"]` + `core.create` (object.ts:392), so it flows straight to
      // the tree walk as the open field bag the interpreter reads.
      const parsedArgs = parseValidated(
        parentSchemas.args.create,
        args,
        "create",
        ""
      );
      data = parsedArgs.data;
      const hasSelect = isRecord(parsedArgs.select);
      this.parsedInclude = isRecord(parsedArgs.include)
        ? parsedArgs.include
        : undefined;
      // The projection: an explicit `select`, else the default scalar projection
      // (respecting `.omit()`, exactly as the update/upsert families do). `include`
      // rides alongside the default scalar projection.
      this.parsedSelect = hasSelect
        ? (parsedArgs.select as Record<string, unknown>)
        : this.parsedInclude
          ? undefined
          : defaultSelect(model);
      this.resultArgs = {
        ...(this.parsedSelect ? { select: this.parsedSelect } : {}),
        ...(this.parsedInclude ? { include: this.parsedInclude } : {}),
      };
    }

    const parent = createQueryScope(engine.adapter, model);
    // Own-write preflight (ATOM §4): reject any payload whose nested decision
    // reads depend on this operation's own writes, before planning. As an upsert
    // create arm — or a nested fresh subtree — the caller runs this per-arm / on
    // the whole enclosing tree, so it is skipped here (V1 checks it inside the
    // whenFalse branch only; a nested subtree's own-write is covered by the
    // enclosing operation's whole-tree walk).
    if (!options.skipOwnWrite) {
      new OwnWritePreflight().assertCreate(parent, data);
    }

    this.terminalId = this.suppressTerminal
      ? ""
      : this.scope.allocate(`${getStepModelName(model, "record")}.select`);

    this.root = this.buildRecord(parent, data, txMode);

    // The statement-atomic fast path (PERF): a pure scalar create — no nested
    // relation work — with a scalar-only projection on a RETURNING driver folds
    // into ONE `INSERT … RETURNING select`, the created row (incl. any generated
    // PK) coming straight back. Empty planning + one step + no ref/insertId → the
    // executor runs it directly with no transaction/batch envelope.
    const isPureScalar =
      this.root.parentHeldArms.length === 0 &&
      this.root.childCreates.length === 0 &&
      this.root.createManyGroups.length === 0 &&
      this.root.afterParts.length === 0;
    this.foldStep =
      !this.suppressTerminal &&
      txMode &&
      isPureScalar &&
      this.projectionIsScalarOnly() &&
      engine.adapter.capabilities.supportsReturning
        ? {
            id: this.root.writeStepId,
            kind: "write",
            statement: buildCreate(parent, {
              data: this.root.scalarData,
              ...(this.parsedSelect ? { select: this.parsedSelect } : {}),
            }),
            outputs: { result: { kind: "rows" } },
            expects: exactlyOneRow(terminalFailure()),
          }
        : undefined;
  }

  planning(): OperationFragment {
    if (this.foldStep) return { steps: [], outputs: {} };
    return {
      steps: this.planningSteps,
      outputs: planningOutputs(this.planningSteps),
    };
  }

  compile(known: Readonly<Record<string, unknown>>): OperationFragment {
    if (this.foldStep) {
      return {
        steps: [this.foldStep],
        outputs: { result: ref(this.root.writeStepId, "result") },
      };
    }
    const guards: OperationStep[] = [];
    const writes: OperationStep[] = [];
    // X1b — the located parent's FK is folded into the root record's INSERT
    // (resolved here at compile: a literal constant, or a planned locate-row value).
    const rootInject = this.rootFkInject ? this.rootFkInject(known) : {};
    this.emitRecord(this.root, rootInject, known, guards, writes);
    if (this.suppressTerminal) {
      // A nested fresh subtree contributes only its writes/guards; the enclosing
      // operation owns the terminal read and the result.
      return { steps: [...guards, ...writes], outputs: {} };
    }
    return {
      steps: [...guards, ...writes, this.buildTerminal(this.root)],
      outputs: { result: ref(this.terminalId, "result") },
    };
  }

  parse<T>(outputs: Readonly<Record<string, unknown>>): T {
    if (!Object.hasOwn(outputs, "result")) {
      throw new QueryEngineError(
        "query-engine-v2 create did not expose its result."
      );
    }
    return new ResultParser(
      this.engine.adapter,
      this.model,
      this.engine.driver,
      this.engine.decimalDecode
    ).parse<T>("create", outputs.result, this.resultArgs);
  }

  /** The step id of the root parent INSERT — the write an enclosing upsert create
   *  arm annotates with its raceable missing-premise `racePin` (T3c). */
  get rootWriteStepId(): string {
    return this.root.writeStepId;
  }

  // -------------------------------------------------------------------------

  /**
   * Interpret one create record: separate its scalars from its relations,
   * allocate its INSERT step, and fold each relation into a before-parent connect,
   * a child-held create/createMany, or an after-parent adopt/M2M Part. Recurses on
   * nested `create` arms. Planning probes are registered on {@link planningSteps}.
   */
  private buildRecord(
    childScope: QueryScope,
    data: Record<string, unknown>,
    txMode: boolean,
    presetWriteStepId?: string
  ): RecordPlan {
    const model = childScope.model;
    const separated = separateData(childScope, data);
    // T3c (shared-PK parent-held edge absorbed): a record whose primary key IS its
    // FK gets that PK from the edge fold, not scalar data — so `planNestedCreateIdentity`
    // would reject it as "primary key not known". Resolve the shared PK from a
    // COMPILE-TIME-LITERAL edge (a direct-referenced `connect` / a literal-id `create`)
    // and thread it into the identity so the terminal read can address the created row.
    // A non-literal edge (non-referenced connect, generated-id create, connectOrCreate)
    // yields no literal here; the shared-PK decline below still routes those to V1.
    const sharedPk = this.resolveSharedPkIdentity(
      childScope,
      separated.relations,
      data
    );
    const { identity, generatedField } = planNestedCreateIdentity(model, {
      ...separated.scalarData,
      ...sharedPk.identity,
    });
    const scalarData = { ...separated.scalarData };
    if (generatedField) delete scalarData[generatedField];

    const recordName = getStepModelName(model, "record");
    const writeStepId =
      presetWriteStepId ?? this.scope.allocate(`${recordName}.create`);
    const self: RecordIdentity = {
      writeStepId,
      identity,
      generatedField,
      model,
      scalarData,
    };

    const parentHeldArms: ParentHeldArm[] = [];
    const childCreates: ChildCreate[] = [];
    const createManyGroups: CreateManyGroup[] = [];
    const afterParts: Part[] = [];

    // The before-parent coverage ledger (TO-ONE.md §2): every parent-held `create`
    // (and connectOrCreate — which guarantees the target exists after the
    // before-parent phase) in THIS record's arms is an unconditional witness a
    // sibling `connect` can adopt without a probe. Computed before interpreting the
    // arms so coverage is order-insensitive, exactly as V1's group-0 analysis.
    const coverage = this.beforeParentCoverage(
      childScope,
      separated.relations,
      data
    );

    for (const [relationName, mutation] of Object.entries(
      separated.relations
    )) {
      this.interpretRelation({
        childScope,
        self,
        sharedPkWriteStepId: sharedPk.producedBy.get(relationName),
        relationName,
        mutation,
        relationInput: requireRecord(
          data[relationName],
          `data.${relationName}`
        ),
        txMode,
        coverage,
        parentHeldArms,
        childCreates,
        createManyGroups,
        afterParts,
      });
    }

    this.registerPlanning(afterParts);

    return {
      model,
      childScope,
      scalarData,
      generatedField,
      identity,
      writeStepId,
      parentHeldArms,
      childCreates,
      createManyGroups,
      afterParts,
    };
  }

  /**
   * Resolve a shared-primary-key parent-held edge's PK from the edge's fold (T3c, then
   * N4-U4). A record whose FK is (part of) its own primary key gets that PK from the
   * edge, not from scalar data, so `planNestedCreateIdentity` would otherwise reject it
   * as "primary key not known before execution" — and that rejection, not the census
   * refusal below it, is what actually stopped this family.
   *
   * Two provenances, both of them the value the edge's own step ACTS ON:
   *
   *  · **a literal** — a direct-referenced `connect` (the referenced column is in
   *    `where`) or a `create` spelling the referenced column in its data (T3c);
   *  · **a produced `Ref`** — a `create` whose target key the DATABASE generates
   *    (N4-U4). The target is a before-parent INSERT, so its identity exists as soon as
   *    that INSERT runs, and the record's own FK column already references it by a
   *    backward `Ref` (`beforeParentFkAssign`). The shared PK is that same column, so
   *    the record's identity — and the terminal read that addresses the created row — is
   *    that same `Ref`. Nothing is re-derived: one produced value, spent everywhere.
   *
   * The `Ref` needs the target's write-step id BEFORE the arms fold (a value the
   * identity is built from, the N4-U1 allocation-order precedent), so this method
   * pre-allocates it and {@link interpretParentHeldCreate} consumes it instead of
   * minting its own. A NON-referenced connect (the FK is a lookup subquery, and
   * re-evaluating it for the identity would be a second provenance) and a
   * `connectOrCreate` (a runtime arm decision) still yield nothing here.
   */
  private resolveSharedPkIdentity(
    childScope: QueryScope,
    relations: Record<string, RelationMutation>,
    data: Record<string, unknown>
  ): SharedPkIdentity {
    const recordPk = getPrimaryKeyFields(childScope.model);
    const identity: Record<string, unknown> = {};
    const producedBy = new Map<string, string>();
    for (const [relationName, mutation] of Object.entries(relations)) {
      const relationInfo = mutation.relationInfo;
      if (relationInfo.type === "manyToMany") continue;
      const fk = getFkDirection(childScope, relationInfo);
      if (!fk.holdsFK) continue;
      const sharedFkFields = fk.fkFields.filter((fkField) =>
        recordPk.includes(fkField)
      );
      if (sharedFkFields.length === 0) continue;
      const kinds = getRelationMutationKinds(mutation);
      if (kinds.length !== 1) continue;
      const relationInput = data[relationName];
      if (!isRecord(relationInput)) continue;
      const source =
        kinds[0] === "connect"
          ? normalizeSingle(relationInput.connect, relationName)
          : kinds[0] === "create"
            ? normalizeSingle(relationInput.create, relationName)
            : undefined;
      if (!source) continue;
      for (let index = 0; index < fk.fkFields.length; index += 1) {
        const fkField = fk.fkFields[index]!;
        const referenced = fk.pkFields[index]!;
        if (!recordPk.includes(fkField)) continue;
        // The literal the fold SPELLS. `isMissingGeneratedIncrement` is the same
        // question `planNestedCreateIdentity` asks one line later: a create payload
        // carries the target's auto-increment key as an ABSENT value, so the key is
        // present-but-unspelled and only the INSERT will know it.
        const spelled = source[referenced];
        if (
          spelled !== undefined &&
          !isMissingGeneratedIncrement(
            relationInfo.targetModel["~"].state.scalars[referenced],
            spelled
          )
        ) {
          identity[fkField] = spelled;
          continue;
        }
        // N4-U4: the target's key is the one its own INSERT will generate. Pre-allocate
        // that INSERT's step id so the record's identity can `Ref` it here, before the
        // arms fold — one id, one producing statement, one value.
        if (
          kinds[0] === "create" &&
          targetGeneratesReferencedKey(relationInfo.targetModel, referenced)
        ) {
          const producedStep =
            producedBy.get(relationName) ??
            this.scope.allocate(
              `${getStepModelName(relationInfo.targetModel, "record")}.create`
            );
          producedBy.set(relationName, producedStep);
          identity[fkField] = ref(producedStep, "id");
        }
      }
    }
    return { identity, producedBy };
  }

  /**
   * Build the before-parent coverage ledger (TO-ONE.md §2): the set of target
   * keys a sibling `connect` may adopt without a probe because a sibling arm
   * guarantees the target exists after the before-parent phase. An unconditional
   * `create` always writes its target; a `connectOrCreate` guarantees existence by
   * found-or-create. Both contribute; a `connect` does not (it asserts, it does not
   * produce). Only literal referenced fields enter the key — a generated target id
   * is not connectable, so it can cover nothing.
   */
  private beforeParentCoverage(
    childScope: QueryScope,
    relations: Record<string, RelationMutation>,
    data: Record<string, unknown>
  ): CreatedTarget[] {
    const targets: CreatedTarget[] = [];
    for (const [relationName, mutation] of Object.entries(relations)) {
      const relationInfo = mutation.relationInfo;
      if (relationInfo.type === "manyToMany") continue;
      const fk = getFkDirection(childScope, relationInfo);
      if (!fk.holdsFK) continue;
      const kinds = getRelationMutationKinds(mutation);
      const producesTarget =
        kinds.includes("create") || kinds.includes("connectOrCreate");
      if (!producesTarget) continue;
      const relationInput = data[relationName];
      if (!isRecord(relationInput)) continue;
      const createRaw = kinds.includes("create")
        ? relationInput.create
        : isRecord(relationInput.connectOrCreate)
          ? relationInput.connectOrCreate.create
          : undefined;
      const createData = Array.isArray(createRaw) ? createRaw[0] : createRaw;
      if (!isRecord(createData)) continue;
      const key: Record<string, unknown> = {};
      let hasAny = false;
      for (const referenced of fk.pkFields) {
        if (Object.hasOwn(createData, referenced)) {
          key[referenced] = createData[referenced];
          hasAny = true;
        }
      }
      if (hasAny) targets.push({ model: relationInfo.targetModel, key });
    }
    return targets;
  }

  /** True iff a sibling before-parent arm creates the `connect` target (TO-ONE.md §2). */
  private connectIsCovered(
    coverage: readonly CreatedTarget[],
    targetModel: Model<any>,
    where: Record<string, unknown>,
    referencedFields: readonly string[]
  ): boolean {
    return coverage.some(
      (target) =>
        target.model === targetModel &&
        referencedFields.every(
          (field) =>
            Object.hasOwn(target.key, field) &&
            Object.hasOwn(where, field) &&
            target.key[field] === where[field]
        )
    );
  }

  private interpretRelation(input: {
    childScope: QueryScope;
    self: RecordIdentity;
    /** N4-U4 — the write-step id the shared-primary-key identity `Ref`s, when this
     *  relation's before-parent `create` is what produces this record's primary key. */
    sharedPkWriteStepId?: string;
    relationName: string;
    mutation: RelationMutation;
    relationInput: Record<string, unknown>;
    txMode: boolean;
    coverage: readonly CreatedTarget[];
    parentHeldArms: ParentHeldArm[];
    childCreates: ChildCreate[];
    createManyGroups: CreateManyGroup[];
    afterParts: Part[];
  }): void {
    const { relationName, mutation, txMode, relationInput } = input;
    const relationInfo = mutation.relationInfo;
    const kinds = getRelationMutationKinds(mutation);

    if (relationInfo.type === "manyToMany") {
      // M2M is not special (WHY §4.3): the junction composes as ordinary Parts. A
      // fresh parent has no existing memberships, so connect/create/connectOrCreate
      // only add join rows (elision). create/connect/connectOrCreate are the
      // create-tree M2M surface; disconnect/set/delete/upsert route to V1 (its
      // rejection). M2M `upsert` under create is NOT the P−1.2 one-to-many
      // superset — V1 rejects it (`NestedWriteError: … not supported in parent
      // create`), so V2 declines it at construction and the whole tree routes to
      // V1 for that byte-identical rejection (the junction upsert Part needs a
      // *planned* parent id, which a fresh parent cannot supply — deferring the
      // decision to compile would hard-fail instead of routing).
      this.assertCreateTreeKinds(kinds, relationName);
      const engine = this.engine;
      const scope = this.scope;
      input.afterParts.push(
        ...buildJunctionParts({
          scope,
          engine,
          parentScope: input.childScope,
          relationName,
          relationInfo,
          mutation,
          parsedRelation: relationInput,
          parentId: this.edgeParentId(
            input.self,
            getPrimaryKeyFields(input.self.model),
            relationName
          ),
          txMode,
          // T3b-2 (family C): a junction create target whose data carries its own
          // relations folds them one level deeper against the fresh target's explicit
          // literal PK (mechanism 2, fresh-parent elision — ATOM §4). The fold
          // correlates to the junction target's OWN PK, not this fresh parent's.
          nestedBuilder: (targetScope, parentId, relations, nestedTxMode) =>
            buildNestedTargetChildParts(
              scope,
              engine,
              targetScope,
              relations,
              parentId,
              nestedTxMode
            ),
        })
      );
      return;
    }

    const fk = getFkDirection(input.childScope, relationInfo);
    if (fk.holdsFK) {
      this.interpretParentHeld(input, relationInfo, fk, kinds);
      return;
    }
    // A child-held relation this record is the referenced side of: to-many
    // (`oneToMany`) or a to-one inverse (`oneToOne`, the child holding the FK).
    // The create-tree mechanics are direction-based, not arity-based — a child
    // INSERTs AFTER the parent with `fk = parent`, riding the same already-certified
    // own-write machinery (a sibling reading a just-created child is still rejected
    // by the OwnWritePreflight). A to-one is the arity-1 case of that path; the
    // mixed-directions conformance scenario and the create-family oracle certify the
    // one-to-one `create`.
    //
    // NOT a schema impossibility — N7-U-A MEASURED it. A `manyToOne` declared without
    // `.fields()` (the inverse side spelled with the many-side helper, its FK resolved
    // from the target's own back-reference) has `holdsFK === false` and
    // `type === "manyToOne"`, so it lands HERE and is refused, while the SAME relation
    // on the SAME schema constructs under `update` — `UpdateOperation`'s sibling gate
    // asks `isToOne || type === "oneToMany"`, which admits it, and routes it down the
    // very `interpretChildHeld` path this line withholds. The refusal is a create-root
    // capability gap with a narrower predicate than its own update-root twin, not a
    // defensive guard; it stays in the census (audit disposition (c-ii)) until a wave
    // widens the predicate or measures why the child-held path cannot take it.
    if (relationInfo.type !== "oneToMany" && relationInfo.type !== "oneToOne") {
      throw new UnsupportedOperationError(
        `query-engine-v2 create supports only child-held one-to-many / one-to-one relations; relation '${relationName}' is '${relationInfo.type}'.`
      );
    }
    this.interpretChildHeld(input, relationInfo, fk, kinds);
  }

  /**
   * A parent-held-FK to-one relation (the record holds the FK): a before-parent
   * arm (TO-ONE.md §1.1). `connect` (covered / probed), `create`, and
   * `connectOrCreate` are on V2; a shared-primary-key edge stays routed.
   */
  private interpretParentHeld(
    input: Parameters<CreateOperation["interpretRelation"]>[0],
    relationInfo: RelationInfo,
    fk: FkDirection,
    kinds: readonly string[]
  ): void {
    const { relationName } = input;
    if (kinds.length !== 1) {
      throw new UnsupportedOperationError(
        `query-engine-v2 create supports one operation on the to-one relation '${relationName}'; it has ${kinds.join(", ") || "none"}.`
      );
    }
    // Shared-primary-key edge: the FK the record holds IS (part of) its own primary
    // key. The PK is then supplied by the connect/create fold, not by scalar data.
    // T3c: when that fold value is a COMPILE-TIME LITERAL (a direct-referenced connect,
    // a literal-id create), `resolveSharedPkIdentity` threaded it into `self.identity`
    // above, so the terminal read can address the created row — proceed natively. A
    // fold value that is NOT a literal (a non-referenced connect subquery, a generated
    // create id, a connectOrCreate runtime decision) leaves the shared PK field absent
    // from the identity; the terminal read cannot address it without a produced value it
    // does not carry, so route the whole tree to V1 (whose `getCreatedRowWhere` resolves
    // the shared PK). A finer boundary of the same class as the non-referenced connect.
    const recordPk = getPrimaryKeyFields(input.self.model);
    const sharedFkFields = fk.fkFields.filter((fkField) =>
      recordPk.includes(fkField)
    );
    if (
      sharedFkFields.length > 0 &&
      !sharedFkFields.every((fkField) =>
        Object.hasOwn(input.self.identity, fkField)
      )
    ) {
      throw new UnsupportedOperationError(
        `query-engine-v2 create does not support a shared-primary-key ${kinds[0]} on relation '${relationName}' whose foreign key '${fk.fkFields.join(", ")}' (this record's primary key) is not a compile-time literal.`
      );
    }
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    switch (kinds[0]) {
      case "connect":
        this.interpretParentHeldConnect(input, relationInfo, fk, childScope);
        return;
      case "create":
        this.interpretParentHeldCreate(input, fk, childScope);
        return;
      case "connectOrCreate":
        this.interpretParentHeldConnectOrCreate(
          input,
          relationInfo,
          fk,
          childScope
        );
        return;
      default:
        // Unreachable by construction (N7-U-A, the X1c disposition): `toOneCreateFactory`
        // offers EXACTLY `create` / `connect` / `connectOrCreate`, and the three arms above
        // are total over that set. `update` / `delete` / `disconnect` / `upsert` / `set`
        // under a create root are answered by the parse boundary first
        // (`ValidationError: Unknown key: <kind>`) — an engine invariant, not a route.
        throw new QueryEngineError(
          `query-engine-v2 internal: kind '${kinds[0]}' reached the parent-held to-one create dispatch on relation '${relationName}'; the parse boundary admits only create/connect/connectOrCreate there.`
        );
    }
  }

  /** A parent-held `connect`: covered by a sibling before-parent create (pure FK
   *  assign, no probe) or an uncovered global existence probe + pin. */
  private interpretParentHeldConnect(
    input: Parameters<CreateOperation["interpretRelation"]>[0],
    relationInfo: RelationInfo,
    fk: FkDirection,
    childScope: QueryScope
  ): void {
    const { relationName, relationInput } = input;
    const where = normalizeSingle(relationInput.connect, relationName);
    const fkAssign = this.toOneFkAssign(
      input.self.model,
      relationInfo,
      fk,
      where,
      relationName
    );
    if (
      this.connectIsCovered(
        input.coverage,
        relationInfo.targetModel,
        where,
        fk.pkFields
      )
    ) {
      // The incident's create-then-connect: a sibling before-parent create writes
      // this target, so existence is our own write inside the atomic envelope —
      // pure FK assignment, no probe, no guard, no pin (TO-ONE.md §2.3).
      input.parentHeldArms.push({ kind: "connect-covered", fkAssign });
      return;
    }
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    const probeId = this.scope.allocate(`${childName}.find`);
    const guardId = this.scope.allocate(`${childName}.guard.exists`);
    const pkSelect = Object.fromEntries(fk.pkFields.map((f) => [f, true]));
    const probe: StatementStep = {
      id: probeId,
      kind: "read",
      statement: buildFindUnique(childScope, {
        where,
        select: pkSelect,
        forUpdate: input.txMode,
      }),
      outputs: { rows: { kind: "rows" } },
    };
    input.parentHeldArms.push({
      kind: "connect-probe",
      relationName,
      relationInfo,
      guardId,
      probeId,
      guardProbe: buildFindUnique(childScope, { where, select: pkSelect }),
      fkAssign,
    });
    this.planningSteps.push(probe);
  }

  /** A parent-held `create`: INSERT the target before the record, the record's FK
   *  referencing the target's (possibly generated) identity by a backward `Ref`. */
  private interpretParentHeldCreate(
    input: Parameters<CreateOperation["interpretRelation"]>[0],
    fk: FkDirection,
    childScope: QueryScope
  ): void {
    // N4-U4: when this record's own primary key IS the foreign key this arm resolves,
    // the identity already `Ref`s a step id — so this INSERT must BE that step, not a
    // freshly allocated one. The allocation moved to `resolveSharedPkIdentity` because
    // the identity is built before the arms fold (the N4-U1 precedent).
    const before = this.buildRecord(
      childScope,
      normalizeSingle(input.relationInput.create, input.relationName),
      input.txMode,
      input.sharedPkWriteStepId
    );
    input.parentHeldArms.push({
      kind: "create",
      before,
      fkAssign: this.beforeParentFkAssign(
        input.self.model,
        fk,
        before,
        input.relationName
      ),
    });
  }

  /** A parent-held `connectOrCreate`: a global probe decides found (connect) vs
   *  missing (create the target before the parent, `racePin`ned). */
  private interpretParentHeldConnectOrCreate(
    input: Parameters<CreateOperation["interpretRelation"]>[0],
    relationInfo: RelationInfo,
    fk: FkDirection,
    childScope: QueryScope
  ): void {
    const { relationName, relationInput } = input;
    const spec = normalizeSingle(relationInput.connectOrCreate, relationName);
    const where = requireRecord(
      spec.where,
      `${relationName}.connectOrCreate.where`
    );
    const createData = requireRecord(
      spec.create,
      `${relationName}.connectOrCreate.create`
    );
    const foundFkAssign = this.toOneFkAssign(
      input.self.model,
      relationInfo,
      fk,
      where,
      relationName
    );
    const before = this.buildRecord(childScope, createData, input.txMode);
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    const probeId = this.scope.allocate(`${childName}.find`);
    const guardId = this.scope.allocate(`${childName}.guard.exists`);
    const pkSelect = Object.fromEntries(fk.pkFields.map((f) => [f, true]));
    input.parentHeldArms.push({
      kind: "connectOrCreate",
      relationName,
      relationInfo,
      probeId,
      guardId,
      guardProbe: buildFindUnique(childScope, { where, select: pkSelect }),
      foundFkAssign,
      before,
      missingFkAssign: this.beforeParentFkAssign(
        input.self.model,
        fk,
        before,
        relationName
      ),
      racePin: childRacePin(childScope, where),
    });
    this.planningSteps.push({
      id: probeId,
      kind: "read",
      statement: buildFindUnique(childScope, {
        where,
        select: pkSelect,
        forUpdate: input.txMode,
      }),
      outputs: { rows: { kind: "rows" } },
    });
  }

  /**
   * The record's FK columns ← the connect target's referenced values (TO-ONE.md
   * §1.1). A directly-referenced unique (`where` carries the referenced column) is a
   * compile-time literal; a **NON-referenced unique** (`where` carries some OTHER
   * unique — a to-one connect by e.g. `email` when the FK references `id`) resolves
   * through a correlated lookup subquery `(SELECT referenced FROM target WHERE …)` —
   * V1's `buildConnectSubqueryForField`, verbatim (T3c create-root decline absorbed).
   * The existence premise is unaffected: the parent-held connect's probe/guard reads
   * the target by the SAME `where`, so a missing target is caught exactly as the
   * directly-referenced case is.
   */
  private toOneFkAssign(
    recordModel: Model<any>,
    relationInfo: RelationInfo,
    fk: FkDirection,
    where: Record<string, unknown>,
    _relationName: string
  ): Record<string, unknown> {
    const recordScope = createQueryScope(this.engine.adapter, recordModel);
    const fkAssign: Record<string, unknown> = {};
    for (let index = 0; index < fk.fkFields.length; index += 1) {
      const referenced = fk.pkFields[index]!;
      const fkField = fk.fkFields[index]!;
      fkAssign[fkField] = Object.hasOwn(where, referenced)
        ? referenceSql(this.engine, recordModel, fkField, where[referenced])
        : buildConnectSubqueryForField(
            recordScope,
            relationInfo,
            where,
            referenced
          );
    }
    return fkAssign;
  }

  /** The record's FK columns ← a before-parent target record's referenced values
   *  (a `Ref` to a captured generated id, or a known literal). */
  private beforeParentFkAssign(
    recordModel: Model<any>,
    fk: FkDirection,
    target: RecordPlan,
    relationName: string
  ): Record<string, unknown> {
    const fkAssign: Record<string, unknown> = {};
    for (let index = 0; index < fk.fkFields.length; index += 1) {
      fkAssign[fk.fkFields[index]!] = referenceSql(
        this.engine,
        recordModel,
        fk.fkFields[index]!,
        this.targetReferencedValue(target, fk.pkFields[index]!, relationName)
      );
    }
    return fkAssign;
  }

  /** The value a before-parent target produces for one referenced field — a `Ref` to
   *  its captured generated id, or a value knowable at construction (N4-U4). */
  private targetReferencedValue(
    target: RecordPlan,
    referencedField: string,
    relationName: string
  ): unknown {
    const resolved = freshReferenced(target, referencedField);
    if (resolved === undefined) {
      throw new UnsupportedOperationError(
        `query-engine-v2 create cannot resolve referenced field '${referencedField}' for the before-parent target of relation '${relationName}': it is neither that record's primary key nor a knowable value in its own create data.`
      );
    }
    return resolved.kind === "ref" ? resolved.ref : resolved.value;
  }

  /** A child-held-FK to-many relation: create/createMany/connect/adopt (after). */
  private interpretChildHeld(
    input: Parameters<CreateOperation["interpretRelation"]>[0],
    relationInfo: RelationInfo,
    fk: FkDirection,
    kinds: readonly string[]
  ): void {
    const { txMode, relationName, relationInput } = input;
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    for (const kind of kinds) {
      switch (kind) {
        case "create":
          this.foldChildCreates(input, childScope, fk, relationInput.create);
          break;
        case "createMany":
          this.foldCreateMany(input, childScope, fk, relationInput.createMany);
          break;
        case "connect":
          input.afterParts.push(
            ...normalizeItems(relationInput.connect, relationName).map(
              (where) =>
                new ChildConnectPart(this.scope, {
                  engine: this.engine,
                  childScope,
                  childName: getStepModelName(
                    relationInfo.targetModel,
                    relationName
                  ),
                  relationName,
                  relationInfo,
                  where,
                  fkAssign: this.childFkAssign(
                    input.self,
                    fk,
                    childScope.model,
                    relationName
                  ),
                  txMode,
                })
            )
          );
          break;
        case "connectOrCreate":
          input.afterParts.push(
            ...buildConnectOrCreateParts(
              this.scope,
              input.childScope,
              this.engine,
              relationName,
              relationInfo,
              normalizeItems(relationInput.connectOrCreate, relationName),
              this.edgeParentId(input.self, fk.pkFields, relationName),
              txMode,
              this.buildFreshArm
            )
          );
          break;
        case "upsert":
          input.afterParts.push(
            ...buildToManyUpsertParts(
              this.scope,
              input.childScope,
              this.engine,
              relationName,
              relationInfo,
              normalizeItems(relationInput.upsert, relationName),
              this.edgeParentId(input.self, fk.pkFields, relationName),
              "global-adopt",
              txMode,
              this.buildFreshArm,
              "upsert"
            )
          );
          break;
        default:
          // Unreachable by construction (N7-U-A, the X1c disposition): the five arms above
          // are total over `toManyCreateFactory`'s key set (create / createMany / connect /
          // connectOrCreate / upsert). `update` / `updateMany` / `delete` / `deleteMany` /
          // `set` / `disconnect` under a create root are answered by the parse boundary
          // first (`ValidationError: Unknown key: <kind>`) — an engine invariant, not a
          // route.
          throw new QueryEngineError(
            `query-engine-v2 internal: kind '${kind}' reached the child-held create dispatch on relation '${relationName}'; the parse boundary admits only the five create-tree kinds there.`
          );
      }
    }
  }

  /** Nested `create` items: each a full child record spliced after the parent. */
  private foldChildCreates(
    input: Parameters<CreateOperation["interpretRelation"]>[0],
    childScope: QueryScope,
    fk: FkDirection,
    createInput: unknown
  ): void {
    const inject = this.childFkAssign(
      input.self,
      fk,
      childScope.model,
      input.relationName
    );
    for (const item of normalizeItems(createInput, input.relationName)) {
      input.childCreates.push({
        record: this.buildRecord(childScope, item, input.txMode),
        inject,
      });
    }
  }

  /** Nested `createMany`: FK-injected rows spliced after the parent (one INSERT). */
  private foldCreateMany(
    input: Parameters<CreateOperation["interpretRelation"]>[0],
    childScope: QueryScope,
    fk: FkDirection,
    createManyInput: unknown
  ): void {
    const createMany = requireRecord(
      createManyInput,
      `${input.relationName}.createMany`
    );
    const skipDuplicates = createMany.skipDuplicates === true;
    const userRows = normalizeItems(createMany.data, input.relationName);
    if (skipDuplicates) {
      // V1's portability guard, run BEFORE the parent write (construction time) on
      // the PRE-injection user rows: a `skipDuplicates` createMany carrying a
      // default-only row (no explicit user scalar — the FK is system-derived, so
      // injection does not count) is inexpressible, so V1 rejects with a typed
      // `QueryEngineError`. `buildValueGroups` on the user rows detects the
      // zero-column group exactly as V1's `buildCreateManyStatement` does, and
      // `assertPortableCreateManySkip` throws V1's byte-identical message. The
      // FK-injected plan below never trips its OWN internal check (every row carries
      // the injected FK column), so this pre-injection check is the sole V1-parity
      // gate for the default-only shape (T4a CLASS VI).
      const groups = buildValueGroups(childScope, userRows);
      assertPortableCreateManySkip(
        true,
        groups.some((group) => group.columns.length === 0)
      );
    }
    const inject = this.childFkAssign(
      input.self,
      fk,
      childScope.model,
      input.relationName
    );
    const rows = userRows.map((row) => ({ ...row, ...inject }));
    if (rows.length === 0) return;
    // Lower to grouped INSERTs (buildCreateManyPlan): one statement per same-shape
    // group, so heterogeneous rows (some supplying a generated PK, some omitting
    // it) split into contiguous grouped INSERTs — full parity with V1's grouped
    // execution, never the single-VALUES "Heterogeneous insert rows" hard-fail.
    // `skipDuplicates` rides the plan: a dialect whose skip IS a SQL leaf
    // (`ON CONFLICT DO NOTHING`, `INSERT OR IGNORE`) carries the semantics in the
    // statement; a `recoverableUniqueError` dialect (MySQL) has no leaf, so each
    // per-row statement carries the savepoint-wrapped `onUniqueConflict: "skip"`
    // executor effect — exactly as the root `createMany` (ATOM §8, CreateManyOperation).
    const plan = buildCreateManyPlan(
      childScope,
      { data: rows, skipDuplicates },
      false
    );
    const recoverUnique =
      skipDuplicates &&
      this.engine.adapter.mutations.skipDuplicatesStrategy ===
        "recoverableUniqueError";
    const base = getStepModelName(childScope.model, input.relationName);
    input.createManyGroups.push({
      steps: plan.statements.map((statement) => ({
        id: this.scope.allocate(`${base}.createMany`),
        kind: "write" as const,
        statement: statement.sql,
        outputs: {},
        ...(recoverUnique ? { onUniqueConflict: "skip" as const } : {}),
      })),
    });
  }

  private registerPlanning(parts: readonly Part[]): void {
    for (const part of parts) {
      if (this.registeredParts.has(part)) continue;
      this.registeredParts.add(part);
      this.planningSteps.push(...part.planning(this.scope));
    }
  }

  /** The FK columns a child edge writes ← its referenced parent columns. */
  private childFkAssign(
    self: RecordIdentity,
    fk: FkDirection,
    childModel: Model<any>,
    relationName: string
  ): Record<string, unknown> {
    const assign: Record<string, unknown> = {};
    for (let index = 0; index < fk.fkFields.length; index += 1) {
      assign[fk.fkFields[index]!] = referenceSql(
        this.engine,
        childModel,
        fk.fkFields[index]!,
        this.referencedValue(self, fk.pkFields[index]!, relationName)
      );
    }
    return assign;
  }

  /** The parent value a child FK references — a `Ref` to the value this record's own
   *  INSERT produces, or a value already knowable at construction (N4-U4). */
  private referencedValue(
    self: RecordIdentity,
    referencedField: string,
    relationName: string
  ): unknown {
    const resolved = freshReferenced(self, referencedField);
    if (resolved === undefined) {
      throw new UnsupportedOperationError(
        `query-engine-v2 create cannot resolve referenced field '${referencedField}' for relation '${relationName}': it is neither this record's primary key nor a knowable value in its own create data.`
      );
    }
    return resolved.kind === "ref" ? resolved.ref : resolved.value;
  }

  /** The {@link ParentIdSource} an after-parent adopt/M2M Part consumes (the
   *  existing Parts read a single referenced parent value). */
  private edgeParentId(
    self: RecordIdentity,
    referencedFields: readonly string[],
    relationName: string
  ): ParentIdSource {
    if (referencedFields.length !== 1) {
      throw new UnsupportedOperationError(
        `query-engine-v2 create does not support a compound child edge on relation '${relationName}'.`
      );
    }
    const referenced = referencedFields[0]!;
    const resolved = freshReferenced(self, referenced);
    if (resolved === undefined) {
      throw new UnsupportedOperationError(
        `query-engine-v2 create cannot resolve the parent id for relation '${relationName}': referenced field '${referenced}' is neither this record's primary key nor a knowable value in its own create data.`
      );
    }
    return resolved.kind === "ref"
      ? refParentId(resolved.ref)
      : literalParentId(resolved.value);
  }

  // -------------------------------------------------------------------------

  private emitRecord(
    plan: RecordPlan,
    inject: Record<string, unknown>,
    known: Readonly<Record<string, unknown>>,
    guards: OperationStep[],
    writes: OperationStep[]
  ): void {
    const insertData: Record<string, unknown> = {
      ...plan.scalarData,
      ...inject,
    };
    // 1. Before the record INSERT: resolve each parent-held to-one arm — a before-
    //    parent target INSERT (emitted first, its id referenced backward), a covered
    //    connect (pure FK assign), or an uncovered connect/connectOrCreate probe +
    //    pin (TO-ONE.md §1.1/§2). Each folds its FK value into `insertData`.
    for (const arm of plan.parentHeldArms) {
      this.emitParentHeldArm(arm, insertData, known, guards, writes);
    }

    // 2. The record's own INSERT.
    writes.push(this.buildInsertStep(plan, insertData));

    // 3. After the INSERT: child-held creates (recurse), createMany, and the
    //    adopt/M2M Parts — all correlated to this record's (fresh) identity.
    for (const child of plan.childCreates) {
      this.emitRecord(child.record, child.inject, known, guards, writes);
    }
    for (const group of plan.createManyGroups) {
      for (const step of group.steps) writes.push(step);
    }
    for (const part of plan.afterParts) {
      for (const step of part.compile(this.scope, known)) {
        (step.kind === "guard" ? guards : writes).push(step);
      }
    }
  }

  /** Resolve one parent-held to-one arm into the record's `insertData`, emitting
   *  any before-parent target write ahead of the record INSERT (TO-ONE.md §1.1). */
  private emitParentHeldArm(
    arm: ParentHeldArm,
    insertData: Record<string, unknown>,
    known: Readonly<Record<string, unknown>>,
    guards: OperationStep[],
    writes: OperationStep[]
  ): void {
    switch (arm.kind) {
      case "connect-covered":
        Object.assign(insertData, arm.fkAssign);
        return;
      case "connect-probe":
        this.requireConnectFound(
          arm.probeId,
          arm.relationName,
          arm.relationInfo,
          known
        );
        Object.assign(insertData, arm.fkAssign);
        if (this.mode === "batch") {
          guards.push(
            this.connectGuard(
              arm.guardId,
              arm.guardProbe,
              arm.relationInfo,
              arm.relationName
            )
          );
        }
        return;
      case "create":
        this.emitBeforeParent(arm.before, undefined, known, guards, writes);
        Object.assign(insertData, arm.fkAssign);
        return;
      case "connectOrCreate": {
        const rows = known[planningKey(arm.probeId, "rows")];
        const found = Array.isArray(rows) && rows.length > 0;
        if (found) {
          Object.assign(insertData, arm.foundFkAssign);
          if (this.mode === "batch") {
            guards.push(
              this.connectGuard(
                arm.guardId,
                arm.guardProbe,
                arm.relationInfo,
                arm.relationName
              )
            );
          }
        } else {
          this.emitBeforeParent(arm.before, arm.racePin, known, guards, writes);
          Object.assign(insertData, arm.missingFkAssign);
        }
        return;
      }
      default: {
        const _exhaustive: never = arm;
        throw new QueryEngineError(
          `query-engine-v2 create: unhandled parent-held arm ${JSON.stringify(_exhaustive)}.`
        );
      }
    }
  }

  /** Emit a before-parent target record subtree ahead of the record INSERT,
   *  applying a `racePin` to the target's own INSERT (connectOrCreate missing arm). */
  private emitBeforeParent(
    before: RecordPlan,
    racePin: TargetConstraintPin | undefined,
    known: Readonly<Record<string, unknown>>,
    guards: OperationStep[],
    writes: OperationStep[]
  ): void {
    const beforeWrites: OperationStep[] = [];
    this.emitRecord(before, {}, known, guards, beforeWrites);
    if (racePin) {
      for (let index = 0; index < beforeWrites.length; index += 1) {
        const step = beforeWrites[index]!;
        if (step.id === before.writeStepId && step.kind === "write") {
          beforeWrites[index] = { ...step, racePin };
          break;
        }
      }
    }
    for (const step of beforeWrites) writes.push(step);
  }

  private connectGuard(
    guardId: string,
    guardProbe: Sql,
    relationInfo: RelationInfo,
    relationName: string
  ): OperationStep {
    return presenceGuard(
      guardId,
      guardProbe,
      nestedWriteFailure(
        relationTargetNotFound(relationInfo, "connect"),
        relationName,
        false
      )
    );
  }

  private requireConnectFound(
    probeId: string,
    relationName: string,
    relationInfo: RelationInfo,
    known: Readonly<Record<string, unknown>>
  ): void {
    const rows = known[planningKey(probeId, "rows")];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 create connect probe for relation '${relationName}' did not expose rows.`,
        relationName
      );
    }
    if (rows.length === 0) {
      throw new NestedWriteError(
        relationTargetNotFound(relationInfo, "connect"),
        relationName
      );
    }
  }

  private buildInsertStep(
    plan: RecordPlan,
    insertData: Record<string, unknown>
  ): StatementStep {
    const { childScope, generatedField, writeStepId } = plan;
    const txMode = this.mode === "transaction";
    // N4-U2: the enclosing adopt arm's missing-premise pin rides THIS record's INSERT
    // when this record is the subtree's root — the one statement whose unique-constraint
    // violation is the arm's raceable signal. Every deeper record of the subtree is an
    // unconditional create, so none of them carries it.
    const racePin =
      this.rootRacePin && writeStepId === this.root.writeStepId
        ? { racePin: this.rootRacePin }
        : {};
    if (!generatedField) {
      return {
        id: writeStepId,
        kind: "write",
        statement: buildInsert(
          childScope,
          getTableName(childScope.model),
          insertData
        ),
        outputs: {},
        ...racePin,
      };
    }
    // Capture the generated auto-increment identity: `firstRowField` on a
    // returning driver in tx mode (INSERT … RETURNING pk), else the driver's
    // `insertId` (scratch-threaded in batch mode by the executor).
    const returning = this.engine.adapter.capabilities.supportsReturning;
    return {
      id: writeStepId,
      kind: "write",
      statement:
        txMode && returning
          ? buildCreate(childScope, {
              data: insertData,
              select: { [generatedField]: true },
            })
          : buildInsert(childScope, getTableName(childScope.model), insertData),
      outputs: {
        id:
          txMode && returning
            ? { kind: "firstRowField", field: generatedField }
            : { kind: "insertId" },
      },
      ...racePin,
    };
  }

  /**
   * N4-U4 — the terminal read's unique `where` from the root record's identity. A
   * shared-primary-key identity carries a `Ref` to the before-parent INSERT that
   * produces it, so that member is lowered like every other deferred value (the same
   * `referenceSql` the generated-key branch above uses); a literal identity is passed
   * through untouched, so every other create compiles the same `where` it always did.
   */
  private terminalIdentity(
    identity: Record<string, unknown>
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(identity)) {
      resolved[field] = isOperationValueReference(value)
        ? referenceSql(this.engine, this.model, field, value)
        : value;
    }
    return resolved;
  }

  private buildTerminal(plan: RecordPlan): StatementStep {
    const parent = createQueryScope(this.engine.adapter, this.model);
    const txMode = this.mode === "transaction";
    const where = plan.generatedField
      ? {
          [plan.generatedField]: referenceSql(
            this.engine,
            this.model,
            plan.generatedField,
            ref(plan.writeStepId, "id")
          ),
        }
      : buildPrimaryKeyWhereUnique(
          this.model,
          this.terminalIdentity(plan.identity)
        );
    return {
      id: this.terminalId,
      kind: "read",
      statement: buildFindUnique(parent, {
        where,
        ...(this.parsedSelect ? { select: this.parsedSelect } : {}),
        ...(this.parsedInclude ? { include: this.parsedInclude } : {}),
      }),
      outputs: { result: { kind: "rows" } },
      ...(txMode ? { expects: exactlyOneRow(terminalFailure()) } : {}),
    };
  }

  private projectionIsScalarOnly(): boolean {
    if (this.parsedInclude) return false;
    if (!this.parsedSelect) return true;
    return !Object.keys(this.parsedSelect).some((field) =>
      this.model["~"].relationSet.has(field)
    );
  }

  private assertCreateTreeKinds(
    kinds: readonly string[],
    relationName: string
  ): void {
    // The M2M create-tree surface: create/createMany/connect/connectOrCreate. Every
    // one of them only ADDS membership to a parent that cannot already have any
    // (fresh-parent elision, ATOM §4). `createMany` joined the set in N3-U1 — it is
    // the `create` slot per row plus the duplicate skip, and a fresh parent needs
    // nothing more. The rest (upsert/disconnect/set/delete/update/updateMany/
    // deleteMany) address a PRE-EXISTING membership a fresh parent cannot have, so
    // they stay a typed refusal here.
    for (const kind of kinds) {
      if (
        kind !== "create" &&
        kind !== "createMany" &&
        kind !== "connect" &&
        kind !== "connectOrCreate"
      ) {
        throw new UnsupportedOperationError(
          `query-engine-v2 create does not support nested '${kind}' on the many-to-many relation '${relationName}'.`
        );
      }
    }
  }
}

/**
 * N4-U4 — one referenced value of a FRESH record, in the ONE place every asker reads
 * it: the child-FK assignment, the after-parent adopt/M2M parent id, the before-parent
 * target's referenced value, and (through the identity) the terminal read.
 *
 * Three provenances, all of them the row this record's own INSERT writes:
 *
 *  1. the primary key the INSERT GENERATES — a backward `Ref` to that statement;
 *  2. a primary key already resolved into the identity — a literal, or (shared-PK) the
 *     `Ref` a before-parent INSERT produces, which `resolveSharedPkIdentity` put there;
 *  3. a NON-primary-key referenced column the record's own create data SPELLS. A fresh
 *     record's identity is wider than its primary key: an FK referencing one of its
 *     uniques (the D4 shape on a create root) needs the value that unique is about to
 *     hold, and that value is in the same create data the primary key came from — the
 *     same provenance, one column over. Nothing is re-read and nothing is re-derived.
 *
 * A value that is not knowable NOW is not resolved: an `Sql` operand would be evaluated
 * a SECOND time for the foreign key, and two evaluations of one expression are two
 * values (`gen_random_uuid()`, `now()`), so the child would reference a row that does
 * not exist. `null`/absent likewise resolves nothing — an FK equal to NULL references
 * no row. Both fall through to the caller's typed refusal.
 */
function freshReferenced(
  record: {
    readonly writeStepId: string;
    readonly generatedField: string | undefined;
    readonly identity: Record<string, unknown>;
    readonly scalarData: Record<string, unknown>;
  },
  referencedField: string
): FreshReferenced | undefined {
  if (record.generatedField === referencedField) {
    return { kind: "ref", ref: ref(record.writeStepId, "id") };
  }
  if (Object.hasOwn(record.identity, referencedField)) {
    const value = record.identity[referencedField];
    return isOperationValueReference(value)
      ? { kind: "ref", ref: value }
      : { kind: "literal", value };
  }
  const spelled = record.scalarData[referencedField];
  if (spelled === undefined || spelled === null || isSql(spelled)) {
    return undefined;
  }
  return { kind: "literal", value: spelled };
}

/**
 * N4-U4 — whether a before-parent target's referenced column is the key its own INSERT
 * will GENERATE: the target's single primary key, auto-increment, and not spelled in the
 * payload. Decided from the schema alone, so the shared-primary-key identity can `Ref`
 * that INSERT before the arm (and therefore the target's own plan) is built.
 */
function targetGeneratesReferencedKey(
  targetModel: Model<any>,
  referencedField: string
): boolean {
  const pk = getPrimaryKeyFields(targetModel);
  if (!(pk.length === 1 && pk[0] === referencedField)) return false;
  return (
    targetModel["~"].state.scalars[referencedField]?.["~"].state
      .autoGenerate === "increment"
  );
}

/**
 * A child-held-FK `connect` under a create tree: adopt an existing global row by
 * setting its FK to the freshly-created parent. A fresh parent means the target
 * cannot already be correlated, so this is a pure global reparent (ATOM §4): plan
 * an uncorrelated existence probe, compile `UPDATE child SET fk = parent WHERE
 * unique`, pinned in batch by an `exists` guard. Absent → V1's verbatim
 * `Cannot connect …`. The parent value arrives as a ready {@link referenceSql}
 * assignment (Ref or literal), so it serves both a generated and a known parent id.
 */
interface ChildConnectConfig {
  readonly engine: QueryEngine;
  readonly childScope: QueryScope;
  readonly childName: string;
  readonly relationName: string;
  readonly relationInfo: RelationInfo;
  readonly where: Record<string, unknown>;
  readonly fkAssign: Record<string, unknown>;
  readonly txMode: boolean;
}

class ChildConnectPart implements Part {
  private readonly config: ChildConnectConfig;
  private readonly probeId: string;
  private readonly writeId: string;
  private readonly guardId: string;
  private readonly probe: StatementStep;

  constructor(scope: StepScope, config: ChildConnectConfig) {
    this.config = config;
    this.probeId = scope.allocate(`${config.childName}.find`);
    this.writeId = scope.allocate(`${config.childName}.connect`);
    this.guardId = scope.allocate(`${config.childName}.guard.exists`);
    this.probe = {
      id: this.probeId,
      kind: "read",
      statement: buildFindUnique(config.childScope, {
        where: config.where,
        select: this.pkSelect(),
        forUpdate: config.txMode,
      }),
      outputs: { rows: { kind: "rows" } },
    };
  }

  planning(): readonly OperationStep[] {
    return [this.probe];
  }

  compile(_scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    const rows = known[planningKey(this.probeId, "rows")];
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new NestedWriteError(
        relationTargetNotFound(this.config.relationInfo, "connect"),
        this.config.relationName
      );
    }
    const steps: OperationStep[] = [];
    if (!this.config.txMode) {
      steps.push(
        presenceGuard(
          this.guardId,
          buildFindUnique(this.config.childScope, {
            where: this.config.where,
            select: this.pkSelect(),
          }),
          nestedWriteFailure(
            relationTargetNotFound(this.config.relationInfo, "connect"),
            this.config.relationName,
            false
          )
        )
      );
    }
    steps.push({
      id: this.writeId,
      kind: "write",
      statement: buildUpdate(this.config.childScope, {
        where: this.config.where,
        data: this.config.fkAssign,
        select: this.pkSelect(),
      }),
      outputs: {},
    });
    return steps;
  }

  private pkSelect(): Record<string, boolean> {
    return Object.fromEntries(
      getPrimaryKeyFields(this.config.childScope.model).map((f) => [f, true])
    );
  }
}

// ---------------------------------------------------------------------------

function terminalFailure() {
  return {
    kind: "query" as const,
    message: "query-engine-v2 create terminal read expected exactly one row.",
    raceable: false,
  };
}

function defaultSelect(model: Model<any>): Record<string, unknown> | undefined {
  // V1's default projection is every scalar EXCEPT `.omit()`-ed fields — the raw
  // scalar names would leak an omitted column into the public result. When EVERY
  // scalar is `.omit()`-ed the projection is empty; an explicit `select: {}` is
  // invalid SQL ("needs at least one truthy value"), so we return undefined and
  // let the terminal read + ResultParser produce the empty public object `{}`
  // exactly as `ReadOperation`/`findUnique` does with no select (the read builder
  // already excludes omitted columns).
  const fields = getDefaultScalarFieldNames(model);
  if (fields.length === 0) return undefined;
  return Object.fromEntries(fields.map((field: string) => [field, true]));
}

/** An `unknown -> Record` narrowing, NOT a shape check (N7-U-A). Every caller reads a
 *  dynamically-keyed slot of an ALREADY-PARSED payload, so the whole-args
 *  `parseValidated(parentSchemas.args.create)` has already rejected a non-object here
 *  (`ValidationError: Expected object`). A non-record reaching this narrowing is an
 *  engine invariant break — the X1c disposition, not a route. */
function normalizeSingle(
  value: unknown,
  relationName: string
): Record<string, unknown> {
  const item = Array.isArray(value) ? value[0] : value;
  if (!isRecord(item)) {
    throw new QueryEngineError(
      `query-engine-v2 internal: the to-one connect for relation '${relationName}' reached the create tree without the single unique where the parse boundary validated.`
    );
  }
  return item;
}

function normalizeItems(
  value: unknown,
  relationName: string
): Record<string, unknown>[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (!isRecord(item)) {
      throw new QueryEngineError(
        `Relation '${relationName}' create item must be an object.`
      );
    }
    return item;
  });
}

/** As {@link normalizeSingle}: an `unknown -> Record` narrowing behind the whole-args
 *  create parse, converted by N7-U-A. */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new QueryEngineError(
    `query-engine-v2 internal: '${label}' must be an object after the parse boundary validated the create payload.`
  );
}
