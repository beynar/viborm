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
import { directPolymorphicMembership } from "../builders/polymorphic-relation";
import {
  type BoundRelation,
  bindRelation,
  buildConnectSubqueryForField,
  type ChildHeldRelation,
  hasPolymorphicMembership,
  type OrdinaryChildHeldRelation,
  type ParentHeldRelation,
  type PolymorphicChildHeldRelation,
} from "../builders/relation-data-builder";
import {
  buildParsedRelationPrograms,
  type ParsedRecordPrograms,
  type ParsedRelationMutation,
  type RecordMutationData,
  type RelationMutationEntry,
  type RelationMutationProgram,
} from "../builders/relation-mutation-parser";
import { buildInsert, buildValueGroups } from "../builders/values-builder";
import {
  createQueryScope,
  getColumnName,
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
  compileMutationDependencyFold,
} from "../operations";
import { assertPortableCreateManySkip } from "../operations/create-many-portability";
import {
  databaseAssignedRowKeyFields,
  planNestedCreateIdentity,
} from "../operations/mutation-identity";
import type { QueryEngine } from "../query-engine";
import { ResultParser } from "../result/ResultParser";
import type { QueryScope, RelationRef, SelectedVariantRow } from "../types";
import {
  type CreateRacePin,
  createDataSpellsRacePin,
  createRacePin,
} from "./create-race-pin";
import {
  buildFreshRecordSeriesPart,
  createManyCarriesRelations,
} from "./FreshRecordSeriesPart";
import {
  assignmentIdentityFromFieldValue,
  assignmentIdentityFromScalar,
  FinalRootAssignmentTruth,
} from "./final-root-assignment";
import {
  exactlyOneRow,
  nestedWriteFailure,
  presenceGuard,
  queryFailure,
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
  type GuardStep,
  isOperationValueReference,
  type OperationFragment,
  type OperationStep,
  type OperationValueReference,
  type PlanningFragment,
  type ReadStep,
  ref,
  type StatementOutputSource,
  type StatementStep,
  type WriteStep,
} from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { planningKey } from "./Part";
import { buildPolymorphicCollectionPart } from "./PolymorphicCollectionPart";
import { parseValidated } from "./parse-boundary";
import {
  buildRecordUpdateCompiler,
  type RecordCompilerSeam,
} from "./RecordUpdateCompiler";
import { buildJunctionParts } from "./RelationJunctionPart";
import {
  buildJunctionToOneParts,
  isSingularCollectionInverse,
} from "./RelationJunctionToOnePart";
import {
  buildConnectOrCreateParts,
  buildToManyUpsertParts,
} from "./RelationUpsertPart";
import type { SeriesRootConflictDisposition } from "./record-series";
import {
  applyRootMembershipAssignment,
  bindRelationMembership,
  type FinalReferenceSource,
  type ForeignKeyMember,
  fkEquals,
  foreignKeyWriteValue,
  linkedPolymorphicStorage,
  lowerMembershipWrite,
  pairForeignKeyMembers,
  type RelationMembershipBinding,
  type RootMembershipAssignment,
  resolvePolymorphicStorageValue,
} from "./relation-membership";
import { StepScope } from "./StepScope";
import {
  capturedSelectorWhere,
  createDataUniqueWhere,
  getStepModelName,
  isRecord,
  projectionNamesNoRelation,
  projectionReadsAnyTable,
  projectionReadsMutatedModel,
  type SubOperationOptions,
  selectExecutionMode,
  UnsupportedOperationError,
} from "./shared";
import { completeTargetPresenceGuard } from "./target-projection";

type ExecutionMode = "transaction" | "batch";

export interface FreshRecordPart extends Part {
  readonly rootWriteId: string;
  readonly seriesRootConflict: SeriesRootConflictDisposition | undefined;
  rootReferenced(field: string): FinalReferenceSource | undefined;
  /**
   * The DEMANDING half of {@link FreshRecordPart.rootReferenced}, for the one
   * consumer whose edge cannot proceed without the value: an update root's
   * before-root parent-held target (residual plan §G3). Refusing here rather than
   * at the caller is what keeps "a fresh record cannot publish the referenced
   * column this edge needs" one decision — the subtree knows what its own INSERT
   * can publish, and the enclosing family only names the position.
   */
  requireRootReferenced(
    field: string,
    relationName: string
  ): FinalReferenceSource;
  rootRowKey(): Readonly<Record<string, FinalReferenceSource>>;
}

export interface FreshRecordInput {
  readonly childScope: QueryScope;
  readonly data: RecordMutationData;
  readonly incomingMembership?: RelationMembershipBinding;
  readonly relationName: string;
  readonly racePin?: CreateRacePin;
  readonly skipDuplicates?: boolean;
}

export type FreshRecordBuilder = (
  scope: StepScope,
  input: FreshRecordInput
) => FreshRecordPart;

/** Build one nested non-bulk fresh record through the create compiler. */
export function buildFreshRecordPart(
  scope: StepScope,
  engine: QueryEngine,
  input: FreshRecordInput
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
        skipDuplicates: input.skipDuplicates,
      },
    }
  );
  return {
    planning: () => operation.planning().steps,
    compile: (_scope, known) => operation.compile(known).steps,
    get rootWriteId() {
      return operation.rootWriteStepId;
    },
    get seriesRootConflict() {
      return operation.seriesRootConflict;
    },
    rootReferenced: (field) => operation.freshRootReferenced(field),
    requireRootReferenced: (field, relationName) =>
      operation.requireFreshRootReferenced(field, relationName),
    rootRowKey: () => operation.freshRootRowKey(),
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
/**
 * How a batch guard re-asserts the target its planning probe found.
 *
 * `precompiled` is the ordinary shape: the selector the payload spelled is complete on
 * its own, so the statement is built once at construction. `captured` is the shape a
 * DIRECT POLYMORPHIC connect needs: its target is named by a discriminator beside a
 * referenced value, and the exact value only exists once the probe has published it —
 * so the statement is rebuilt at emit from the captured row. One kept difference, one
 * field; never two arms.
 */
type CapturedGuard =
  | { readonly kind: "precompiled"; readonly probe: Sql }
  | {
      readonly kind: "captured";
      readonly fields: readonly string[];
      readonly where: Record<string, unknown>;
      readonly forUpdate: boolean;
    };

/** Create-local refinement for selected FK provenance and consumed publication.
 * The central assignment union owns storage only; these facts exist solely while
 * one fresh INSERT is assembled. */
type CreateRootAssignment =
  | Extract<RootMembershipAssignment, { kind: "polymorphic" }>
  | (Extract<RootMembershipAssignment, { kind: "foreignKey" }> & {
      readonly members?: readonly ForeignKeyMember[];
      readonly publishedFields?: ReadonlySet<string>;
      readonly relationName?: string;
    });

type ParentHeldArm =
  | {
      readonly kind: "connect-covered";
      readonly assignment: CreateRootAssignment;
    }
  | {
      readonly kind: "connect-probe";
      readonly relationRef: RelationRef;
      readonly guardId: string;
      readonly probeId: string;
      readonly guard: CapturedGuard;
      readonly assignment: CreateRootAssignment;
    }
  | {
      readonly kind: "create";
      readonly before: RecordPlan;
      /** The before-parent target's referenced value (a `Ref` or literal), assigned
       *  to whichever storage this membership holds. */
      readonly assignment: CreateRootAssignment;
    }
  | {
      readonly kind: "connectOrCreate";
      readonly relationRef: RelationRef;
      readonly probeId: string;
      readonly guardId: string;
      readonly guard: CapturedGuard;
      /** Found arm: the connect target's referenced literal. */
      readonly foundAssignment: CreateRootAssignment;
      /** Missing arm: the before-parent target create, and its `Ref`. */
      readonly before: RecordPlan;
      readonly missingAssignment:
        | CreateRootAssignment
        | {
            readonly kind: "deferredForeignKey";
            readonly relation: ParentHeldRelation;
            readonly publishedFields: ReadonlySet<string>;
          };
      /** Withheld (`undefined`) when the selector could not establish the missing
       *  premise — see {@link createRacePin}. A `connectOrCreate` selector is strict,
       *  so today this is always present here; the type admits the withholding
       *  because the one function that mints the pin owns that decision. */
      readonly racePin: CreateRacePin | undefined;
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
  readonly incomingMembership?: RelationMembershipBinding;
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

type CreateManyWork =
  | { readonly kind: "group"; readonly group: CreateManyGroup }
  | { readonly kind: "series"; readonly part: Part };

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
  /** Exact values supplied by a selected parent-held relation tuple. */
  readonly relationSuppliedValues: Record<string, unknown>;
  /** Scalar fields the payload supplied; materialized defaults are not requests. */
  readonly explicitScalarFields: ReadonlySet<string>;
  /** Explicit alternate unique used only when generated row keys need a focused read. */
  readonly postWriteLocator?: Readonly<Record<string, unknown>>;
  /** Row-key members whose values this INSERT leaves for the database to assign. */
  readonly databaseAssigned: readonly string[];
  /** Known row-key values; database-assigned members are absent here. */
  readonly identity: Record<string, unknown>;
  readonly writeStepId: string;
  readonly parentHeldArms: readonly ParentHeldArm[];
  readonly childCreates: readonly ChildCreate[];
  readonly createManyWork: readonly CreateManyWork[];
  readonly afterParts: readonly Part[];
}

interface EmittedRecordData {
  readonly data: Record<string, unknown>;
  readonly effectiveScalarValues: Readonly<Record<string, unknown>>;
  readonly polymorphicStorage: readonly PolymorphicStorageValue<unknown>[];
  readonly consumedValues: Readonly<Record<string, unknown>>;
}

/** The record identity a child edge resolves its FK value against. */
interface RecordIdentity {
  readonly writeStepId: string;
  readonly identity: Record<string, unknown>;
  readonly databaseAssigned: readonly string[];
  readonly model: Model<any>;
  /**
   * The record's own scalar assignments, so a child edge referencing a
   * NON-primary-key column of this fresh record can read the value the record's INSERT
   * is about to write. The primary key is the identity; a referenced unique is still
   * part of what this fresh row IS.
   */
  readonly scalarData: Record<string, unknown>;
  /** Selected relation values stay separate so explicit scalar provenance survives. */
  readonly relationSuppliedValues: Record<string, unknown>;
  /** Explicit alternate unique used only when generated row keys need a focused read. */
  readonly postWriteLocator?: Readonly<Record<string, unknown>>;
}

/**
 * What selected parent-held edges contribute to a fresh record. Every exact
 * construction-time FK value remains available to later nested references; only
 * row-key overlap reserves dynamic selected-arm publication and contributes to
 * the record identity.
 */
interface SharedPkIdentity {
  readonly identity: Record<string, unknown>;
  /** Exact construction-time values supplied by selected relation tuples. */
  readonly suppliedValues: Record<string, unknown>;
  /** relation name → the pre-allocated before-parent INSERT step id. */
  readonly producedBy: ReadonlyMap<string, string>;
  /** Relation name → complete FK tuple supplied by its selected arm. */
  readonly selectedBy: ReadonlyMap<string, ReadonlySet<string>>;
}

function explicitCreateScalarFields(
  model: Model<any>,
  source: Readonly<Record<string, unknown>> | undefined
): ReadonlySet<string> {
  return new Set(
    Object.keys(source ?? {}).filter(
      (field) =>
        source?.[field] !== undefined &&
        Object.hasOwn(model["~"].state.scalars, field)
    )
  );
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

  /** The canonical top-level payload, read only by public query interception. */
  get validatedArgs(): Record<string, unknown> {
    return this.inspectionArgs;
  }

  private readonly engine: QueryEngine;
  private readonly inspectionArgs: Record<string, unknown>;
  private readonly model: Model<any>;
  private readonly scope: StepScope;
  private readonly resultArgs: Record<string, unknown>;
  /** Internal series members publish exact row keys, even when public decimal
   * decoding deliberately requests the legacy lossy number representation. */
  private readonly resultDecimalDecode: "string" | "number";
  private readonly root: RecordPlan;
  private readonly parsedSelect: Record<string, unknown> | undefined;
  private readonly parsedInclude: Record<string, unknown> | undefined;
  private readonly terminalId: string;
  private readonly planningSteps: StatementStep[] = [];
  private readonly registeredParts = new Set<Part>();
  /**
   * F1 — demand-driven record-field publication (§4.3). One record INSERT's step id
   * maps to the fields some consumer asked that INSERT to publish. The generated
   * primary key was the only publishable field before F; any DATABASE-PRODUCED
   * referenced column is publishable now, and the entry is written ONLY by
   * {@link CreateOperation.producedReference}. `buildInsertStep` reads it at compile,
   * after every descendant and junction consumer has registered — so the output set is
   * minimal by construction rather than by a second pass.
   *
   * TWO registrars reach `producedReference`, and both are named here because a reader
   * looking for "who can demand a field" must find the whole answer in one place:
   * {@link CreateOperation.recordReferenced} — the seam behind every `rootReferenced`
   * call — and {@link CreateOperation.resolveSharedPkIdentity}, which must register
   * BEFORE the target's record plan exists (it runs at the arm scan, and `buildRecord`
   * builds that plan afterwards) and therefore cannot go through the record seam.
   */
  private readonly publishedFields = new Map<string, Set<string>>();
  /**
   * F3 — the ONE post-insert read that publishes every demanded field of a record
   * whose substrate cannot RETURNING them, keyed by that record's INSERT step id.
   * One entry per record, so the keep gate's "at most one post-insert read per root"
   * holds by construction and not by inspection.
   */
  private readonly publishReads = new Map<
    string,
    { readonly stepId: string; readonly fields: Set<string> }
  >();
  private compiledRootScalarValues:
    | Readonly<Record<string, unknown>>
    | undefined;
  /** The single-step `INSERT … RETURNING select` fold, when eligible. */
  private readonly foldStep: WriteStep | undefined;
  /** X1b — a nested fresh subtree emits no terminal read (the enclosing op owns
   *  the result) and injects the located parent's FK into its root INSERT. */
  private readonly suppressTerminal: boolean;
  /** A root-series member whose root conflict suppresses its complete subtree. */
  private readonly rootSkipDuplicates: boolean;
  private readonly incomingMembership: RelationMembershipBinding | undefined;
  /** The enclosing adopt arm's raceable missing-premise pin, carried by this
   *  subtree's ROOT record INSERT (the statement that was the arm's own create leaf
   *  before the arm became a subtree). */
  private readonly rootRacePin: CreateRacePin | undefined;
  private readonly armLegalityChecks: (() => void) | undefined;
  /** The adopt family's fresh-arm seam. Its caller supplies the record scope so
   *  a data-dependent record-series member keeps one allocator for its complete
   *  subtree instead of borrowing the enclosing record's allocator. */
  private readonly createFresh: FreshRecordBuilder = (scope, input) =>
    buildFreshRecordPart(scope, this.engine, input);
  /** E3 — the adopt family's whole seam: the fresh CREATE arm above, plus the
   *  located UPDATE arm's deeper child Parts. Arrow fields, so this binds lazily
   *  and field-initializer order does not matter. */
  private readonly recordCompilers: RecordCompilerSeam = {
    createFresh: (scope, input) => this.createFresh(scope, input),
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
    this.resultDecimalDecode = options.parsedRoot
      ? "string"
      : engine.decimalDecode;
    this.suppressTerminal = nestedFresh !== undefined;
    this.rootSkipDuplicates =
      options.parsedRoot?.skipDuplicates === true ||
      nestedFresh?.skipDuplicates === true;
    this.incomingMembership = nestedFresh?.incomingMembership;
    this.rootRacePin = nestedFresh?.rootRacePin ?? options.rootRacePin;

    let data: RecordMutationData;
    if (nestedFresh) {
      data = nestedFresh.data;
      this.inspectionArgs = nestedFresh.data.parsed;
      this.parsedInclude = undefined;
      this.parsedSelect = undefined;
      this.resultArgs = {};
    } else if (options.parsedRoot) {
      // J3 — an independent root whose row the enclosing `createMany` args schema
      // already validated (each row is parsed exactly once, §5.1). Only the parse is
      // replaced: this operation keeps its terminal read, its own-write preflight,
      // and its result parse, because it IS a root — see `SubOperationOptions`.
      data = options.parsedRoot.data;
      this.inspectionArgs = options.parsedRoot.data.parsed;
      this.parsedInclude = undefined;
      this.parsedSelect = options.parsedRoot.select;
      this.resultArgs = { select: this.parsedSelect };
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
      this.inspectionArgs = parsedArgs;
      data = {
        parsed: parsedArgs.data,
        source: isRecord(args.data) ? args.data : undefined,
      };
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

    const parent = createQueryScope(engine, model);
    // Own-write preflight (ATOM “OwnWrite legality”): reject any payload whose nested decision
    // reads depend on this operation's own writes, before planning. As an upsert
    // create arm — or a nested fresh subtree — the caller runs this per-arm / on
    // the whole enclosing tree, so it is skipped here (V1 checks it inside the
    // whenFalse branch only; a nested subtree's own-write is covered by the
    // enclosing operation's whole-tree walk).
    const parsedData = buildParsedRelationPrograms(
      parent,
      data.parsed,
      data.source
    );
    const assertOwnWrite = () => {
      assertCreateOwnWriteSafety(
        parent,
        parsedData.scalarData,
        parsedData.relations
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
      this.root.createManyWork.length === 0 &&
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
      !(this.suppressTerminal || this.rootSkipDuplicates) &&
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
            ...(this.rootRacePin &&
            createDataSpellsRacePin(this.root.scalarData, this.rootRacePin)
              ? { racePin: this.rootRacePin.pin }
              : {}),
            ...(txMode ? { expects: exactlyOneRow(terminalFailure()) } : {}),
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

  /**
   * Residual §G3 — the same question asked by the one consumer that cannot carry on
   * without an answer, so the refusal is this operation's rather than a second
   * limitation constructed at the update root with the identical invariant. The
   * `beforeRootTarget` position exists only to keep the enclosing family's noun in
   * the sentence; the decision is {@link CreateOperation.requireRecordReferenced}'s,
   * exactly as it already is for the create root's own before-parent target.
   */
  requireFreshRootReferenced(
    referencedField: string,
    relationName: string
  ): FinalReferenceSource {
    return this.requireRecordReferenced(
      this.root,
      referencedField,
      relationName,
      "beforeRootTarget"
    );
  }

  /** Publish every member of this fresh record's complete row key. */
  freshRootRowKey(): Readonly<Record<string, FinalReferenceSource>> {
    const rowKey: Record<string, FinalReferenceSource> = {};
    for (const field of getPrimaryKeyFields(this.root.model)) {
      const source = this.recordReferenced(this.root, field);
      if (!source) {
        throw new QueryEngineError(
          `query-engine-v2 internal: fresh row-key field '${field}' was neither known nor database-assigned.`
        );
      }
      rowKey[field] = source;
    }
    return rowKey;
  }

  /** Parsed scalar values of the fresh root, exposed without reparsing for an
   * enclosing owner's provenance comparison. */
  freshRootScalarValues(): Readonly<Record<string, unknown>> {
    return this.compiledRootScalarValues ?? this.root.scalarData;
  }

  planning(): PlanningFragment {
    if (this.foldStep) return { steps: [] };
    return {
      steps: this.planningSteps,
    };
  }

  assertArmLegality(): void {
    this.armLegalityChecks?.();
  }

  compile(known: Readonly<Record<string, unknown>>): OperationFragment {
    this.compiledRootScalarValues = undefined;
    if (this.foldStep) {
      return {
        steps: [this.foldStep],
        outputs: { result: ref(this.root.writeStepId, "result") },
      };
    }
    // A result-producing non-folded create must later address the exact row it
    // inserted. Register every database-assigned row-key member only after an
    // enclosing conditional owner has selected this arm, but before emitRecord
    // constructs the INSERT and fixes its outputs. Nested fresh parts register
    // only the fields their enclosing operation requests.
    if (!this.suppressTerminal) this.freshRootRowKey();
    const guards: OperationStep[] = [];
    const writes: OperationStep[] = [];
    // X1b — the located parent's FK is folded into the root record's INSERT
    // (resolved here at compile: a literal constant, or a planned locate-row value).
    const incoming = this.incomingMembership
      ? lowerMembershipWrite(
          this.engine,
          createQueryScope(this.engine, this.model),
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
      incoming.polymorphicStorage,
      this.incomingMembership
    );
    this.compiledRootScalarValues = rootInsertData.effectiveScalarValues;
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
   *  · **Every value that flows between the statements has an in-statement
   *    spelling** ({@link compileMutationDependencyFold}, plan §4.5). A `WITH`
   *    gives every arm the same snapshot, so an arm cannot read what a sibling
   *    wrote by re-reading the table — but it CAN read the sibling's `RETURNING`
   *    relation, and that is the channel a child INSERT needing the parent's
   *    DATABASE-generated key travels. The lowerer replaces each
   *    `OperationValueReference` in an arm's `Sql.values` with
   *    `(SELECT <column> FROM <producing arm>)`; a reference it cannot spell —
   *    a producer outside the fold, a producer that is not strictly earlier, an
   *    output that is not a `firstRowField` — returns `undefined` and this fold
   *    declines. A tree whose keys are all literals (supplied, or materialized
   *    by a `ulid`/`cuid`/`uuid` default at the parse boundary) reaches the
   *    lowerer with nothing to do and keeps its arms byte-identical.
   *    After lowering, the merged statement holds no `OperationValueReference`
   *    at all, which is what keeps the folded step on the statement-atomic path.
   *  · **No step carries an effect the merge would drop.** A `skip` effect needs
   *    a savepoint scope one statement has not got, and a per-step `expects` is a
   *    JS check on a result that stops existing once the steps are one.
   *  · **An enclosing race fact is known before folding.** The root INSERT already
   *    carries its pin. A fold keeps it only when no descendant writes the same
   *    table, so a descendant violation cannot be mistaken for the root race.
   *  · **The arms do not care what order they run in** ({@link foldArmsAreOrderInsensitive}).
   *    The multi-statement path runs them in declaration order; PostgreSQL runs
   *    unread data-modifying `WITH` arms in an order it does not specify, and on
   *    PG 16 it runs them LAST-TO-FIRST. Nothing the emitter can spell pins that,
   *    so the fold must only merge arms whose outcome the order cannot change.
   *  · **A snapshot-safe root projection.** The sibling arms' effects are invisible
   *    to the outer SELECT for exactly the snapshot reason above. A projection may
   *    read an untouched relation, but it must not reach any table this tree writes.
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
    const parent = createQueryScope(this.engine, this.model);
    const mutatedTables = new Set(
      statementWrites.flatMap((step) => {
        const arm = semantics.get(step.id);
        return arm ? [arm.targetTable] : [];
      })
    );
    const projectionIsSnapshotSafe = !projectionReadsAnyTable(
      createQueryScope(this.engine, this.model),
      this.parsedSelect,
      this.parsedInclude,
      mutatedTables
    );
    const rootRacePin = rootWrite?.racePin;
    const rootRaceIsAttributable =
      rootRacePin === undefined ||
      siblings.every(
        (step) => semantics.get(step.id)?.targetTable !== rootRacePin.table
      );
    const foldable =
      !this.rootSkipDuplicates &&
      this.engine.adapter.capabilities.supportsCteWithMutations &&
      this.engine.adapter.capabilities.supportsReturning &&
      projectionIsSnapshotSafe &&
      this.planningSteps.length === 0 &&
      guards.length === 0 &&
      siblings.length > 0 &&
      statementWrites.length === writes.length &&
      rootWrite?.id === this.root.writeStepId &&
      foldArmsAreOrderInsensitive(writes, semantics) &&
      rootRaceIsAttributable &&
      statementWrites.every(
        (step) =>
          isSql(step.statement) && !(step.expects || step.onUniqueConflict)
      );
    if (!foldable) return undefined;
    // Offer the arms to the dependency lowerer, which spells each
    // `OperationValueReference` as the producing arm's CTE column. `undefined`
    // is every reference it cannot spell, and the caller's multi-statement
    // fragment is returned untouched. The root's rebuilt INSERT below carries no
    // reference the lowerer did not see: it is built from the same
    // `rootInsertData` as `statementWrites[0]`, whose values the lowerer read.
    const armStatements = compileMutationDependencyFold(
      parent,
      statementWrites
    );
    if (!armStatements) return undefined;
    return {
      id: this.root.writeStepId,
      kind: "write",
      statement: buildMutationProjectionFold(parent, {
        mutation: buildInsertStatement(
          parent,
          rootInsertData.data,
          rootInsertData.polymorphicStorage
        ),
        siblings: armStatements,
        ...(this.parsedSelect ? { select: this.parsedSelect } : {}),
        ...(this.parsedInclude ? { include: this.parsedInclude } : {}),
      }),
      outputs: { result: { kind: "rows" } },
      ...(rootRacePin ? { racePin: rootRacePin } : {}),
      ...(this.mode === "transaction"
        ? { expects: exactlyOneRow(terminalFailure()) }
        : {}),
    };
  }

  parse<T>(outputs: Readonly<Record<string, unknown>>): T {
    if (!Object.hasOwn(outputs, "result")) {
      throw new QueryEngineError(
        "query-engine-v2 create did not expose its result."
      );
    }
    return new ResultParser(
      this.engine,
      this.model,
      this.engine.driver,
      this.resultDecimalDecode
    ).parse<T>("create", outputs.result, this.resultArgs);
  }

  /** The step id of the root parent INSERT — the write an enclosing upsert create
   *  arm annotates with its raceable missing-premise `racePin` (T3c). */
  get rootWriteStepId(): string {
    return this.root.writeStepId;
  }

  /** Exact series-only root-conflict disposition. Descendant writes never expose it. */
  get seriesRootConflict(): SeriesRootConflictDisposition | undefined {
    return this.rootSkipDuplicates
      ? { kind: "skipDuplicate", rootWriteId: this.root.writeStepId }
      : undefined;
  }

  /**
   * The step id of a write this operation is CERTAIN to emit before its root
   * INSERT — read from the parsed shape alone, with nothing compiled and nothing
   * probed — or `undefined` when the shape declares none.
   *
   * WHO ASKS AND WHY (plan §9.6, "before member zero"). A progressive record
   * series preflights every member it can COMPILE, and the compiled fragment is
   * where a prior effect before a skippable root is normally seen. A member whose
   * planning phase is non-empty cannot be compiled at preflight — compiling it
   * needs planning outputs that only that member's own turn can read — so its
   * refusal would otherwise arrive after earlier members had committed. This
   * getter is what such a member can still be asked, and its only claim is the
   * one the parse already settled.
   *
   * EXACT, NEVER OPTIMISTIC, in both directions:
   *
   *  · A parent-held `create` arm ALWAYS writes before the root INSERT
   *    ({@link emitRecord} step 1), and a record carrying one never folds — the
   *    fold requires no parent-held arms at all, and is refused outright under
   *    `skipDuplicates`. So a declared id is a step id the compiled fragment
   *    will really carry, and this reader can never refuse a shape that would
   *    have compiled clean.
   *  · A parent-held `connectOrCreate` is deliberately NOT declared: it writes
   *    before the root only on the arm its probe selects, so declaring it would
   *    refuse the found-arm program that runs correctly today. That shape stays
   *    with the compiled reader, which sees the arm actually chosen.
   *
   * The id names the FIRST such write: a before-parent create emits its own
   * before-parent creates first, so the recursion descends before it answers.
   */
  get declaredPreRootWriteId(): string | undefined {
    return declaredPreRootWriteId(this.root);
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
    data: RecordMutationData,
    txMode: boolean,
    presetWriteStepId?: string,
    parsedData: ParsedRecordPrograms = buildParsedRelationPrograms(
      childScope,
      data.parsed,
      data.source
    )
  ): RecordPlan {
    const model = childScope.model;
    const recordName = getStepModelName(model, "record");
    const explicitScalarFields = explicitCreateScalarFields(model, data.source);
    const postWriteLocator = createDataUniqueWhere(
      model,
      parsedData.scalarData,
      explicitScalarFields
    );
    let reservedWriteStepId = presetWriteStepId;
    const reserveWriteStepId = (): string => {
      reservedWriteStepId ??= this.scope.allocate(`${recordName}.create`);
      return reservedWriteStepId;
    };
    // A record whose primary key is also its foreign key takes that identity from the
    // edge, not from scalar data. Resolve it before planning the record so the terminal
    // read addresses the inserted row; unresolved sources fail at that ownership seam.
    const sharedPk = this.resolveSharedPkIdentity(
      childScope,
      parsedData.relations,
      reserveWriteStepId
    );
    const { identity, databaseAssigned } = planNestedCreateIdentity(model, {
      ...parsedData.scalarData,
      ...sharedPk.suppliedValues,
      ...sharedPk.identity,
    });
    const scalarData = { ...parsedData.scalarData };
    for (const field of databaseAssigned) delete scalarData[field];

    const writeStepId = reserveWriteStepId();
    const self: RecordIdentity = {
      writeStepId,
      identity,
      databaseAssigned,
      model,
      scalarData,
      relationSuppliedValues: sharedPk.suppliedValues,
      ...(postWriteLocator ? { postWriteLocator } : {}),
    };

    const parentHeldArms: ParentHeldArm[] = [];
    const childCreates: ChildCreate[] = [];
    const createManyWork: CreateManyWork[] = [];
    const afterParts: Part[] = [];

    // The before-parent coverage ledger: every parent-held `create`
    // (and connectOrCreate — which guarantees the target exists after the
    // before-parent phase) in THIS record's arms is an unconditional witness a
    // sibling `connect` can adopt without a probe. Computed before interpreting the
    // arms so coverage is order-insensitive, exactly as V1's group-0 analysis.
    const coverage = this.beforeParentCoverage(
      childScope,
      parsedData.relations
    );

    for (const parsed of parsedData.relations) {
      // A create input spells no `disconnect`, so a targetless polymorphic
      // disconnect has no route into this record; it is skipped here exactly as it
      // was invisible to the former program map. Refusing it would be a new refusal
      // on a shape with no public spelling.
      if (parsed.kind === "polymorphicDisconnect") continue;
      if (parsed.kind === "polymorphicCollection") {
        // NEVER a `parentHeldArm`: a collection stores nothing on the owner's
        // row, so it has no before-parent phase to join — its member rows can
        // only be written once this record's key exists.
        afterParts.push(
          this.buildCollectionPart(childScope, self, parsed, txMode)
        );
        continue;
      }
      const { name: relationName, program } = parsed;
      if (parsed.kind === "polymorphicTarget") {
        this.interpretPolymorphicRelation({
          childScope,
          self,
          program,
          edge: parsed.edge,
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
        selectedSharedPkFields: sharedPk.selectedBy.get(relationName),
        relation: bindRelation(childScope, program.relationRef),
        program,
        txMode,
        coverage,
        parentHeldArms,
        childCreates,
        createManyWork,
        afterParts,
      });
    }

    this.registerPlanning(
      createManyWork.flatMap((work) =>
        work.kind === "series" ? [work.part] : []
      )
    );
    this.registerPlanning(afterParts);

    return {
      model,
      childScope,
      scalarData,
      relationSuppliedValues: sharedPk.suppliedValues,
      explicitScalarFields,
      ...(postWriteLocator ? { postWriteLocator } : {}),
      databaseAssigned,
      identity,
      writeStepId,
      parentHeldArms,
      childCreates,
      createManyWork,
      afterParts,
    };
  }

  private interpretPolymorphicRelation(input: {
    readonly childScope: QueryScope;
    readonly self: RecordIdentity;
    readonly program: RelationMutationProgram;
    readonly edge: SelectedVariantRow;
    readonly txMode: boolean;
    readonly coverage: readonly CreatedTarget[];
    readonly parentHeldArms: ParentHeldArm[];
  }): void {
    const relationName = input.edge.ref.name;
    const entry = input.program.entries[0];
    if (!(entry && input.program.entries.length === 1)) {
      throw new QueryEngineError(
        `query-engine internal: direct polymorphic relation '${relationName}' requires one target operation.`
      );
    }
    const childScope = createQueryScope(
      this.engine,
      input.edge.member.targetModel
    );
    if (entry.kind === "create") {
      const createData = entry.items[0];
      if (!createData) {
        throw new QueryEngineError(
          `query-engine internal: polymorphic create on relation '${relationName}' has no item.`
        );
      }
      const before = this.buildRecord(childScope, createData, input.txMode);
      // The direct-polymorphic arm asks the publication owner
      // the same question its three ordinary siblings do. The sentence it used to
      // build inline said `query-engine` where they say `query-engine-v2`; nothing
      // pinned that difference and it was not a distinction.
      const source = this.requireRecordReferenced(
        before,
        input.edge.member.referencedField,
        relationName,
        "beforeParentTarget"
      );
      input.parentHeldArms.push({
        kind: "create",
        before,
        assignment: {
          kind: "polymorphic",
          storage: linkedPolymorphicStorage(
            directPolymorphicMembership(input.edge),
            source
          ),
        },
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
        input.edge.member.referencedField
      );
      if (!missingSource) {
        // ONE SENTENCE, TWO CLASSES — the estate's oldest instance of it, and the
        // one instance the guard census left unresolved. This is the `connectOrCreate` twin of
        // the `create` arm above: same position, same question, same words, but an
        // engine-fault class instead of a refusal. It shares the owner's message
        // builder so the two cannot drift again; it does not share the owner's
        // THROW, because reclassifying a shipped error owes a behavioral witness of
        // the shape (this file's census-discipline rule), and no test reaches either
        // polymorphic position today. Whoever writes that witness converts this.
        throw new QueryEngineError(
          unresolvedFreshReferenceMessage(
            "beforeParentTarget",
            input.edge.member.referencedField,
            relationName
          )
        );
      }
      const childName = getStepModelName(
        input.edge.member.targetModel,
        relationName
      );
      const probeId = this.scope.allocate(`${childName}.find`);
      const guardId = this.scope.allocate(`${childName}.guard.exists`);
      const guardField = input.edge.member.referencedField;
      const select = { [guardField]: true };
      input.parentHeldArms.push({
        kind: "connectOrCreate",
        relationRef: input.edge.ref,
        probeId,
        guardId,
        guard: {
          kind: "captured",
          fields: [guardField],
          where: spec.where,
          forUpdate: false,
        },
        before,
        foundAssignment: {
          kind: "polymorphic",
          storage: linkedPolymorphicStorage(
            directPolymorphicMembership(input.edge),
            {
              kind: "planningField",
              step: probeId,
            }
          ),
        },
        missingAssignment: {
          kind: "polymorphic",
          storage: linkedPolymorphicStorage(
            directPolymorphicMembership(input.edge),
            missingSource
          ),
        },
        racePin: createRacePin(childScope, spec.where),
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
      this.connectIsCovered(
        input.coverage,
        input.edge.member.targetModel,
        where,
        [input.edge.member.referencedField]
      )
    ) {
      input.parentHeldArms.push({
        kind: "connect-covered",
        assignment: {
          kind: "polymorphic",
          storage: this.polymorphicConnectAssignment(
            input.childScope,
            input.edge,
            where
          ),
        },
      });
      return;
    }
    const childName = getStepModelName(
      input.edge.member.targetModel,
      relationName
    );
    const probeId = this.scope.allocate(`${childName}.find`);
    const guardId = this.scope.allocate(`${childName}.guard.exists`);
    const guardField = input.edge.member.referencedField;
    const select = { [guardField]: true };
    input.parentHeldArms.push({
      kind: "connect-probe",
      relationRef: input.edge.ref,
      probeId,
      guardId,
      guard: {
        kind: "captured",
        fields: [guardField],
        where,
        forUpdate: true,
      },
      assignment: {
        kind: "polymorphic",
        storage: linkedPolymorphicStorage(
          directPolymorphicMembership(input.edge),
          {
            kind: "planningField",
            step: probeId,
          }
        ),
      },
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
    edge: SelectedVariantRow,
    where: Record<string, unknown>
  ): PolymorphicStorageValue<FinalReferenceSource> {
    const id: FinalReferenceSource = Object.hasOwn(
      where,
      edge.member.referencedField
    )
      ? { kind: "literal", value: where[edge.member.referencedField] }
      : {
          kind: "lookup",
          statement: buildConnectSubqueryForField(
            owner,
            edge.ref,
            where,
            edge.member.referencedField
          ),
        };
    return linkedPolymorphicStorage(directPolymorphicMembership(edge), id);
  }

  /**
   * Resolve a shared-primary-key parent-held edge's PK from the edge's fold. A record
   * whose FK is (part of) its own primary key gets that PK from the
   * edge, not from scalar data, so `planNestedCreateIdentity` would otherwise reject it
   * as "primary key not known before execution" — and that rejection, not the census
   * refusal below it, is what actually stopped this family.
   *
   * Two provenances, both of them the value the edge's own step ACTS ON:
   *
   *  · **a literal** — a direct-referenced `connect` (the referenced column is in
   *    `where`) or a `create` spelling the referenced column in its data;
   *  · **a produced `Ref`** — a `create` whose target key the DATABASE generates
   *    The target is a before-parent INSERT, so its identity exists as soon as
   *    that INSERT runs, and the record's own FK column already references it by a
   *    backward `Ref` (`beforeParentFkAssign`). The shared PK is that same column, so
   *    the record's identity — and the terminal read that addresses the created row — is
   *    that same `Ref`. Nothing is re-derived: one produced value, spent everywhere.
   *
   * The `Ref` needs the target's write-step id BEFORE the arms fold (a value the
   * identity is built from, the allocation-order precedent), so this method
   * pre-allocates it and {@link interpretParentHeldCreate} consumes it instead of
   * minting its own.
   *
   * **`connectOrCreate` is a third source, and it is the SAME literal.** The
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
   * internal `QueryEngineError`). Deciding at the source is the placement rule.
   */
  private resolveSharedPkIdentity(
    childScope: QueryScope,
    relations: readonly ParsedRelationMutation[],
    reserveRootWriteStepId: () => string
  ): SharedPkIdentity {
    const recordPk = getPrimaryKeyFields(childScope.model);
    const identity: Record<string, unknown> = {};
    const suppliedValues: Record<string, unknown> = {};
    const producedBy = new Map<string, string>();
    const selectedBy = new Map<string, Set<string>>();
    for (const parsed of relations) {
      // A direct polymorphic edge writes its private `(type, id)` pair, never the
      // relation's `foreignFields`, and a storage column is not a declared scalar —
      // so it can never be a member of this record's row key.
      if (parsed.kind !== "ordinary") continue;
      const { name: relationName, program } = parsed;
      const relation = bindRelation(childScope, program.relationRef);
      if (relation.position !== "parentHeld") continue;
      const suppliesRowKey = relation.membership.foreignFields.some(
        (foreignField) => recordPk.includes(foreignField)
      );
      const entries = program.entries;
      // H3/R1 RE-JUSTIFIED. This skip used to be premised on a REFUSAL downstream —
      // "`interpretParentHeld`'s own arity refusal is more specific and must reach the
      // caller first" — and that refusal is now an engine-fault assertion, so the premise
      // has to be the one that was always doing the work: the create root's to-one input
      // owns neither `update` nor a vacate key, so `to-one-mutation-schema.ts` admits
      // exactly ONE entry here and a second could only be a second supplier, which it
      // refuses. The skip is therefore unreachable rather than fail-open — nothing walks
      // past it leaving a shared key member unresolved. Its update-root twin,
      // `RecordUpdateCompiler.resolveSharedKeyMembers`, DOES see multi-entry programs
      // since H and unions over every entry accordingly.
      if (entries.length !== 1) continue;
      const entry = entries[0];
      if (!entry) continue;
      const armSpec =
        entry.kind === "connectOrCreate" ? entry.items[0] : undefined;
      const createdTarget =
        entry.kind === "create" ? entry.items[0] : undefined;
      // The value the found arm's foreign key takes, per the `connectOrCreate` note above.
      const agreeWith = armSpec ? armSpec.create.parsed : undefined;
      const source =
        entry.kind === "connect"
          ? entry.targets[0]
          : entry.kind === "create"
            ? createdTarget?.parsed
            : armSpec
              ? armSpec.where
              : undefined;
      const reserveSelectedArmValue = (foreignField: string): void => {
        const selected = selectedBy.get(relationName) ?? new Set<string>();
        selected.add(foreignField);
        selectedBy.set(relationName, selected);
        const reference = this.demandConsumedReference(
          reserveRootWriteStepId(),
          foreignField
        );
        suppliedValues[foreignField] = reference;
        if (recordPk.includes(foreignField)) {
          identity[foreignField] = reference;
        }
      };
      // ONE guard, asserted at BOTH exits of this iteration — the invariant is "this
      // edge resolved every shared member", and an edge with no readable source exits
      // here. It is deliberately asked about an EMPTY map, not the accumulated one: a
      // sibling edge that already resolved the same column must not answer for this one.
      if (!source) {
        if (
          suppliesRowKey &&
          (entry.kind === "connect" || entry.kind === "connectOrCreate")
        ) {
          for (const foreignField of relation.membership.foreignFields) {
            reserveSelectedArmValue(foreignField);
          }
        }
        continue;
      }
      for (const { foreignField, referencedField: referenced } of relation
        .membership.members) {
        // The literal the fold SPELLS. `isMissingGeneratedIncrement` is the same
        // question `planNestedCreateIdentity` asks one line later: a create payload
        // carries the target's auto-increment key as an ABSENT value, so the key is
        // present-but-unspelled and only the INSERT will know it.
        const spelled = source[referenced];
        // On a `connectOrCreate` the two arms must leave the record holding the SAME
        // key, so the create arm's own referenced value has to agree with the `where`'s.
        // `fkEquals` is the comparator for exactly this construction-time question,
        // reused rather than re-derived.
        const armsAgree =
          agreeWith === undefined || fkEquals(agreeWith[referenced], spelled);
        if (
          armsAgree &&
          spelled !== undefined &&
          !isMissingGeneratedIncrement(
            relation.relationRef.targetModel["~"].state.scalars[referenced],
            spelled
          )
        ) {
          suppliedValues[foreignField] = spelled;
          if (recordPk.includes(foreignField)) {
            identity[foreignField] = spelled;
          }
          continue;
        }
        // The target's key is the one its own INSERT will PRODUCE. Pre-allocate
        // that INSERT's step id so the record's identity can `Ref` it here, before the
        // arms fold — one id, one producing statement, one value.
        //
        // F4: the referenced column no longer has to be the target's primary key. What
        // the consumer needs at CONSTRUCTION is a reference, not a value, and a produced
        // reference is exactly what {@link CreateOperation.producedReference} mints —
        // registering the demand on the very step id allocated here, so the target's own
        // INSERT publishes the column when its plan is built a few lines later. The
        // measured obstacle is untouched: a NON-referenced connect's lookup subquery and
        // a `connectOrCreate` whose two arms name different keys still resolve nothing,
        // and still refuse below.
        const targetModel = relation.relationRef.targetModel;
        if (
          suppliesRowKey &&
          entry.kind === "create" &&
          targetProducesKey(targetModel, referenced)
        ) {
          const producedStep =
            producedBy.get(relationName) ??
            this.scope.allocate(
              `${getStepModelName(targetModel, "record")}.create`
            );
          producedBy.set(relationName, producedStep);
          const databaseAssigned = databaseAssignedRowKeyFields(
            targetModel,
            source
          );
          const postWriteLocator = createdTarget
            ? createDataUniqueWhere(
                targetModel,
                createdTarget.parsed,
                explicitCreateScalarFields(targetModel, createdTarget.source)
              )
            : undefined;
          const reference = this.producedReference(
            targetModel,
            producedStep,
            referenced,
            databaseAssigned,
            postWriteLocator
          );
          suppliedValues[foreignField] = reference;
          if (recordPk.includes(foreignField)) {
            identity[foreignField] = reference;
          }
          continue;
        }
        if (
          suppliesRowKey &&
          (entry.kind === "connect" || entry.kind === "connectOrCreate")
        ) {
          reserveSelectedArmValue(foreignField);
        }
      }
    }
    return { identity, suppliedValues, producedBy, selectedBy };
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
    relations: readonly ParsedRelationMutation[]
  ): CreatedTarget[] {
    const targets: CreatedTarget[] = [];
    for (const parsed of relations) {
      // No create route (see `buildRecord`), and a disconnect produces no target.
      if (parsed.kind === "polymorphicDisconnect") continue;
      // A collection contributes NO before-parent coverage: coverage is the set
      // of keys a sibling `connect` may adopt without a probe because some arm
      // guarantees the target exists BEFORE the parent INSERT — and every member
      // row a collection writes lands after it, correlated on the key that
      // INSERT produces.
      if (parsed.kind === "polymorphicCollection") continue;
      const { program } = parsed;
      if (parsed.kind === "polymorphicTarget") {
        const edge = parsed.edge;
        const create = program.entries.find((entry) => entry.kind === "create");
        const data = create?.items[0]?.parsed;
        if (data && Object.hasOwn(data, edge.member.referencedField)) {
          targets.push({
            model: edge.member.targetModel,
            key: {
              [edge.member.referencedField]: data[edge.member.referencedField],
            },
          });
        }
        continue;
      }
      const relation = bindRelation(childScope, program.relationRef);
      if (relation.position !== "parentHeld") continue;
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
      for (const referenced of relation.membership.referencedFields) {
        if (Object.hasOwn(createData.parsed, referenced)) {
          key[referenced] = createData.parsed[referenced];
          hasAny = true;
        }
      }
      if (hasAny) {
        targets.push({ model: relation.relationRef.targetModel, key });
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

  /**
   * MOUNT 1 of 3 — a direct polymorphic collection under a CREATE root.
   *
   * The coordinator gets the same fresh-parent identity every junction arm on
   * this record gets, and the same `nestedBuilder`, so a collection target
   * carrying its own relations folds one level deeper exactly as a junction
   * target does. `membershipReadSource` is that identity too: this record is
   * being MADE, so no committed value can name it.
   */
  private buildCollectionPart(
    childScope: QueryScope,
    self: RecordIdentity,
    arm: Extract<ParsedRelationMutation, { kind: "polymorphicCollection" }>,
    txMode: boolean
  ): Part {
    const engine = this.engine;
    const scope = this.scope;
    const freshParentId = this.edgeParentSources(
      self,
      getPrimaryKeyFields(self.model),
      arm.name
    );
    return buildPolymorphicCollectionPart({
      scope,
      engine,
      parentScope: childScope,
      arm,
      parentId: freshParentId,
      membershipReadSource: freshParentId,
      freshParent: true,
      txMode,
      recordCompilers: this.recordCompilers,
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
    });
  }

  private interpretRelation(input: {
    childScope: QueryScope;
    self: RecordIdentity;
    /** The write-step id the shared-primary-key identity `Ref`s, when this
     *  relation's before-parent `create` is what produces this record's primary key. */
    sharedPkWriteStepId?: string;
    /** Row-key members whose exact values are supplied by this selected arm. */
    selectedSharedPkFields?: ReadonlySet<string>;
    relation: BoundRelation;
    program: RelationMutationProgram;
    txMode: boolean;
    coverage: readonly CreatedTarget[];
    parentHeldArms: ParentHeldArm[];
    childCreates: ChildCreate[];
    createManyWork: CreateManyWork[];
    afterParts: Part[];
  }): void {
    const { relation, program, txMode } = input;
    const { relationRef } = relation;
    const relationName = relationRef.name;
    const entries = program.entries;

    if (relation.position === "junction") {
      // The junction composes as ordinary Parts. A
      // fresh parent has no existing memberships, so every kind the parse boundary
      // admits here — create/createMany/connect/connectOrCreate/upsert — only ADDS
      // membership (ATOM “Relation-owner boundary”).
      //
      // `upsert` is the last of them, and it is the beyond-parity superset the
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
      const freshParentId = this.edgeParentSources(
        input.self,
        getPrimaryKeyFields(input.self.model),
        relationName
      );
      // THE JUNCTION-TO-ONE FORK, the create-root twin of
      // `RecordUpdateCompiler`'s. It is asked BEFORE `buildJunctionParts` for the
      // same reason: one writer for "is this the singular collection inverse", in
      // the same words the analyzer already uses. A fresh variant row holds no
      // membership yet, so the transfer's capture is elided rather than read —
      // the same structural proof `freshParent` gives the plural fold.
      if (isSingularCollectionInverse(relation)) {
        input.afterParts.push(
          ...buildJunctionToOneParts({
            scope,
            engine,
            parentScope: input.childScope,
            relation,
            program,
            parentId: freshParentId,
            membershipReadSource: freshParentId,
            freshParent: true,
            txMode,
            recordCompilers: this.recordCompilers,
          })
        );
        return;
      }
      input.afterParts.push(
        ...buildJunctionParts({
          scope,
          engine,
          parentScope: input.childScope,
          relation,
          program,
          parentId: freshParentId,
          // This record is being MADE, so it has no membership to read.
          freshParent: true,
          txMode,
          recordCompilers: this.recordCompilers,
          // Same fact, said where the type asks for it: nothing committed can be read
          // by an older value, so the read source is the fresh parent's own identity.
          membershipReadSource: freshParentId,
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

    if (relation.position === "parentHeld") {
      this.interpretParentHeld(input, relation, entries);
      return;
    }
    // A child-held relation this record is the referenced side of: a collection,
    // or a singular inverse whose child holds the FK.
    // The create-tree mechanics are direction-based, not arity-based — a child
    // INSERTs AFTER the parent with `fk = parent`, riding the same already-certified
    // own-write machinery (a sibling reading a just-created child is still rejected
    // by OwnWrite analysis). A to-one is the arity-1 case of that path; the
    // mixed-directions conformance scenario and the create-family oracle certify the
    // one-to-one `create`.
    //
    // This line once carried a NAME-based predicate over the retired four-way
    // relation family, and that predicate was measured to be a create-root
    // capability gap: it refused a child-held singular inverse the SAME schema's
    // `update` root accepted, because `RecordUpdateCompiler`'s sibling gate asks
    // the bound POSITION and routes it down this very path.
    //
    // The predicate is deleted rather than extended, because the union it tested is
    // closed and every other member left before this line: a junction position
    // returned at the top, the parent-held position returned just above, and an edge
    // with no partner never arrives — the schema-wide resolver refuses it before a
    // client exists. What remains is one
    // mechanism, not three names: the child INSERTs after the parent with `fk = parent`, and all three
    // create-root kinds the parse admits (`create` / `connect` / `connectOrCreate`) have
    // a child-held arm below. The to-one slot's own contradiction — two kinds naming one
    // slot — is answered inside `interpretChildHeld` by the arity twin, which reads
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
    relation: ParentHeldRelation,
    entries: readonly RelationMutationEntry[]
  ): void {
    const { relationRef } = relation;
    const relationName = relationRef.name;
    // H3/R1 — an ENGINE FAULT, not a shape this layer declines. Under the CREATE root
    // the to-one input owns neither `update` nor a vacate key, so the only multi-entry
    // payload the parse could deliver is supplier + supplier, which
    // `to-one-mutation-schema.ts` — the lattice's single owner — refuses before the
    // parser runs (`parity-h-to-one-lattice` pins that sentence on both directions of
    // this root). A zero-entry program cannot be built at all: the parser returns
    // `undefined` and no relation is interpreted, which is why the old `|| "none"` tail
    // never had a payload either. So this line answers no user spelling; it answers the
    // schema and this dispatch disagreeing, and says so (the X1c precedent).
    if (entries.length !== 1) {
      throw new QueryEngineError(
        `query-engine-v2 internal: an uncomposable parent-held to-one payload reached the create dispatch on relation '${relationName}'; it has ${entries.map((entry) => entry.kind).join(", ") || "none"}.`
      );
    }
    // The shared-primary-key edge is decided in `resolveSharedPkIdentity`, which
    // runs BEFORE this record's identity is planned and refuses there — at the site that
    // manufactures the shared key's source. The check used to stand here and read
    // `input.self.identity`, which by then could hold an application-materialized
    // `ulid` DEFAULT for the key rather than the edge's value; see that method's note
    // for the measurement.
    const childScope = createQueryScope(this.engine, relationRef.targetModel);
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
        // Unreachable by construction: `toOneCreateFactory`
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
    relation: ParentHeldRelation,
    childScope: QueryScope,
    entry: Extract<RelationMutationEntry, { kind: "connect" }>
  ): void {
    const { relationRef } = relation;
    const relationName = relationRef.name;
    const where = entry.targets[0];
    if (!where) {
      throw new QueryEngineError(
        `query-engine-v2 internal: parent-held connect on relation '${relationName}' has no target.`
      );
    }
    const assignment = this.toOneFkAssign(input.self.model, relation, where);
    if (
      this.connectIsCovered(
        input.coverage,
        relationRef.targetModel,
        where,
        relation.membership.referencedFields
      )
    ) {
      // The incident's create-then-connect: a sibling before-parent create writes
      // this target, so existence is our own write inside the atomic envelope —
      // pure FK assignment, with no probe, guard, or pin.
      input.parentHeldArms.push({
        kind: "connect-covered",
        assignment,
      });
      return;
    }
    const childName = getStepModelName(relationRef.targetModel, relationName);
    const probeId = this.scope.allocate(`${childName}.find`);
    const guardId = this.scope.allocate(`${childName}.guard.exists`);
    const pkSelect = Object.fromEntries(
      relation.membership.referencedFields.map((field) => [field, true])
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
      relationRef: relation.relationRef,
      guardId,
      probeId,
      guard: input.selectedSharedPkFields
        ? {
            kind: "captured",
            fields: relation.membership.referencedFields,
            where,
            forUpdate: false,
          }
        : {
            kind: "precompiled",
            probe: buildFindUnique(childScope, { where, select: pkSelect }),
          },
      assignment: input.selectedSharedPkFields
        ? this.selectedSharedPkAssignment(
            input.self.model,
            relation,
            where,
            probeId,
            input.selectedSharedPkFields
          )
        : assignment,
    });
    this.planningSteps.push(probe);
  }

  /** A parent-held `create`: INSERT the target before the record, the record's FK
   *  referencing the target's (possibly generated) identity by a backward `Ref`. */
  private interpretParentHeldCreate(
    input: Parameters<CreateOperation["interpretRelation"]>[0],
    relation: ParentHeldRelation,
    childScope: QueryScope,
    entry: Extract<RelationMutationEntry, { kind: "create" }>
  ): void {
    const createData = entry.items[0];
    if (!createData) {
      throw new QueryEngineError(
        `query-engine-v2 internal: parent-held create on relation '${relation.relationRef.name}' has no item.`
      );
    }
    // When this record's own primary key IS the foreign key this arm resolves,
    // the identity already `Ref`s a step id — so this INSERT must BE that step, not a
    // freshly allocated one. The allocation moved to `resolveSharedPkIdentity` because
    // the identity is built before the arms fold.
    const before = this.buildRecord(
      childScope,
      createData,
      input.txMode,
      input.sharedPkWriteStepId
    );
    input.parentHeldArms.push({
      kind: "create",
      before,
      assignment: {
        ...this.beforeParentFkAssign(input.self.model, relation, before),
      },
    });
  }

  /** A parent-held `connectOrCreate`: a global probe decides found (connect) vs
   *  missing (create the target before the parent, `racePin`ned). */
  private interpretParentHeldConnectOrCreate(
    input: Parameters<CreateOperation["interpretRelation"]>[0],
    relation: ParentHeldRelation,
    childScope: QueryScope,
    entry: Extract<RelationMutationEntry, { kind: "connectOrCreate" }>
  ): void {
    const { relationRef } = relation;
    const relationName = relationRef.name;
    const spec = entry.items[0];
    if (!spec) {
      throw new QueryEngineError(
        `query-engine-v2 internal: parent-held connectOrCreate on relation '${relationName}' has no item.`
      );
    }
    const where = spec.where;
    const createData = spec.create;
    const foundAssignment = this.toOneFkAssign(
      input.self.model,
      relation,
      where
    );
    const before = this.buildRecord(childScope, createData, input.txMode);
    const childName = getStepModelName(relationRef.targetModel, relationName);
    const probeId = this.scope.allocate(`${childName}.find`);
    const guardId = this.scope.allocate(`${childName}.guard.exists`);
    const pkSelect = Object.fromEntries(
      relation.membership.referencedFields.map((field) => [field, true])
    );
    input.parentHeldArms.push({
      kind: "connectOrCreate",
      relationRef,
      probeId,
      guardId,
      guard: input.selectedSharedPkFields
        ? {
            kind: "captured",
            fields: relation.membership.referencedFields,
            where,
            forUpdate: false,
          }
        : {
            kind: "precompiled",
            probe: buildFindUnique(childScope, { where, select: pkSelect }),
          },
      foundAssignment: input.selectedSharedPkFields
        ? this.selectedSharedPkAssignment(
            input.self.model,
            relation,
            where,
            probeId,
            input.selectedSharedPkFields
          )
        : foundAssignment,
      before,
      missingAssignment: input.selectedSharedPkFields
        ? {
            kind: "deferredForeignKey",
            relation,
            publishedFields: input.selectedSharedPkFields,
          }
        : this.beforeParentFkAssign(input.self.model, relation, before),
      racePin: createRacePin(childScope, where),
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
    relation: ParentHeldRelation,
    where: Record<string, unknown>
  ): Extract<CreateRootAssignment, { kind: "foreignKey" }> {
    const { relationRef } = relation;
    const relationName = relationRef.name;
    const recordScope = createQueryScope(this.engine, recordModel);
    const fkAssign: Record<string, unknown> = {};
    const members: ForeignKeyMember[] = [];
    for (const { foreignField, referencedField: referenced } of relation
      .membership.members) {
      const member: ForeignKeyMember = {
        foreignField,
        referencedField: referenced,
        writeSource: Object.hasOwn(where, referenced)
          ? { kind: "literal", value: where[referenced] }
          : {
              kind: "lookup",
              statement: buildConnectSubqueryForField(
                recordScope,
                relationRef,
                where,
                referenced
              ),
            },
      };
      members.push(member);
      fkAssign[foreignField] = referenceSql(
        this.engine,
        recordModel,
        foreignField,
        foreignKeyWriteValue(member, undefined, relationName, "connect")
      );
    }
    return {
      kind: "foreignKey",
      data: fkAssign,
      members,
      relationName,
    };
  }

  /** A selected target arm supplies these shared row-key members from the probe
   * row it actually chose, never from a second lookup subquery. */
  private selectedSharedPkAssignment(
    recordModel: Model<any>,
    relation: ParentHeldRelation,
    where: Record<string, unknown>,
    probeId: string,
    selectedFields: ReadonlySet<string>
  ): Extract<CreateRootAssignment, { kind: "foreignKey" }> {
    const recordScope = createQueryScope(this.engine, recordModel);
    const members = relation.membership.members.map(
      ({ foreignField, referencedField }): ForeignKeyMember => ({
        foreignField,
        referencedField,
        writeSource: selectedFields.has(foreignField)
          ? { kind: "planningField", step: probeId }
          : Object.hasOwn(where, referencedField)
            ? { kind: "literal", value: where[referencedField] }
            : {
                kind: "lookup",
                statement: buildConnectSubqueryForField(
                  recordScope,
                  relation.relationRef,
                  where,
                  referencedField
                ),
              },
      })
    );
    return {
      kind: "foreignKey",
      data: {},
      members,
      publishedFields: selectedFields,
      relationName: relation.relationRef.name,
    };
  }

  /** The missing arm's selected assignment is built only after that arm wins, so
   * an untaken generated target does not demand publication on a batch provider. */
  private beforeParentSelectedAssignment(
    relation: ParentHeldRelation,
    target: RecordPlan,
    publishedFields: ReadonlySet<string>
  ): Extract<CreateRootAssignment, { kind: "foreignKey" }> {
    const members = relation.membership.members.map(
      ({ foreignField, referencedField }): ForeignKeyMember => ({
        foreignField,
        referencedField,
        writeSource: this.requireRecordReferenced(
          target,
          referencedField,
          relation.relationRef.name,
          "beforeParentTarget"
        ),
      })
    );
    return {
      kind: "foreignKey",
      data: {},
      members,
      publishedFields,
      relationName: relation.relationRef.name,
    };
  }

  /** The record's FK columns ← a before-parent target record's referenced values
   *  (a `Ref` to a captured generated id, or a known literal). */
  private beforeParentFkAssign(
    recordModel: Model<any>,
    relation: ParentHeldRelation,
    target: RecordPlan
  ): Extract<CreateRootAssignment, { kind: "foreignKey" }> {
    const relationName = relation.relationRef.name;
    const fkAssign: Record<string, unknown> = {};
    const members: ForeignKeyMember[] = [];
    for (const { foreignField, referencedField } of relation.membership
      .members) {
      const writeSource = this.requireRecordReferenced(
        target,
        referencedField,
        relationName,
        "beforeParentTarget"
      );
      const member: ForeignKeyMember = {
        foreignField,
        referencedField,
        writeSource,
      };
      members.push(member);
      fkAssign[foreignField] = referenceSql(
        this.engine,
        recordModel,
        foreignField,
        foreignKeyWriteValue(member, undefined, relationName, "create")
      );
    }
    return {
      kind: "foreignKey",
      data: fkAssign,
      members,
      relationName,
    };
  }

  /** A child-held-FK to-many relation: create/createMany/connect/adopt (after). */
  private interpretChildHeld(
    input: Parameters<CreateOperation["interpretRelation"]>[0],
    relation: ChildHeldRelation,
    entries: readonly RelationMutationEntry[]
  ): void {
    const { txMode } = input;
    const { relationRef } = relation;
    const relationName = relationRef.name;
    // H3/R1 — the child-held twin of the parent-held line above, and an ENGINE FAULT for
    // the same reason: under the CREATE root the to-one input owns neither `update` nor a
    // vacate, so the lattice's only multi-entry create-root payload is supplier +
    // supplier and `to-one-mutation-schema.ts` refuses it first, on this direction too
    // (`parity-h-to-one-lattice` pins both sentences). What used to justify a DECLINED
    // shape here — that without it the loop built every arm and the user got a database
    // `UniqueConstraintError` on a 1:1 leg, or TWO ROWS in the to-one slot and no
    // diagnostic at all on a non-owning singular inverse — is the consequence of the
    // engine and the schema disagreeing, which is what this now says.
    //
    // `> 1`, not `!== 1`: a payload naming NO kind (`{ card: {} }`) asks for nothing and
    // is Prisma's no-op, which this loop already answers by building nothing — the same
    // reading `RecordUpdateCompiler.interpretRelation` spells out for its empty payload.
    if (relation.cardinality === "one" && entries.length > 1) {
      throw new QueryEngineError(
        `query-engine-v2 internal: an uncomposable child-held to-one payload reached the create dispatch on relation '${relationName}'; it has ${entries.map((entry) => entry.kind).join(", ")}.`
      );
    }
    const childScope = createQueryScope(this.engine, relationRef.targetModel);
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
                  relationRef.targetModel,
                  relationName
                ),
                wheres,
                txMode,
              };
              return new ChildConnectPart(this.scope, {
                ...common,
                relation,
                assignment: hasPolymorphicMembership(relation)
                  ? {
                      kind: "polymorphic",
                      storage: this.childPolymorphicStorage(
                        input.self,
                        relation
                      ),
                    }
                  : {
                      kind: "foreignKey",
                      data: this.childFkAssign(
                        input.self,
                        relation,
                        childScope.model
                      ),
                    },
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
              hasPolymorphicMembership(relation)
                ? bindRelationMembership(
                    relation,
                    this.referencedParentSource(
                      input.self,
                      relation.membership.referencedField,
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
              hasPolymorphicMembership(relation)
                ? bindRelationMembership(
                    relation,
                    this.referencedParentSource(
                      input.self,
                      relation.membership.referencedField,
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
          // Unreachable by construction: the five arms above
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
    items: readonly RecordMutationData[]
  ): void {
    const incomingMembership: RelationMembershipBinding =
      hasPolymorphicMembership(relation)
        ? bindRelationMembership(
            relation,
            this.referencedParentSource(
              input.self,
              relation.membership.referencedField,
              relation.relationRef.name
            )
          )
        : {
            kind: "foreignKey",
            relation,
            members: this.childEdgeMembers(input.self, relation),
          };
    const inject = hasPolymorphicMembership(relation)
      ? {}
      : this.childFkAssign(input.self, relation, childScope.model);
    const polymorphicStorage = hasPolymorphicMembership(relation)
      ? [this.childPolymorphicStorage(input.self, relation)]
      : undefined;
    for (const item of items) {
      input.childCreates.push({
        record: this.buildRecord(childScope, item, input.txMode),
        inject,
        incomingMembership,
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
    const parsedRows = userRows.map((row) => row.parsed);
    if (userRows.length === 0) return;
    if (createManyCarriesRelations(childScope, entry)) {
      const relationName = relation.relationRef.name;
      const incomingMembership = hasPolymorphicMembership(relation)
        ? bindRelationMembership(
            relation,
            this.referencedParentSource(
              input.self,
              relation.membership.referencedField,
              relationName
            )
          )
        : {
            kind: "foreignKey" as const,
            relation,
            members: this.childEdgeMembers(input.self, relation),
          };
      const parentRowKey = this.progressiveParentRowKey(input.self);
      input.createManyWork.push({
        kind: "series",
        part: buildFreshRecordSeriesPart({
          scope: this.scope,
          engine: this.engine,
          childScope,
          childName: getStepModelName(childScope.model, relationName),
          relationName,
          rows: userRows,
          incomingMembership,
          ...(parentRowKey ? { parentRowKey } : {}),
          skipDuplicates,
          createFresh: this.createFresh,
        }),
      });
      return;
    }
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
      const groups = buildValueGroups(childScope, parsedRows);
      assertPortableCreateManySkip(
        true,
        groups.some((group) => group.columns.length === 0)
      );
    }
    const inject = hasPolymorphicMembership(relation)
      ? {}
      : this.childFkAssign(input.self, relation, childScope.model);
    const rows = parsedRows.map((row) => ({ ...row, ...inject }));
    // Lower to grouped INSERTs (buildCreateManyPlan): one statement per same-shape
    // group, so heterogeneous rows (some supplying a generated PK, some omitting
    // it) split into contiguous grouped INSERTs — full parity with V1's grouped
    // execution, never the single-VALUES "Heterogeneous insert rows" hard-fail.
    // `skipDuplicates` rides the plan: a dialect whose skip is a SQL leaf carries the semantics in the
    // statement; a `recoverableUniqueError` dialect (MySQL) has no leaf, so each
    // per-row statement carries the savepoint-wrapped `onUniqueConflict: "skip"`
    // executor effect — exactly as the root `createMany` (ATOM “Bulk specializations”).
    const sharedPolymorphicStorage = hasPolymorphicMembership(relation)
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
      sharedPolymorphicStorage,
      this.engine.maxBindParametersPerStatement
    );
    const recoverUnique =
      skipDuplicates &&
      this.engine.adapter.mutations.skipDuplicatesStrategy ===
        "recoverableUniqueError";
    const base = getStepModelName(childScope.model, relation.relationRef.name);
    input.createManyWork.push({
      kind: "group",
      group: {
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
      },
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
    relation: OrdinaryChildHeldRelation,
    childModel: Model<any>
  ): Record<string, unknown> {
    const relationName = relation.relationRef.name;
    const assign: Record<string, unknown> = {};
    for (const { foreignField, referencedField } of relation.membership
      .members) {
      assign[foreignField] = referenceSql(
        this.engine,
        childModel,
        foreignField,
        this.referencedValue(self, foreignField, referencedField, relationName)
      );
    }
    return assign;
  }

  private childPolymorphicStorage(
    self: RecordIdentity,
    relation: PolymorphicChildHeldRelation
  ): Extract<
    PolymorphicStorageValue<FinalReferenceSource>,
    { kind: "linked" }
  > {
    const { carrier, storage, storedType, referencedField } =
      relation.membership;
    return {
      kind: "linked",
      carrier,
      storage,
      storedType,
      referencedField,
      id: this.referencedParentSource(
        self,
        referencedField,
        relation.relationRef.name
      ),
    };
  }

  /** The parent value a child FK references — a `Ref` to the value this record's own
   *  INSERT produces, or a value already knowable at construction. */
  private referencedValue(
    self: RecordIdentity,
    foreignField: string,
    referencedField: string,
    relationName: string
  ): unknown {
    const resolved = this.requireRecordReferenced(
      self,
      referencedField,
      relationName,
      "childEdge"
    );
    return foreignKeyWriteValue(
      { foreignField, referencedField, writeSource: resolved },
      undefined,
      relationName,
      "create"
    );
  }

  /** Every value the junction's complete parent-side stored reference consumes. */
  private edgeParentSources(
    self: RecordIdentity,
    referencedFields: readonly string[],
    relationName: string
  ): Readonly<Record<string, FinalReferenceSource>> {
    return Object.fromEntries(
      referencedFields.map((field) => [
        field,
        this.referencedParentSource(self, field, relationName),
      ])
    );
  }

  /**
   * The parent source a child-held ADOPT edge (`connectOrCreate` / `upsert`)
   * consumes: one whole-value source per referenced column, keyed by that column's NAME.
   *
   * A single-column edge is the length-1 case and produces exactly the source it always
   * did, so nothing about the common shape moves. A COMPOUND edge used to be refused
   * here, and the refusal was right for the source that existed: every consumer of a
   * unbound source spends one value on every foreign-key column, so
   * a two-column edge would have written the first referenced value into both — the
   * cross-pair trap measured one level deeper. Keying by name removes the trap by
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
    relation: OrdinaryChildHeldRelation
  ): ForeignKeyMember[] {
    const relationName = relation.relationRef.name;
    const { members } = relation.membership;
    const sources = members.map((member) =>
      this.referencedParentSource(self, member.referencedField, relationName)
    );
    return pairForeignKeyMembers(members, sources);
  }

  /** One referenced column of this fresh record, as a whole-value parent source. */
  private referencedParentSource(
    self: RecordIdentity,
    referenced: string,
    relationName: string
  ): FinalReferenceSource {
    return this.requireRecordReferenced(
      self,
      referenced,
      relationName,
      "parentId"
    );
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
    initialPolymorphicStorage: readonly PolymorphicStorageValue<unknown>[] = [],
    initialMembership?: RelationMembershipBinding
  ): EmittedRecordData {
    const insertData: Record<string, unknown> = {
      ...plan.scalarData,
      ...inject,
    };
    const consumedValues: Record<string, unknown> = {};
    const effectiveScalarValues: Record<string, unknown> = {
      ...plan.scalarData,
    };
    const assignmentTruth = new FinalRootAssignmentTruth();
    if (initialMembership?.kind === "foreignKey") {
      for (const member of initialMembership.members) {
        const value = foreignKeyWriteValue(
          member,
          known,
          initialMembership.relation.relationRef.name,
          "create"
        );
        assignmentTruth.contribute(
          getColumnName(plan.model, member.foreignField),
          assignmentIdentityFromFieldValue(member.foreignField, value),
          "membership",
          `query-engine-v2 create has conflicting final assignments for column '${getColumnName(plan.model, member.foreignField)}' on relation '${initialMembership.relation.relationRef.name}'.`
        );
        effectiveScalarValues[member.foreignField] = value;
      }
    }
    for (const field of plan.explicitScalarFields) {
      if (!Object.hasOwn(plan.scalarData, field)) continue;
      assignmentTruth.contribute(
        getColumnName(plan.model, field),
        assignmentIdentityFromScalar(plan.scalarData[field]),
        "scalar",
        `query-engine-v2 create has conflicting final assignments for column '${getColumnName(plan.model, field)}'.`
      );
    }
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
        writes,
        consumedValues,
        plan.model,
        assignmentTruth,
        effectiveScalarValues
      );
    }

    // 2. The record's own INSERT, and — on a substrate whose INSERT cannot report the
    //    database-produced fields a consumer demanded (F3) — the one focused read that
    //    publishes them. It sits here, between the statement that produces the values
    //    and the first statement that spends them.
    writes.push(
      this.buildInsertStep(
        plan,
        insertData,
        polymorphicStorage,
        consumedValues,
        effectiveScalarValues
      )
    );
    const producedRead = this.buildProducedRead(plan);
    if (producedRead) writes.push(producedRead);

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
        ),
        child.incomingMembership
      );
    }
    for (const work of plan.createManyWork) {
      if (work.kind === "series") {
        bucketOperationSteps(
          work.part.compile(this.scope, known),
          guards,
          writes
        );
        continue;
      }
      for (const step of work.group.steps) writes.push(step);
    }
    for (const part of plan.afterParts) {
      bucketOperationSteps(part.compile(this.scope, known), guards, writes);
    }
    return {
      data: insertData,
      effectiveScalarValues,
      polymorphicStorage,
      consumedValues,
    };
  }

  /** Resolve one parent-held arm and emit its target before the record INSERT. */
  private emitParentHeldArm(
    arm: ParentHeldArm,
    insertData: Record<string, unknown>,
    polymorphicStorage: PolymorphicStorageValue<unknown>[],
    known: Readonly<Record<string, unknown>>,
    guards: OperationStep[],
    writes: OperationStep[],
    consumedValues: Record<string, unknown>,
    recordModel: Model<any>,
    assignmentTruth: FinalRootAssignmentTruth,
    effectiveScalarValues: Record<string, unknown>
  ): void {
    switch (arm.kind) {
      case "connect-covered":
        // The incident's create-then-connect: a sibling before-parent create writes
        // this target, so existence is our own write inside the atomic envelope —
        // pure assignment, with no probe, guard, or pin.
        this.assignParentHeld(
          arm.assignment,
          known,
          "connect",
          insertData,
          polymorphicStorage,
          consumedValues,
          recordModel,
          assignmentTruth,
          effectiveScalarValues
        );
        return;
      case "connect-probe":
        this.requireConnectFound(arm.probeId, arm.relationRef, known);
        this.assignParentHeld(
          arm.assignment,
          known,
          "connect",
          insertData,
          polymorphicStorage,
          consumedValues,
          recordModel,
          assignmentTruth,
          effectiveScalarValues
        );
        if (this.mode === "batch") {
          guards.push(
            this.connectGuard(
              arm.guardId,
              this.parentHeldGuardProbe(
                arm.guard,
                arm.probeId,
                arm.relationRef,
                known
              ),
              arm.relationRef
            )
          );
        }
        return;
      case "create":
        this.emitBeforeParent(arm.before, undefined, known, guards, writes);
        this.assignParentHeld(
          arm.assignment,
          known,
          "create",
          insertData,
          polymorphicStorage,
          consumedValues,
          recordModel,
          assignmentTruth,
          effectiveScalarValues
        );
        return;
      case "connectOrCreate": {
        const rows = known[planningKey(arm.probeId, "rows")];
        // Zero rows is the ARM DECISION here, not an error: the probe's empty read is
        // exactly what makes this a create.
        const found = Array.isArray(rows) && rows.length > 0;
        if (found) {
          this.assignParentHeld(
            arm.foundAssignment,
            known,
            "connectOrCreate",
            insertData,
            polymorphicStorage,
            consumedValues,
            recordModel,
            assignmentTruth,
            effectiveScalarValues
          );
          if (this.mode === "batch") {
            guards.push(
              presenceGuard(
                arm.guardId,
                this.parentHeldGuardProbe(
                  arm.guard,
                  arm.probeId,
                  arm.relationRef,
                  known
                ),
                nestedWriteFailure(
                  // V1's found-arm captured guard: the planning-seen target vanished
                  // before the batch — a replacement race, not a plain not-found.
                  nestedReplacement("connectOrCreate"),
                  arm.relationRef.name,
                  false
                )
              )
            );
          }
          return;
        }
        // Resolve every demanded target value before emitting the target subtree:
        // buildInsertStep freezes that INSERT's output declaration.
        const missingAssignment =
          arm.missingAssignment.kind === "deferredForeignKey"
            ? this.beforeParentSelectedAssignment(
                arm.missingAssignment.relation,
                arm.before,
                arm.missingAssignment.publishedFields
              )
            : arm.missingAssignment;
        // The arm's raceable missing premise rides the SUBTREE's root INSERT.
        this.emitBeforeParent(arm.before, arm.racePin, known, guards, writes);
        this.assignParentHeld(
          missingAssignment,
          known,
          "connectOrCreate",
          insertData,
          polymorphicStorage,
          consumedValues,
          recordModel,
          assignmentTruth,
          effectiveScalarValues
        );
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

  /**
   * Apply one parent-held arm's root-membership assignment to this record's two sinks
   * — the INSERT data an ordinary foreign key rides in, and the private storage list a
   * polymorphic pair rides in. Which sink is the assignment's own answer.
   */
  private assignParentHeld(
    assignment: CreateRootAssignment,
    known: Readonly<Record<string, unknown>>,
    kind: string,
    insertData: Record<string, unknown>,
    polymorphicStorage: PolymorphicStorageValue<unknown>[],
    consumedValues: Record<string, unknown>,
    recordModel: Model<any>,
    assignmentTruth: FinalRootAssignmentTruth,
    effectiveScalarValues: Record<string, unknown>
  ): void {
    if (assignment.kind === "foreignKey" && assignment.members) {
      for (const member of assignment.members) {
        const value = foreignKeyWriteValue(
          member,
          known,
          assignment.relationName ?? kind,
          kind
        );
        const column = getColumnName(recordModel, member.foreignField);
        assignmentTruth.contribute(
          column,
          assignmentIdentityFromFieldValue(member.foreignField, value),
          "fold",
          `query-engine-v2 create has conflicting final assignments for column '${column}' on relation '${assignment.relationName ?? kind}'.`
        );
        insertData[member.foreignField] = referenceSql(
          this.engine,
          recordModel,
          member.foreignField,
          value
        );
        effectiveScalarValues[member.foreignField] = value;
        if (assignment.publishedFields?.has(member.foreignField)) {
          assertSelectedSharedPkValue(
            assignment,
            member.foreignField,
            value,
            kind
          );
          consumedValues[member.foreignField] = value;
        }
      }
      return;
    }
    applyRootMembershipAssignment(
      this.engine,
      assignment,
      known,
      kind,
      insertData,
      polymorphicStorage
    );
  }

  /**
   * The statement a parent-held arm's batch guard runs. A `precompiled` guard was
   * built at construction from a selector that is complete on its own; a `captured`
   * one is rebuilt HERE from the value the probe published, because a direct
   * polymorphic connect names its target by a discriminator beside a referenced value
   * and only the probe knows that value.
   */
  private parentHeldGuardProbe(
    guard: CapturedGuard,
    probeId: string,
    relationRef: RelationRef,
    known: Readonly<Record<string, unknown>>
  ): Sql {
    if (guard.kind === "precompiled") return guard.probe;
    const target = this.capturedConnectValues(
      probeId,
      guard.fields,
      relationRef,
      known
    );
    const childScope = createQueryScope(this.engine, relationRef.targetModel);
    return buildFind(
      childScope,
      {
        where: capturedSelectorWhere(childScope, guard.where, target),
        select: Object.fromEntries(guard.fields.map((field) => [field, true])),
        ...(guard.forUpdate ? { forUpdate: true } : {}),
      },
      { limit: 1 }
    );
  }

  /** Emit a before-parent target record subtree ahead of the record INSERT,
   *  applying a `racePin` to the target's own INSERT (connectOrCreate missing arm). */
  private emitBeforeParent(
    before: RecordPlan,
    racePin: CreateRacePin | undefined,
    known: Readonly<Record<string, unknown>>,
    guards: OperationStep[],
    writes: OperationStep[]
  ): void {
    const beforeWrites: OperationStep[] = [];
    const emitted = this.emitRecord(before, {}, known, guards, beforeWrites);
    if (
      racePin &&
      createDataSpellsRacePin(emitted.effectiveScalarValues, racePin)
    ) {
      for (let index = 0; index < beforeWrites.length; index += 1) {
        const step = beforeWrites[index]!;
        if (step.id === before.writeStepId && step.kind === "write") {
          beforeWrites[index] = { ...step, racePin: racePin.pin };
          break;
        }
      }
    }
    for (const step of beforeWrites) writes.push(step);
  }

  private connectGuard(
    guardId: string,
    guardProbe: Sql,
    relationRef: RelationRef
  ): OperationStep {
    const relationName = relationRef.name;
    return presenceGuard(
      guardId,
      guardProbe,
      nestedWriteFailure(
        relationTargetNotFound(relationRef, "connect"),
        relationName,
        false
      )
    );
  }

  private requireConnectFound(
    probeId: string,
    relationRef: RelationRef,
    known: Readonly<Record<string, unknown>>
  ): void {
    const relationName = relationRef.name;
    const rows = known[planningKey(probeId, "rows")];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 create connect probe for relation '${relationName}' did not expose rows.`,
        relationName
      );
    }
    if (rows.length === 0) {
      throw new NestedWriteError(
        relationTargetNotFound(relationRef, "connect"),
        relationName
      );
    }
  }

  private capturedConnectValues(
    probeId: string,
    fields: readonly string[],
    relationRef: RelationRef,
    known: Readonly<Record<string, unknown>>
  ): Readonly<Record<string, unknown>> {
    this.requireConnectFound(probeId, relationRef, known);
    const rows = known[planningKey(probeId, "rows")];
    const row = Array.isArray(rows) ? rows[0] : undefined;
    const captured: Record<string, unknown> = {};
    for (const field of fields) {
      if (!isRecord(row) || row[field] === undefined || row[field] === null) {
        throw new NestedWriteError(
          `query-engine create connect probe for relation '${relationRef.name}' did not expose '${field}'.`,
          relationRef.name
        );
      }
      captured[field] = row[field];
    }
    return captured;
  }

  private buildInsertStep(
    plan: RecordPlan,
    insertData: Record<string, unknown>,
    polymorphicStorage: readonly PolymorphicStorageValue<unknown>[],
    consumedValues: Readonly<Record<string, unknown>>,
    effectiveScalarValues: Readonly<Record<string, unknown>>
  ): WriteStep {
    const { childScope, databaseAssigned, writeStepId } = plan;
    const generatedField = legacyGeneratedField(databaseAssigned);
    // The enclosing adopt arm's missing-premise pin rides THIS record's INSERT
    // when this record is the subtree's root — the one statement whose unique-constraint
    // violation is the arm's raceable signal. Every deeper record of the subtree is an
    // unconditional create, so none of them carries it.
    const racePin =
      this.rootRacePin &&
      writeStepId === this.root.writeStepId &&
      createDataSpellsRacePin(effectiveScalarValues, this.rootRacePin)
        ? { racePin: this.rootRacePin.pin }
        : {};
    let demanded = this.publishedFields.get(writeStepId);
    // A later committed segment can spend one demanded database-produced field
    // only while it can still identify the row that published it. Close that
    // demand over the complete database-assigned row key before RETURNING and
    // the output declaration freeze; the continuation guard must never create a
    // late, undeclared sibling reference.
    if (this.mode === "batch" && demanded?.size) {
      for (const field of databaseAssigned) {
        this.demandProducedField(writeStepId, field);
      }
      demanded = this.publishedFields.get(writeStepId);
    }
    // F3 — a focused post-insert read addresses its row through the created-row
    // selector, and on a generated key that selector IS the captured identity. So a
    // demand for some OTHER produced field makes the identity a substrate need here,
    // exactly as the terminal read already makes it one for the root.
    //
    // The disjunct is the singular insert-id route. A plural generated row key
    // with an explicit alternate unique uses the locator read instead and has no
    // privileged `generatedField`; all of its row-key members are published by
    // that read. Keeping these cases separate preserves the historical insertId
    // SQL and output channel byte-for-byte.
    const capturedIdentity =
      generatedField !== undefined &&
      (demanded?.has(generatedField) === true ||
        this.publishReads.has(writeStepId) ||
        (!this.suppressTerminal && writeStepId === this.root.writeStepId))
        ? generatedField
        : undefined;
    // F2 — the demanded database-produced columns this statement can report itself.
    // Empty unless a consumer asked for a field that is not the generated key, which
    // is what keeps every pre-F create's RETURNING list and outputs byte-identical.
    //
    // This list is a demand SET, not a column order, and it deliberately carries no sort.
    // The emitted projection order belongs to `select-builder` (:232), which walks the
    // model's DECLARED scalars and takes the ones the select names — so the `RETURNING`
    // text is schema-ordered whatever order the fields arrive in here. MEASURED: reversing
    // this list, and separately spelling the payload's relation keys in the opposite
    // order, both compile the identical statement. Sorting here would be a second owner of
    // an order one owner already fixes.
    const returnedProduced = [...(demanded ?? [])].filter(
      (field) =>
        field !== generatedField &&
        this.publishesFieldFromInsert(databaseAssigned, field)
    );
    // Capture the generated auto-increment identity from the same RETURNING row
    // whenever another demanded field already makes this a row-returning INSERT.
    // A statement that returns rows does not also promise a separate insertId on
    // SQLite-family drivers, even when their plain INSERT batch lowering does.
    const capturesIdentityByReturning =
      capturedIdentity !== undefined &&
      (returnedProduced.length > 0 ||
        this.publishesFieldFromInsert(databaseAssigned, capturedIdentity));
    const forwardedConsumed = [...(demanded ?? [])].filter(
      (field) =>
        Object.hasOwn(consumedValues, field) &&
        !returnedProduced.includes(field)
    );
    const skipsRoot =
      this.rootSkipDuplicates && writeStepId === this.root.writeStepId;
    if (
      capturedIdentity === undefined &&
      returnedProduced.length === 0 &&
      forwardedConsumed.length === 0 &&
      !skipsRoot
    ) {
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
    // The generated identity leads the projection so its column position never moves
    // when another field joins the list.
    const select: Record<string, true> = {};
    if (capturedIdentity !== undefined && capturesIdentityByReturning) {
      select[capturedIdentity] = true;
    }
    for (const field of returnedProduced) select[field] = true;
    const outputs: Record<string, StatementOutputSource> = {};
    if (capturedIdentity !== undefined) {
      outputs.id = capturesIdentityByReturning
        ? { kind: "firstRowField", field: capturedIdentity }
        : { kind: "insertId" };
    }
    for (const field of returnedProduced) {
      outputs[producedKey(field)] = { kind: "firstRowField", field };
    }
    for (const field of forwardedConsumed) {
      const value = consumedValues[field];
      outputs[producedKey(field)] = {
        kind: "consumedValue",
        source: isOperationValueReference(value)
          ? { kind: "reference", reference: value }
          : { kind: "literal", value },
      };
    }
    const statement = skipsRoot
      ? buildCreateManyPlan(
          childScope,
          {
            data: [insertData],
            skipDuplicates: true,
            ...(Object.keys(select).length > 0 ? { select } : {}),
          },
          Object.keys(select).length > 0,
          [polymorphicStorage],
          this.engine.maxBindParametersPerStatement
        ).statements[0]?.sql
      : Object.keys(select).length > 0
        ? buildCreate(childScope, {
            data: insertData,
            polymorphicStorage,
            select,
          })
        : buildInsert(
            childScope,
            getTableName(childScope.model),
            insertData,
            polymorphicStorage
          );
    if (!statement) {
      throw new QueryEngineError(
        `query-engine-v2 create did not build the root skip statement '${writeStepId}'.`
      );
    }
    return {
      id: writeStepId,
      kind: "write",
      statement,
      outputs,
      ...((capturedIdentity !== undefined ||
        returnedProduced.length > 0 ||
        forwardedConsumed.length > 0) && {
        progressiveContinuation: this.producedValueContinuationGuard(
          plan,
          writeStepId,
          new Set(
            [
              capturedIdentity,
              ...returnedProduced,
              ...forwardedConsumed,
            ].filter((field): field is string => field !== undefined)
          )
        ),
      }),
      ...(skipsRoot &&
      this.engine.adapter.mutations.skipDuplicatesStrategy ===
        "recoverableUniqueError"
        ? { onUniqueConflict: "skip" as const }
        : {}),
      ...racePin,
    };
  }

  /**
   * F3 — the ONE focused read that publishes every demanded database-produced field of
   * one record on a substrate whose INSERT cannot report them. It selects only those
   * fields, by the selector that already names the created row, in the same transaction
   * and immediately after the INSERT — so every consumer downstream reads a value this
   * operation produced rather than one it re-derived.
   *
   * No postcondition rides it: an absent row leaves the declared `firstRowField` output
   * unresolvable and `extractOutput` fails closed on it already, and a second assertion
   * over the same premise is the redundant defense the house forbids. The cost of that
   * choice is named rather than hidden: the failure arrives as `extractOutput`'s bare
   * "step did not produce row field", without the model/operation attribution the
   * terminal read's `terminalFailure()` carries. Attribution here would be a second
   * owner for one premise, so it is deliberately not added.
   */
  private buildProducedRead(plan: RecordPlan): ReadStep | undefined {
    const read = this.publishReads.get(plan.writeStepId);
    if (!read) return undefined;
    const outputs: Record<string, StatementOutputSource> = {};
    const select: Record<string, true> = {};
    for (const field of read.fields) {
      select[field] = true;
      outputs[producedKey(field)] = { kind: "firstRowField", field };
    }
    return {
      id: read.stepId,
      kind: "read",
      statement: buildFindUnique(createQueryScope(this.engine, plan.model), {
        where: this.createdRowWhere(plan),
        select,
      }),
      outputs,
      progressiveContinuation: this.producedValueContinuationGuard(
        plan,
        read.stepId,
        read.fields
      ),
    };
  }

  /**
   * A progressive consumer must still see the exact fresh row that published its
   * value. Row-key members prove liveness; demanded non-key members additionally
   * prove that the referenced value has not moved to another row between commits.
   */
  private producedValueContinuationGuard(
    plan: RecordPlan,
    publisherStepId: string,
    publishedFields: ReadonlySet<string>
  ): GuardStep {
    const rowKey = new Set(getPrimaryKeyFields(plan.model));
    const identity: Record<string, unknown> = {};
    for (const field of rowKey) {
      const source = this.recordReferenced(plan, field);
      if (!source) {
        throw new QueryEngineError(
          `query-engine-v2 internal: generated-output continuation cannot resolve row-key field '${field}'.`
        );
      }
      if (source.kind === "literal") {
        identity[field] = source.value;
        continue;
      }
      if (source.kind !== "finalRef") {
        throw new QueryEngineError(
          `query-engine-v2 internal: generated-output continuation row-key field '${field}' is not a final value.`
        );
      }
      identity[field] = referenceSql(
        this.engine,
        plan.model,
        field,
        source.ref
      );
    }
    const generatedField = legacyGeneratedField(plan.databaseAssigned);
    const membership: Record<string, unknown> = {};
    for (const field of publishedFields) {
      if (rowKey.has(field)) continue;
      const output = field === generatedField ? "id" : producedKey(field);
      membership[field] = referenceSql(
        this.engine,
        plan.model,
        field,
        ref(publisherStepId, output)
      );
    }
    return completeTargetPresenceGuard(
      createQueryScope(this.engine, plan.model),
      `${publisherStepId}.continuation`,
      identity,
      queryFailure(
        `Created record '${getStepModelName(plan.model, "record")}' changed across a generated-output segment boundary.`
      ),
      membership
    );
  }

  /**
   * The created-row selector: the unique `where` that names the row one record's INSERT
   * writes. The generated key is spent as the `Ref` that INSERT publishes — which is the
   * driver's `insertId` on a substrate with no RETURNING, the one place F3 is allowed to
   * spend it — and every other identity is the record's own primary key, a literal or
   * the `Ref` a before-parent INSERT produces. ONE owner, because the terminal read and
   * F3's focused read must name the same row or they are two different answers.
   *
   * A non-returning INSERT with one generated identity keeps the historical insertId
   * selector. A plural generated row key cannot use that channel; when the source
   * explicitly spells another complete addressable unique, the terminal and focused
   * publication reads both use that alternate locator. The unique constraint excludes
   * multiplicity, and zero rows still fails through the declared output/postcondition.
   * Without either selector, site 19 refuses before I/O.
   *
   * NOT the same owner as `getCreatedRowWhere` (query-engine/operations/mutation-identity.ts),
   * which answers the same question for `ManyAndReturnOperation` through the adapter's
   * `lastInsertId()` SQL rather than a backward reference. Two mechanisms, two owners,
   * near-identical names — a guard-ownership-ledger item, recorded here so a later
   * reuse is a decision and not an accident.
   */
  private createdRowWhere(plan: RecordPlan): Record<string, unknown> {
    if (
      !this.engine.adapter.capabilities.supportsReturning &&
      plan.databaseAssigned.length > 1 &&
      plan.postWriteLocator
    ) {
      return { ...plan.postWriteLocator };
    }
    const identity = this.terminalIdentity(plan.model, plan.identity);
    const generatedField = legacyGeneratedField(plan.databaseAssigned);
    for (const field of plan.databaseAssigned) {
      identity[field] = referenceSql(
        this.engine,
        plan.model,
        field,
        ref(
          plan.writeStepId,
          generatedField === field ? "id" : producedKey(field)
        )
      );
    }
    return buildPrimaryKeyWhereUnique(plan.model, identity);
  }

  /**
   * F1 — the demand-registration seam every `rootReferenced` call goes through. Two of
   * {@link freshReferenced}'s answers need no publication (a literal the create data
   * spells, and an identity member — which is itself either a literal or the `Ref` a
   * before-parent INSERT already produces); the generated primary key and every other
   * DATABASE-PRODUCED column need the record's own INSERT to report the value, and this
   * is where that request is recorded.
   *
   * The other registrar is {@link CreateOperation.resolveSharedPkIdentity}; see
   * {@link CreateOperation.publishedFields} for why it cannot come through here.
   */
  /**
   * THE owner of "a fresh record cannot publish the referenced column this edge
   * needs" (guard-ownership-ledger.md, cluster 1).
   *
   * Four construction sites used to spell this decision — the polymorphic
   * before-parent target, the ordinary before-parent target, this record's own
   * child-edge column, and the whole-value parent source. All four asked
   * {@link recordReferenced} the same question, refused on the same answer, and
   * differed only in the NOUN their sentence uses for the position. A noun is not a
   * decision, so the decision lives here once and the position picks the wording;
   * every shipped sentence survives byte-identically, and the only text that moved
   * is the polymorphic one, which said `query-engine` where its three siblings said
   * `query-engine-v2` and which no test pins.
   *
   * This is not a shared "unsupported" helper: it does not take an error, a class or
   * a message from its callers, and there is exactly one condition under it. A
   * caller that needs a DIFFERENT decision about a fresh reference does not come
   * here — it calls {@link recordReferenced} and answers for itself, which is what
   * the update root's own owner does one file over.
   */
  private requireRecordReferenced(
    record: RecordIdentity,
    referencedField: string,
    relationName: string,
    position: FreshReferencePosition
  ): FinalReferenceSource {
    const resolved = this.recordReferenced(record, referencedField);
    if (resolved !== undefined) return resolved;
    throw new UnsupportedOperationError(
      unresolvedFreshReferenceMessage(position, referencedField, relationName)
    );
  }

  private recordReferenced(
    record: RecordIdentity,
    referencedField: string
  ): FinalReferenceSource | undefined {
    if (record.databaseAssigned.includes(referencedField)) {
      return {
        kind: "finalRef",
        ref: this.producedReference(
          record.model,
          record.writeStepId,
          referencedField,
          record.databaseAssigned,
          record.postWriteLocator
        ),
      };
    }
    const resolved = freshReferenced(record, referencedField);
    if (resolved) return resolved;
    // §4.3 rule 5, and the maintainer's 2026-08-06 ruling: a value that is null,
    // absent, or an `Sql` operand names no row and no round trip produces one, so the
    // caller's focused refusal stands. Only a value the DATABASE produces is published.
    if (
      !isMissingGeneratedIncrement(
        record.model["~"].state.scalars[referencedField],
        record.scalarData[referencedField]
      )
    ) {
      return undefined;
    }
    return {
      kind: "finalRef",
      ref: this.producedReference(
        record.model,
        record.writeStepId,
        referencedField,
        record.databaseAssigned,
        record.postWriteLocator
      ),
    };
  }

  /** Complete identity used only when a later committed segment must re-pin this row. */
  private progressiveParentRowKey(
    record: RecordIdentity
  ): Readonly<Record<string, FinalReferenceSource>> | undefined {
    if (
      this.engine.driver.supportsTransactions ||
      !this.engine.driver.supportsBatch
    ) {
      return undefined;
    }
    const sources: Record<string, FinalReferenceSource> = {};
    for (const field of getPrimaryKeyFields(record.model)) {
      const source = this.recordReferenced(record, field);
      if (!source) return undefined;
      sources[field] = source;
    }
    return sources;
  }

  /**
   * F2/F3 — register one demanded database-produced field on the INSERT that produces
   * it, and hand back the reference the consumer spends. The channel depends on how the
   * substrate can report the value, and on nothing else:
   *
   *  · **RETURNING** (F2) — the field joins the INSERT's own RETURNING list and the
   *    reference names that write step. A transaction consumes it directly. A batch
   *    operation keeps an exact single-statement fold where available, or materializes
   *    the returned value before a guarded continuation segment.
   *  · **No RETURNING, in a transaction** (F3) — the INSERT keeps its current shape and
   *    ONE focused read publishes every demanded field of this record by the created-row
   *    selector the compiler already owns ({@link CreateOperation.createdRowWhere}). The
   *    driver's `insertId` may IDENTIFY the row for that read; it is never substituted
   *    for the field's own value.
   * A non-RETURNING provider still cannot publish a plural database-assigned row key
   * without another complete stable selector. That is an unnamed-row fact, not a general
   * batch limitation.
   *
   * Exactly one database-assigned row-key member keeps the historical `id` output
   * channel. Plural members use field-keyed outputs, so none is privileged.
   */
  private producedReference(
    model: Model<any>,
    writeStepId: string,
    field: string,
    databaseAssigned: readonly string[],
    postWriteLocator?: Readonly<Record<string, unknown>>
  ): OperationValueReference {
    this.demandProducedField(writeStepId, field);
    const generatedField = legacyGeneratedField(databaseAssigned);
    if (field === generatedField) return ref(writeStepId, "id");
    const returning = this.publishesFieldFromInsert(databaseAssigned, field);
    const unavailableReason =
      !returning &&
      databaseAssigned.length > 1 &&
      postWriteLocator === undefined
        ? "without RETURNING: no complete stable selector exists until every database-assigned row-key member has been published."
        : undefined;
    if (unavailableReason) {
      throw new UnsupportedOperationError(
        `query-engine-v2 create cannot publish the database-produced field '${field}' of '${getStepModelName(model, "record")}' ${unavailableReason}`
      );
    }
    if (returning) {
      return ref(writeStepId, producedKey(field));
    }
    const fields =
      databaseAssigned.length > 1 && postWriteLocator
        ? [...new Set([...databaseAssigned, field])]
        : [field];
    for (const demandedField of fields) {
      this.demandProducedField(writeStepId, demandedField);
    }
    const read = this.publishReads.get(writeStepId) ?? {
      stepId: this.scope.allocate(
        `${getStepModelName(model, "record")}.produced`
      ),
      fields: new Set<string>(),
    };
    for (const demandedField of fields) read.fields.add(demandedField);
    this.publishReads.set(writeStepId, read);
    return ref(read.stepId, producedKey(field));
  }

  /**
   * Keep the exact atomic insert-id lowering when the adapter owns one. A
   * returning row becomes the publication channel only when transaction mode
   * already used it, when no exact insert-id lowering exists, or when the
   * demanded field is not that singular legacy identity.
   */
  private publishesFieldFromInsert(
    databaseAssigned: readonly string[],
    field: string
  ): boolean {
    if (!this.engine.adapter.capabilities.supportsReturning) return false;
    const generatedField = legacyGeneratedField(databaseAssigned);
    return (
      this.mode === "transaction" ||
      !this.engine.adapter.batchRefs.storeLastInsertId ||
      field !== generatedField
    );
  }

  /** Register one exact value that the record INSERT consumes and republishes. */
  private demandConsumedReference(
    writeStepId: string,
    field: string
  ): OperationValueReference {
    this.demandProducedField(writeStepId, field);
    return ref(writeStepId, producedKey(field));
  }

  /** The sole demand-set mutation used by generated and consumed publication. */
  private demandProducedField(writeStepId: string, field: string): void {
    const demanded = this.publishedFields.get(writeStepId);
    if (demanded) demanded.add(field);
    else this.publishedFields.set(writeStepId, new Set([field]));
  }

  /**
   * The terminal read's unique `where` from the root record's identity. A
   * shared-primary-key identity carries a `Ref` to the before-parent INSERT that
   * produces it, so that member is lowered like every other deferred value (the same
   * `referenceSql` the generated-key branch above uses); a literal identity is passed
   * through untouched, so every other create compiles the same `where` it always did.
   */
  private terminalIdentity(
    model: Model<any>,
    identity: Record<string, unknown>
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(identity)) {
      resolved[field] = isOperationValueReference(value)
        ? referenceSql(this.engine, model, field, value)
        : value;
    }
    return resolved;
  }

  private buildTerminal(plan: RecordPlan): ReadStep {
    const parent = createQueryScope(this.engine, this.model);
    const txMode = this.mode === "transaction";
    return {
      id: this.terminalId,
      kind: "read",
      statement: buildFindUnique(parent, {
        where: this.createdRowWhere(plan),
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
    // have any (fresh-parent elision, ATOM “Relation-owner boundary”). `createMany`
    // carries the `create` slot per row plus the duplicate skip; `upsert` is the adopt
    // family's third member — global lookup, then adopt-and-update.
    //
    // With `upsert` in, this is an ENGINE INVARIANT, not a capability boundary — the
    // X1c disposition. The kinds it names are EXACTLY the kinds the parse boundary
    // admits in a create-context to-many payload, measured through the public client on
    // both junction spellings (a two-model pair and a self-relation): `delete`,
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
 * F2/F3 — the output channel one published database-produced field travels on. An
 * exactly-one generated row-key member keeps the historical `id` name (four owners
 * spell it, and every byte pin counts on it). Plural row-key publication and every
 * other field use namespaced keys, so no generated member is privileged and a model
 * whose generated key is not called `id` cannot collide with a field that is.
 */
function producedKey(field: string): string {
  return `produced:${field}`;
}

/** Preserve the historical `id` output only for the exact singular case. */
function legacyGeneratedField(
  databaseAssigned: readonly string[]
): string | undefined {
  return databaseAssigned.length === 1 ? databaseAssigned[0] : undefined;
}

/**
 * One referenced value of a FRESH record, in the ONE place every asker reads
 * it: the child-FK assignment, the after-parent adopt/M2M parent id, the before-parent
 * target's referenced value, and (through the identity) the terminal read.
 *
 * TWO provenances, both of them the row this record's own INSERT writes:
 *
 *  1. a primary key already resolved into the identity — a literal, or (shared-PK) the
 *     `Ref` a before-parent INSERT produces, which `resolveSharedPkIdentity` put there;
 *  2. a NON-primary-key referenced column the record's own create data SPELLS. A fresh
 *     record's identity is wider than its primary key: an FK referencing one of its
 *     uniques needs the value that unique is about to
 *     hold, and that value is in the same create data the primary key came from — the
 *     same provenance, one column over. Nothing is re-read and nothing is re-derived.
 *
 * A THIRD provenance used to live here — the primary key the INSERT generates — and it
 * moved out rather than leaving two owners for one answer: publication is
 * a substrate decision now, and {@link CreateOperation.producedReference} is the only
 * thing that makes it. Its caller intercepts the generated key before this function is
 * reached, so an arm for it here could only ever disagree.
 *
 * A value that is not knowable NOW is not resolved: an `Sql` operand would be evaluated
 * a SECOND time for the foreign key, and two evaluations of one expression are two
 * values (`gen_random_uuid()`, `now()`), so the child would reference a row that does
 * not exist. `null`/absent likewise resolves nothing — an FK equal to NULL references
 * no row. Both fall through to the typed refusal in
 * {@link CreateOperation.requireRecordReferenced}.
 */
function freshReferenced(
  record: {
    readonly identity: Record<string, unknown>;
    readonly scalarData: Record<string, unknown>;
    readonly relationSuppliedValues: Record<string, unknown>;
  },
  referencedField: string
): FinalReferenceSource | undefined {
  if (Object.hasOwn(record.identity, referencedField)) {
    const value = record.identity[referencedField];
    return isOperationValueReference(value)
      ? { kind: "finalRef", ref: value }
      : { kind: "literal", value };
  }
  if (Object.hasOwn(record.relationSuppliedValues, referencedField)) {
    const value = record.relationSuppliedValues[referencedField];
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
    // A polymorphic-storage create arm is deliberately UNCLASSIFIED: its
    // before-parent INSERT was never measured for the fold's order-insensitivity
    // claim, so the tree keeps declining exactly as it did when the arm carried
    // its own kind. Lifting this is a ratification with its own witness, not a
    // classification gap.
    if (arm.kind === "create" && arm.assignment.kind === "foreignKey") {
      collectFoldArmSemantics(arm.before, into);
    }
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
  for (const work of plan.createManyWork) {
    if (work.kind === "series") continue;
    const { group } = work;
    for (const [index, step] of group.steps.entries()) {
      into.set(step.id, {
        databaseAssigned: group.databaseAssigned[index]!,
        targetTable: group.targetTable,
        statementSkipsDuplicates: group.statementSkipsDuplicates,
      });
    }
  }
}

/**
 * The first write id this record plan is CERTAIN to emit before its own INSERT.
 * See {@link CreateOperation.declaredPreRootWriteId} for who asks and why only the
 * `create` arm counts. The descent mirrors {@link CreateOperation.emitRecord}'s
 * order exactly: a before-parent create emits its own before-parent creates first.
 */
function declaredPreRootWriteId(plan: RecordPlan): string | undefined {
  for (const arm of plan.parentHeldArms) {
    if (arm.kind !== "create") continue;
    return declaredPreRootWriteId(arm.before) ?? arm.before.writeStepId;
  }
  return undefined;
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

/** A selected shared row-key source must name one actual target row. */
function assertSelectedSharedPkValue(
  assignment: Extract<CreateRootAssignment, { kind: "foreignKey" }>,
  field: string,
  value: unknown,
  kind: string
): void {
  if (value !== null && value !== undefined) return;
  const relationName = assignment.relationName ?? kind;
  const foreignFields =
    assignment.members?.map((member) => member.foreignField).join(", ") ??
    field;
  throw new UnsupportedOperationError(
    `query-engine-v2 create does not support a shared-primary-key ${kind} on relation '${relationName}' whose foreign key '${foreignFields}' (this record's primary key) does not resolve to one final value.`
  );
}

/**
 * F4 — whether a before-parent target's referenced column is one the DATABASE assigns.
 * `increment` is the only such column this schema language has: every other
 * `autoGenerate` carries an application default factory the parse boundary materializes
 * into the create data, and `assertApplicationGeneratedValues` refuses an omitted one —
 * so an absent increment is the entire database-produced population, and it is int or
 * bigint by construction. Callers reach this only where the create data does NOT spell
 * the column, which is what makes "declared increment" the whole question here.
 */
function targetProducesKey(
  targetModel: Model<any>,
  referencedField: string
): boolean {
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

/**
 * One CHILD-held connect group. The membership axis rides as the assignment the
 * child's UPDATE makes — the same union a parent-held arm carries — rather than as a
 * cross-product of the relation type with the storage it writes.
 */
interface ChildConnectConfig extends ChildConnectContext {
  readonly relation: ChildHeldRelation;
  readonly assignment: RootMembershipAssignment;
}

class ChildConnectPart implements Part {
  private readonly config: ChildConnectConfig;
  private readonly probeId: string;
  private readonly writeId: string;
  private readonly guardIds: readonly string[];
  private readonly distinctTargets: number;
  private readonly probe: ReadStep;

  private get relationName(): string {
    return this.config.relation.relationRef.name;
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
        relationTargetNotFound(this.config.relation.relationRef, "connect"),
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
                this.config.relation.relationRef,
                "connect"
              ),
              this.relationName,
              false
            )
          )
        );
      }
    }
    // The child's own two sinks, filled by the one assignment applier: an ordinary
    // edge writes SET columns, a polymorphic one writes the private pair. An empty
    // storage list stays ABSENT from the statement rather than present-and-empty.
    const data: Record<string, unknown> = {};
    const resolved: PolymorphicStorageValue<unknown>[] = [];
    applyRootMembershipAssignment(
      this.config.engine,
      this.config.assignment,
      known,
      "connect",
      data,
      resolved
    );
    const polymorphicStorage = resolved.length > 0 ? resolved : undefined;
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
}

// ---------------------------------------------------------------------------

function terminalFailure() {
  return {
    kind: "query" as const,
    message: "query-engine-v2 create terminal read expected exactly one row.",
    raceable: false,
  };
}

/**
 * Which edge demanded the column {@link CreateOperation.requireRecordReferenced}
 * could not publish. It selects a noun, never a decision.
 *
 * · `beforeParentTarget` — a target this record's own INSERT depends on, so it is
 *   written FIRST and the value must come out of its create data or its INSERT.
 *   Both the ordinary and the direct-polymorphic parent-held arms are here.
 * · `beforeRootTarget` — the same target under an UPDATE root, where the enclosing
 *   statement is an UPDATE rather than an INSERT (residual §G3). The update root
 *   used to construct this refusal itself; the fact is the fresh subtree's, so the
 *   position is all that remained of the second site.
 * · `childEdge` — a child's foreign key must carry THIS record's referenced column.
 * · `parentId` — the same column consumed as one whole-value parent source (adopt,
 *   junction and polymorphic child edges).
 */
type FreshReferencePosition =
  | "beforeParentTarget"
  | "beforeRootTarget"
  | "childEdge"
  | "parentId";

function unresolvedFreshReferenceMessage(
  position: FreshReferencePosition,
  referencedField: string,
  relationName: string
): string {
  if (position === "beforeParentTarget") {
    return `query-engine-v2 create cannot resolve referenced field '${referencedField}' for the before-parent target of relation '${relationName}': it is neither that record's primary key nor a knowable value in its own create data.`;
  }
  if (position === "beforeRootTarget") {
    return `query-engine-v2 update cannot resolve referenced field '${referencedField}' for the before-root target of relation '${relationName}': it is neither that record's primary key nor a knowable value in its own create data.`;
  }
  if (position === "parentId") {
    return `query-engine-v2 create cannot resolve the parent id for relation '${relationName}': referenced field '${referencedField}' is neither this record's primary key nor a knowable value in its own create data.`;
  }
  return `query-engine-v2 create cannot resolve referenced field '${referencedField}' for relation '${relationName}': it is neither this record's primary key nor a knowable value in its own create data.`;
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
