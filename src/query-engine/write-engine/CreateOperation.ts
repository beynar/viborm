// biome-ignore-all lint/style/useFilenamingConvention: CreateOperation is the architecture name.
import { NestedWriteError, QueryEngineError } from "@errors";
import type { Model } from "@schema/model";
import { isSql, type Sql } from "@sql";
import {
  buildPrimaryKeyWhereUnique,
  getPrimaryKeyFields,
} from "../builders/correlation-utils";
import { isMissingGeneratedIncrement } from "../builders/generated-scalar";
import type { PolymorphicStorageValue } from "../builders/polymorphic-mutation";
import {
  type BoundPolymorphicChildHeldRelation,
  type BoundRelation,
  bindRelation,
  buildConnectSubqueryForField,
  type ChildHeldToMany,
  type ChildHeldToOne,
  isPolymorphicChildHeldRelation,
  type ParentHeldToOne,
  type PolymorphicChildHeldToMany,
  type PolymorphicChildHeldToOne,
} from "../builders/relation-data-builder";
import {
  buildParsedRelationPrograms,
  type ParsedRecordPrograms,
  type RelationMutationEntry,
  type RelationMutationProgram,
} from "../builders/relation-mutation-parser";
import { buildInsert, buildValueGroups } from "../builders/values-builder";
import {
  createQueryScope,
  getDefaultScalarFieldNames,
  getTableName,
} from "../context/query-scope";
import { assertCreateOwnWriteSafety } from "../OwnWriteAnalyzer";
import {
  buildCreate,
  buildCreateManyPlan,
  buildFind,
  buildFindUnique,
  buildInsertStatement,
  buildMutationProjectionFold,
  buildUpdate,
  buildUpdateMany,
} from "../operations";
import { assertPortableCreateManySkip } from "../operations/create-many-portability";
import { planNestedCreateIdentity } from "../operations/mutation-identity";
import type { QueryEngine } from "../query-engine";
import { ResultParser } from "../result/ResultParser";
import type {
  QueryScope,
  RelationInfo,
  ResolvedPolymorphicEdge,
} from "../types";
import {
  childRacePin,
  exactlyOneRow,
  nestedWriteFailure,
  presenceGuard,
  referenceSql,
} from "./fragment-builders";
import {
  countDistinctTargets,
  groupLinkTargets,
  linkGroupSelector,
} from "./link-target-groups";
import { nestedReplacement, relationTargetNotFound } from "./messages";
import { buildJunctionTargetRelationParts } from "./nested-target-parts";
import {
  bucketOperationSteps,
  isOperationValueReference,
  type OperationFragment,
  type OperationStep,
  type PlanningFragment,
  type ReadStep,
  ref,
  type StatementStep,
  type TargetConstraintPin,
  type WriteStep,
} from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { planningKey, planningOutputs } from "./Part";
import { parseValidated } from "./parse-boundary";
import {
  buildRecordUpdateCompiler,
  type RecordCompilerSeam,
} from "./RecordUpdateCompiler";
import { buildJunctionParts } from "./RelationJunctionPart";
import {
  buildConnectOrCreateParts,
  buildToManyUpsertParts,
} from "./RelationUpsertPart";
import {
  bindRelationMembership,
  type FinalReferenceSource,
  type ForeignKeyMember,
  fkEquals,
  foreignKeyWriteValue,
  linkedPolymorphicStorage,
  lowerMembershipWrite,
  pairForeignKeyMembers,
  type RelationMembershipBinding,
  resolvePolymorphicStorageValue,
} from "./relation-membership";
import { StepScope } from "./StepScope";
import {
  capturedSelectorWhere,
  getStepModelName,
  isRecord,
  projectionNamesNoRelation,
  projectionReadsMutatedModel,
  type SubOperationOptions,
  selectExecutionMode,
  UnsupportedOperationError,
} from "./shared";

type ExecutionMode = "transaction" | "batch";
type ChildHeldRelation =
  | ChildHeldToOne
  | ChildHeldToMany
  | PolymorphicChildHeldToOne
  | PolymorphicChildHeldToMany;

export interface FreshRecordPart extends Part {
  readonly rootWriteId: string;
  rootReferenced(field: string): FinalReferenceSource | undefined;
}

export type FreshRecordBuilder = (input: {
  readonly childScope: QueryScope;
  readonly data: Record<string, unknown>;
  readonly incomingMembership?: RelationMembershipBinding;
  readonly relationName: string;
  readonly racePin?: TargetConstraintPin;
}) => FreshRecordPart;

/** Build one nested non-bulk fresh record through the create compiler. */
export function buildFreshRecordPart(
  scope: StepScope,
  engine: QueryEngine,
  input: Parameters<FreshRecordBuilder>[0]
): FreshRecordPart {
  const operation = new CreateOperation(
    engine,
    input.childScope.model,
    {},
    {
      scope,
      skipOwnWrite: true,
      nestedFresh: {
        data: input.data,
        ...(input.incomingMembership
          ? { incomingMembership: input.incomingMembership }
          : {}),
        relationName: input.relationName,
        rootRacePin: input.racePin,
      },
    }
  );
  return {
    planning: () => operation.planning().steps,
    compile: (_scope, known) => operation.compile(known).steps,
    get rootWriteId() {
      return operation.rootWriteStepId;
    },
    rootReferenced: (field) => operation.freshRootReferenced(field),
  };
}

/**
 * A parent-held-FK to-one arm folded into a record's INSERT. The record holds
 * the FK, so the target is a **before-parent write**: its
 * referenced value is in the record's own FK column, so the target write (or the
 * connect's existence pin) must resolve *before* the record INSERT. One of four
 * shapes:
 *
 * - `connect-covered` — the target is created by a *sibling* before-parent `create`
 *   in the same record (the incident's create-then-connect). Existence is our own
 *   write inside the atomic envelope, so this is a pure FK assignment: no probe,
 *   guard, or pin. The coverage ledger resolves it at construction.
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
    }
  | {
      readonly kind: "polymorphic-connect-covered";
      readonly assignment: PolymorphicStorageValue<FinalReferenceSource>;
    }
  | {
      readonly kind: "polymorphic-connect-probe";
      readonly relationInfo: RelationInfo;
      readonly guardId: string;
      readonly probeId: string;
      readonly guardField: string;
      readonly where: Record<string, unknown>;
      readonly assignment: PolymorphicStorageValue<FinalReferenceSource>;
    }
  | {
      readonly kind: "polymorphic-create";
      readonly before: RecordPlan;
      readonly assignment: PolymorphicStorageValue<FinalReferenceSource>;
    }
  | {
      readonly kind: "polymorphic-connectOrCreate";
      readonly relationInfo: RelationInfo;
      readonly probeId: string;
      readonly guardId: string;
      readonly guardField: string;
      readonly where: Record<string, unknown>;
      readonly before: RecordPlan;
      readonly foundAssignment: PolymorphicStorageValue<FinalReferenceSource>;
      readonly missingAssignment: PolymorphicStorageValue<FinalReferenceSource>;
      readonly racePin: TargetConstraintPin | undefined;
    };

/** A before-parent target key that lets a sibling `connect` adopt it without a probe. */
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
  /** An inverse polymorphic edge writes its private pair instead of a public FK. */
  readonly polymorphicStorage?: readonly PolymorphicStorageValue<FinalReferenceSource>[];
}

/**
 * A child-held-FK nested `createMany` spliced AFTER this record's INSERT. The
 * rows are lowered to one-or-more INSERT write steps by `buildCreateManyPlan` —
 * one statement per same-shape group, so a heterogeneous batch (e.g. some rows
 * supplying an increment PK, some omitting it) becomes several contiguous
 * grouped INSERTs, exactly as the root `createMany` family (ATOM “Bulk specializations”) and V1's
 * grouped execution do. The steps carry no output (the terminal read fetches the
 * created rows).
 */
interface CreateManyGroup {
  readonly steps: readonly WriteStep[];
  readonly targetTable: string;
  readonly statementSkipsDuplicates: boolean;
  /**
   * Per step, whether its INSERT leaves a value for the DATABASE to assign —
   * Phase 8.2's ordering conjunct reads it (see {@link CreateOperation.buildTreeFold}).
   * Grouped INSERTs split by row SHAPE, so one group's statements can differ:
   * the rows that spell the auto-increment column and the rows that omit it are
   * never in the same statement.
   */
  readonly databaseAssigned: readonly boolean[];
}

/**
 * One create record in the tree (the root or any nested `create`). It knows its
 * own scalar INSERT, the parent-held connects folded before it, and the
 * child-held work (nested create/createMany + adopt-family/M2M Parts) spliced
 * after it. A record holds only its children and its own identity — never its
 * parent: a child edge receives a resolved FK value, never the parent object.
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

interface EmittedRecordData {
  readonly data: Record<string, unknown>;
  readonly polymorphicStorage: readonly PolymorphicStorageValue<unknown>[];
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
 * The fresh-record compiler owns the INSERT, generated identity capture, and nested
 * record compilation. A result-producing use also owns its terminal read; nested
 * FreshRecordPart use omits it. Relation parts retain membership decisions, probes,
 * guards, race pins, and junction effects.
 *
 * A fresh parent has no committed membership, so child-held creates are direct
 * INSERTs and adopt operations use global lookup. Parent-held targets are emitted
 * before the record and feed its FK assignment; child-held targets are emitted
 * after it. A nested `createMany` keeps its grouped statements and its adapter-owned
 * skip-duplicate strategy. Unsupported payloads fail with typed errors; there is no
 * alternate query engine.
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
  private readonly planningSteps: StatementStep[] = [];
  private readonly registeredParts = new Set<Part>();
  private readonly generatedIdentityConsumers = new Set<string>();
  /** The single-step `INSERT … RETURNING select` fold, when eligible. */
  private readonly foldStep: WriteStep | undefined;
  /** X1b — a nested fresh subtree emits no terminal read (the enclosing op owns
   *  the result) and injects the located parent's FK into its root INSERT. */
  private readonly suppressTerminal: boolean;
  private readonly incomingMembership: RelationMembershipBinding | undefined;
  /** N4-U2 — the enclosing adopt arm's raceable missing-premise pin, carried by this
   *  subtree's ROOT record INSERT (the statement that was the arm's own create leaf
   *  before the arm became a subtree). */
  private readonly rootRacePin: TargetConstraintPin | undefined;
  private readonly armLegalityChecks: (() => void) | undefined;
  /** N4-U2 — the adopt family's fresh-arm seam, bound to this operation's scope and
   *  engine (an arrow field, so `this` survives being passed as a callback). */
  private readonly createFresh: FreshRecordBuilder = (input) =>
    buildFreshRecordPart(this.scope, this.engine, input);
  /** E3 — the adopt family's whole seam: the fresh CREATE arm above, plus the
   *  located UPDATE arm's deeper child Parts. Arrow fields, so this binds lazily
   *  and field-initializer order does not matter. */
  private readonly recordCompilers: RecordCompilerSeam = {
    createFresh: (input) => this.createFresh(input),
    updateSelected: (input) =>
      buildRecordUpdateCompiler(input, this.createFresh),
  };

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
    this.incomingMembership = nestedFresh?.incomingMembership;
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
    // Own-write preflight (ATOM “OwnWrite legality”): reject any payload whose nested decision
    // reads depend on this operation's own writes, before planning. As an upsert
    // create arm — or a nested fresh subtree — the caller runs this per-arm / on
    // the whole enclosing tree, so it is skipped here (V1 checks it inside the
    // whenFalse branch only; a nested subtree's own-write is covered by the
    // enclosing operation's whole-tree walk).
    const parsedData = buildParsedRelationPrograms(parent, data);
    const assertOwnWrite = () => {
      assertCreateOwnWriteSafety(
        parent,
        parsedData.scalarData,
        parsedData.relations,
        parsedData.polymorphic
      );
    };
    if (options.skipOwnWrite) {
      this.armLegalityChecks = nestedFresh ? undefined : assertOwnWrite;
    } else {
      this.armLegalityChecks = undefined;
      assertOwnWrite();
    }

    this.terminalId = this.suppressTerminal
      ? ""
      : this.scope.allocate(`${getStepModelName(model, "record")}.select`);

    this.root = this.buildRecord(parent, data, txMode, undefined, parsedData);

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
    // A relation projection cannot ride
    // a RETURNING list (no alias to correlate against) but can ride a CTE:
    // `WITH p AS (INSERT … RETURNING <every column>) SELECT <projection over p>
    // FROM p`. Legal here on ONE guard rather than the update's two: an INSERT
    // fires no `ON UPDATE` referential action, so the only table this statement
    // changes is its own — and the projection must not read it
    // (`projectionReadsMutatedModel`), because PostgreSQL hands the outer SELECT
    // the pre-statement snapshot of every table but the row arriving through `p`.
    const scalarOnlyProjection = this.projectionIsScalarOnly();
    const foldsProjectionIntoCte =
      !scalarOnlyProjection &&
      engine.adapter.capabilities.supportsCteWithMutations &&
      !projectionReadsMutatedModel(
        parent,
        this.parsedSelect,
        this.parsedInclude
      );
    this.foldStep =
      !this.suppressTerminal &&
      txMode &&
      isPureScalar &&
      (scalarOnlyProjection || foldsProjectionIntoCte) &&
      engine.adapter.capabilities.supportsReturning
        ? {
            id: this.root.writeStepId,
            kind: "write",
            statement: foldsProjectionIntoCte
              ? buildMutationProjectionFold(parent, {
                  mutation: buildInsertStatement(parent, this.root.scalarData),
                  ...(this.parsedSelect ? { select: this.parsedSelect } : {}),
                  ...(this.parsedInclude
                    ? { include: this.parsedInclude }
                    : {}),
                })
              : buildCreate(parent, {
                  data: this.root.scalarData,
                  ...(this.parsedSelect ? { select: this.parsedSelect } : {}),
                }),
            outputs: { result: { kind: "rows" } },
            expects: exactlyOneRow(terminalFailure()),
          }
        : undefined;
  }

  /**
   * E1 U3 — the value THIS subtree's root record produces for one referenced field,
   * for an enclosing operation whose own foreign key points AT the subtree root (a
   * parent-held to-one `create`/`connectOrCreate`/`upsert` arm at the update root).
   * The identity flows BACKWARD there — the enclosing UPDATE's SET reads the key of
   * the row this subtree makes — so the seam that resolves it is this operation's
   * own {@link freshReferenced}, not a re-derivation at the caller. `undefined` is
   * the caller's typed refusal (an `Sql` operand, a null/absent value): both would
   * name a row that does not exist.
   */
  freshRootReferenced(
    referencedField: string
  ): FinalReferenceSource | undefined {
    return this.recordReferenced(this.root, referencedField);
  }

  planning(): PlanningFragment {
    if (this.foldStep) return { steps: [], outputs: {} };
    return {
      steps: this.planningSteps,
      outputs: planningOutputs(this.planningSteps),
    };
  }

  assertArmLegality(): void {
    this.armLegalityChecks?.();
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
    const incoming = this.incomingMembership
      ? lowerMembershipWrite(
          this.engine,
          createQueryScope(this.engine.adapter, this.model),
          this.incomingMembership,
          known,
          "create"
        )
      : { data: {}, polymorphicStorage: [] };
    const rootInsertData = this.emitRecord(
      this.root,
      incoming.data,
      known,
      guards,
      writes,
      incoming.polymorphicStorage
    );
    if (this.suppressTerminal) {
      // A nested fresh subtree contributes only its writes/guards; the enclosing
      // operation owns the terminal read and the result.
      return { steps: [...guards, ...writes], outputs: {} };
    }
    const treeFold = this.buildTreeFold(guards, writes, rootInsertData);
    if (treeFold) {
      return {
        steps: [treeFold],
        outputs: { result: ref(this.root.writeStepId, "result") },
      };
    }
    return {
      steps: [...guards, ...writes, this.buildTerminal(this.root)],
      outputs: { result: ref(this.terminalId, "result") },
    };
  }

  /**
   * A guard-free nested-create tree folded into one statement:
   *
   * ```sql
   * WITH "__viborm_mutation" AS (INSERT INTO parent … RETURNING <every column>),
   *      "__viborm_write_0"  AS (INSERT INTO child  …),
   *      "__viborm_write_1"  AS (INSERT INTO child  …)
   * SELECT <scalars> FROM "__viborm_mutation" AS "t0"
   * ```
   *
   * MEASURED on PGlite before the fold: a root plus two nested children sent four
   * statements (three INSERTs and the terminal read); after, one.
   *
   * What makes it legal is the fresh-parent elision ladder (ATOM “Relation-owner boundary”): a child of
   * a row this operation is creating cannot pre-exist, so no correlated probe
   * under it can match and the whole tree needs the database to answer NOTHING
   * before it writes. That is why `guards` and the planning fragment are empty
   * here — and it is also the reason a nested `create` is the only tree shape
   * that folds. The adopt family (`connect` / `connectOrCreate` / `upsert`, M2M)
   * asks a probe first and reads its rows CLIENT-side to pick a branch, so it has
   * statements the fold cannot merge.
   *
   * The conjuncts, each answering one thing:
   *
   *  · **The tree asked the database nothing.** Empty planning is the ladder made
   *    machine-checkable, and it is also what keeps the folded operation
   *    STATEMENT-ATOMIC: one round trip, no envelope. A tree that did probe (a
   *    child-held `connect` under the fresh root, whose targets must be verified
   *    to exist) has already spent a round trip and read rows client-side to
   *    decide, so merging its write buys a statement and not the property.
   *  · **No premise is left unasserted.** A guard is a step the merge has no
   *    place for; the fold declines rather than dropping one silently.
   *  · **Nothing flows between the statements.** A `WITH` gives every arm the
   *    same snapshot, so an arm cannot read what a sibling wrote — a child INSERT
   *    that needed the parent's DATABASE-generated key (an `OperationValueReference`
   *    in its SQL) has no in-statement spelling here and declines. A tree whose
   *    keys are literals — supplied, or materialized by a `ulid`/`cuid`/`uuid`
   *    default at the parse boundary — carries no such value. Checked as the
   *    executor checks it (`statement.values.some(isOperationValueReference)`),
   *    which is also why a folded step still satisfies the statement-atomic path.
   *  · **No step carries an effect the merge would drop.** A `skip` effect needs
   *    a savepoint scope one statement has not got, and a per-step `expects` is a
   *    JS check on a result that stops existing once the steps are one.
   *  · **The arms do not care what order they run in** ({@link foldArmsAreOrderInsensitive}).
   *    The multi-statement path runs them in declaration order; PostgreSQL runs
   *    unread data-modifying `WITH` arms in an order it does not specify, and on
   *    PG 16 it runs them LAST-TO-FIRST. Nothing the emitter can spell pins that,
   *    so the fold must only merge arms whose outcome the order cannot change.
   *  · **A scalar-only root projection.** The sibling arms' effects are invisible
   *    to the outer SELECT for exactly the snapshot reason above, so an `include`
   *    of a relation this tree just populated would answer the empty pre-statement
   *    truth. Phase 8.1's create fold takes the relation projection instead, and
   *    its gate holds precisely because that tree writes only the one row.
   */
  private buildTreeFold(
    guards: readonly OperationStep[],
    writes: readonly OperationStep[],
    rootInsertData: EmittedRecordData
  ): WriteStep | undefined {
    const statementWrites = writes.filter(
      (step): step is WriteStep => step.kind === "write"
    );
    const [rootWrite, ...siblings] = statementWrites;
    // The arms this tree can classify, by step id.
    const semantics = new Map<string, FoldArmSemantics>();
    collectFoldArmSemantics(this.root, semantics);
    const foldable =
      this.mode === "transaction" &&
      this.engine.adapter.capabilities.supportsCteWithMutations &&
      this.engine.adapter.capabilities.supportsReturning &&
      this.projectionIsScalarOnly() &&
      this.planningSteps.length === 0 &&
      guards.length === 0 &&
      siblings.length > 0 &&
      statementWrites.length === writes.length &&
      rootWrite?.id === this.root.writeStepId &&
      foldArmsAreOrderInsensitive(writes, semantics) &&
      statementWrites.every(
        (step) =>
          isSql(step.statement) &&
          !step.statement.values.some(isOperationValueReference) &&
          !(step.expects || step.onUniqueConflict)
      );
    if (!foldable) return undefined;
    const parent = createQueryScope(this.engine.adapter, this.model);
    return {
      id: this.root.writeStepId,
      kind: "write",
      statement: buildMutationProjectionFold(parent, {
        mutation: buildInsertStatement(
          parent,
          rootInsertData.data,
          rootInsertData.polymorphicStorage
        ),
        siblings: siblings.map((step) => step.statement),
        ...(this.parsedSelect ? { select: this.parsedSelect } : {}),
      }),
      outputs: { result: { kind: "rows" } },
      expects: exactlyOneRow(terminalFailure()),
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
    presetWriteStepId?: string,
    parsedData: ParsedRecordPrograms = buildParsedRelationPrograms(
      childScope,
      data
    )
  ): RecordPlan {
    const model = childScope.model;
    // A record whose primary key is also its foreign key takes that identity from the
    // edge, not from scalar data. Resolve it before planning the record so the terminal
    // read addresses the inserted row; unresolved sources fail at that ownership seam.
    const sharedPk = this.resolveSharedPkIdentity(
      childScope,
      parsedData.relations,
      parsedData.polymorphic
    );
    const { identity, generatedField } = planNestedCreateIdentity(model, {
      ...parsedData.scalarData,
      ...sharedPk.identity,
    });
    const scalarData = { ...parsedData.scalarData };
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

    // The before-parent coverage ledger: every parent-held `create`
    // (and connectOrCreate — which guarantees the target exists after the
    // before-parent phase) in THIS record's arms is an unconditional witness a
    // sibling `connect` can adopt without a probe. Computed before interpreting the
    // arms so coverage is order-insensitive, exactly as V1's group-0 analysis.
    const coverage = this.beforeParentCoverage(
      childScope,
      parsedData.relations,
      parsedData.polymorphic
    );

    for (const [relationName, program] of Object.entries(
      parsedData.relations
    )) {
      const polymorphic = parsedData.polymorphic[relationName];
      if (polymorphic?.kind === "targeted") {
        this.interpretPolymorphicRelation({
          childScope,
          self,
          program,
          edge: polymorphic.edge,
          txMode,
          coverage,
          parentHeldArms,
        });
        continue;
      }
      this.interpretRelation({
        childScope,
        self,
        sharedPkWriteStepId: sharedPk.producedBy.get(relationName),
        relation: bindRelation(childScope, program.relationInfo),
        program,
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

  private interpretPolymorphicRelation(input: {
    readonly childScope: QueryScope;
    readonly self: RecordIdentity;
    readonly program: RelationMutationProgram;
    readonly edge: ResolvedPolymorphicEdge;
    readonly txMode: boolean;
    readonly coverage: readonly CreatedTarget[];
    readonly parentHeldArms: ParentHeldArm[];
  }): void {
    const relationName = input.edge.relationInfo.name;
    const entry = input.program.entries[0];
    if (!(entry && input.program.entries.length === 1)) {
      throw new QueryEngineError(
        `query-engine internal: direct polymorphic relation '${relationName}' requires one target operation.`
      );
    }
    const childScope = createQueryScope(
      this.engine.adapter,
      input.edge.targetModel
    );
    if (entry.kind === "create") {
      const createData = entry.items[0];
      if (!createData) {
        throw new QueryEngineError(
          `query-engine internal: polymorphic create on relation '${relationName}' has no item.`
        );
      }
      const before = this.buildRecord(childScope, createData, input.txMode);
      const source = this.recordReferenced(before, input.edge.referencedField);
      if (!source) {
        throw new UnsupportedOperationError(
          `query-engine create cannot resolve referenced field '${input.edge.referencedField}' for the before-parent target of relation '${relationName}': it is neither that record's primary key nor a knowable value in its own create data.`
        );
      }
      input.parentHeldArms.push({
        kind: "polymorphic-create",
        before,
        assignment: linkedPolymorphicStorage(input.edge, source),
      });
      return;
    }
    if (entry.kind === "connectOrCreate") {
      const spec = entry.items[0];
      if (!spec) {
        throw new QueryEngineError(
          `query-engine internal: polymorphic connectOrCreate on relation '${relationName}' has no item.`
        );
      }
      const before = this.buildRecord(childScope, spec.create, input.txMode);
      const missingSource = this.recordReferenced(
        before,
        input.edge.referencedField
      );
      if (!missingSource) {
        throw new QueryEngineError(
          `query-engine create cannot resolve referenced field '${input.edge.referencedField}' for the before-parent target of relation '${relationName}': it is neither that record's primary key nor a knowable value in its own create data.`
        );
      }
      const childName = getStepModelName(input.edge.targetModel, relationName);
      const probeId = this.scope.allocate(`${childName}.find`);
      const guardId = this.scope.allocate(`${childName}.guard.exists`);
      const guardField = input.edge.referencedField;
      const select = { [guardField]: true };
      input.parentHeldArms.push({
        kind: "polymorphic-connectOrCreate",
        relationInfo: input.edge.relationInfo,
        probeId,
        guardId,
        guardField,
        where: spec.where,
        before,
        foundAssignment: linkedPolymorphicStorage(input.edge, {
          kind: "planningField",
          step: probeId,
        }),
        missingAssignment: linkedPolymorphicStorage(input.edge, missingSource),
        racePin: childRacePin(childScope, spec.where),
      });
      this.planningSteps.push({
        id: probeId,
        kind: "read",
        statement: buildFindUnique(childScope, {
          where: spec.where,
          select,
          forUpdate: input.txMode,
        }),
        outputs: { rows: { kind: "rows" } },
      });
      return;
    }
    if (entry.kind !== "connect") {
      throw new QueryEngineError(
        `query-engine internal: kind '${entry.kind}' reached direct polymorphic create relation '${relationName}'.`
      );
    }
    const where = entry.targets[0];
    if (!where) {
      throw new QueryEngineError(
        `query-engine internal: polymorphic connect on relation '${relationName}' has no target.`
      );
    }
    if (
      this.connectIsCovered(input.coverage, input.edge.targetModel, where, [
        input.edge.referencedField,
      ])
    ) {
      input.parentHeldArms.push({
        kind: "polymorphic-connect-covered",
        assignment: this.polymorphicConnectAssignment(
          input.childScope,
          input.edge,
          where
        ),
      });
      return;
    }
    const childName = getStepModelName(input.edge.targetModel, relationName);
    const probeId = this.scope.allocate(`${childName}.find`);
    const guardId = this.scope.allocate(`${childName}.guard.exists`);
    const guardField = input.edge.referencedField;
    const select = { [guardField]: true };
    input.parentHeldArms.push({
      kind: "polymorphic-connect-probe",
      relationInfo: input.edge.relationInfo,
      probeId,
      guardId,
      guardField,
      where,
      assignment: linkedPolymorphicStorage(input.edge, {
        kind: "planningField",
        step: probeId,
      }),
    });
    this.planningSteps.push({
      id: probeId,
      kind: "read",
      statement: buildFindUnique(childScope, {
        where,
        select,
        forUpdate: input.txMode,
      }),
      outputs: { rows: { kind: "rows" } },
    });
  }

  private polymorphicConnectAssignment(
    owner: QueryScope,
    edge: ResolvedPolymorphicEdge,
    where: Record<string, unknown>
  ): PolymorphicStorageValue<FinalReferenceSource> {
    const id: FinalReferenceSource = Object.hasOwn(where, edge.referencedField)
      ? { kind: "literal", value: where[edge.referencedField] }
      : {
          kind: "lookup",
          statement: buildConnectSubqueryForField(
            owner,
            edge.relationInfo,
            where,
            edge.referencedField
          ),
        };
    return linkedPolymorphicStorage(edge, id);
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
   * minting its own.
   *
   * **E6.3 — `connectOrCreate` is a third source, and it is the SAME literal.** The
   * arm is a runtime decision, but the value is not: the found arm's foreign key is
   * `connectOrCreate.where`'s referenced literal ({@link CreateOperation.toOneFkAssign}
   * reads that `where`), and the create arm's is the created target's own referenced
   * value. When the `where` spells the referenced column AND the `create` data spells
   * the same value, both arms leave the record holding ONE compile-known key, so the
   * identity is that key on either arm — one provenance, the probe deciding only which
   * statement puts the row there. A `create` that spells a DIFFERENT value (or none, so
   * a default mints one) makes the two arms disagree, and a disagreement is not an
   * identity: it stays unresolved and refuses below.
   *
   * **What still yields nothing, and why it now REFUSES here rather than downstream.**
   * A NON-referenced connect resolves its foreign key through a lookup SUBQUERY, and
   * re-evaluating that expression for the identity is a second evaluation of one
   * expression — the recorded second-provenance rule. The only other source is the
   * planning probe this arm already runs, whose value is COMPILE-known; but the record
   * identity is consumed at CONSTRUCTION by `planNestedCreateIdentity`, by
   * {@link freshReferenced} (sibling edges and junction parent sources), and by
   * {@link CreateOperation.freshRootReferenced} — a PUBLIC seam an enclosing
   * `RecordUpdateCompiler` reads while building its own SET, with no `known` at the call
   * site and no deferral in the final source union (`literal | finalRef`, where a ref
   * names an EMITTED step; ATOM “Proof obligations” forbids a final-fragment step from
   * referencing a planning step). So the sub-shape stays refused, and the refusal is
   * raised HERE, where the shared key's source is manufactured: a record whose primary
   * key is its foreign key must take that key from the edge, and a `s.string().id()`
   * member carries an application-materialized `ulid` DEFAULT that the arm's foreign-key
   * assignment then OVERWRITES. Leaving the check downstream let that phantom stand in
   * for the edge's value — measured at 8c2908d, the operation ran and the terminal read
   * addressed a key no row holds (transaction: the whole unit aborts on the read's
   * postcondition; ATOMIC BATCH: the write COMMITS and the operation then reports an
   * internal `QueryEngineError`). Deciding at the source is D3's placement rule.
   */
  private resolveSharedPkIdentity(
    childScope: QueryScope,
    relations: Record<string, RelationMutationProgram>,
    polymorphic: ParsedRecordPrograms["polymorphic"]
  ): SharedPkIdentity {
    const recordPk = getPrimaryKeyFields(childScope.model);
    const identity: Record<string, unknown> = {};
    const producedBy = new Map<string, string>();
    for (const [relationName, program] of Object.entries(relations)) {
      if (polymorphic[relationName]?.kind === "targeted") continue;
      const relation = bindRelation(childScope, program.relationInfo);
      if (isPolymorphicChildHeldRelation(relation)) continue;
      if (relation.kind !== "parentHeldToOne") continue;
      const sharedForeignFields = relation.foreignFields.filter(
        (foreignField) => recordPk.includes(foreignField)
      );
      if (sharedForeignFields.length === 0) continue;
      const entries = program.entries;
      // A multi-kind to-one payload is `interpretParentHeld`'s own arity refusal,
      // which is more specific than this one and must reach the caller first.
      if (entries.length !== 1) continue;
      const entry = entries[0];
      if (!entry) continue;
      const armSpec =
        entry.kind === "connectOrCreate" ? entry.items[0] : undefined;
      // The value the found arm's foreign key takes, per E6.3's note above.
      const agreeWith =
        armSpec && isRecord(armSpec.create) ? armSpec.create : undefined;
      const source =
        entry.kind === "connect"
          ? entry.targets[0]
          : entry.kind === "create"
            ? entry.items[0]
            : armSpec
              ? armSpec.where
              : undefined;
      // ONE guard, asserted at BOTH exits of this iteration — the invariant is "this
      // edge resolved every shared member", and an edge with no readable source exits
      // here. It is deliberately asked about an EMPTY map, not the accumulated one: a
      // sibling edge that already resolved the same column must not answer for this one.
      if (!source) {
        assertSharedPkResolved(childScope, entry.kind, relation, {});
        continue;
      }
      for (let index = 0; index < relation.foreignFields.length; index += 1) {
        const foreignField = relation.foreignFields[index]!;
        const referenced = relation.referencedFields[index]!;
        if (!recordPk.includes(foreignField)) continue;
        // The literal the fold SPELLS. `isMissingGeneratedIncrement` is the same
        // question `planNestedCreateIdentity` asks one line later: a create payload
        // carries the target's auto-increment key as an ABSENT value, so the key is
        // present-but-unspelled and only the INSERT will know it.
        const spelled = source[referenced];
        // E6.3: on a `connectOrCreate` the two arms must leave the record holding the
        // SAME key, so the create arm's own referenced value has to agree with the
        // `where`'s. `fkEquals` is the comparator E5-U2 chose for exactly this
        // construction-time question, reused rather than re-derived.
        const armsAgree =
          agreeWith === undefined || fkEquals(agreeWith[referenced], spelled);
        if (
          armsAgree &&
          spelled !== undefined &&
          !isMissingGeneratedIncrement(
            relation.relationInfo.targetModel["~"].state.scalars[referenced],
            spelled
          )
        ) {
          identity[foreignField] = spelled;
          continue;
        }
        // N4-U4: the target's key is the one its own INSERT will generate. Pre-allocate
        // that INSERT's step id so the record's identity can `Ref` it here, before the
        // arms fold — one id, one producing statement, one value.
        if (
          entry.kind === "create" &&
          targetGeneratesReferencedKey(
            relation.relationInfo.targetModel,
            referenced
          )
        ) {
          const producedStep =
            producedBy.get(relationName) ??
            this.scope.allocate(
              `${getStepModelName(relation.relationInfo.targetModel, "record")}.create`
            );
          producedBy.set(relationName, producedStep);
          identity[foreignField] = ref(producedStep, "id");
        }
      }
      assertSharedPkResolved(childScope, entry.kind, relation, identity);
    }
    return { identity, producedBy };
  }

  /**
   * Build the before-parent coverage ledger: the set of target
   * keys a sibling `connect` may adopt without a probe because a sibling arm
   * guarantees the target exists after the before-parent phase. An unconditional
   * `create` always writes its target; a `connectOrCreate` guarantees existence by
   * found-or-create. Both contribute; a `connect` does not (it asserts, it does not
   * produce). Only literal referenced fields enter the key — a generated target id
   * is not connectable, so it can cover nothing.
   */
  private beforeParentCoverage(
    childScope: QueryScope,
    relations: Record<string, RelationMutationProgram>,
    polymorphic: ParsedRecordPrograms["polymorphic"]
  ): CreatedTarget[] {
    const targets: CreatedTarget[] = [];
    for (const [relationName, program] of Object.entries(relations)) {
      const direct = polymorphic[relationName];
      if (direct?.kind === "targeted") {
        const create = program.entries.find((entry) => entry.kind === "create");
        const data = create?.items[0];
        if (data && Object.hasOwn(data, direct.edge.referencedField)) {
          targets.push({
            model: direct.edge.targetModel,
            key: {
              [direct.edge.referencedField]: data[direct.edge.referencedField],
            },
          });
        }
        continue;
      }
      const relation = bindRelation(childScope, program.relationInfo);
      if (isPolymorphicChildHeldRelation(relation)) continue;
      if (relation.kind !== "parentHeldToOne") continue;
      const createEntry = program.entries.find(
        (entry) => entry.kind === "create"
      );
      const adoptEntry = program.entries.find(
        (entry) => entry.kind === "connectOrCreate"
      );
      const createData = createEntry?.items[0] ?? adoptEntry?.items[0]?.create;
      if (!createData) continue;
      const key: Record<string, unknown> = {};
      let hasAny = false;
      for (const referenced of relation.referencedFields) {
        if (Object.hasOwn(createData, referenced)) {
          key[referenced] = createData[referenced];
          hasAny = true;
        }
      }
      if (hasAny) {
        targets.push({ model: relation.relationInfo.targetModel, key });
      }
    }
    return targets;
  }

  /** True when a sibling before-parent arm creates the `connect` target. */
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
    relation: BoundRelation;
    program: RelationMutationProgram;
    txMode: boolean;
    coverage: readonly CreatedTarget[];
    parentHeldArms: ParentHeldArm[];
    childCreates: ChildCreate[];
    createManyGroups: CreateManyGroup[];
    afterParts: Part[];
  }): void {
    const { relation, program, txMode } = input;
    const { relationInfo } = relation;
    const relationName = relationInfo.name;
    const entries = program.entries;

    if (relation.kind === "junction") {
      // The junction composes as ordinary Parts. A
      // fresh parent has no existing memberships, so every kind the parse boundary
      // admits here — create/createMany/connect/connectOrCreate/upsert — only ADDS
      // membership (ATOM “Relation-owner boundary”).
      //
      // E5-U1 — `upsert` is the last of them, and it is the beyond-parity superset the
      // parse boundary has documented since P−1.2: Prisma has no `upsert` in a create
      // input, VibORM accepts one with GLOBAL-LOOKUP, ADOPT-AND-UPDATE semantics. The
      // reason it used to refuse was mechanical and is gone: the junction's correlated
      // three-way reads a membership probe correlated on a `planned`/`literal` parent,
      // and a fresh parent supplies a `ref`. {@link RelationJunctionConfig.freshParent}
      // elides that read — the answer was never in doubt — and the three-way collapses
      // to the adopt family's two-way.
      this.assertCreateTreeKinds(
        entries.map((entry) => entry.kind),
        relationName
      );
      const engine = this.engine;
      const scope = this.scope;
      input.afterParts.push(
        ...buildJunctionParts({
          scope,
          engine,
          parentScope: input.childScope,
          relation,
          program,
          parentId: this.edgeParentId(
            input.self,
            getPrimaryKeyFields(input.self.model),
            relationName
          ),
          // E5-U1 — this record is being MADE, so it has no membership to read.
          freshParent: true,
          txMode,
          recordCompilers: this.recordCompilers,
          // T3b-2 (family C): a junction create target whose data carries its own
          // relations folds them one level deeper against the fresh target's explicit
          // literal PK (mechanism 2, fresh-parent elision — ATOM “Relation-owner boundary”). The fold
          // correlates to the junction target's OWN PK, not this fresh parent's.
          nestedBuilder: (
            targetScope,
            parentId,
            relations,
            nestedTxMode,
            membershipReadSource
          ) =>
            buildJunctionTargetRelationParts(
              scope,
              engine,
              targetScope,
              relations,
              parentId,
              nestedTxMode,
              this.recordCompilers,
              membershipReadSource
            ),
        })
      );
      return;
    }

    if (relation.kind === "parentHeldToOne") {
      this.interpretParentHeld(input, relation, entries);
      return;
    }
    // A child-held relation this record is the referenced side of: to-many
    // (`oneToMany`) or a to-one inverse (`oneToOne`, the child holding the FK).
    // The create-tree mechanics are direction-based, not arity-based — a child
    // INSERTs AFTER the parent with `fk = parent`, riding the same already-certified
    // own-write machinery (a sibling reading a just-created child is still rejected
    // by OwnWrite analysis). A to-one is the arity-1 case of that path; the
    // mixed-directions conformance scenario and the create-family oracle certify the
    // one-to-one `create`.
    //
    // E4-U1 — and the fields-less `manyToOne` too, which used to be REFUSED here by a
    // type-name predicate (`oneToMany || oneToOne`). N7-U-A measured that refusal: a
    // `manyToOne` declared without `.fields()` (the inverse side spelled with the
    // many-side helper, its FK resolved from the target's own back-reference) has
    // a child-held position and `type === "manyToOne"`, so it landed here and was refused,
    // while the SAME relation on the SAME schema constructed under `update` —
    // `RecordUpdateCompiler`'s sibling gate asks the bound position and routes
    // it down this very path. It was a create-root capability gap with a narrower
    // predicate than its own update-root twin.
    //
    // The predicate is deleted rather than extended by one member, because the union it
    // tested is closed and every other member left before this line: `manyToMany`
    // returned at the top, the parent-held position returned just above, and an edge with
    // NO inverse to resolve never arrives — `bindRelation` raises its typed "Cannot
    // determine FK fields for relation" before a position exists. What remains is one
    // mechanism, not three names: the child INSERTs after the parent with `fk = parent`, and all three
    // create-root kinds the parse admits (`create` / `connect` / `connectOrCreate`) have
    // a child-held arm below. The to-one slot's own contradiction — two kinds naming one
    // slot — is answered inside `interpretChildHeld` by D5's arity twin, which reads
    // the bound to-one kind and so covers the fields-less spelling by construction.
    //
    // No occupied-slot decision belongs here either: this parent is FRESH, so its to-one
    // slot starts empty and each admitted kind is a pure add against it (the same
    // fresh-parent elision the m2m branch above cites). The occupied question is the
    // UPDATE root's, where the slot may already hold a row (M10).
    this.interpretChildHeld(input, relation, entries);
  }

  /**
   * A parent-held-FK to-one relation (the record holds the FK): a before-parent
   * arm. `connect` (covered or probed), `create`, and
   * `connectOrCreate` are on V2; a shared-primary-key edge stays routed.
   */
  private interpretParentHeld(
    input: Parameters<CreateOperation["interpretRelation"]>[0],
    relation: ParentHeldToOne,
    entries: readonly RelationMutationEntry[]
  ): void {
    const { relationInfo } = relation;
    const relationName = relationInfo.name;
    if (entries.length !== 1) {
      throw new UnsupportedOperationError(
        `query-engine-v2 create supports one operation on the to-one relation '${relationName}'; it has ${entries.map((entry) => entry.kind).join(", ") || "none"}.`
      );
    }
    // The shared-primary-key edge is decided in `resolveSharedPkIdentity` (E6.3), which
    // runs BEFORE this record's identity is planned and refuses there — at the site that
    // manufactures the shared key's source. The check used to stand here and read
    // `input.self.identity`, which by then could hold an application-materialized
    // `ulid` DEFAULT for the key rather than the edge's value; see that method's note
    // for the measurement.
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const entry = entries[0];
    if (!entry) return;
    switch (entry.kind) {
      case "connect":
        this.interpretParentHeldConnect(input, relation, childScope, entry);
        return;
      case "create":
        this.interpretParentHeldCreate(input, relation, childScope, entry);
        return;
      case "connectOrCreate":
        this.interpretParentHeldConnectOrCreate(
          input,
          relation,
          childScope,
          entry
        );
        return;
      default:
        // Unreachable by construction (N7-U-A, the X1c disposition): `toOneCreateFactory`
        // offers EXACTLY `create` / `connect` / `connectOrCreate`, and the three arms above
        // are total over that set. `update` / `delete` / `disconnect` / `upsert` / `set`
        // under a create root are answered by the parse boundary first
        // (`ValidationError: Unknown key: <kind>`) — an engine invariant, not a route.
        throw new QueryEngineError(
          `query-engine-v2 internal: kind '${entry.kind}' reached the parent-held to-one create dispatch on relation '${relationName}'; the parse boundary admits only create/connect/connectOrCreate there.`
        );
    }
  }

  /** A parent-held `connect`: covered by a sibling before-parent create (pure FK
   *  assign, no probe) or an uncovered global existence probe + pin. */
  private interpretParentHeldConnect(
    input: Parameters<CreateOperation["interpretRelation"]>[0],
    relation: ParentHeldToOne,
    childScope: QueryScope,
    entry: Extract<RelationMutationEntry, { kind: "connect" }>
  ): void {
    const { relationInfo } = relation;
    const relationName = relationInfo.name;
    const where = entry.targets[0];
    if (!where) {
      throw new QueryEngineError(
        `query-engine-v2 internal: parent-held connect on relation '${relationName}' has no target.`
      );
    }
    const fkAssign = this.toOneFkAssign(input.self.model, relation, where);
    if (
      this.connectIsCovered(
        input.coverage,
        relationInfo.targetModel,
        where,
        relation.referencedFields
      )
    ) {
      // The incident's create-then-connect: a sibling before-parent create writes
      // this target, so existence is our own write inside the atomic envelope —
      // pure FK assignment, with no probe, guard, or pin.
      input.parentHeldArms.push({ kind: "connect-covered", fkAssign });
      return;
    }
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    const probeId = this.scope.allocate(`${childName}.find`);
    const guardId = this.scope.allocate(`${childName}.guard.exists`);
    const pkSelect = Object.fromEntries(
      relation.referencedFields.map((field) => [field, true])
    );
    const probe: ReadStep = {
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
      relationInfo: relation.relationInfo,
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
    relation: ParentHeldToOne,
    childScope: QueryScope,
    entry: Extract<RelationMutationEntry, { kind: "create" }>
  ): void {
    const createData = entry.items[0];
    if (!createData) {
      throw new QueryEngineError(
        `query-engine-v2 internal: parent-held create on relation '${relation.relationInfo.name}' has no item.`
      );
    }
    // N4-U4: when this record's own primary key IS the foreign key this arm resolves,
    // the identity already `Ref`s a step id — so this INSERT must BE that step, not a
    // freshly allocated one. The allocation moved to `resolveSharedPkIdentity` because
    // the identity is built before the arms fold (the N4-U1 precedent).
    const before = this.buildRecord(
      childScope,
      createData,
      input.txMode,
      input.sharedPkWriteStepId
    );
    input.parentHeldArms.push({
      kind: "create",
      before,
      fkAssign: this.beforeParentFkAssign(input.self.model, relation, before),
    });
  }

  /** A parent-held `connectOrCreate`: a global probe decides found (connect) vs
   *  missing (create the target before the parent, `racePin`ned). */
  private interpretParentHeldConnectOrCreate(
    input: Parameters<CreateOperation["interpretRelation"]>[0],
    relation: ParentHeldToOne,
    childScope: QueryScope,
    entry: Extract<RelationMutationEntry, { kind: "connectOrCreate" }>
  ): void {
    const { relationInfo } = relation;
    const relationName = relationInfo.name;
    const spec = entry.items[0];
    if (!spec) {
      throw new QueryEngineError(
        `query-engine-v2 internal: parent-held connectOrCreate on relation '${relationName}' has no item.`
      );
    }
    const where = spec.where;
    const createData = spec.create;
    const foundFkAssign = this.toOneFkAssign(input.self.model, relation, where);
    const before = this.buildRecord(childScope, createData, input.txMode);
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    const probeId = this.scope.allocate(`${childName}.find`);
    const guardId = this.scope.allocate(`${childName}.guard.exists`);
    const pkSelect = Object.fromEntries(
      relation.referencedFields.map((field) => [field, true])
    );
    input.parentHeldArms.push({
      kind: "connectOrCreate",
      relationInfo,
      probeId,
      guardId,
      guardProbe: buildFindUnique(childScope, { where, select: pkSelect }),
      foundFkAssign,
      before,
      missingFkAssign: this.beforeParentFkAssign(
        input.self.model,
        relation,
        before
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
   * The record's FK columns take the connect target's referenced values. A
   * directly-referenced unique (`where` carries the referenced column) is a
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
    relation: ParentHeldToOne,
    where: Record<string, unknown>
  ): Record<string, unknown> {
    const { relationInfo } = relation;
    const relationName = relationInfo.name;
    const recordScope = createQueryScope(this.engine.adapter, recordModel);
    const fkAssign: Record<string, unknown> = {};
    for (let index = 0; index < relation.foreignFields.length; index += 1) {
      const referenced = relation.referencedFields[index]!;
      const foreignField = relation.foreignFields[index]!;
      const member: ForeignKeyMember = {
        foreignField,
        referencedField: referenced,
        writeSource: Object.hasOwn(where, referenced)
          ? { kind: "literal", value: where[referenced] }
          : {
              kind: "lookup",
              statement: buildConnectSubqueryForField(
                recordScope,
                relationInfo,
                where,
                referenced
              ),
            },
      };
      fkAssign[foreignField] = referenceSql(
        this.engine,
        recordModel,
        foreignField,
        foreignKeyWriteValue(member, undefined, relationName, "connect")
      );
    }
    return fkAssign;
  }

  /** The record's FK columns ← a before-parent target record's referenced values
   *  (a `Ref` to a captured generated id, or a known literal). */
  private beforeParentFkAssign(
    recordModel: Model<any>,
    relation: ParentHeldToOne,
    target: RecordPlan
  ): Record<string, unknown> {
    const relationName = relation.relationInfo.name;
    const fkAssign: Record<string, unknown> = {};
    for (let index = 0; index < relation.foreignFields.length; index += 1) {
      const foreignField = relation.foreignFields[index]!;
      fkAssign[foreignField] = referenceSql(
        this.engine,
        recordModel,
        foreignField,
        this.targetReferencedValue(
          target,
          foreignField,
          relation.referencedFields[index]!,
          relationName
        )
      );
    }
    return fkAssign;
  }

  /** The value a before-parent target produces for one referenced field — a `Ref` to
   *  its captured generated id, or a value knowable at construction (N4-U4). */
  private targetReferencedValue(
    target: RecordPlan,
    foreignField: string,
    referencedField: string,
    relationName: string
  ): unknown {
    const resolved = this.recordReferenced(target, referencedField);
    if (resolved === undefined) {
      throw new UnsupportedOperationError(
        `query-engine-v2 create cannot resolve referenced field '${referencedField}' for the before-parent target of relation '${relationName}': it is neither that record's primary key nor a knowable value in its own create data.`
      );
    }
    return foreignKeyWriteValue(
      { foreignField, referencedField, writeSource: resolved },
      undefined,
      relationName,
      "create"
    );
  }

  /** A child-held-FK to-many relation: create/createMany/connect/adopt (after). */
  private interpretChildHeld(
    input: Parameters<CreateOperation["interpretRelation"]>[0],
    relation: ChildHeldRelation,
    entries: readonly RelationMutationEntry[]
  ): void {
    const { txMode } = input;
    const { relationInfo } = relation;
    const relationName = relationInfo.name;
    // A to-one slot holds ONE row, so two kinds on it name two intents for one slot —
    // the contradiction `interpretParentHeld` refuses above, refused here on the dispatch
    // that reaches the OTHER direction. THAT is this guard's unique coverage: the
    // child-held to-one DISPATCH positions (this one, and `RecordUpdateCompiler`'s inverse
    // branch), which the census's to-one two-kinds family covers only at the ARM
    // positions. Without it the loop below built EVERY arm, and which contradiction the
    // user got depended on whether the child's foreign key happened to carry a unique: a
    // database `UniqueConstraintError` on a 1:1 leg, and — on a leg whose FK is not
    // unique, the fields-less `manyToOne` inverse — TWO ROWS in the to-one slot with no
    // diagnostic at all.
    //
    // `> 1`, not `!== 1`: a payload naming NO kind (`{ card: {} }`) asks for nothing and
    // is Prisma's no-op, which this loop already answers by building nothing — the same
    // reading `RecordUpdateCompiler.interpretRelation` spells out for its empty payload.
    if (
      (relation.kind === "childHeldToOne" ||
        relation.kind === "polymorphicChildHeldToOne") &&
      entries.length > 1
    ) {
      throw new UnsupportedOperationError(
        `query-engine-v2 create supports one operation on the to-one relation '${relationName}'; it has ${entries.map((entry) => entry.kind).join(", ")}.`
      );
    }
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    for (const entry of entries) {
      switch (entry.kind) {
        case "create":
          this.foldChildCreates(input, childScope, relation, entry.items);
          break;
        case "createMany":
          this.foldCreateMany(input, childScope, relation, entry);
          break;
        case "connect":
          input.afterParts.push(
            // P4 — one Part per key-shape GROUP, so `connect: [a, b, c]` sends one
            // probe and one write instead of six statements.
            ...groupLinkTargets(childScope, entry.targets).map((wheres) => {
              const common = {
                engine: this.engine,
                childScope,
                childName: getStepModelName(
                  relationInfo.targetModel,
                  relationName
                ),
                wheres,
                txMode,
              };
              return isPolymorphicChildHeldRelation(relation)
                ? new ChildConnectPart(this.scope, {
                    ...common,
                    relation,
                    polymorphicStorage: this.childPolymorphicStorage(
                      input.self,
                      relation
                    ),
                  })
                : new ChildConnectPart(this.scope, {
                    ...common,
                    relation,
                    fkAssign: this.childFkAssign(
                      input.self,
                      relation,
                      childScope.model
                    ),
                  });
            })
          );
          break;
        case "connectOrCreate":
          input.afterParts.push(
            ...buildConnectOrCreateParts(
              this.scope,
              this.engine,
              entry.items,
              isPolymorphicChildHeldRelation(relation)
                ? bindRelationMembership(
                    relation,
                    this.referencedParentSource(
                      input.self,
                      relation.referencedFields[0],
                      relationName
                    )
                  )
                : {
                    kind: "foreignKey",
                    relation,
                    members: this.childEdgeMembers(input.self, relation),
                  },
              txMode,
              this.recordCompilers
            )
          );
          break;
        case "upsert":
          input.afterParts.push(
            ...buildToManyUpsertParts(
              this.scope,
              this.engine,
              entry.items,
              isPolymorphicChildHeldRelation(relation)
                ? bindRelationMembership(
                    relation,
                    this.referencedParentSource(
                      input.self,
                      relation.referencedFields[0],
                      relationName
                    )
                  )
                : {
                    kind: "foreignKey",
                    relation,
                    members: this.childEdgeMembers(input.self, relation),
                  },
              txMode,
              this.recordCompilers
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
            `query-engine-v2 internal: unsupported entry reached the child-held create dispatch on relation '${relationName}'; the parse boundary admits only the five create-tree kinds there.`
          );
      }
    }
  }

  /** Nested `create` items: each a full child record spliced after the parent. */
  private foldChildCreates(
    input: Parameters<CreateOperation["interpretRelation"]>[0],
    childScope: QueryScope,
    relation: ChildHeldRelation,
    items: readonly Record<string, unknown>[]
  ): void {
    const inject = isPolymorphicChildHeldRelation(relation)
      ? {}
      : this.childFkAssign(input.self, relation, childScope.model);
    const polymorphicStorage = isPolymorphicChildHeldRelation(relation)
      ? [this.childPolymorphicStorage(input.self, relation)]
      : undefined;
    for (const item of items) {
      input.childCreates.push({
        record: this.buildRecord(childScope, item, input.txMode),
        inject,
        ...(polymorphicStorage ? { polymorphicStorage } : {}),
      });
    }
  }

  /** Nested `createMany`: FK-injected rows spliced after the parent (one INSERT). */
  private foldCreateMany(
    input: Parameters<CreateOperation["interpretRelation"]>[0],
    childScope: QueryScope,
    relation: ChildHeldRelation,
    entry: Extract<RelationMutationEntry, { kind: "createMany" }>
  ): void {
    const skipDuplicates = entry.skipDuplicates === true;
    const userRows = entry.rows;
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
    const inject = isPolymorphicChildHeldRelation(relation)
      ? {}
      : this.childFkAssign(input.self, relation, childScope.model);
    const rows = userRows.map((row) => ({ ...row, ...inject }));
    if (rows.length === 0) return;
    // Lower to grouped INSERTs (buildCreateManyPlan): one statement per same-shape
    // group, so heterogeneous rows (some supplying a generated PK, some omitting
    // it) split into contiguous grouped INSERTs — full parity with V1's grouped
    // execution, never the single-VALUES "Heterogeneous insert rows" hard-fail.
    // `skipDuplicates` rides the plan: a dialect whose skip is a SQL leaf carries the semantics in the
    // statement; a `recoverableUniqueError` dialect (MySQL) has no leaf, so each
    // per-row statement carries the savepoint-wrapped `onUniqueConflict: "skip"`
    // executor effect — exactly as the root `createMany` (ATOM “Bulk specializations”).
    const sharedPolymorphicStorage = isPolymorphicChildHeldRelation(relation)
      ? resolvePolymorphicStorageValue(
          this.engine,
          this.childPolymorphicStorage(input.self, relation),
          undefined,
          "create"
        )
      : undefined;
    const plan = buildCreateManyPlan(
      childScope,
      { data: rows, skipDuplicates },
      false,
      sharedPolymorphicStorage
    );
    const recoverUnique =
      skipDuplicates &&
      this.engine.adapter.mutations.skipDuplicatesStrategy ===
        "recoverableUniqueError";
    const base = getStepModelName(childScope.model, relation.relationInfo.name);
    input.createManyGroups.push({
      steps: plan.statements.map(
        (statement): WriteStep => ({
          id: this.scope.allocate(`${base}.createMany`),
          kind: "write",
          statement: statement.sql,
          outputs: {},
          ...(recoverUnique ? { onUniqueConflict: "skip" } : {}),
        })
      ),
      databaseAssigned: plan.statements.map((statement) =>
        statement.inputIndexes.some((index) =>
          insertTakesDatabaseAssignedValue(childScope.model, rows[index]!)
        )
      ),
      targetTable: getTableName(childScope.model),
      statementSkipsDuplicates:
        skipDuplicates &&
        this.engine.adapter.mutations.skipDuplicatesStrategy === "sql",
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
    relation: ChildHeldToOne | ChildHeldToMany,
    childModel: Model<any>
  ): Record<string, unknown> {
    const relationName = relation.relationInfo.name;
    const assign: Record<string, unknown> = {};
    for (let index = 0; index < relation.foreignFields.length; index += 1) {
      const foreignField = relation.foreignFields[index]!;
      assign[foreignField] = referenceSql(
        this.engine,
        childModel,
        foreignField,
        this.referencedValue(
          self,
          foreignField,
          relation.referencedFields[index]!,
          relationName
        )
      );
    }
    return assign;
  }

  private childPolymorphicStorage(
    self: RecordIdentity,
    relation: BoundPolymorphicChildHeldRelation
  ): Extract<
    PolymorphicStorageValue<FinalReferenceSource>,
    { kind: "linked" }
  > {
    return {
      kind: "linked",
      storage: relation.storage,
      storedType: relation.storedType,
      referencedField: relation.referencedFields[0],
      id: this.referencedParentSource(
        self,
        relation.referencedFields[0],
        relation.relationInfo.name
      ),
    };
  }

  /** The parent value a child FK references — a `Ref` to the value this record's own
   *  INSERT produces, or a value already knowable at construction (N4-U4). */
  private referencedValue(
    self: RecordIdentity,
    foreignField: string,
    referencedField: string,
    relationName: string
  ): unknown {
    const resolved = this.recordReferenced(self, referencedField);
    if (resolved === undefined) {
      throw new UnsupportedOperationError(
        `query-engine-v2 create cannot resolve referenced field '${referencedField}' for relation '${relationName}': it is neither this record's primary key nor a knowable value in its own create data.`
      );
    }
    return foreignKeyWriteValue(
      { foreignField, referencedField, writeSource: resolved },
      undefined,
      relationName,
      "create"
    );
  }

  /**
   * The single parent value a many-to-many junction Part consumes.
   *
   * The junction row keys its parent half with ONE column — `getManyToManyJoinInfo`
   * resolves it through `getRequiredSinglePrimaryKeyField`, which is where a compound
   * primary key is answered for every other m2m shape (N3-U3). This refusal reaches the
   * same fact one statement earlier, because the parent source is an ARGUMENT to
   * `buildJunctionParts` and so is built before that resolution runs. It is not the
   * child-edge arity boundary any more: E4-U2 gave the child-held adopt kinds a source
   * with one value per referenced column ({@link childEdgeParentSource}), and they no
   * longer come here.
   */
  private edgeParentId(
    self: RecordIdentity,
    referencedFields: readonly string[],
    relationName: string
  ): FinalReferenceSource {
    if (referencedFields.length !== 1) {
      throw new UnsupportedOperationError(
        `query-engine-v2 create does not support a compound child edge on relation '${relationName}'.`
      );
    }
    return this.referencedParentSource(
      self,
      referencedFields[0]!,
      relationName
    );
  }

  /**
   * E4-U2 — the parent source a child-held ADOPT edge (`connectOrCreate` / `upsert`)
   * consumes: one whole-value source per referenced column, keyed by that column's NAME.
   *
   * A single-column edge is the length-1 case and produces exactly the source it always
   * did, so nothing about the common shape moves. A COMPOUND edge used to be refused
   * here, and the refusal was right for the source that existed: every consumer of a
   * unbound source spends one value on every foreign-key column, so
   * a two-column edge would have written the first referenced value into both — the
   * cross-pair trap D3 measured one level deeper. Keying by name removes the trap by
   * construction rather than by care: there is no index to misalign, and a column with
   * no member is an engine invariant break rather than a silent `undefined`.
   *
   * Each column resolves through the SAME {@link freshReferenced} the single-column edge
   * uses, so the per-component refusal is the same sentence naming the component that
   * failed. That is what a NULL member gets: a spelled `null` (or an `Sql` operand, or
   * an absent column) resolves nothing, and a foreign key equal to NULL references no
   * row — it would make the adopt probe's correlated `WHERE` match nothing silently on a
   * nullable column, and raise a bare NOT NULL violation on a required one.
   */
  private childEdgeMembers(
    self: RecordIdentity,
    relation: ChildHeldToOne | ChildHeldToMany
  ): ForeignKeyMember[] {
    const relationName = relation.relationInfo.name;
    const sources = relation.referencedFields.map((referenced) =>
      this.referencedParentSource(self, referenced, relationName)
    );
    return pairForeignKeyMembers(
      relation.foreignFields,
      relation.referencedFields,
      sources
    );
  }

  /** One referenced column of this fresh record, as a whole-value parent source. */
  private referencedParentSource(
    self: RecordIdentity,
    referenced: string,
    relationName: string
  ): FinalReferenceSource {
    const resolved = this.recordReferenced(self, referenced);
    if (resolved === undefined) {
      throw new UnsupportedOperationError(
        `query-engine-v2 create cannot resolve the parent id for relation '${relationName}': referenced field '${referenced}' is neither this record's primary key nor a knowable value in its own create data.`
      );
    }
    return resolved;
  }

  // -------------------------------------------------------------------------

  /** Emits this record's writes and returns the INSERT data it used — Phase 8.2's
   *  fold rebuilds the ROOT statement with an all-columns `RETURNING`, and this
   *  is the one place that knows what the parent-held arms folded into it. */
  private emitRecord(
    plan: RecordPlan,
    inject: Record<string, unknown>,
    known: Readonly<Record<string, unknown>>,
    guards: OperationStep[],
    writes: OperationStep[],
    initialPolymorphicStorage: readonly PolymorphicStorageValue<unknown>[] = []
  ): EmittedRecordData {
    const insertData: Record<string, unknown> = {
      ...plan.scalarData,
      ...inject,
    };
    const polymorphicStorage: PolymorphicStorageValue<unknown>[] = [
      ...initialPolymorphicStorage,
    ];
    // 1. Before the record INSERT: resolve each parent-held to-one arm — a before-
    //    parent target INSERT (emitted first, its id referenced backward), a covered
    //    connect (pure FK assign), or an uncovered connect/connectOrCreate probe +
    //    pin. Each folds its FK value into `insertData`.
    for (const arm of plan.parentHeldArms) {
      this.emitParentHeldArm(
        arm,
        insertData,
        polymorphicStorage,
        known,
        guards,
        writes
      );
    }

    // 2. The record's own INSERT.
    writes.push(this.buildInsertStep(plan, insertData, polymorphicStorage));

    // 3. After the INSERT: child-held creates (recurse), createMany, and the
    //    adopt/M2M Parts — all correlated to this record's (fresh) identity.
    for (const child of plan.childCreates) {
      this.emitRecord(
        child.record,
        child.inject,
        known,
        guards,
        writes,
        (child.polymorphicStorage ?? []).map((value) =>
          resolvePolymorphicStorageValue(this.engine, value, known, "create")
        )
      );
    }
    for (const group of plan.createManyGroups) {
      for (const step of group.steps) writes.push(step);
    }
    for (const part of plan.afterParts) {
      bucketOperationSteps(part.compile(this.scope, known), guards, writes);
    }
    return { data: insertData, polymorphicStorage };
  }

  /** Resolve one parent-held arm and emit its target before the record INSERT. */
  private emitParentHeldArm(
    arm: ParentHeldArm,
    insertData: Record<string, unknown>,
    polymorphicStorage: PolymorphicStorageValue<unknown>[],
    known: Readonly<Record<string, unknown>>,
    guards: OperationStep[],
    writes: OperationStep[]
  ): void {
    switch (arm.kind) {
      case "connect-covered":
        Object.assign(insertData, arm.fkAssign);
        return;
      case "connect-probe":
        this.requireConnectFound(arm.probeId, arm.relationInfo, known);
        Object.assign(insertData, arm.fkAssign);
        if (this.mode === "batch") {
          guards.push(
            this.connectGuard(arm.guardId, arm.guardProbe, arm.relationInfo)
          );
        }
        return;
      case "create":
        this.emitBeforeParent(arm.before, undefined, known, guards, writes);
        Object.assign(insertData, arm.fkAssign);
        return;
      case "connectOrCreate": {
        const relationName = arm.relationInfo.name;
        const rows = known[planningKey(arm.probeId, "rows")];
        const found = Array.isArray(rows) && rows.length > 0;
        if (found) {
          Object.assign(insertData, arm.foundFkAssign);
          if (this.mode === "batch") {
            guards.push(
              presenceGuard(
                arm.guardId,
                arm.guardProbe,
                nestedWriteFailure(
                  nestedReplacement("connectOrCreate"),
                  relationName,
                  false
                )
              )
            );
          }
        } else {
          this.emitBeforeParent(arm.before, arm.racePin, known, guards, writes);
          Object.assign(insertData, arm.missingFkAssign);
        }
        return;
      }
      case "polymorphic-connect-covered":
        polymorphicStorage.push(
          resolvePolymorphicStorageValue(
            this.engine,
            arm.assignment,
            known,
            "connect"
          )
        );
        return;
      case "polymorphic-connect-probe":
        this.requireConnectFound(arm.probeId, arm.relationInfo, known);
        polymorphicStorage.push(
          resolvePolymorphicStorageValue(
            this.engine,
            arm.assignment,
            known,
            "connect"
          )
        );
        if (this.mode === "batch") {
          const target = this.capturedConnectValue(
            arm.probeId,
            arm.guardField,
            arm.relationInfo,
            known
          );
          const childScope = createQueryScope(
            this.engine.adapter,
            arm.relationInfo.targetModel
          );
          guards.push(
            this.connectGuard(
              arm.guardId,
              buildFind(
                childScope,
                {
                  where: capturedSelectorWhere(childScope, arm.where, {
                    [arm.guardField]: target,
                  }),
                  select: { [arm.guardField]: true },
                  forUpdate: true,
                },
                { limit: 1 }
              ),
              arm.relationInfo
            )
          );
        }
        return;
      case "polymorphic-create":
        this.emitBeforeParent(arm.before, undefined, known, guards, writes);
        polymorphicStorage.push(
          resolvePolymorphicStorageValue(
            this.engine,
            arm.assignment,
            known,
            "create"
          )
        );
        return;
      case "polymorphic-connectOrCreate": {
        const relationName = arm.relationInfo.name;
        const rows = known[planningKey(arm.probeId, "rows")];
        const found = Array.isArray(rows) && rows.length > 0;
        if (found) {
          polymorphicStorage.push(
            resolvePolymorphicStorageValue(
              this.engine,
              arm.foundAssignment,
              known,
              "connectOrCreate"
            )
          );
          if (this.mode === "batch") {
            const target = this.capturedConnectValue(
              arm.probeId,
              arm.guardField,
              arm.relationInfo,
              known
            );
            const childScope = createQueryScope(
              this.engine.adapter,
              arm.relationInfo.targetModel
            );
            guards.push(
              presenceGuard(
                arm.guardId,
                buildFind(
                  childScope,
                  {
                    where: capturedSelectorWhere(childScope, arm.where, {
                      [arm.guardField]: target,
                    }),
                    select: { [arm.guardField]: true },
                  },
                  { limit: 1 }
                ),
                nestedWriteFailure(
                  nestedReplacement("connectOrCreate"),
                  relationName,
                  false
                )
              )
            );
          }
        } else {
          this.emitBeforeParent(arm.before, arm.racePin, known, guards, writes);
          polymorphicStorage.push(
            resolvePolymorphicStorageValue(
              this.engine,
              arm.missingAssignment,
              known,
              "connectOrCreate"
            )
          );
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
    relationInfo: RelationInfo
  ): OperationStep {
    const relationName = relationInfo.name;
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
    relationInfo: RelationInfo,
    known: Readonly<Record<string, unknown>>
  ): void {
    const relationName = relationInfo.name;
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

  private capturedConnectValue(
    probeId: string,
    field: string,
    relationInfo: RelationInfo,
    known: Readonly<Record<string, unknown>>
  ): unknown {
    this.requireConnectFound(probeId, relationInfo, known);
    const rows = known[planningKey(probeId, "rows")];
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!isRecord(row) || row[field] === undefined || row[field] === null) {
      throw new NestedWriteError(
        `query-engine create connect probe for relation '${relationInfo.name}' did not expose '${field}'.`,
        relationInfo.name
      );
    }
    return row[field];
  }

  private buildInsertStep(
    plan: RecordPlan,
    insertData: Record<string, unknown>,
    polymorphicStorage: readonly PolymorphicStorageValue<unknown>[]
  ): WriteStep {
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
    const capturesGeneratedIdentity =
      generatedField !== undefined &&
      (this.generatedIdentityConsumers.has(writeStepId) ||
        (!this.suppressTerminal && writeStepId === this.root.writeStepId));
    if (!capturesGeneratedIdentity) {
      return {
        id: writeStepId,
        kind: "write",
        statement: buildInsert(
          childScope,
          getTableName(childScope.model),
          insertData,
          polymorphicStorage
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
              polymorphicStorage,
              select: { [generatedField]: true },
            })
          : buildInsert(
              childScope,
              getTableName(childScope.model),
              insertData,
              polymorphicStorage
            ),
      outputs: {
        id:
          txMode && returning
            ? { kind: "firstRowField", field: generatedField }
            : { kind: "insertId" },
      },
      ...racePin,
    };
  }

  private recordReferenced(
    record: RecordIdentity,
    referencedField: string
  ): FinalReferenceSource | undefined {
    if (record.generatedField === referencedField) {
      this.generatedIdentityConsumers.add(record.writeStepId);
    }
    return freshReferenced(record, referencedField);
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

  private buildTerminal(plan: RecordPlan): ReadStep {
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

  /** Scalars alone, so `buildCreate`'s RETURNING list and the terminal read's
   *  projection name the same columns. `_count` is a relation projection, not a
   *  scalar one: a folded create answered it from a RETURNING subquery whose outer
   *  reference binds by name, which counted a child row whose own `id` equalled its
   *  FK instead of the (necessarily zero) children of the fresh row. */
  private projectionIsScalarOnly(): boolean {
    return projectionNamesNoRelation(
      this.model,
      this.parsedSelect,
      this.parsedInclude
    );
  }

  private assertCreateTreeKinds(
    kinds: readonly string[],
    relationName: string
  ): void {
    // The M2M create-tree surface: create / createMany / connect / connectOrCreate /
    // upsert. Every one of them only ADDS membership to a parent that cannot already
    // have any (fresh-parent elision, ATOM “Relation-owner boundary”). `createMany` joined the set in N3-U1
    // (the `create` slot per row plus the duplicate skip); `upsert` joined it in E5-U1
    // (the adopt family's third member — global lookup, then adopt-and-update).
    //
    // With `upsert` in, this is an ENGINE INVARIANT, not a capability boundary — the
    // X1c disposition. The kinds it names are EXACTLY the kinds the parse boundary
    // admits in a create-context to-many payload, measured through the public client on
    // both relation spellings (`s.manyToMany` and the self-relation): `delete`,
    // `deleteMany`, `disconnect`, `set`, `update` and `updateMany` are refused upstream
    // by `ToManyCreateSchema` with `ValidationError: … Unknown key: <kind>`, so no
    // payload arrives carrying one. The check stays because the union it walks is the
    // runtime kind list, not a closed type — but it now describes a code path a user
    // cannot reach, and a `QueryEngineError` is what that is.
    for (const kind of kinds) {
      if (
        kind !== "create" &&
        kind !== "createMany" &&
        kind !== "connect" &&
        kind !== "connectOrCreate" &&
        kind !== "upsert"
      ) {
        throw new QueryEngineError(
          `query-engine-v2 internal: nested '${kind}' on the many-to-many relation '${relationName}' reached the create tree; the create-context relation schema admits no such key.`
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
): FinalReferenceSource | undefined {
  if (record.generatedField === referencedField) {
    return { kind: "finalRef", ref: ref(record.writeStepId, "id") };
  }
  if (Object.hasOwn(record.identity, referencedField)) {
    const value = record.identity[referencedField];
    return isOperationValueReference(value)
      ? { kind: "finalRef", ref: value }
      : { kind: "literal", value };
  }
  const spelled = record.scalarData[referencedField];
  if (spelled === undefined || spelled === null || isSql(spelled)) {
    return undefined;
  }
  return { kind: "literal", value: spelled };
}

/**
 * PHASE 8.2, THE ORDERING CONJUNCT — may these arms be merged into one `WITH`?
 *
 * PostgreSQL runs a data-modifying `WITH` arm whose output nothing reads in an order
 * it does not specify; on PG 16 / PGlite it runs them LAST-TO-FIRST, so the sequence
 * hands its first value to the last-declared child. The multi-statement path runs
 * them in declaration order. The fold is therefore a divergence in PERSISTED state —
 * invisible in the operation's own answer, which is why nothing else here catches it —
 * unless the arms carry nothing an ordering can decide.
 *
 * The only thing this engine ever leaves for the database to decide is a SEQUENCE:
 * `assertApplicationGeneratedValues` (values-builder) makes every other `autoGenerate`
 * a materialized application value before a statement is built, and an ordinary
 * default is already a value in the row. So an absent auto-increment column is the
 * whole of it, and two conjuncts answer the question, both fail-closed:
 *
 *  · **Every arm is one this tree classified.** The metadata comes from walking the
 *    record tree the operation planned ({@link collectFoldArmSemantics}); a write no
 *    record and no `createMany` group produced is not in it, and an unclassified arm
 *    declines rather than being assumed harmless.
 *  · **At most ONE classified arm takes a database-assigned value.** Rows WITHIN one
 *    statement take theirs in that statement's own `VALUES` order, which is defined;
 *    it is only ACROSS arms that the order is the planner's to choose. One arm calling
 *    `nextval` is deterministic however the arms are ordered — two are not.
 *
 * It costs a statement, never an answer: `create: [{…}, {…}]` on a serial-keyed child
 * declines here and keeps the multi-statement path, while the same children through
 * `createMany` — one arm, one defined row order — still fold.
 */
interface FoldArmSemantics {
  readonly databaseAssigned: boolean;
  readonly targetTable: string;
  readonly statementSkipsDuplicates: boolean;
}

/**
 * P8/P9 review (blocking): PostgreSQL's conflict-skipping clause cannot see a tuple another
 * arm of the SAME command inserted — measured raw on PostgreSQL 16: two CTE arms
 * writing one table, one carrying the skip leaf, turn a succeeding create into a
 * `UniqueConstraintError` with NOTHING written, where the unfolded statements
 * skip the duplicate exactly as `skipDuplicates` promises. So a fold declines
 * when a skip-carrying arm shares its target table with ANY other arm (the root
 * included — a self-relation puts the root's tuple in the same blind spot). A
 * single skip arm with internal duplicates stays foldable: rows within one
 * statement see each other's conflicts.
 * The record plan owns these facts before SQL rendering. The fold therefore does
 * not infer query semantics from a dialect's statement text.
 */
function foldArmsAreOrderInsensitive(
  writes: readonly OperationStep[],
  semantics: ReadonlyMap<string, FoldArmSemantics>
): boolean {
  const armsPerTable = new Map<string, number>();
  const skipTables: string[] = [];
  let databaseAssigned = 0;
  for (const step of writes) {
    const arm = semantics.get(step.id);
    if (!arm) return false;
    armsPerTable.set(
      arm.targetTable,
      (armsPerTable.get(arm.targetTable) ?? 0) + 1
    );
    if (arm.statementSkipsDuplicates) skipTables.push(arm.targetTable);
    if (arm.databaseAssigned) databaseAssigned += 1;
  }
  return (
    databaseAssigned <= 1 &&
    !skipTables.some((table) => (armsPerTable.get(table) ?? 0) >= 2)
  );
}

/** Every write step {@link foldArmsAreOrderInsensitive} can classify. Walks the
 * record tree exactly as `emitRecord` emits it, so the two agree on which steps
 * exist. */
function collectFoldArmSemantics(
  plan: RecordPlan,
  into: Map<string, FoldArmSemantics>
): void {
  for (const arm of plan.parentHeldArms) {
    // The other parent-held kinds either write nothing (`connect-covered`) or plan a
    // probe, and a tree that probed has already declined on empty planning.
    if (arm.kind === "create") collectFoldArmSemantics(arm.before, into);
  }
  into.set(plan.writeStepId, {
    databaseAssigned: insertTakesDatabaseAssignedValue(plan.model, {
      ...plan.scalarData,
      ...plan.identity,
    }),
    targetTable: getTableName(plan.model),
    statementSkipsDuplicates: false,
  });
  for (const child of plan.childCreates) {
    collectFoldArmSemantics(child.record, into);
  }
  for (const group of plan.createManyGroups) {
    for (const [index, step] of group.steps.entries()) {
      into.set(step.id, {
        databaseAssigned: group.databaseAssigned[index]!,
        targetTable: group.targetTable,
        statementSkipsDuplicates: group.statementSkipsDuplicates,
      });
    }
  }
}

/** Whether this INSERT leaves a value for the DATABASE to assign — an auto-increment
 *  column the row does not spell, which is the only kind there is (see the sequence
 *  paragraph on {@link foldArmsAreOrderInsensitive}). */
function insertTakesDatabaseAssignedValue(
  model: Model<any>,
  row: Readonly<Record<string, unknown>>
): boolean {
  for (const fieldName of model["~"].scalarFieldNames) {
    const scalar = model["~"].state.scalars[fieldName];
    if (isMissingGeneratedIncrement(scalar, row[fieldName])) return true;
  }
  return false;
}

/**
 * E6.3 — every shared primary-key member must have taken its value FROM THE EDGE.
 *
 * Raised where the shared key's source is manufactured, so nothing downstream can read
 * a stand-in: a `s.string().id()` member arrives carrying an application-materialized
 * `ulid` default, and the arm's own foreign-key assignment overwrites that column, so a
 * later "is the member present?" test answers YES about a value the row never holds.
 * See {@link CreateOperation.resolveSharedPkIdentity} for the measurement and for what
 * the surviving sub-shape is.
 */
function assertSharedPkResolved(
  childScope: QueryScope,
  kind: string | undefined,
  relation: ParentHeldToOne,
  identity: Record<string, unknown>
): void {
  const relationName = relation.relationInfo.name;
  const recordPk = getPrimaryKeyFields(childScope.model);
  const shared = relation.foreignFields.filter((foreignField) =>
    recordPk.includes(foreignField)
  );
  if (shared.every((foreignField) => Object.hasOwn(identity, foreignField))) {
    return;
  }
  throw new UnsupportedOperationError(
    `query-engine-v2 create does not support a shared-primary-key ${kind} on relation '${relationName}' whose foreign key '${relation.foreignFields.join(", ")}' (this record's primary key) is not a compile-time literal.`
  );
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
 * cannot already be correlated, so this is a pure global reparent (ATOM “Relation-owner boundary”): plan
 * an uncorrelated existence probe, compile `UPDATE child SET fk = parent WHERE
 * unique`, pinned in batch by an `exists` guard. Absent → V1's verbatim
 * `Cannot connect …`. The parent value arrives as a ready {@link referenceSql}
 * assignment (Ref or literal), so it serves both a generated and a known parent id.
 *
 * P4 — one Part carries a whole key-shape GROUP of targets (`groupLinkTargets`),
 * so `connect: [a, b, c]` sends one `… WHERE key IN (a,b,c) FOR UPDATE` probe and
 * one `UPDATE … WHERE key IN (a,b,c)`. A one-target group keeps the arity-1
 * statements verbatim. The batch presence guards stay per target.
 */
interface ChildConnectContext {
  readonly engine: QueryEngine;
  readonly childScope: QueryScope;
  readonly childName: string;
  /** One key-shape group of connect targets, in input order. */
  readonly wheres: readonly Record<string, unknown>[];
  readonly txMode: boolean;
}

type ChildConnectConfig = ChildConnectContext &
  (
    | {
        readonly relation: ChildHeldToOne | ChildHeldToMany;
        readonly fkAssign: Record<string, unknown>;
      }
    | {
        readonly relation: BoundPolymorphicChildHeldRelation;
        readonly polymorphicStorage: Extract<
          PolymorphicStorageValue<FinalReferenceSource>,
          { kind: "linked" }
        >;
      }
  );

class ChildConnectPart implements Part {
  private readonly config: ChildConnectConfig;
  private readonly probeId: string;
  private readonly writeId: string;
  private readonly guardIds: readonly string[];
  private readonly distinctTargets: number;
  private readonly probe: ReadStep;

  private get relationName(): string {
    return this.config.relation.relationInfo.name;
  }

  constructor(scope: StepScope, config: ChildConnectConfig) {
    this.config = config;
    this.probeId = scope.allocate(`${config.childName}.find`);
    this.writeId = scope.allocate(`${config.childName}.connect`);
    this.guardIds = config.wheres.map(() =>
      scope.allocate(`${config.childName}.guard.exists`)
    );
    this.distinctTargets = countDistinctTargets(
      config.childScope,
      config.wheres
    );
    this.probe = {
      id: this.probeId,
      kind: "read",
      statement:
        config.wheres.length === 1
          ? buildFindUnique(config.childScope, {
              where: config.wheres[0]!,
              select: this.pkSelect(),
              forUpdate: config.txMode,
            })
          : buildFind(config.childScope, {
              where: this.groupSelector(),
              select: this.pkSelect(),
              forUpdate: config.txMode,
            }),
      outputs: { rows: { kind: "rows" } },
    };
  }

  planning(): readonly ReadStep[] {
    return [this.probe];
  }

  compile(_scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    const rows = known[planningKey(this.probeId, "rows")];
    // A complete unique key names at most one row, so the probe returns exactly
    // as many rows as there are DISTINCT targets that exist: fewer means one of
    // the named targets is absent. Same message, same attribution, same phase.
    if (!Array.isArray(rows) || rows.length < this.distinctTargets) {
      throw new NestedWriteError(
        relationTargetNotFound(this.config.relation.relationInfo, "connect"),
        this.relationName
      );
    }
    const steps: OperationStep[] = [];
    if (!this.config.txMode) {
      for (const [index, where] of this.config.wheres.entries()) {
        steps.push(
          presenceGuard(
            this.guardIds[index]!,
            buildFindUnique(this.config.childScope, {
              where,
              select: this.pkSelect(),
            }),
            nestedWriteFailure(
              relationTargetNotFound(
                this.config.relation.relationInfo,
                "connect"
              ),
              this.relationName,
              false
            )
          )
        );
      }
    }
    const polymorphicStorage = this.resolvedPolymorphicStorage(known);
    const data = "fkAssign" in this.config ? this.config.fkAssign : {};
    steps.push({
      id: this.writeId,
      kind: "write",
      statement:
        this.config.wheres.length === 1
          ? buildUpdate(this.config.childScope, {
              where: this.config.wheres[0]!,
              data,
              ...(polymorphicStorage ? { polymorphicStorage } : {}),
              select: this.pkSelect(),
            })
          : buildUpdateMany(this.config.childScope, {
              where: this.groupSelector(),
              data,
              ...(polymorphicStorage ? { polymorphicStorage } : {}),
            }),
      outputs: {},
    });
    return steps;
  }

  private groupSelector(): Record<string, unknown> {
    return linkGroupSelector(this.config.childScope, this.config.wheres);
  }

  private pkSelect(): Record<string, boolean> {
    return Object.fromEntries(
      getPrimaryKeyFields(this.config.childScope.model).map((f) => [f, true])
    );
  }

  private resolvedPolymorphicStorage(
    known: PlanningKnown
  ): readonly PolymorphicStorageValue<unknown>[] | undefined {
    if (!("polymorphicStorage" in this.config)) {
      return undefined;
    }
    return [
      resolvePolymorphicStorageValue(
        this.config.engine,
        this.config.polymorphicStorage,
        known,
        "connect"
      ),
    ];
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
