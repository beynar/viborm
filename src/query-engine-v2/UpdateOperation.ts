// biome-ignore-all lint/style/useFilenamingConvention: UpdateOperation is the architecture name.
import { NestedWriteError, NotFoundError, QueryEngineError } from "@errors";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import {
  splitToOneUpdateTarget,
  type ToOneUpdateTarget,
} from "@validation/relations/to-one-update-form";
import {
  buildPrimaryKeyWhereUnique,
  getPrimaryKeyFields,
} from "../query-engine/builders/correlation-utils";
import {
  type FkDirection,
  getFkDirection,
  type RelationMutation,
  separateData,
} from "../query-engine/builders/relation-data-builder";
import { getRelationMutationKinds } from "../query-engine/builders/relation-mutation-parser";
import { buildInsert } from "../query-engine/builders/values-builder";
import { getWhereUniqueEntries } from "../query-engine/builders/where-unique-builder";
import {
  createQueryScope,
  getDefaultScalarFieldNames,
  getTableName,
} from "../query-engine/context/query-scope";
import {
  buildCreate,
  buildDeleteMany,
  buildFind,
  buildFindUnique,
  buildUpdate,
} from "../query-engine/operations";
import {
  assertPortablePrimaryKeyUpdateInput,
  getUpdatedPrimaryKeyValue,
  getUpdatedPrimaryKeyWhere,
  planNestedCreateIdentity,
} from "../query-engine/operations/mutation-identity";
import type { QueryEngine } from "../query-engine/query-engine";
import { assertNullable } from "../query-engine/RelationProgramValues";
import {
  assertRelationKeyUpdatesAreCompilable,
  assertUpdateManyRelationsAreCompilable,
} from "../query-engine/relation-key-legality";
import { ResultParser } from "../query-engine/result/ResultParser";
import { classifyRelationKeyScalarUpdate } from "../query-engine/TargetConstraint";
import type { QueryScope, RelationInfo } from "../query-engine/types";
import {
  absenceGuard,
  affectedRows,
  childRacePin,
  exactlyOneRow,
  nestedWriteFailure,
  notFoundFailure,
  presenceGuard,
  queryFailure,
  referenceSql,
} from "./fragment-builders";
import {
  nestedReplacement,
  relationKeyOccupiedMessage,
  relationTargetNotFound,
  upsertPremiseChanged,
} from "./messages";
import {
  buildFreshArmPart,
  buildLiteralParentCreateManyPart,
  buildLiteralParentCreatePart,
  buildNestedTargetChildParts,
  buildNestedTargetUpdatePart,
  buildPlannedParentCreateManyPart,
  buildPlannedParentCreatePart,
  type FreshArmBuilder,
  targetNeedsFullUpdate,
} from "./nested-target-parts";
import {
  type OperationFragment,
  type OperationStep,
  ref,
  type StatementStep,
  type TargetConstraintPin,
} from "./OperationFragment";
import { OwnWritePreflight } from "./OwnWritePreflight";
import type { Part, PlanningKnown } from "./Part";
import { planningKey, planningOutputs } from "./Part";
import { referencedFieldRef, referencedFieldValue } from "./parent-reference";
import { parseValidated } from "./parse-boundary";
import { buildJunctionParts } from "./RelationJunctionPart";
import { buildToManyLinkParts } from "./RelationLinkPart";
import {
  buildConnectOrCreateParts,
  buildToManyUpsertParts,
  literalParentId,
  type ParentIdSource,
  plannedParentId,
} from "./RelationUpsertPart";
import {
  buildInverseToOneUpsertPart,
  buildToManyDeleteManyParts,
  buildToManyDeleteParts,
  buildToManySetPart,
  buildToManyUpdateManyParts,
  buildToManyUpdateParts,
  buildToOneUpdatePart,
} from "./RelationWritePart";
import { StepScope } from "./StepScope";
import {
  getStepModelName,
  isRecord,
  type NestedTargetLocate,
  type SubOperationOptions,
  sameScalarValue,
  selectExecutionMode,
  UnsupportedOperationError,
  uniqueSelectorConjuncts,
} from "./shared";

type ExecutionMode = "transaction" | "batch";

/** A to-one (parent-held-FK) connect/disconnect folded into the root update SET. */
interface ToOneLink {
  readonly relationName: string;
  readonly relationInfo: RelationInfo;
  /** FK assignment merged into the parent SET clause. */
  readonly assignment: Record<string, unknown>;
  /** Present for `connect`: an existence probe + its batch guard id. */
  readonly connect?: {
    readonly probeId: string;
    readonly guardId: string;
    readonly probe: StatementStep;
  };
}

/**
 * A **before-root target** INSERT plan (TO-ONE.md §7.0.2): a scalar-only nested
 * record created ahead of the root parent UPDATE, whose (possibly generated)
 * identity the parent's FK column references. It is the arity-1 `create` payload
 * of the parent-held direction, with the parent INSERT replaced by the parent
 * UPDATE. A nested-relation target `create` is out of T2 scope (routes to V1).
 */
interface BeforeTarget {
  readonly childScope: QueryScope;
  /** Materialized scalar data (defaults applied, the generated PK removed). */
  readonly scalarData: Record<string, unknown>;
  /** The single auto-increment PK captured from the INSERT, if any. */
  readonly generatedField: string | undefined;
  /** The known PK literals (the generated PK is absent here). */
  readonly identity: Record<string, unknown>;
  readonly writeStepId: string;
}

/**
 * A parent-held-FK to-one arm under **update** whose target is written before the
 * root parent UPDATE and referenced by it (TO-ONE.md §7.0.2 / §7.1). Unlike the
 * create-root fold (which lands in the record's own INSERT), the FK here is set by
 * the root parent UPDATE, so the target write is emitted first and its identity
 * flows backward into the UPDATE's SET. `connect`/`disconnect` stay in
 * {@link ToOneLink} (their FK literal is known at construction).
 *
 * - `create` — unconditional before-root INSERT; FK ← `ref(target.create, id)` (or
 *   a known literal). No pin (a unique violation is a genuine error).
 * - `connectOrCreate` — a global probe decides at compile: found → FK ← the where's
 *   referenced literal + a batch `exists` guard (`raceable: false`); missing →
 *   before-root INSERT (constraint + `racePin`, Pin Rule class 2) + FK ← `ref`.
 */
type ParentHeldTarget =
  | {
      readonly kind: "create";
      readonly relationName: string;
      readonly relationInfo: RelationInfo;
      readonly before: BeforeTarget;
      readonly fkAssign: Record<string, unknown>;
    }
  | {
      readonly kind: "connectOrCreate";
      readonly relationName: string;
      readonly relationInfo: RelationInfo;
      readonly probeId: string;
      readonly guardId: string;
      readonly guardProbe: Sql;
      readonly probe: StatementStep;
      readonly foundFkAssign: Record<string, unknown>;
      readonly before: BeforeTarget;
      readonly missingFkAssign: Record<string, unknown>;
      /** Withheld (`undefined`) when the selector could not establish the missing
       *  premise — see {@link childRacePin}. A `connectOrCreate` selector is strict,
       *  so today this is always present here. */
      readonly racePin: TargetConstraintPin | undefined;
    }
  // FK-holder-side (parent-held) to-one `update` under update (TO-ONE.md §7.2,
  // family A): mutate the REFERENCED target row located through the parent's own
  // FK columns (`child.<referenced> = parent.<fk>`, the FINAL fk value after any
  // same-root scalar rebind). A correlated child write — no parent-side FK change
  // — pinned in batch by the split-witness `exists` guard (V1's
  // `RelationUpdates.compileRelation` update arm + `compileLocatedUpdate`).
  | {
      readonly kind: "update";
      readonly relationName: string;
      readonly relationInfo: RelationInfo;
      readonly childScope: QueryScope;
      readonly childPrimaryKey: string;
      readonly probeId: string;
      readonly guardId: string;
      readonly writeId: string;
      readonly correlation: ParentHeldCorrelation;
      readonly probe: StatementStep;
      /** W4-U3 — the `update: { where, data }` wrapper's NON-unique filter on the
       *  currently connected record, ANDed into the locate probe AND the batch
       *  split-witness guard (never the write, which addresses the captured PK).
       *  Absent for the bare `update: <data>` spelling. */
      readonly filter?: Record<string, unknown>;
      readonly data: Record<string, unknown>;
      // T3b family A-remainder — the located target's own child Parts, built from its
      // `data` relations and correlated to its captured PK (a `planned` source on this
      // probe). The self-UPDATE reorders AFTER them on a PK transition (ON UPDATE
      // CASCADE to depth), exactly as the child-held nested update does. Empty when the
      // parent-held update's target data carries no nested relation writes.
      readonly childParts: readonly Part[];
      readonly reorderAfterChildren: boolean;
    }
  // FK-holder-side (parent-held) to-one `delete: true` (TO-ONE.md §7.2, family A):
  // NULL the parent's FK first (a parent UPDATE — V1's `assertNullable` gate), then
  // `deleteMany child WHERE <referenced> = <old fk>` (V1's `RelationRemovals.delete`
  // `holdsFK` arm). No probe: zero matched rows is V1's silent success.
  | {
      readonly kind: "delete";
      readonly relationName: string;
      readonly relationInfo: RelationInfo;
      readonly childScope: QueryScope;
      readonly nullWriteId: string;
      readonly deleteWriteId: string;
      readonly fkFields: readonly string[];
      readonly correlation: ParentHeldCorrelation;
    }
  // FK-holder-side (parent-held) to-one `upsert` (TO-ONE.md §7.2, family A): the
  // correlated probe decides at compile — found → UPDATE the located target (the
  // parent FK is already the located value, no rebind write); absent → INSERT the
  // target (before-root) and set the parent's FK to the created identity (V1's
  // `RelationBranches.compileOneUpsert` `holdsFK` arm + `updateParentForeignKey`).
  | {
      readonly kind: "upsert";
      readonly relationName: string;
      readonly relationInfo: RelationInfo;
      readonly childScope: QueryScope;
      readonly childPrimaryKey: string;
      readonly probeId: string;
      readonly guardId: string;
      readonly writeId: string;
      readonly parentSetId: string;
      readonly correlation: ParentHeldCorrelation;
      readonly probe: StatementStep;
      readonly updateData: Record<string, unknown>;
      readonly before: BeforeTarget;
      readonly missingFkAssign: Record<string, unknown>;
    };

/**
 * How a family-A (parent-held) to-one write locates its referenced target:
 * `child.<childReferencedFields[i]> = <finalFk[i]>` where `finalFk[i]` is the
 * parent's FK column value AFTER any same-root scalar rebind (V1 correlates on the
 * post-update `parentValues` for `holdsFK`). A rebound column resolves to a
 * construction-time literal (`override`); an untouched column resolves to the
 * located parent row's value (a SQL `Ref` at planning, the literal at compile).
 */
interface ParentHeldCorrelation {
  readonly childReferencedFields: readonly string[];
  readonly parentFkFields: readonly string[];
  /** parentFkField → its rebound literal, when the same root update rewrites it. */
  readonly override: Record<string, unknown>;
}

/**
 * CLASS IV (T4c) — V1's `RelationUpdates.compileRelationKeyGuards`, ported to V2's
 * guard/probe vocabulary. A root update that TRANSITIONS a parent PK a child-held,
 * NON-cascade relation references (setNull / restrict / noAction) may not leave the
 * OLD slot occupied: V1 rejects `Cannot update relation '…' with onUpdate('…') while
 * the current relation is occupied.` The transition being REAL (before ≠ after) is a
 * compile-time fact (both literals — the where-pinned pre-value and
 * `getUpdatedPrimaryKeyValue`); occupancy is the runtime premise. Transaction mode
 * inspects the locked planning probe and throws BEFORE any write; batch mode pins the
 * empty-slot decision with an `exists` guard (the concurrent-plant race). The
 * absorbed accept-shape — an EMPTY slot — creates the child with the POST-transition
 * FK after the root UPDATE (the upsert's update arm is unreachable: occupied rejects,
 * empty creates), reusing the T4b `afterRootParts` machinery.
 */
interface RelationKeyGuard {
  readonly relationName: string;
  /** The onUpdate action naming the rejection (`setNull` / `restrict` / …). */
  readonly action: string;
  readonly probeId: string;
  readonly guardId: string;
  readonly probe: StatementStep;
}

/**
 * N5-U1 — how the ADOPT family (`connect` / `connectOrCreate` / `set` / a to-many
 * `upsert`) is built under a `guarded` non-cascade referenced-PK transition. The
 * refusal this replaced said an adopt "writes a fresh FK on the pre-transition value,
 * orphaned by the referential action" — true of the ordering it had, and only of that.
 * Two facts make the shape ordinary:
 *   1. the OLD slot is proven EMPTY by the occupied guard the same relation just
 *      emitted, so nothing is being moved off a value the transition vacates; and
 *   2. the POST-transition value is a compile-time literal here (`after`).
 * So the edge is written against `after`, AFTER the root UPDATE that creates that id.
 * `correlationParentId` is the pre-transition source for the one member that reads
 * existing membership as well as writing it (`set`'s departing half).
 */
interface PostTransitionAdopt {
  /** The value an adopt edge WRITES — the parent's post-transition referenced column. */
  readonly parentId: ParentIdSource;
  /** The value an adopt member READS existing children by — the located row's own. */
  readonly correlationParentId: ReturnType<typeof plannedParentId>;
  /** The list whose writes are emitted after the root UPDATE (`afterRootParts`). */
  readonly target: Part[];
}

/**
 * The root `update` (PLAN P2a — generalized beyond the P1 upsert slice). It
 * locates a row by ANY unique `where`, applies scalar `data`, and composes any
 * mix of nested to-many `upsert`/`connect`/`disconnect` (child-held FK) plus
 * to-one `connect`/`disconnect` (parent-held FK, folded into the root SET). It
 * adds only local update semantics over the same executor, fragment vocabulary,
 * and Part composition proven in P1; every unsupported shape is a typed
 * {@link UnsupportedOperationError} raised before I/O (the routing signal).
 */
export class UpdateOperation {
  readonly mode: ExecutionMode;

  private readonly engine: QueryEngine;
  /** N4-U2 — the adopt family's fresh-arm seam, bound to this operation's scope and
   *  engine (an arrow field, so `this` survives being passed as a callback). */
  private readonly buildFreshArm: FreshArmBuilder = (input) =>
    buildFreshArmPart(this.scope, this.engine, input);
  private readonly model: Model<any>;
  private readonly scope: StepScope;
  private readonly resultArgs: Record<string, unknown>;
  private readonly childParts: readonly Part[];
  // POST-transition Parts: every child edge whose foreign key is the parent's
  // post-transition referenced value, so its WRITES must land AFTER the root UPDATE —
  // the new parent row must exist first (a NO-ACTION FK does not cascade a fresh row).
  // Two families live here: the transitioned-PK nested `create` leaves (T4b CLASS III,
  // {@link resolveCreateParent}) and, since N5-U1, the ADOPT family under a guarded
  // non-cascade transition ({@link interpretRelation}). Held apart from `childParts`,
  // which are the cascade-carried edges written BEFORE the root UPDATE. Their GUARD
  // steps are still hoisted with every other guard (a batch pins its premises first);
  // only the writes are deferred. See `compile`.
  private readonly afterRootParts: readonly Part[];
  private readonly toOneLinks: readonly ToOneLink[];
  // Parent-held to-one `create`/`connectOrCreate` under update: a before-root
  // target INSERT whose identity the root parent UPDATE's FK column references
  // (TO-ONE.md §7.0.2). Emitted between the guards and the root UPDATE at compile.
  private readonly parentHeldTargets: readonly ParentHeldTarget[];
  // CLASS IV (T4c) — the referential-action occupied guards for a non-cascade
  // child-held relation whose referenced PK the root update transitions (see
  // {@link RelationKeyGuard}). Empty for cascade / no-op transitions and for every
  // non-transitioning update.
  private readonly relationKeyGuards: readonly RelationKeyGuard[];
  // The located-parent id source (a planning read inlined at compile) — consumed by
  // the family-A parent-held correlation filters, which read/ref the parent's FK
  // columns from the located row.
  private readonly parentIdSource!: ReturnType<typeof plannedParentId>;
  // The locate read's step id, needed while the relations are being interpreted (the
  // `locate` step itself is assembled at the end of the constructor): a child-held
  // nested create whose referenced parent column no compile-time literal names threads
  // it as a `planned` parent id into that read (N1-U1).
  private readonly locateId: string;
  private readonly locate: StatementStep;
  // Whether the non-fold path emits a parent-row UPDATE (a scalar SET ∪ to-one FK
  // folds). Built at compile so it can address the captured PK (V1's `WHERE id`);
  // `false` for a relation-only update (no parent row written) or the fold path.
  private readonly needsRootUpdate: boolean;
  // Emit the root parent UPDATE AFTER the child edge writes (default: before).
  // Set only when the root SET rewrites a child-referenced column (a PK
  // transition, or a literal on a non-PK referenced unique): the child edges are
  // written against the parent's pre-transition id and the root UPDATE's
  // `ON UPDATE CASCADE` then carries them to the new value. See `compile`.
  private readonly reorderRootUpdateAfterChildren: boolean;
  // The returning-driver fast path (finding 4 / PERF.md P5): a simple update
  // (scalar `data`, no nested relation mutation, a scalar-only projection) on a
  // driver with `RETURNING` folds locate+mutate+terminal into ONE `UPDATE …
  // WHERE selector RETURNING select` — V1's `compileDirect`. Statement-atomic
  // (empty planning, exactly one step), so the executor runs it with no
  // transaction/batch envelope (isStatementAtomic → runLinearOn), enforcing the
  // affectedRows/notFound postcondition in JS after the single round-trip. The
  // fold is gated to `transaction` mode: a folded step carries a postcondition,
  // and the atomic-batch lowering (compileToEntries) does not yet enforce one, so
  // batch-only drivers keep the plan-then-execute path (whose batch guard checks
  // presence instead). `undefined` on non-returning drivers, batch mode, a
  // relation projection, or when nested relations make the mutation genuinely
  // multi-statement.
  private readonly directWrite?: StatementStep;
  private readonly updateId: string;
  private readonly parentPrimaryKeys: readonly string[];
  private readonly parentWhere: Record<string, unknown>;
  private readonly parsedSelect: Record<string, unknown>;
  private readonly parsedInclude: Record<string, unknown> | undefined;
  private readonly terminalId: string;
  private readonly rootGuardId: string;
  // The parent SET (scalar data ∪ to-one FK folds), retained so the terminal read
  // addresses the row by its POST-update primary key — a literal rename or a
  // portable arithmetic increment on a PK field moves the identity the located
  // (pre-update) row no longer answers to (the `DerivedValue` disposition, ATOM §3).
  private readonly parentUpdateData: Record<string, unknown>;
  // T3c: an upsert update arm defers its payload-legality analyses to the enclosing
  // per-arm compile (`deferArmLegality`) — V1 validates the update branch only when
  // it is taken. `undefined` for a standalone update (validated at construction).
  private readonly armLegalityChecks?: () => void;
  // X1c: this update is a nested UPDATE target spliced under an enclosing write (a
  // located-target subtree; ATOM §8.1 X1c). Its locate is CORRELATED to the enclosing
  // parent, it emits no terminal read, and it carries pre-validated data. `undefined`
  // for a standalone / upsert-arm update.
  private readonly nestedTarget?: NestedTargetLocate;
  private readonly suppressTerminal: boolean;

  constructor(
    engine: QueryEngine,
    model: Model<any>,
    args: Record<string, unknown>,
    options: SubOperationOptions = {}
  ) {
    this.engine = engine;
    this.model = model;
    this.mode = selectExecutionMode(engine, "update");
    const txMode = this.mode === "transaction";
    // T3c: an upsert's update arm reuses this operation as one arm of a larger
    // fragment, sharing the enclosing scope so no two arms collide on a step id.
    this.scope = options.scope ?? new StepScope();
    const scope = this.scope;

    // 1. Validate the argument shape. `where` locates by any unique; `data`
    //    mixes scalar assignments and nested relation mutations; `select` is
    //    optional and shapes the terminal read (Prisma's default is all scalars).
    const parentSchemas = engine.schemaRegistry.getModelSchemas(model);
    // THE one home for update's legality (X2): the whole-args `args.update` schema is
    // the front line — a missing `where`/`data`, an unknown top-level key, or an
    // unknown nested key surfaces V1's byte-identical ValidationError with no
    // pre-validate key gate shadowing it into a coarser UnsupportedOperationError.
    // V2's per-field parse path reaches
    // `separateData`'s relation-mutation parser first, so an unknown nested
    // key — a `deleteMany` on a to-one relation — surfaced V2's "Nested operation …
    // is not supported for to-one relation" where V1 rejects "Unknown key:
    // deleteMany" at schema validation, before the parent mutation. Run V1's
    // whole-args validation first so the rejection ordering AND message match.
    // As an upsert update arm (`deferArmLegality`), V1 validates the update branch
    // INSIDE the taken whenTrue branch only — an invalid UNTAKEN update branch (the
    // create arm is taken) must not reject the whole tree — so the caller runs these
    // three legality analyses per-arm via `assertArmLegality()` instead.
    // X1c: a nested UPDATE target subtree carries its ALREADY-PARSED update data — the
    // enclosing operation's relation-schema parse produced it, and that schema is the
    // target's own `core.update`, so every scalar SET and every relation payload below
    // is already in its post-transform form. It is therefore consumed AS-IS: no
    // whole-args parse here, no `where`/`select` parse, and no per-field re-parse below
    // (a transform is not idempotent — X2, and the lesson upsert's arms record). The
    // subtree locates + correlates to its enclosing parent and emits no terminal read;
    // its own-write is covered by the enclosing operation's whole-tree preflight walk.
    const nestedTarget = options.nestedTarget;
    this.nestedTarget = nestedTarget?.locate;
    this.suppressTerminal = nestedTarget !== undefined;
    const deferLegality = options.deferArmLegality === true;
    // The whole-args parse is ALSO where `omit` becomes the `select` it denotes
    // (@validation/model/args/omit), so the projection below is read from ITS
    // output: an omit-only payload has no raw `args.select` to find. Reading the
    // parsed value additionally removes a double parse — `select` used to be
    // parsed here, discarded, and parsed again from the raw args.
    const validatedArgs =
      deferLegality || nestedTarget
        ? undefined
        : parseValidated(parentSchemas.args.update, args, "update", "");
    const where = nestedTarget
      ? (nestedTarget.locate.where ?? {})
      : requireRecord(args.where, "update.where");
    const data = nestedTarget
      ? nestedTarget.data
      : requireRecord(args.data, "update.data");
    // V1 runs this in its shared `validator` (validator.ts) for every operation;
    // V2's per-schema parse path bypasses it, so a top-level PK arithmetic that
    // is not portable (float/decimal), divides by zero, or stacks operations was
    // caught late (at the terminal read's `getUpdatedPrimaryKeyWhere`, after the
    // locate ran) with V1's OTHER message. Run it at construction, before any I/O.
    if (!deferLegality) {
      assertPortablePrimaryKeyUpdateInput(model, "update", { data });
    }
    const parent = createQueryScope(engine.adapter, model);
    const separated = separateData(parent, data);

    const parentPrimaryKeys = getPrimaryKeyFields(model);
    if (parentPrimaryKeys.length === 0) {
      // Unreachable by construction (N7-U-A, the X1c disposition): a model with no PK has
      // no discriminator in its `whereUnique`, so the whole-args parse above answers first
      // with `ValidationError: Missing required field: one of …` (and `where: {}` with
      // "Object cannot be empty"). §3.A A16 states every model must have a PK; this line
      // is that invariant, not a route.
      throw new QueryEngineError(
        "query-engine-v2 internal: update reached a model with no primary key; the where-unique parse admits none."
      );
    }
    // Compound primary keys are supported: the locate reads and terminal read
    // carry every PK field, and the child FK edges reference them per-field.
    this.parentPrimaryKeys = parentPrimaryKeys;

    // V1's relation-key legality (RelationUpdates.assertRelationKeyUpdatesAre-
    // Compilable, ported verbatim): a relation-key field — the FK column when the
    // parent holds it, else the parent column a child FK references (a non-PK
    // unique like `code`) — cannot be rewritten by a non-literal arithmetic op
    // while that relation is mutated, because the DerivedValue would desync the
    // edge. Both substrates, before any effect. V2 previously only rejected the
    // holds-FK case by routing to-one update/upsert to V1; the child-holds-FK
    // referenced-field case (a supported one-to-many update) reached no check.
    if (deferLegality) {
      // Retained for the caller's per-arm invocation (the upsert's whenTrue branch).
      this.armLegalityChecks = () => {
        parseValidated(parentSchemas.args.update, args, "update", "");
        assertPortablePrimaryKeyUpdateInput(model, "update", args);
        assertRelationKeyUpdatesAreCompilable(
          parent,
          separated.scalarData,
          separated.relations
        );
        this.assertUpdateManyRelationLegality(separated.relations);
      };
    } else {
      assertRelationKeyUpdatesAreCompilable(
        parent,
        separated.scalarData,
        separated.relations
      );
      // CLASS V (T4c) — V1's `assertUpdateManyDataIsCompilable`, reused: a nested
      // relation write inside `updateMany` data rejects (byte-identical) BEFORE the
      // parent mutation. Runtime-branch-gated inside an upsert update arm (the
      // deferred branch above), so a missing-target upsert taking the create arm never
      // validates it.
      this.assertUpdateManyRelationLegality(separated.relations);
    }

    // A nested target's `where` (a child-held to-many `update` selector) is already
    // validated by the enclosing tree parse — re-parsing a transformed value is
    // non-idempotent (X2); a parent-held / to-one target has no `where` at all (it
    // locates by correlation alone), so `{}` is its non-selector. The standalone /
    // upsert-arm path parses its user `where` through the EXTENDED whereUnique
    // schema (W4-U1): a top-level `where` may carry non-unique scalar filters and
    // AND/OR/NOT alongside its discriminator. A NESTED target keeps the strict
    // one — and reaches this branch already validated by the enclosing parse.
    this.parentWhere = nestedTarget
      ? where
      : parseValidated(
          parentSchemas.core.whereUniqueExtended,
          where,
          "update",
          "where"
        );
    // The projection comes from the whole-args parse when there was one — that
    // parse is where `omit` became the `select` it denotes, so an omit-only
    // payload has nothing to find in the raw args. The two paths that skip it
    // read the args as given: an upsert update ARM is handed its parent's
    // already-parsed projection, and a nested target carries none at all.
    const projectionArgs = validatedArgs ?? (nestedTarget ? undefined : args);
    const projectedSelect = projectionArgs?.select;
    const projectedInclude = projectionArgs?.include;
    this.parsedSelect = isRecord(projectedSelect)
      ? projectedSelect
      : defaultSelect(model);
    // `include` rides alongside the (default or explicit-scalar) projection —
    // the same result-shaping surface `create` owns. A relation projection forces
    // the proven terminal-read path (below): lateral joins, not the RETURNING fold.
    // A nested target emits no terminal read, so it carries no projection.
    this.parsedInclude = isRecord(projectedInclude)
      ? projectedInclude
      : undefined;
    this.resultArgs = {
      select: this.parsedSelect,
      ...(this.parsedInclude ? { include: this.parsedInclude } : {}),
    };

    // 2. Own-write preflight (ATOM §4): any decision read overlapping this
    //    operation's own writes is rejected here with V1's typed "split these
    //    operations" error, before planning — identically on both substrates. As
    //    an upsert update arm the caller runs this per-arm at compile (V1 checks it
    //    inside the whenTrue branch only), so it is skipped here.
    if (!(options.skipOwnWrite || nestedTarget)) {
      new OwnWritePreflight().assertUpdate(parent, data, where);
    }

    const parentName = getStepModelName(model, "parent");
    const locateId = scope.allocate(`${parentName}.locate`);
    this.locateId = locateId;
    const updateId = scope.allocate(`${parentName}.update`);
    this.updateId = updateId;
    this.terminalId = scope.allocate(`${parentName}.select`);
    this.rootGuardId = scope.allocate(`${parentName}.guard.exists`);

    // 3. Interpret each nested relation into a to-many child Part or a to-one
    //    root-SET fold. The parent-id every child arm consumes is the located
    //    id — a planning value inlined at compile (the correlated disconnect
    //    probe additionally refs it in SQL: technique #1).
    const parentIdSource = plannedParentId(
      locateId,
      this.parentPrimaryKeys[0]!
    );
    this.parentIdSource = parentIdSource;
    const childParts: Part[] = [];
    // T4b CLASS III + N5-U1 — the post-transition Parts collect here (see the field
    // comment): transitioned-PK creates and the guarded adopt family, both writing the
    // POST-transition referenced value and both emitted after the root UPDATE.
    const afterRootParts: Part[] = [];
    const toOneLinks: ToOneLink[] = [];
    const parentHeldTargets: ParentHeldTarget[] = [];
    const relationKeyGuards: RelationKeyGuard[] = [];
    // Every parent column a child FK edge references must be exposed by the
    // locate read (a compound edge references several; a D4-style edge references
    // a non-PK unique). Collected here, unioned with the PK, and selected +
    // exposed as firstRowField outputs below so a per-field child part can read
    // each referenced value (compile literal) or ref it (planning correlation).
    const locateFields = new Set<string>(this.parentPrimaryKeys);
    // The parent's OWN FK columns a family-A (parent-held) to-one arm correlates on
    // (`child.<referenced> = parent.<fk>`). Selected by the locate read like
    // `locateFields`, but held SEPARATELY: these columns are NOT child-referenced, so
    // they must NOT drive `reorderRootUpdateAfterChildren` (a self-relation FK rebind
    // like `partnerId` is the parent's own column; reordering the root UPDATE after a
    // sibling child write would race an unfreed UNIQUE value — the inverse holder).
    const parentFkLocateFields = new Set<string>();
    for (const [relationName, mutation] of Object.entries(
      separated.relations
    )) {
      const relationSchemas = parentSchemas.relations[relationName];
      if (!relationSchemas) {
        // Unreachable by construction (N7-U-A, the X1c disposition): `separated.relations`
        // is keyed by `isRelation(model, key)` / `getRelationInfo` and
        // `parentSchemas.relations` by `getRelationsSchemas`, and BOTH enumerate the same
        // `model["~"].state.relations`. A key present in one is present in the other; there
        // is no payload that spells a relation the registry has no schema for. An engine
        // invariant, not a route — this one has no public spelling at all.
        throw new QueryEngineError(
          `query-engine-v2 internal: no validation schema exists for relation '${relationName}', which the model's own relation set declares.`
        );
      }
      // THE ONE transform of this relation payload. A standalone update holds the RAW
      // `data` (the whole-args parse above validates and its output is discarded), and
      // an upsert update arm has no whole-args parse at all, so for both the relation
      // schema here is where the payload is narrowed AND transformed — exactly once.
      // X1c: a nested target holds the ENCLOSING parse's OUTPUT, which already ran THIS
      // schema over this key (a target's `core.update` carries its relations' `update`
      // entries), so it is consumed as-is. Re-parsing a transformed value is not a
      // no-op: a JSON write's `{ set: … }` envelope is itself a legal JSON document, so
      // a second pass wraps it AGAIN and the ORM's envelope lands in the user's column,
      // and a JSON null sentinel fails the second pass outright. Parse once (X2, and
      // the same lesson upsert's arms record) — never re-parse parsed data.
      const parsedRelation = nestedTarget
        ? mutation.payload
        : parseValidated(
            relationSchemas.update,
            data[relationName],
            "update",
            `data.${relationName}`
          );
      this.interpretRelation({
        scope,
        parent,
        relationName,
        mutation,
        parsedRelation,
        parentIdSource,
        txMode,
        childParts,
        afterRootParts,
        toOneLinks,
        parentHeldTargets,
        relationKeyGuards,
        locateFields,
        parentFkLocateFields,
        rootScalarData: separated.scalarData,
      });
    }
    this.childParts = childParts;
    this.afterRootParts = afterRootParts;
    this.toOneLinks = toOneLinks;
    this.parentHeldTargets = parentHeldTargets;
    this.relationKeyGuards = relationKeyGuards;

    // 4. The parent SET = validated scalar data ∪ to-one FK folds. Emitted only
    //    when non-empty (a relation-only update never writes the parent row;
    //    Prisma's `update({ data: { posts: { connect } } })`).
    const parentSet: Record<string, unknown> = {};
    if (Object.keys(separated.scalarData).length > 0) {
      Object.assign(
        parentSet,
        // The same parse-once rule the relation payloads follow: a nested target's
        // scalar SET is ALREADY this schema's output (the enclosing tree parse ran the
        // target's `core.update` over it), so it is assigned as-is. A second pass over
        // a JSON write's `{ set: … }` envelope re-wraps it into the column.
        nestedTarget
          ? separated.scalarData
          : parseValidated(
              parentSchemas.core.scalarUpdate,
              separated.scalarData,
              "update",
              "data"
            )
      );
    }
    for (const link of toOneLinks) Object.assign(parentSet, link.assignment);
    this.parentUpdateData = parentSet;

    // Reorder the root UPDATE after the child edge writes when the SET rewrites a
    // column some child FK references (the located fields are the PK ∪ every
    // child-referenced column). A child edge written against the pre-transition id
    // is then carried to the new value by the FK's `ON UPDATE CASCADE`, so a
    // self-M2M junction / a reparent never strands on the vacated id. No child
    // parts → nothing to reorder around.
    this.reorderRootUpdateAfterChildren =
      childParts.length > 0 &&
      [...locateFields].some((field) => Object.hasOwn(parentSet, field));

    // Fast path (finding 4): a simple update — no nested relation mutation
    // (no child Parts, no to-one FK folds) with a non-empty scalar SET and a
    // scalar-only projection — on a RETURNING driver is V1's `compileDirect`: one
    // `UPDATE … WHERE selector RETURNING select`, the updated row (incl. any PK
    // the SET rewrote) coming straight back. No locate, no terminal, no envelope.
    // Gated to a scalar-only `select`: for scalars `buildUpdate`'s RETURNING
    // projection and the terminal `buildFindUnique` projection are the same
    // columns, so the parsed result is byte-identical; a relation projection
    // (lateral joins vs RETURNING subqueries) keeps the proven terminal-read
    // path. Gated to `transaction` mode: the folded step's postcondition has no
    // atomic-batch lowering yet (compileToEntries), so batch-only drivers keep
    // plan-then-execute (their batch guard checks presence).
    const selectIsScalarOnly = !Object.keys(this.parsedSelect).some((field) =>
      model["~"].relationSet.has(field)
    );
    const canFold =
      txMode &&
      // X1c: a nested target emits no terminal read and must LOCATE + CORRELATE (its
      // membership in the enclosing parent is verified by the locate) — never the
      // single-statement RETURNING fold, which skips both the locate and the terminal.
      !this.suppressTerminal &&
      engine.adapter.capabilities.supportsReturning &&
      childParts.length === 0 &&
      // A transitioned-PK create (T4b CLASS III) is a real second statement that
      // the single-statement RETURNING fold cannot carry — never fold past one.
      afterRootParts.length === 0 &&
      toOneLinks.length === 0 &&
      parentHeldTargets.length === 0 &&
      selectIsScalarOnly &&
      !this.parsedInclude &&
      Object.keys(parentSet).length > 0;
    this.directWrite = canFold
      ? {
          id: updateId,
          kind: "write",
          statement: buildUpdate(parent, {
            where: this.parentWhere,
            data: parentSet,
            select: this.parsedSelect,
          }),
          outputs: { result: { kind: "rows" } },
          expects: affectedRows(
            1,
            notFoundFailure(
              `query-engine-v2 update located no '${parentName}' row for its unique where.`
            )
          ),
        }
      : undefined;
    // A parent-held `create`/`connectOrCreate` folds its FK into the root UPDATE at
    // compile (the value is a `Ref`, or a found/missing decision), so the parent
    // UPDATE is needed even when the construction-time `parentSet` is empty. The
    // family-A `update`/`delete`/`upsert` arms emit their OWN parent/child writes
    // (never a root-SET fold), so they do not force a root UPDATE — a pure such arm
    // with an empty `parentSet` must not build an empty-SET root UPDATE.
    this.needsRootUpdate =
      !this.directWrite &&
      (Object.keys(parentSet).length > 0 ||
        parentHeldTargets.some(
          (target) =>
            target.kind === "create" || target.kind === "connectOrCreate"
        ));

    // 5. The locate planning read. It carries the `notFound` postcondition on
    //    BOTH substrates (enforced by the executor during planning): a missing
    //    root aborts before any write AND before any correlated child probe can
    //    dereference a located id that does not exist (ATOM §8.1 note (a)/(b)).
    // The SELECT unions the child-referenced fields (reorder-relevant) with the
    // parent-held FK columns (family-A correlation, reorder-irrelevant).
    const locateSelectFields = [
      ...new Set<string>([...locateFields, ...parentFkLocateFields]),
    ];
    // X1c: a nested target's locate is CORRELATED to its enclosing parent — the
    // target's own unique `where` (child-held to-many; empty for a to-one / parent-held
    // target) ANDed with `child.<childField> = parent.<referenced>` (a SQL `Ref` to the
    // enclosing locate for a `planned` parent — technique #1 — or an inlined literal).
    // A cross-parent selector finds no row, so the not-found is the target's own
    // `Cannot … relation … for this parent`, byte-identical to the located-target leaf.
    const locateStatement = this.nestedTarget
      ? buildFind(
          parent,
          {
            where: {
              AND: [
                ...this.nestedTargetWhereFilters(parent),
                ...this.nestedTargetCorrelationFilters(undefined, true),
              ],
            },
            select: Object.fromEntries(
              locateSelectFields.map((field) => [field, true])
            ),
            forUpdate: txMode,
          },
          { limit: 1 }
        )
      : buildFindUnique(parent, {
          where: this.parentWhere,
          select: Object.fromEntries(
            locateSelectFields.map((field) => [field, true])
          ),
          forUpdate: txMode,
        });
    const locateNotFound = this.nestedTarget
      ? nestedWriteFailure(
          this.nestedTarget.notFoundMessage,
          this.nestedTarget.relationName,
          false
        )
      : notFoundFailure(
          `query-engine-v2 update located no '${parentName}' row for its unique where.`
        );
    this.locate = {
      id: locateId,
      kind: "read",
      statement: locateStatement,
      // Each PK field AND each child-FK-referenced field is a firstRowField
      // output so a per-field child FK edge can ref it (compound keys / D4-style
      // non-PK references — the census's multi-field produces). As an upsert update
      // arm (`locateNotFoundOptional`) the create arm may leave the parent absent, so
      // these firstRowField outputs are optional — an untaken update arm's superset
      // locate must not fail planning on the empty result (T4c).
      outputs: {
        rows: { kind: "rows" },
        ...Object.fromEntries(
          locateSelectFields.map((field) => [
            field,
            {
              kind: "firstRowField",
              field,
              ...(options.locateNotFoundOptional ? { optional: true } : {}),
            },
          ])
        ),
      },
      // As an upsert update arm the located-miss is the CREATE decision (the
      // enclosing upsert's own locate decides the branch), not a not-found error,
      // so the postcondition is dropped — planning must not abort on an absent row.
      // A nested target's miss is its own `Cannot … relation … for this parent`
      // (`locateNotFound`, byte-identical to the located-target leaf), on BOTH
      // substrates, before any correlated grandchild probe dereferences it.
      ...(options.locateNotFoundOptional
        ? {}
        : { expects: exactlyOneRow(locateNotFound) }),
    };
  }

  planning(): OperationFragment {
    // The RETURNING fold is a single self-contained statement — no planning read
    // (the located id it would carry is unused; the RETURNING clause returns the
    // mutated row directly). Empty planning is what makes it statement-atomic.
    if (this.directWrite) return { steps: [], outputs: {} };
    const steps: OperationStep[] = [this.locate];
    // CLASS IV (T4c): the occupied-guard probes read the OLD slot (correlated on the
    // pre-transition parent value), locked in tx mode so the compile-time occupancy
    // verdict is pinned by the same lock the locate holds.
    for (const guard of this.relationKeyGuards) steps.push(guard.probe);
    for (const link of this.toOneLinks) {
      if (link.connect) steps.push(link.connect.probe);
    }
    for (const target of this.parentHeldTargets) {
      if (
        target.kind === "connectOrCreate" ||
        target.kind === "update" ||
        target.kind === "upsert"
      ) {
        steps.push(target.probe);
      }
      // A parent-held `update` whose located target carries nested relation writes
      // (family A-remainder): its child Parts plan their probes here, correlated to
      // the target's captured PK by a `planned` source on `target.probe`.
      if (target.kind === "update") {
        for (const part of target.childParts) {
          steps.push(...part.planning(this.scope));
        }
      }
    }
    for (const part of this.childParts)
      steps.push(...part.planning(this.scope));
    // N5-U1: the post-transition Parts plan like any other — their probes are global
    // target lookups (a connect's `WHERE unique`, an adopt's widened read), none of
    // which depends on the parent's referenced value, so planning them here is
    // independent of the fact that their WRITES land after the root UPDATE. The T4b
    // create leaves that share this list plan nothing (empty planning), so this loop is
    // a no-op for them and the pre-N5 step stream is byte-identical.
    for (const part of this.afterRootParts)
      steps.push(...part.planning(this.scope));
    return { steps, outputs: planningOutputs(steps) };
  }

  compile(known: Readonly<Record<string, unknown>>): OperationFragment {
    // The RETURNING fold compiles to its one write step regardless of `known`
    // (it consumes no planning value): the `UPDATE … WHERE selector RETURNING
    // select` locates, mutates, and returns the row in one statement, with the
    // affectedRows/notFound postcondition enforced by the executor after it runs.
    if (this.directWrite) {
      return {
        steps: [this.directWrite],
        outputs: { result: ref(this.updateId, "result") },
      };
    }
    // Defensive: the locate's postcondition already aborts a missing root at
    // planning; this keeps compile fail-closed if it is ever called directly.
    const locateRows = known[planningKey(this.locate.id, "rows")];
    if (!Array.isArray(locateRows)) {
      throw new QueryEngineError(
        "query-engine-v2 update planning did not expose the locate rows."
      );
    }
    if (locateRows.length === 0) {
      if (this.nestedTarget) {
        throw new NestedWriteError(
          this.nestedTarget.notFoundMessage,
          this.nestedTarget.relationName
        );
      }
      throw new NotFoundError(getStepModelName(this.model, "record"), "update");
    }
    const locatedRow = locateRows[0] as Record<string, unknown>;

    // Build-don't-select (P1.2): to-one connect checks + child arms construct
    // their taken steps; the shared root update and deep terminal read emit once.
    // Guards hoist ahead of every write (batch pins premises first).
    const guards: OperationStep[] = [];
    const writes: OperationStep[] = [];
    // Batch mode pins the root's presence inside the atomic unit (ATOM §8.1 note
    // (b)): the affectedRows/notFound postcondition the tx path checks on the
    // root write, lowered to an adapter-owned exists assertion. It closes the
    // staleness window between the unlocked locate read and the batch; a
    // concurrent delete aborts the batch typed instead of a silent empty result.
    if (this.mode === "batch") {
      guards.push(this.buildRootPresenceGuard(known, locatedRow));
    }
    // CLASS IV (T4c): the referential-action occupied guards. The transition is real
    // (before != after, decided at construction). tx mode inspects the locked probe
    // and throws V1's byte-identical `NestedWriteError` before any write; batch mode
    // pins the empty-slot decision with an `exists` guard that aborts the atomic unit
    // if the slot is occupied (the concurrent-plant race).
    this.compileRelationKeyGuards(known, guards);
    for (const link of this.toOneLinks) {
      guards.push(...this.compileToOneConnect(link, known));
    }
    // Parent-held `create`/`connectOrCreate`: the target INSERT(s) that must land
    // BEFORE the root UPDATE, and the FK folds the UPDATE's SET absorbs (TO-ONE.md
    // §7.0.2). The root UPDATE references the (possibly just-inserted) identity.
    const beforeRootWrites: OperationStep[] = [];
    const rootExtraSet = this.compileParentHeldTargets(
      known,
      locatedRow,
      guards,
      beforeRootWrites,
      writes
    );
    for (const part of this.childParts) {
      for (const step of part.compile(this.scope, known)) {
        (step.kind === "guard" ? guards : writes).push(step);
      }
    }
    // The post-transition Parts (T4b create leaves + N5-U1's guarded adopt family).
    // Their GUARDS join every other guard at the front — a batch pins its premises
    // before any write, and every premise these Parts assert (the connect target
    // exists; the departing set is empty) is a fact about rows the root UPDATE does
    // not touch, so hoisting it past that UPDATE changes nothing it asserts. Their
    // WRITES are held back and appended after the root UPDATE below.
    const afterRootWrites: OperationStep[] = [];
    for (const part of this.afterRootParts) {
      for (const step of part.compile(this.scope, known)) {
        (step.kind === "guard" ? guards : afterRootWrites).push(step);
      }
    }
    const steps: OperationStep[] = [...guards, ...beforeRootWrites];
    const rootUpdate = this.needsRootUpdate
      ? this.buildRootUpdate(locatedRow, rootExtraSet)
      : undefined;
    // A root SET that rewrites a child-referenced column (a PK transition
    // `id: 2`, or a literal on a non-PK referenced unique) must land AFTER the
    // child edge writes: a self-M2M junction row / a child reparent references the
    // parent by its CURRENT (pre-transition) value, so the edge is written first
    // against the located id and the root UPDATE's `ON UPDATE CASCADE` then carries
    // it to the new value. Emitting the root UPDATE first would strand the edge on
    // an id the transition just vacated (ForeignKeyError where V1 succeeds).
    // Correlation stays on the pre-transition value — the row still holds the old
    // FK until the cascade fires, so a nested update/delete of an existing member
    // matches by the located id, not the post-transition one.
    if (rootUpdate && !this.reorderRootUpdateAfterChildren) {
      steps.push(rootUpdate);
    }
    steps.push(...writes);
    if (rootUpdate && this.reorderRootUpdateAfterChildren) {
      steps.push(rootUpdate);
    }
    // T4b CLASS III + N5-U1 — every write whose foreign key is the POST-transition
    // referenced value lands here: the transitioned-PK create INSERTs, and the guarded
    // adopt family's reparent UPDATEs. They must follow the root UPDATE, which is what
    // makes the new parent row exist (a NO-ACTION foreign key does not cascade a fresh
    // or reparented row onto an id the transition has not written yet).
    if (this.afterRootParts.length > 0) {
      if (!rootUpdate) {
        throw new QueryEngineError(
          "query-engine-v2 update built a post-transition child write with no root UPDATE to run before it."
        );
      }
      steps.push(...afterRootWrites);
    }
    // X1c: a nested target contributes only its writes/guards; the enclosing operation
    // owns the terminal read and the result (no double refetch, no cross-fragment ref).
    if (this.suppressTerminal) {
      return { steps, outputs: {} };
    }
    steps.push(this.buildTerminal(locatedRow));
    return { steps, outputs: { result: ref(this.terminalId, "result") } };
  }

  parse<T>(outputs: Readonly<Record<string, unknown>>): T {
    if (!Object.hasOwn(outputs, "result")) {
      throw new QueryEngineError(
        "query-engine-v2 update did not expose its result."
      );
    }
    return new ResultParser(
      this.engine.adapter,
      this.model,
      this.engine.driver,
      this.engine.decimalDecode
    ).parse<T>("update", outputs.result, this.resultArgs);
  }

  /** Run the deferred payload-legality analyses of an upsert update arm (T3c). The
   *  enclosing upsert calls this only on the taken found branch — V1's whenTrue
   *  timing — so an invalid untaken update branch never rejects the whole tree. */
  assertArmLegality(): void {
    this.armLegalityChecks?.();
  }

  /**
   * CLASS V (T4c) — V1's `RelationUpdates.assertUpdateManyDataIsCompilable`, reused:
   * a nested relation write inside a to-many relation's `updateMany` data is
   * inexpressible; reject with V1's byte-identical `NestedWriteError` before any
   * effect. Mirrors `compileRelation`, which separates each updateMany input's data
   * and runs the check. The offending `updateMany` Part is skipped at interpretation
   * ({@link updateManyCarriesRelations}); this owns the rejection, immediate at
   * construction (a plain update) or deferred to the taken upsert branch.
   */
  private assertUpdateManyRelationLegality(
    relations: Record<string, RelationMutation>
  ): void {
    for (const mutation of Object.values(relations)) {
      const updateMany = mutation.updateMany;
      if (updateMany === undefined) continue;
      const childScope = createQueryScope(
        this.engine.adapter,
        mutation.relationInfo.targetModel
      );
      const inputs = Array.isArray(updateMany) ? updateMany : [updateMany];
      for (const input of inputs) {
        if (!(isRecord(input) && isRecord(input.data))) continue;
        const { relations: nested } = separateData(childScope, input.data);
        assertUpdateManyRelationsAreCompilable(
          mutation.relationInfo.name,
          nested
        );
      }
    }
  }

  /**
   * CLASS IV (T4c) — emit V1's referential-action occupied guards (see
   * {@link RelationKeyGuard}). Transaction mode inspects the locked planning probe and
   * throws BEFORE any write when the OLD slot is occupied; batch mode pins the
   * empty-slot decision with an `exists` guard (the concurrent-plant race). The
   * message is V1's `relationFailure` verbatim: `Cannot update relation '…' with
   * onUpdate('…') while the current relation is occupied.`.
   */
  private compileRelationKeyGuards(
    known: Readonly<Record<string, unknown>>,
    guards: OperationStep[]
  ): void {
    for (const guard of this.relationKeyGuards) {
      const message = relationKeyOccupiedMessage(
        guard.relationName,
        guard.action
      );
      if (this.mode === "batch") {
        // V1's `notExistsWhenChanged` premise: assert the OLD slot is EMPTY; the batch
        // aborts (rejects "occupied") if a row exists — a `notExists` guard whose
        // materialized condition a concurrent plant can invalidate, so `raceable: true`
        // (the empty-slot race; the validator requires it of every notExists guard).
        guards.push(
          absenceGuard(
            guard.guardId,
            guard.probe.statement,
            nestedWriteFailure(message, guard.relationName, true)
          )
        );
        continue;
      }
      const rows = known[planningKey(guard.probeId, "rows")];
      if (Array.isArray(rows) && rows.length > 0) {
        throw new NestedWriteError(message, guard.relationName, {
          meta: { operation: "update", relation: guard.relationName },
        });
      }
    }
  }

  // -------------------------------------------------------------------------

  private interpretRelation(input: {
    scope: StepScope;
    parent: QueryScope;
    relationName: string;
    mutation: RelationMutation;
    parsedRelation: Record<string, unknown>;
    parentIdSource: ReturnType<typeof plannedParentId>;
    txMode: boolean;
    childParts: Part[];
    afterRootParts: Part[];
    toOneLinks: ToOneLink[];
    parentHeldTargets: ParentHeldTarget[];
    /** CLASS IV (T4c) — collected occupied guards for a non-cascade child-held
     *  relation whose referenced PK the root update transitions. */
    relationKeyGuards: RelationKeyGuard[];
    locateFields: Set<string>;
    /** Parent-held FK columns a family-A arm correlates on — selected but NOT
     *  reorder-relevant (see the constructor's `parentFkLocateFields`). */
    parentFkLocateFields: Set<string>;
    /** The root update's validated scalar writes — used to detect a concurrent
     *  referenced-key transition (a write to a parent column a child FK references)
     *  that puts a nested arm on V1's referential-legality path (§7.2). */
    rootScalarData: Record<string, unknown>;
  }): void {
    const { relationName, mutation, parsedRelation } = input;
    const relationInfo = mutation.relationInfo;
    const kinds = getRelationMutationKinds(mutation);

    if (relationInfo.type === "manyToMany") {
      // Many-to-many is not special (WHY §4.3): junction as ordinary Parts. Each
      // membership kind is a leaf feeding the same step vocabulary; the whole
      // family lives in one file, never an `M2M*` subsystem.
      const engine = this.engine;
      const scope = input.scope;
      input.childParts.push(
        ...buildJunctionParts({
          scope,
          engine,
          parentScope: input.parent,
          relationName,
          relationInfo,
          mutation,
          parsedRelation,
          parentId: input.parentIdSource,
          txMode: input.txMode,
          // T3b-2 (family C): a junction create/update/upsert target whose data
          // carries its own relations folds them one level deeper through the same
          // literal-parent builder the child-held families use (mechanism 1 reuse for
          // located update targets; mechanism 2 fresh-parent elision for create arms).
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

    const fk = getFkDirection(input.parent, relationInfo);

    if (fk.holdsFK) {
      // A parent-held FK is a same-row change. `connect`/`disconnect` fold their
      // (construction-known) FK literal into the root SET; `create`/`connectOrCreate`
      // write the target before the root UPDATE and reference its identity from the
      // UPDATE's SET (TO-ONE.md §7.0.2). Only one kind per to-one relation.
      if (kinds.length !== 1) {
        throw new UnsupportedOperationError(
          `query-engine-v2 update supports one mutation kind on the to-one relation '${relationName}'; it has ${kinds.join(", ") || "none"}.`
        );
      }
      this.interpretParentHeldToOne(
        input,
        relationName,
        relationInfo,
        fk,
        kinds[0]!
      );
      return;
    }

    // Child-held direction (the target holds the FK). One-to-many is the plural
    // case; the **inverse-side one-to-one** is its arity-1 case (TO-ONE.md §7.0.1)
    // — the same correlated/global-adopt child writes, differing only in the to-one
    // payload spelling (`update: <data>` with no selector, `disconnect: true`).
    // The parent exists, so no fresh-parent elision: every probe reads committed
    // state, exactly as the to-many family already does under update.
    const isInverseToOne = relationInfo.isToOne;
    if (!(isInverseToOne || relationInfo.type === "oneToMany")) {
      // Unreachable by construction (N7-U-A, the X1c disposition): `RelationInfo.type` is
      // the four-value union `oneToOne | oneToMany | manyToOne | manyToMany`. `manyToMany`
      // was dispatched to the junction above and the parent-held direction to
      // `interpretParentHeldToOne`; `oneToOne` and `manyToOne` both carry `isToOne`, and
      // `oneToMany` is named outright. The predicate is therefore false for every member of
      // the union that can arrive — an engine invariant, not a route, and one with no
      // public spelling (unlike `CreateOperation`'s narrower `type !== oneToOne` twin,
      // which a fields-less `manyToOne` DOES reach).
      throw new QueryEngineError(
        `query-engine-v2 internal: relation '${relationName}' reached the child-held update dispatch as '${relationInfo.type}', which is neither to-one nor one-to-many.`
      );
    }
    // Compound foreign keys are per-field (ATOM §1): every referenced parent
    // column — the PK, a subset of it, or a non-PK unique (D4-style) — is added
    // to the locate read's select/outputs so a per-field child part reads or refs
    // each one. The whole family (link/adopt/write/set) generalizes together; no
    // shape routes to V1 on account of compound arity any longer.
    //
    // T3b-2 (family E): a nested `create`/`createMany` resolves its FK from the
    // update's own inputs (the referenced column pinned by the unique `where`, or
    // rewritten by the root SET — D4), NOT from the located row, so a create-ONLY
    // relation adds no referenced column to `locateFields`. This keeps the D4 order
    // correct: the root UPDATE stays reorder-FALSE (before the child INSERT), so the
    // fresh row references the post-transition value that already exists.
    const needsLocatedReference = kinds.some(
      (mutationKind) =>
        mutationKind !== "create" && mutationKind !== "createMany"
    );
    if (needsLocatedReference) {
      for (const field of fk.pkFields) input.locateFields.add(field);
    }
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const childPrimaryKeys = getPrimaryKeyFields(childScope.model);
    if (childPrimaryKeys.length !== 1) {
      throw new UnsupportedOperationError(
        `query-engine-v2 update requires a child with one primary key for relation '${relationName}'.`
      );
    }
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    // CLASS IV (T4c-fix) — V1's relation-level occupied guard for a non-cascade
    // referenced-PK transition, emitted ONCE for the relation before the per-kind
    // dispatch (kind- and cardinality-agnostic, exactly as V1). It rejects an occupied
    // OLD slot for any nested mutation, declines an adopt kind / a past-surface
    // reference (route to V1), and tells the to-one upsert to reroute its create arm.
    const keyTransition = this.interpretReferencedKeyTransition({
      input,
      relationName,
      fk,
      childScope,
      childName,
    });
    if (keyTransition.regime === "pastSurface") {
      // A real transition past the reproduced single-PK surface (a compound / non-PK /
      // unpinned reference). Only nested `create` / `createMany` proceed — their FK
      // literal (incl. a non-PK D4 rewrite) is resolved by `resolveLiteralCreateParent`
      // against the empty-slot accept. Every other kind needs V1's occupied guard on a
      // pre-transition value V2 cannot compile-correlate — route the whole tree to V1.
      for (const kind of kinds) {
        if (kind !== "create" && kind !== "createMany") {
          throw new UnsupportedOperationError(
            `query-engine-v2 update does not support a nested '${kind}' on the child-held relation '${relationName}' while the root update transitions a compound / non-PK / unpinned referenced column.`
          );
        }
      }
    }
    // N5-U1 — the ADOPT family under a guarded non-cascade transition. The occupied
    // guard just emitted proves the OLD slot is empty, so an adopt edge has exactly
    // one correct target: the parent's POST-transition referenced value. That value is
    // compile-known here (`after`, derived by `getUpdatedPrimaryKeyValue` from the
    // where-pinned pre-value and the root SET's operand — the same derivation the T4b
    // create leaf and the to-one upsert create-arm reroute already trust), and the
    // WRITE is deferred until after the root UPDATE, which is what makes the row it
    // points at exist. Ordering closes this family; no new expressiveness was needed.
    const adopt: PostTransitionAdopt | undefined =
      keyTransition.regime === "guarded"
        ? {
            parentId: literalParentId(keyTransition.after),
            correlationParentId: input.parentIdSource,
            target: input.afterRootParts,
          }
        : undefined;
    const engine = this.engine;
    const writeBase = {
      scope: input.scope,
      engine,
      relationName,
      relationInfo,
      childName,
      childScope,
      fkFields: fk.fkFields,
      referencedFields: fk.pkFields,
      childPrimaryKey: childPrimaryKeys[0]!,
      parentId: input.parentIdSource,
      txMode: input.txMode,
      // T3b mechanism 1: a targeted nested `update` whose located target data carries
      // its own relations folds them one level deeper (family B). The seam captures
      // this operation's scope + engine; depth adds list entries, never vocabulary.
      nestedBuilder: (
        targetScope: QueryScope,
        parentId: ParentIdSource,
        relations: Record<string, RelationMutation>,
        txMode: boolean
      ) =>
        buildNestedTargetChildParts(
          input.scope,
          engine,
          targetScope,
          relations,
          parentId,
          txMode
        ),
      // N4-U2: the inverse-side to-one upsert's relation-carrying create arm is a
      // create subtree, built through the same seam the to-many adopt family uses.
      freshArm: this.buildFreshArm,
    } as const;

    // Multiple mutation kinds may coexist on one relation (V1's `{ delete,
    // deleteMany }`, `{ update, updateMany }`, …). Each present kind contributes
    // its own Part(s); they compose into the one linear fragment in a stable,
    // V1-mirroring order (link/adopt, then removals, then updates).
    for (const kind of kinds) {
      if (isInverseToOne) {
        this.interpretInverseToOneKind({
          kind,
          relationName,
          relationInfo,
          fk,
          parsedRelation,
          childScope,
          childName,
          childPrimaryKey: childPrimaryKeys[0]!,
          fkFields: fk.fkFields,
          referencedFields: fk.pkFields,
          writeBase,
          input,
          keyTransition,
          adopt,
        });
        continue;
      }
      // T3b-2 (family E): a nested `create`/`createMany` under the update root on a
      // child-held to-many. The located parent's FK is a construction-time literal
      // (the referenced column pinned by the unique `where`, or rewritten by the root
      // SET — D4's "thread the new value"), so it reuses the same literal-parent create
      // leaf the child-held recursion uses. A referenced column resolvable only from the
      // located row (a planned FK), a compound key, or a non-literal rewrite routes to V1.
      if (kind === "create" || kind === "createMany") {
        this.interpretChildHeldCreate({
          kind,
          relationName,
          fk,
          parsedRelation,
          childScope,
          childName,
          input,
        });
        continue;
      }
      this.interpretToManyKind({
        kind,
        relationName,
        relationInfo,
        parsedRelation,
        childScope,
        childName,
        childPrimaryKey: childPrimaryKeys[0]!,
        fkFields: fk.fkFields,
        referencedFields: fk.pkFields,
        writeBase,
        input,
        adopt,
      });
    }
  }

  /**
   * A child-held nested `create`/`createMany` under the update root (T3b-2 family E,
   * generalized by N1-U1). The fresh child's foreign key is the located parent's
   * referenced column, resolved by {@link resolveCreateParent} to either a
   * construction-time literal (the `where` pins it, or the root SET rewrites it) or a
   * `planned` read of the LOCATE step — the located-parent Ref. Both provenances feed
   * the same leaf builders and compile to the same statements; only where the value
   * comes from differs.
   */
  private interpretChildHeldCreate(args: {
    kind: string;
    relationName: string;
    fk: FkDirection;
    parsedRelation: Record<string, unknown>;
    childScope: QueryScope;
    childName: string;
    input: Parameters<UpdateOperation["interpretRelation"]>[0];
  }): void {
    const {
      kind,
      relationName,
      fk,
      parsedRelation,
      childScope,
      childName,
      input,
    } = args;
    const { parentId, afterRoot } = this.resolveCreateParent(
      input,
      fk,
      relationName
    );
    // A transitioned-PK parent (T4b CLASS III) orders its fresh INSERT AFTER the root
    // UPDATE; every other create — literal or located-parent Ref — rides the normal
    // child-part order (its referenced column is not rewritten, so the value the fresh
    // row references already exists before the root UPDATE runs).
    const target = afterRoot ? input.afterRootParts : input.childParts;
    const leaf = {
      scope: input.scope,
      engine: this.engine,
      childScope,
      childName,
      relationName,
      fk,
      parentId,
    } as const;
    if (kind === "create") {
      const creates = normalizeItems(parsedRelation.create, relationName);
      const txMode = this.mode === "transaction";
      target.push(
        ...(parentId.kind === "literal"
          ? buildLiteralParentCreatePart({ ...leaf, txMode, creates })
          : buildPlannedParentCreatePart({ ...leaf, txMode, creates }))
      );
      return;
    }
    const createManyInput = parsedRelation.createMany;
    target.push(
      parentId.kind === "literal"
        ? buildLiteralParentCreateManyPart({ ...leaf, createManyInput })
        : buildPlannedParentCreateManyPart({ ...leaf, createManyInput })
    );
  }

  /** Where a child-held nested create's foreign key comes from, and where the fresh
   *  INSERT is ordered (`afterRoot`).
   *
   *  **No referenced column is rewritten by the root SET** (the ordinary case):
   *   - a SINGLE referenced column the unique `where` PINS → a construction-time literal,
   *     `afterRoot: false`. Byte-identical to the pre-N1 plan: no extra locate column, no
   *     extra statement, no compile-time resolution;
   *   - anything else — the `where: { email }` spelling, whose discriminator names a
   *     DIFFERENT column than the one the child FK references, or a COMPOUND reference
   *     (N1-U2) — → the **located-parent Ref**: every referenced column joins the locate
   *     read's select/outputs, and the fresh row's FK is resolved PER FIELD at compile from
   *     the row the locate ACTED ON (the wrong-row doctrine: never from re-consulting the
   *     `where`). Compound needs no new mechanism — a compound foreign key is per-field
   *     (ATOM §1's multi-field produces), and the leaf's inject already loops the FK
   *     columns index-aligned with the referenced ones. Still `afterRoot: false` — no
   *     referenced value is being rewritten, so all of them already exist before the root
   *     UPDATE runs.
   *
   *  **A referenced column IS rewritten** (a transition). The referential ACTION decides,
   *  because it decides whether a post-transition value is needed at all:
   *   - `ON UPDATE CASCADE`, any arity, pinned or not (N5-U2) → the LOCATED pre-transition
   *     values, `afterRoot: false`. The INSERT lands before the root UPDATE and the cascade
   *     carries the fresh row's foreign key new — the ordering a reparent already gets;
   *   - a NON-cascading **transitioned PRIMARY KEY** whose pre-transition value the `where`
   *     pins (T4b CLASS III) → the POST-transition id, derived by
   *     `getUpdatedPrimaryKeyValue` (the same JS==SQL derivation the terminal read already
   *     trusts, portability guaranteed by `assertPortablePrimaryKeyUpdateInput` on the root
   *     SET) → `afterRoot: true`, so the INSERT lands after the root UPDATE creates the row;
   *   - a non-cascading non-PK referenced column rewritten to a literal → that literal,
   *     `afterRoot: false`.
   *
   *  The three survivors are typed refusals, not oversights — see each throw. */
  private resolveCreateParent(
    input: Parameters<UpdateOperation["interpretRelation"]>[0],
    fk: FkDirection,
    relationName: string
  ): { parentId: ParentIdSource; afterRoot: boolean } {
    const referencedFields = fk.pkFields;
    const rewritten = referencedFields.filter((field) =>
      Object.hasOwn(input.rootScalarData, field)
    );
    if (rewritten.length === 0) {
      return this.locatedCreateParent(input, referencedFields);
    }
    // N5-U2 — a rewritten reference on an `ON UPDATE CASCADE` edge needs NO
    // post-transition derivation at all, whatever its arity and wherever its
    // pre-transition value lives. Write the fresh row against the LOCATED (pre-transition)
    // values, before the root UPDATE, and the cascade carries it new — the same ordering
    // `reorderRootUpdateAfterChildren` already applies to a reparent, applied to an
    // INSERT. `locatedCreateParent` is entered unchanged, so a compound reference rides
    // it per field exactly as N1-U2 made it. This is checked BEFORE the arity and
    // pinned-value branches below, because both of those exist only to derive a
    // POST-transition value, and a cascading edge never needs one.
    if (fk.onUpdate === "cascade") {
      return this.locatedCreateParent(input, referencedFields);
    }
    if (referencedFields.length !== 1) {
      // What survives is a NON-cascade compound reference the root SET rewrites. The
      // located row carries the pre-transition members, but a NO-ACTION foreign key does
      // not follow them, so the fresh row must reference the POST-transition TUPLE — and
      // that is per member: `getUpdatedPrimaryKeyValue` over each located value and its
      // operand, at COMPILE (the locate has run) rather than at construction. What the
      // engine has no way to spell today is a parent-id source meaning "the located row's
      // column, with this SET operand applied" — every source is a literal, a planning
      // read, or a SQL `Ref`, and none of the three transforms. That source is the single
      // missing mechanism, shared with the unpinned single-key case below.
      throw new UnsupportedOperationError(
        `query-engine-v2 update does not support a compound-key nested create on relation '${relationName}' while the root update rewrites non-cascading referenced column(s) '${rewritten.join(", ")}'.`
      );
    }
    const referencedField = referencedFields[0]!;
    // A rewritten PRIMARY KEY is a transition: the fresh child references the new PK.
    // T4b CLASS III — the post-transition value is COMPILE-known, derived from the
    // where-pinned pre-transition value by `getUpdatedPrimaryKeyValue` (the same exact
    // JS==SQL arithmetic the terminal read trusts; the root SET already passed
    // `assertPortablePrimaryKeyUpdateInput`, so a non-portable op is impossible here).
    // The INSERT is ordered AFTER the root UPDATE (`afterRoot: true`) because a
    // NO-ACTION FK does not cascade a fresh row: the new parent must exist first.
    if (this.parentPrimaryKeys.includes(referencedField)) {
      const pinnedBefore = getWhereUniqueEntries(
        input.parent,
        this.parentWhere
      ).find((entry) => entry.fieldName === referencedField);
      if (!pinnedBefore) {
        // N5-U2, MEASURED: the Ref reaches the pre-transition value — the locate row
        // carries it, which is exactly what N1 proved — so this is not a dataflow gap and
        // never was. What a NO-ACTION foreign key needs is the POST-transition value, and
        // the derivation `getUpdatedPrimaryKeyValue(before, operand)` can only run once
        // `before` is known, i.e. at COMPILE. Every parent-id source the engine has is
        // fixed at construction: a `literal` (a value), a `planned` (a column of the
        // located row, verbatim), a `ref` (a SQL reference). None of them applies a
        // transform, so the value cannot be spelled — not because no SQL expresses it
        // (`INSERT … VALUES (<new id>)` is trivial SQL) but because no source names it.
        // The missing mechanism is one field: a `planned` source carrying the SET operand,
        // resolved through the same derivation at compile. It is the SAME gap the compound
        // branch above hits, and closing it closes both.
        throw new UnsupportedOperationError(
          `query-engine-v2 update nested create on relation '${relationName}' transitions non-cascading primary key '${referencedField}' whose pre-transition value is not pinned by the unique where.`
        );
      }
      const transitioned = getUpdatedPrimaryKeyValue(
        this.model,
        referencedField,
        pinnedBefore.value,
        input.rootScalarData[referencedField],
        getStepModelName(this.model, "record")
      );
      return { parentId: literalParentId(transitioned), afterRoot: true };
    }
    const literal = input.rootScalarData[referencedField];
    if (!isConstructionLiteral(literal)) {
      throw new UnsupportedOperationError(
        `query-engine-v2 update nested create on relation '${relationName}' references a non-literal rewritten column '${referencedField}'.`
      );
    }
    return { parentId: literalParentId(literal), afterRoot: false };
  }

  /**
   * N1-U1/U2 — the parent id for a nested create whose referenced columns the root SET
   * leaves alone. A SINGLE referenced column the unique `where` PINS keeps its
   * construction-time literal (the pre-N1 plan, byte for byte). Everything else — an
   * unpinned reference (`where: { email }` while the child FK references `id`) or a
   * COMPOUND one — takes THE LOCATED-PARENT REF.
   *
   * It was never an unknowable value: the locate read already reads this row. Registering
   * each referenced field in `locateFields` is what makes the locate expose it (its SELECT
   * plus a `firstRowField` output); `plannedParentId` is what makes the create leaf read it
   * from the LOCATED ROW rather than re-deriving it from the `where` (ATOM §1's Ref, and
   * the wrong-row doctrine's requirement). Compound rides the same call: the leaf's inject
   * loops the FK columns index-aligned with the referenced ones and resolves each by NAME
   * from that row, so the parent-id source names the readStep and the per-field lookup does
   * the rest. Under a transaction the locate holds `FOR UPDATE`, so no value can move
   * between read and write; under an atomic batch the root-presence guard pins the row
   * inside the unit.
   */
  private locatedCreateParent(
    input: Parameters<UpdateOperation["interpretRelation"]>[0],
    referencedFields: readonly string[]
  ): { parentId: ParentIdSource; afterRoot: boolean } {
    if (referencedFields.length === 1) {
      const pinned = getWhereUniqueEntries(input.parent, this.parentWhere).find(
        (entry) => entry.fieldName === referencedFields[0]
      );
      if (pinned) {
        return { parentId: literalParentId(pinned.value), afterRoot: false };
      }
    }
    for (const field of referencedFields) input.locateFields.add(field);
    return {
      parentId: plannedParentId(this.locateId, referencedFields[0]!),
      afterRoot: false,
    };
  }

  private interpretToManyKind(args: {
    kind: string;
    relationName: string;
    relationInfo: RelationInfo;
    parsedRelation: Record<string, unknown>;
    childScope: QueryScope;
    childName: string;
    childPrimaryKey: string;
    fkFields: readonly string[];
    referencedFields: readonly string[];
    writeBase: Parameters<typeof buildToManyUpdateParts>[0];
    input: {
      scope: StepScope;
      parent: QueryScope;
      parentIdSource: ReturnType<typeof plannedParentId>;
      txMode: boolean;
      childParts: Part[];
    };
    /** N5-U1 — present only under a guarded non-cascade referenced-PK transition. */
    adopt?: PostTransitionAdopt;
  }): void {
    const {
      kind,
      relationName,
      relationInfo,
      parsedRelation,
      childScope,
      childName,
      childPrimaryKey,
      fkFields,
      referencedFields,
      writeBase,
      input,
      adopt,
    } = args;
    const push = (parts: readonly Part[]) => input.childParts.push(...parts);
    // N5-U1: an adopt kind writes the POST-transition value and is held back until
    // after the root UPDATE; without a transition both fall back to the pre-N5
    // located-parent source and the ordinary child-part list, byte for byte.
    const adoptParentId = adopt?.parentId ?? input.parentIdSource;
    const pushAdopt = (parts: readonly Part[]) =>
      (adopt?.target ?? input.childParts).push(...parts);

    switch (kind) {
      case "upsert":
        pushAdopt(
          buildToManyUpsertParts(
            input.scope,
            input.parent,
            this.engine,
            relationName,
            relationInfo,
            normalizeItems(parsedRelation.upsert, relationName),
            adoptParentId,
            "correlated",
            input.txMode,
            this.buildFreshArm
          )
        );
        return;
      case "connectOrCreate":
        // Still a GLOBAL lookup-and-adopt under update (found → reparent, absent
        // → create), never correlated (PLAN P−1.2) — composed like the upsert part.
        pushAdopt(
          buildConnectOrCreateParts(
            input.scope,
            input.parent,
            this.engine,
            relationName,
            relationInfo,
            normalizeItems(parsedRelation.connectOrCreate, relationName),
            adoptParentId,
            input.txMode,
            this.buildFreshArm
          )
        );
        return;
      case "connect":
      case "disconnect": {
        if (kind === "disconnect") {
          // A required child FK cannot be nulled — V1's verbatim typed rejection.
          assertNullable(
            relationInfo,
            getFkDirection(input.parent, relationInfo)
          );
        }
        // `connect` adopts (post-transition value, after the root UPDATE); `disconnect`
        // releases rows that carry the parent's CURRENT value and its probe correlates
        // on the located row in SQL, so it keeps the planned source and its place among
        // the ordinary child parts.
        const isAdopt = kind === "connect";
        const parts = buildToManyLinkParts(
          input.scope,
          this.engine,
          relationName,
          relationInfo,
          childName,
          childScope,
          fkFields,
          referencedFields,
          childPrimaryKey,
          kind,
          kind === "connect"
            ? parsedRelation.connect
            : parsedRelation.disconnect,
          isAdopt ? adoptParentId : input.parentIdSource,
          input.txMode
        );
        if (isAdopt) pushAdopt(parts);
        else push(parts);
        return;
      }
      case "update":
        push(buildToManyUpdateParts(writeBase, parsedRelation.update));
        return;
      case "updateMany":
        // CLASS V (T4c): a relation-carrying updateMany is rejected by the legality
        // check (immediate at construction for a plain update, or deferred to the taken
        // upsert branch). Skip building the Part so its construction does not throw
        // ahead of that runtime-branch-gated verdict (an untaken upsert update arm
        // whose invalid updateMany never runs must not reject the whole tree).
        if (updateManyCarriesRelations(childScope, parsedRelation.updateMany)) {
          return;
        }
        push(buildToManyUpdateManyParts(writeBase, parsedRelation.updateMany));
        return;
      case "delete":
        push(buildToManyDeleteParts(writeBase, parsedRelation.delete));
        return;
      case "deleteMany":
        push(buildToManyDeleteManyParts(writeBase, parsedRelation.deleteMany));
        return;
      case "set":
        // `set` is BOTH halves at once: it reparents its targets (the adopt half —
        // post-transition value, after the root UPDATE) and releases the departing
        // rows, which still carry the PRE-transition value. `correlationParentId`
        // keeps those two apart; without a transition they are the same source.
        pushAdopt([
          buildToManySetPart(
            adopt ? { ...writeBase, parentId: adopt.parentId } : writeBase,
            parsedRelation.set,
            adopt?.correlationParentId
          ),
        ]);
        return;
      default:
        // Unreachable by construction (N7-U-A, the X1c disposition). The claim this
        // comment used to make — "create / createMany nested under update are V1's
        // surface" — has been false since T3b-2: both are handled UPSTREAM at
        // `interpretChildHeldCreate`, and the nine cases above cover the rest of
        // `toManyUpdateFactory`'s key set. Measured: all ELEVEN to-many keys construct on
        // this path, so nothing falls through here. An engine invariant, not a route.
        throw new QueryEngineError(
          `query-engine-v2 internal: kind '${kind}' reached the child-held update dispatch on relation '${relationName}'; the parse boundary admits only the eleven to-many kinds, all of which are handled above.`
        );
    }
  }

  /**
   * One mutation kind on an **inverse-side one-to-one** (child-held FK) relation
   * under update (TO-ONE.md §7). The parent exists (located first), so these are
   * ordinary correlated / global-adopt child writes — the arity-1 case of the
   * to-many child-held family — differing only in the to-one payload spelling:
   * `update: <data>` (no unique selector, correlation is the locator), `disconnect:
   * true` / `delete: true` (the whole correlated set), and `upsert` (found → update
   * the correlated child / absent → create it, fk = parent — TO-ONE.md §7.2, family
   * F, scalar arms), and — since N2-U1 — `create` (the arity-1 child-held INSERT,
   * with the 1:1 FK's UNIQUE constraint as the occupied-slot rule).
   *
   * The dispatch is TOTAL over the parse boundary's inverse-to-one surface. The
   * relation schema for a to-one ({@link file://../validation/relations/update.ts}
   * `toOneUpdateFactory`) emits exactly `create` / `connect` / `connectOrCreate` /
   * `update` / `upsert`, plus `disconnect` / `delete` on an OPTIONAL relation — the
   * same seven keys Prisma's `<T>UpdateOneWithout<R>NestedInput` carries (measured
   * against Prisma 7.9.1; `createMany` / `deleteMany` / `updateMany` / `set` are
   * to-many-only there too, and this schema does not offer them either). Every one is
   * a `case` below, so the `default` is unreachable by construction and is an internal
   * invariant, not a route.
   */
  private interpretInverseToOneKind(args: {
    kind: string;
    relationName: string;
    relationInfo: RelationInfo;
    fk: FkDirection;
    parsedRelation: Record<string, unknown>;
    childScope: QueryScope;
    childName: string;
    childPrimaryKey: string;
    fkFields: readonly string[];
    referencedFields: readonly string[];
    writeBase: Parameters<typeof buildToManyUpdateParts>[0];
    input: Parameters<UpdateOperation["interpretRelation"]>[0];
    keyTransition: ReturnType<
      UpdateOperation["interpretReferencedKeyTransition"]
    >;
    /** N5-U1 — present only under a guarded non-cascade referenced-PK transition. */
    adopt?: PostTransitionAdopt;
  }): void {
    const {
      kind,
      relationName,
      relationInfo,
      fk,
      parsedRelation,
      childScope,
      childName,
      childPrimaryKey,
      fkFields,
      referencedFields,
      writeBase,
      input,
      keyTransition,
      adopt,
    } = args;
    const push = (parts: readonly Part[]) => input.childParts.push(...parts);
    // N5-U1 — the arity-1 case of the to-many adopt ordering (see interpretToManyKind).
    const adoptParentId = adopt?.parentId ?? input.parentIdSource;
    const pushAdopt = (parts: readonly Part[]) =>
      (adopt?.target ?? input.childParts).push(...parts);

    switch (kind) {
      case "create":
        // N2-U1 — the mainstream Prisma shape,
        // `user.update({ where, data: { profile: { create: { bio } } } })`.
        // Mechanically it is the ARITY-1 case of the child-held create the update root
        // already builds: one INSERT whose foreign key is the located parent's referenced
        // column — a construction literal when the unique `where` pins that column, N1's
        // located-parent Ref when it does not. `interpretChildHeldCreate` is entered
        // unchanged; the to-one payload is a bare object where the to-many spelling is
        // single-or-array, and `normalizeItems` already reads both.
        //
        // THE OCCUPIED SLOT (Prisma's documented behavior: a related row already there is
        // an error). The 1:1 foreign key carries a UNIQUE constraint — `serializer.ts`
        // adds one when the schema does not, "1:1 FK must be unique at the DB level, or it
        // degrades to N:1" — so an INSERT into an occupied slot violates it and surfaces as
        // `UniqueConstraintError` with nothing written, on both substrates. That constraint
        // IS the guard. A pre-check SELECT would be a SECOND guard on the one invariant
        // (the AGENTS.md ban) and a racy one besides: two concurrent creates would both
        // read an empty slot, both proceed, and leave the constraint to decide anyway.
        //
        // The race attribution, stated because it is load-bearing: this leaf carries NO
        // `racePin` (only the adopt family's create-the-target-first arms do —
        // `childRacePin`), so `race-retry.ts` sees a `UniqueConstraintError` matching no
        // pin and not `meta.raceable`, and does NOT re-run the operation. That is the
        // correct verdict — an occupied slot is a genuine conflict the caller must see,
        // not a lost create-branch race worth retrying.
        this.interpretChildHeldCreate({
          kind,
          relationName,
          fk,
          parsedRelation,
          childScope,
          childName,
          input,
        });
        return;
      case "connect":
        // Global lookup-and-adopt: UPDATE child SET fk = parent WHERE unique, pinned
        // by an exists guard — V1's child-held connect arm. A one-to-one FK carries a
        // UNIQUE constraint, so a second row already pointing at this parent makes the
        // reparent collide (V1's steal semantics, the DB enforces the invariant).
        pushAdopt(
          buildToManyLinkParts(
            input.scope,
            this.engine,
            relationName,
            relationInfo,
            childName,
            childScope,
            fkFields,
            referencedFields,
            childPrimaryKey,
            "connect",
            parsedRelation.connect,
            adoptParentId,
            input.txMode
          )
        );
        return;
      case "connectOrCreate":
        pushAdopt(
          buildConnectOrCreateParts(
            input.scope,
            input.parent,
            this.engine,
            relationName,
            relationInfo,
            normalizeItems(parsedRelation.connectOrCreate, relationName),
            adoptParentId,
            input.txMode,
            this.buildFreshArm
          )
        );
        return;
      case "update":
        // Correlated targeted update with NO unique selector — the FK correlation
        // (fk = parent) is the whole locator (TO-ONE.md §7.2). W4-U3's optional
        // `{ where, data }` wrapper arrives already told apart from bare data by the
        // relation schema, as its canonical envelope; the filter narrows that
        // locator. See `splitToOneUpdateTarget`.
        input.childParts.push(
          buildToOneUpdatePart(writeBase, parsedRelation.update)
        );
        return;
      case "upsert":
        // Correlated to-one upsert (TO-ONE.md §7.2, family F): the correlated probe
        // decides found → update / absent → create (fk = parent), no unique `where`.
        // The same correlated locator as the `update` arm, with a create branch.
        //
        // CLASS IV (T4c): when the SAME root update TRANSITIONS a parent PK this child
        // FK references, the relation-level {@link interpretReferencedKeyTransition} has
        // already emitted V1's occupied guard (reject an occupied OLD slot); here the
        // empty-slot accept-shape reroutes the CREATE arm to a POST-transition-FK leaf
        // ordered after the root UPDATE (the update arm is unreachable: occupied rejects,
        // empty creates). A cascade / no-op / non-transition keeps the ordinary part.
        if (keyTransition.regime === "guarded") {
          this.rerouteTransitionedUpsertCreateArm({
            input,
            relationName,
            fk,
            childScope,
            childName,
            upsertInput: parsedRelation.upsert,
            after: keyTransition.after,
          });
          return;
        }
        input.childParts.push(
          buildInverseToOneUpsertPart(writeBase, parsedRelation.upsert)
        );
        return;
      case "disconnect": {
        // A required child FK cannot be nulled — V1's verbatim typed rejection.
        assertNullable(relationInfo, fk);
        if (parsedRelation.disconnect !== true) {
          // A targeted (non-boolean) to-one disconnect is V1's captured path; out
          // of T2 scope — route the whole tree to V1.
          throw new UnsupportedOperationError(
            `query-engine-v2 update supports only 'disconnect: true' on the inverse-side to-one relation '${relationName}'.`
          );
        }
        push(
          buildToManyLinkParts(
            input.scope,
            this.engine,
            relationName,
            relationInfo,
            childName,
            childScope,
            fkFields,
            referencedFields,
            childPrimaryKey,
            "disconnect",
            true,
            input.parentIdSource,
            input.txMode
          )
        );
        return;
      }
      case "delete":
        if (parsedRelation.delete !== true) {
          // A targeted (non-boolean) to-one delete is V1's captured path; out of
          // T2 scope — route the whole tree to V1.
          throw new UnsupportedOperationError(
            `query-engine-v2 update supports only 'delete: true' on the inverse-side to-one relation '${relationName}'.`
          );
        }
        // `delete: true` is a correlated bulk delete — DELETE child WHERE fk = parent
        // (V1's `RelationRemovals.delete` input===true, child-held arm).
        push(buildToManyDeleteManyParts(writeBase, {}));
        return;
      default:
        // Unreachable: the seven keys the to-one relation schema can deliver each have a
        // case above (see this method's doc). A `createMany` / `deleteMany` / `set` /
        // `updateMany` here would mean the parse boundary let through a key it does not
        // define — an engine invariant break, not a shape we decline, so it is a
        // `QueryEngineError` and NOT an `UnsupportedOperationError` route (the X1c
        // precedent for a branch made unreachable by construction). Fail closed rather
        // than fall through and silently drop the mutation.
        throw new QueryEngineError(
          `query-engine-v2 update reached an unknown nested kind '${kind}' on the inverse-side to-one relation '${relationName}'.`
        );
    }
  }

  /**
   * CLASS IV (T4c / T4c-fix) — V1's `RelationUpdates.compileRelationKeyGuards`,
   * reproduced at the RELATION level (kind- AND cardinality-agnostic, exactly as V1
   * loops `relations` independent of the mutation planning). A child-held, non-cascade
   * relation whose referenced key the SAME root update TRANSITIONS may not leave the OLD
   * slot occupied: V1 rejects `Cannot update relation '…' with onUpdate('…') while the
   * current relation is occupied.` for ANY nested mutation on it (upsert / update /
   * delete / disconnect / create / …) and either cardinality. Called once per relation
   * before the per-kind dispatch, and kind-BLIND in its body since N5-U1 removed the one
   * per-kind branch it had (the adopt refusal): the guard belongs to the relation, the
   * ordering to the kind. Returns which regime applies:
   *   · **`"none"`** — parent-held / `ON UPDATE CASCADE`, no referenced column written,
   *     or a no-op (`increment: 0` / `set` same, before == after). The ordinary parts
   *     are byte-identical; no guard.
   *   · **`"guarded"`** — a real non-cascade transition of a SINGLE PRIMARY KEY pinned by
   *     the unique `where` (before is a compile literal). V1's occupied guard is emitted
   *     (reject an occupied OLD slot); the correlated / literal-parent-create kinds keep
   *     their ordinary part (empty-slot native), the to-one upsert reroutes its create
   *     arm off `after`. The ADOPT kinds (`connect` / `connectOrCreate` / `set`, and a
   *     to-many `upsert`) take `after` as their parent value and are ORDERED after the
   *     root UPDATE — N5-U1's {@link PostTransitionAdopt}, which is why `after` is
   *     returned rather than consumed here.
   *   · **`"pastSurface"`** — a real transition past the reproduced surface (a compound
   *     edge, a non-PK referenced unique — the D4 case, or a pre-value the `where` does
   *     not pin). V2 cannot compile-correlate the occupied guard, so only nested
   *     `create` / `createMany` proceed (their FK literal, incl. a non-PK D4 rewrite, is
   *     resolved by {@link resolveLiteralCreateParent} against the empty-slot accept); any
   *     other kind routes the tree to V1 ({@link interpretRelation} enforces this). The
   *     remaining narrower boundary — a non-PK / compound occupied slot under such a
   *     create — is V1's staged mutation-identity engine, unreached by the estate.
   */
  private interpretReferencedKeyTransition(args: {
    input: Parameters<UpdateOperation["interpretRelation"]>[0];
    relationName: string;
    fk: FkDirection;
    childScope: QueryScope;
    childName: string;
  }):
    | { regime: "none" }
    | { regime: "guarded"; after: unknown }
    | {
        regime: "pastSurface";
      } {
    const { input, relationName, fk, childScope, childName } = args;
    // Parent-held FK or an ON UPDATE CASCADE relation: no referential-action guard.
    if (fk.holdsFK || fk.onUpdate === "cascade") return { regime: "none" };
    // Does the root SET rewrite a referenced parent column?
    const changed = fk.pkFields.filter((field) =>
      Object.hasOwn(input.rootScalarData, field)
    );
    if (changed.length === 0) return { regime: "none" };
    // The occupied guard is reproduced natively only for a single primary-key reference
    // pinned by the unique `where` (before is a compile literal). A compound edge, a
    // non-PK referenced unique (D4), or an unpinned pre-value is past that surface.
    if (
      fk.pkFields.length !== 1 ||
      fk.fkFields.length !== 1 ||
      !this.parentPrimaryKeys.includes(fk.pkFields[0]!)
    ) {
      return { regime: "pastSurface" };
    }
    const referencedField = fk.pkFields[0]!;
    const fkField = fk.fkFields[0]!;
    const pinned = getWhereUniqueEntries(input.parent, this.parentWhere).find(
      (entry) => entry.fieldName === referencedField
    );
    if (!pinned) {
      return { regime: "pastSurface" };
    }
    const before = pinned.value;
    const after = getUpdatedPrimaryKeyValue(
      this.model,
      referencedField,
      before,
      input.rootScalarData[referencedField],
      getStepModelName(this.model, "record")
    );
    // No-op transition (increment 0 / set same): the slot stays; ordinary parts hold.
    if (sameScalarValue(before, after)) return { regime: "none" };
    // Emit V1's occupied guard (reject when the OLD slot, a child correlated on the
    // pre-transition parent value, is occupied). Hoisted ahead of every write, so the
    // rejection lands before the ordinary correlated / literal-parent-create part runs.
    this.pushOccupiedGuard({
      input,
      relationName,
      fk,
      childScope,
      childName,
      before,
      fkField,
    });
    return { regime: "guarded", after };
  }

  /** CLASS IV (T4c) — emit V1's occupied guard onto `relationKeyGuards`: a read of the
   *  OLD slot (a child correlated on the pre-transition parent value), locked in tx mode.
   *  The probe reads at planning; the verdict fires at compile ({@link compileRelationKeyGuards}),
   *  independent of the nested mutation kind — tx throws V1's byte-identical
   *  `NestedWriteError` before any write, batch pins the empty-slot race with an absence
   *  guard. */
  private pushOccupiedGuard(args: {
    input: Parameters<UpdateOperation["interpretRelation"]>[0];
    relationName: string;
    fk: FkDirection;
    childScope: QueryScope;
    childName: string;
    before: unknown;
    fkField: string;
  }): void {
    const { input, relationName, fk, childScope, childName, before, fkField } =
      args;
    const childPk = getPrimaryKeyFields(childScope.model)[0]!;
    const probeId = input.scope.allocate(`${childName}.transition.find`);
    input.relationKeyGuards.push({
      relationName,
      action: fk.onUpdate ?? "restrict",
      probeId,
      guardId: input.scope.allocate(`${childName}.guard.occupied`),
      probe: {
        id: probeId,
        kind: "read",
        statement: buildFind(
          childScope,
          {
            where: { [fkField]: { equals: before } },
            select: { [childPk]: true },
            forUpdate: input.txMode,
          },
          { limit: 1 }
        ),
        outputs: { rows: { kind: "rows" } },
      },
    });
  }

  /** CLASS IV (T4c) — the to-one upsert's empty-slot accept-shape under a real
   *  non-cascade referenced-PK transition: its CREATE arm runs with the POST-transition
   *  FK, ordered AFTER the root UPDATE (a NO-ACTION FK does not cascade a fresh row — the
   *  new parent must exist first), exactly the T4b transitioned-PK create leaf. The
   *  update arm never runs (the occupied guard rejects an occupied slot; an empty slot
   *  creates). The relation-level occupied guard is already emitted
   *  ({@link interpretReferencedKeyTransition}). */
  private rerouteTransitionedUpsertCreateArm(args: {
    input: Parameters<UpdateOperation["interpretRelation"]>[0];
    relationName: string;
    fk: FkDirection;
    childScope: QueryScope;
    childName: string;
    upsertInput: unknown;
    after: unknown;
  }): void {
    const {
      input,
      relationName,
      fk,
      childScope,
      childName,
      upsertInput,
      after,
    } = args;
    const spec = normalizeSingle(upsertInput, relationName, "upsert");
    const createData = requireRecord(
      spec.create,
      `${relationName}.upsert.create`
    );
    input.afterRootParts.push(
      ...buildLiteralParentCreatePart({
        scope: input.scope,
        engine: this.engine,
        childScope,
        childName,
        relationName,
        fk,
        parentId: literalParentId(after),
        txMode: this.mode === "transaction",
        creates: normalizeItems(createData, relationName),
      })
    );
  }

  /**
   * A parent-held-FK (FK-holder-side) to-one arm under update. `connect`/
   * `disconnect` fold their construction-known FK literal into the root SET
   * ({@link interpretToOneLink}); `create`/`connectOrCreate` write the target
   * ahead of the root UPDATE and reference its identity from the UPDATE's SET
   * (TO-ONE.md §7.0.2). FK-holder-side `update`/`delete` (mutating the referenced
   * row) route to V1 — a documented boundary (they need V1's staged
   * `compileLocatedUpdate` / parent-FK-null-then-delete recursion).
   */
  private interpretParentHeldToOne(
    input: Parameters<UpdateOperation["interpretRelation"]>[0],
    relationName: string,
    relationInfo: RelationInfo,
    fk: FkDirection,
    kind: string
  ): void {
    switch (kind) {
      case "connect":
      case "disconnect":
        input.toOneLinks.push(
          this.interpretToOneLink(
            input.scope,
            relationName,
            relationInfo,
            fk,
            kind,
            input.parsedRelation
          )
        );
        return;
      case "create":
        input.parentHeldTargets.push(
          this.interpretParentHeldCreate(input, relationName, relationInfo, fk)
        );
        return;
      case "connectOrCreate":
        input.parentHeldTargets.push(
          this.interpretParentHeldConnectOrCreate(
            input,
            relationName,
            relationInfo,
            fk
          )
        );
        return;
      case "update": {
        // W4-U3: the to-one `update` payload reaches here as the relation schema's
        // canonical envelope — bare data and Prisma's `{ where?, data }` wrapper are
        // told apart ONCE, at the parse, off the user's own payload (a schema output
        // rewrites scalar shorthands and is not a faithful witness of the form). The
        // wrapper's `where` is a NON-unique filter on the currently connected record;
        // it rides the locate, never the write. The bare form yields no filter and is
        // byte-identical to pre-W4-U3.
        const target = splitToOneUpdateTarget(
          normalizeSingle(input.parsedRelation.update, relationName, "update")
        );
        // X1c: a parent-held to-one UPDATE target whose own data carries the
        // located-target projection of mechanism 1/2 (a deeper parent-held to-one —
        // child-SET folding on the referenced row — or a D4 edge) delegates its WHOLE
        // update to the update root, correlated to THIS parent by `child.<referenced> =
        // parent.<fk>`. The remaining A-remainder shapes keep the in-place fold.
        const delegated = this.tryDelegateParentHeldUpdate(
          input,
          relationName,
          relationInfo,
          fk,
          target
        );
        if (delegated) {
          input.childParts.push(delegated);
          return;
        }
        input.parentHeldTargets.push(
          this.interpretParentHeldUpdate(
            input,
            relationName,
            relationInfo,
            fk,
            target
          )
        );
        return;
      }
      case "delete":
        input.parentHeldTargets.push(
          this.interpretParentHeldDelete(input, relationName, relationInfo, fk)
        );
        return;
      case "upsert":
        input.parentHeldTargets.push(
          this.interpretParentHeldUpsert(input, relationName, relationInfo, fk)
        );
        return;
      default:
        // Unreachable by construction (N7-U-A, the X1c disposition): `toOneUpdateFactory`
        // offers exactly create / connect / connectOrCreate / update / upsert (+ disconnect
        // and delete when the relation is optional). `connect` and `disconnect` are
        // dispatched to `interpretToOneLink` above this switch and the rest have arms; a
        // to-many-only key such as `set` / `createMany` / `updateMany` / `deleteMany` is
        // answered by the parse boundary first (`ValidationError: Unknown key: <kind>`).
        throw new QueryEngineError(
          `query-engine-v2 internal: kind '${kind}' reached the parent-held to-one update dispatch on relation '${relationName}'; the parse boundary admits no such key there.`
        );
    }
  }

  /**
   * X1c — a parent-held to-one UPDATE target whose OWN data carries the located-target
   * projection of mechanism 1/2 delegates its whole update to an {@link UpdateOperation}
   * nested-target sub-op, correlated to THIS parent by `child.<referenced> = parent.<fk>`
   * (the referenced-row locator the A-remainder fold uses). The parent's FK columns are
   * added to `parentFkLocateFields` so the locate exposes them for the correlation `Ref`
   * (technique #1). Relation-key legality forbids the same update rebinding its FK while
   * mutating this relation, so the located FK value is the correct correlation target.
   * Returns `undefined` when the target keeps the in-place A-remainder fold.
   */
  private tryDelegateParentHeldUpdate(
    input: Parameters<UpdateOperation["interpretRelation"]>[0],
    relationName: string,
    relationInfo: RelationInfo,
    fk: FkDirection,
    target: ToOneUpdateTarget
  ): Part | undefined {
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    if (!targetNeedsFullUpdate(childScope, target.data)) return undefined;
    for (const field of fk.fkFields) input.parentFkLocateFields.add(field);
    return buildNestedTargetUpdatePart({
      scope: input.scope,
      engine: this.engine,
      targetModel: relationInfo.targetModel,
      data: target.data,
      locate: {
        parentId: input.parentIdSource,
        childFields: fk.pkFields,
        parentFields: fk.fkFields,
        ...(target.filter ? { filter: target.filter } : {}),
        relationName,
        notFoundMessage: relationTargetNotFound(relationInfo, "update"),
      },
    });
  }

  /**
   * Build the family-A correlation ledger for a parent-held to-one arm: the child
   * is located by `child.<referenced> = parent.<fk>` where the parent's FK value is
   * its FINAL value (V1 correlates `holdsFK` on the post-scalar-update parentValues).
   * A column the same root update rebinds resolves to a construction-time literal;
   * an untouched column reads the located parent row. Only a single-field FK whose
   * referenced column is the child's single primary key is supported natively; any
   * other shape (compound edge, non-PK reference) routes the whole tree to V1.
   */
  private parentHeldCorrelation(
    input: Parameters<UpdateOperation["interpretRelation"]>[0],
    relationName: string,
    fk: FkDirection,
    childScope: QueryScope,
    kind: string
  ): { correlation: ParentHeldCorrelation; childPrimaryKey: string } {
    const childPrimaryKeys = getPrimaryKeyFields(childScope.model);
    if (
      fk.fkFields.length !== 1 ||
      fk.pkFields.length !== 1 ||
      childPrimaryKeys.length !== 1 ||
      fk.pkFields[0] !== childPrimaryKeys[0]
    ) {
      // A compound parent-held edge or a non-PK reference needs V1's staged
      // mutation-identity resolution — a documented narrower boundary.
      throw new UnsupportedOperationError(
        `query-engine-v2 update supports only a single-field primary-key reference for '${kind}' on the parent-held to-one relation '${relationName}'.`
      );
    }
    // Every parent FK column must be a firstRowField output of the locate read so
    // the untouched-column path can ref/read it. Held in the parent-FK set (NOT
    // `locateFields`): these are the parent's own columns, not child-referenced, so
    // a same-root rebind of one must not trigger the child-edge reorder.
    for (const field of fk.fkFields) input.parentFkLocateFields.add(field);
    const override: Record<string, unknown> = {};
    for (const fkField of fk.fkFields) {
      if (!Object.hasOwn(input.rootScalarData, fkField)) continue;
      // `assertRelationKeyUpdatesAreCompilable` already ran (constructor): a mutated
      // parent-held FK column is resolvable to a literal, never a DerivedValue.
      const resolved = classifyRelationKeyScalarUpdate(
        input.rootScalarData[fkField]
      );
      if (resolved.resolved) override[fkField] = resolved.value;
    }
    return {
      correlation: {
        childReferencedFields: fk.pkFields,
        parentFkFields: fk.fkFields,
        override,
      },
      childPrimaryKey: childPrimaryKeys[0]!,
    };
  }

  /** A parent-held to-one `update`: locate the referenced target by the parent's
   *  (final) FK value, then UPDATE it by the captured PK. Nested-relation update
   *  data (V1's staged recursion) routes the whole tree to V1. */
  private interpretParentHeldUpdate(
    input: Parameters<UpdateOperation["interpretRelation"]>[0],
    relationName: string,
    relationInfo: RelationInfo,
    fk: FkDirection,
    target: ToOneUpdateTarget
  ): ParentHeldTarget {
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const { correlation, childPrimaryKey } = this.parentHeldCorrelation(
      input,
      relationName,
      fk,
      childScope,
      "update"
    );
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    const probeId = input.scope.allocate(`${childName}.find`);
    const built = this.parentHeldUpdateData(
      input,
      childScope,
      target.data,
      probeId,
      childPrimaryKey
    );
    // A parent-held update whose located target carries nested relation writes exposes
    // its captured PK as a firstRowField output so the target's own child Parts (family
    // A-remainder recursion) correlate to it by a `planned` source. That eager output
    // extraction throws on a MISSING target, so the probe additionally carries the
    // not-found postcondition (enforced during planning, before extraction) — V1's
    // `Cannot update relation` wording. A scalar-only target keeps the plain probe (its
    // missing-target check stays at compile, `parentHeldCapturedPk`), byte-identical to
    // pre-T3b.
    const hasChildParts = built.childParts.length > 0;
    const probe: StatementStep = {
      id: probeId,
      kind: "read",
      statement: this.parentHeldProbeStatement(
        childScope,
        childPrimaryKey,
        correlation,
        undefined,
        true,
        undefined,
        target.filter
      ),
      outputs: hasChildParts
        ? {
            rows: { kind: "rows" },
            [childPrimaryKey]: {
              kind: "firstRowField",
              field: childPrimaryKey,
            },
          }
        : { rows: { kind: "rows" } },
      ...(hasChildParts
        ? {
            expects: exactlyOneRow(
              nestedWriteFailure(
                relationTargetNotFound(relationInfo, "update"),
                relationName,
                false
              )
            ),
          }
        : {}),
    };
    return {
      kind: "update",
      relationName,
      relationInfo,
      childScope,
      childPrimaryKey,
      probeId,
      guardId: input.scope.allocate(`${childName}.guard.exists`),
      writeId: input.scope.allocate(`${childName}.update`),
      correlation,
      probe,
      ...(target.filter ? { filter: target.filter } : {}),
      data: built.scalarData,
      childParts: built.childParts,
      reorderAfterChildren: built.reorderAfterChildren,
    };
  }

  /**
   * The validated scalar assignments AND the child Parts of a family-A parent-held
   * `update` target's payload (TO-ONE.md §7.7, A-remainder). Pre-T3b a nested relation
   * write here threw; now the located target builds its own child Parts one level
   * deeper — the parent-held projection of the child-held nested-update recursion —
   * correlated to its captured PK by a `planned` source on the parent-held probe.
   */
  private parentHeldUpdateData(
    input: Parameters<UpdateOperation["interpretRelation"]>[0],
    childScope: QueryScope,
    data: Record<string, unknown>,
    probeId: string,
    childPrimaryKey: string
  ): {
    scalarData: Record<string, unknown>;
    childParts: readonly Part[];
    reorderAfterChildren: boolean;
  } {
    const { scalarData, relations } = separateData(childScope, data);
    assertPortablePrimaryKeyUpdateInput(childScope.model, "update", {
      data: scalarData,
    });
    if (Object.keys(relations).length === 0) {
      return { scalarData, childParts: [], reorderAfterChildren: false };
    }
    const childParts = buildNestedTargetChildParts(
      input.scope,
      this.engine,
      childScope,
      relations,
      plannedParentId(probeId, childPrimaryKey),
      input.txMode
    );
    const reorderAfterChildren =
      childParts.length > 0 && Object.hasOwn(scalarData, childPrimaryKey);
    return { scalarData, childParts, reorderAfterChildren };
  }

  /** A parent-held to-one `delete: true`: NULL the parent FK (a required FK is V1's
   *  typed reject), then correlated bulk-delete the referenced target. */
  private interpretParentHeldDelete(
    input: Parameters<UpdateOperation["interpretRelation"]>[0],
    relationName: string,
    relationInfo: RelationInfo,
    fk: FkDirection
  ): ParentHeldTarget {
    if (input.parsedRelation.delete !== true) {
      // A targeted (non-boolean) parent-held delete is V1's captured path.
      throw new UnsupportedOperationError(
        `query-engine-v2 update supports only 'delete: true' on the parent-held to-one relation '${relationName}'.`
      );
    }
    // A required (non-nullable) FK cannot be nulled — V1's verbatim typed rejection.
    assertNullable(relationInfo, fk);
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const { correlation } = this.parentHeldCorrelation(
      input,
      relationName,
      fk,
      childScope,
      "delete"
    );
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    return {
      kind: "delete",
      relationName,
      relationInfo,
      childScope,
      nullWriteId: input.scope.allocate("parent.fknull"),
      deleteWriteId: input.scope.allocate(`${childName}.delete`),
      fkFields: fk.fkFields,
      correlation,
    };
  }

  /** A parent-held to-one `upsert`: found → UPDATE the located target; absent →
   *  INSERT it (before root) and rebind the parent FK to the created identity. */
  private interpretParentHeldUpsert(
    input: Parameters<UpdateOperation["interpretRelation"]>[0],
    relationName: string,
    relationInfo: RelationInfo,
    fk: FkDirection
  ): ParentHeldTarget {
    this.assertNotSharedPk(relationName, fk, "upsert");
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const { correlation, childPrimaryKey } = this.parentHeldCorrelation(
      input,
      relationName,
      fk,
      childScope,
      "upsert"
    );
    const spec = normalizeSingle(
      input.parsedRelation.upsert,
      relationName,
      "upsert"
    );
    const updateData = this.parentHeldScalarUpdateData(
      childScope,
      requireRecord(spec.update, `${relationName}.upsert.update`),
      relationName,
      "upsert"
    );
    const before = this.buildBeforeTarget(
      childScope,
      requireRecord(spec.create, `${relationName}.upsert.create`),
      relationName
    );
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    const probeId = input.scope.allocate(`${childName}.find`);
    return {
      kind: "upsert",
      relationName,
      relationInfo,
      childScope,
      childPrimaryKey,
      probeId,
      guardId: input.scope.allocate(`${childName}.guard.exists`),
      writeId: input.scope.allocate(`${childName}.update`),
      parentSetId: input.scope.allocate("parent.fkset"),
      correlation,
      probe: {
        id: probeId,
        kind: "read",
        statement: this.parentHeldProbeStatement(
          childScope,
          childPrimaryKey,
          correlation,
          undefined,
          true
        ),
        outputs: { rows: { kind: "rows" } },
      },
      updateData,
      before,
      missingFkAssign: this.beforeTargetFkAssign(fk, before, relationName),
    };
  }

  /** The validated scalar update data for a parent-held to-one `update`/`upsert`
   *  arm. Nested-relation data (the located target's own grandchild writes, V1's
   *  staged recursion) routes the whole tree to V1 — the parent-held projection of
   *  the family-B boundary. */
  private parentHeldScalarUpdateData(
    childScope: QueryScope,
    data: Record<string, unknown>,
    relationName: string,
    kind: string
  ): Record<string, unknown> {
    const { scalarData, relations } = separateData(childScope, data);
    if (Object.keys(relations).length > 0) {
      throw new UnsupportedOperationError(
        `query-engine-v2 update does not support nested relation writes in the '${kind}' data of the parent-held to-one relation '${relationName}'.`
      );
    }
    assertPortablePrimaryKeyUpdateInput(childScope.model, "update", {
      data: scalarData,
    });
    return scalarData;
  }

  /** `child.<referenced> = <finalFk>` — a SQL `Ref` to the located parent at
   *  planning (technique #1) for an untouched FK column, the rebound literal for a
   *  same-root-rewritten one; the inlined literal at compile. */
  private parentHeldCorrelationFilters(
    correlation: ParentHeldCorrelation,
    relationName: string,
    kind: string,
    known: Readonly<Record<string, unknown>> | undefined,
    useRef: boolean
  ): Record<string, unknown>[] {
    return correlation.childReferencedFields.map((childField, index) => {
      const fkField = correlation.parentFkFields[index]!;
      if (Object.hasOwn(correlation.override, fkField)) {
        return { [childField]: { equals: correlation.override[fkField] } };
      }
      return {
        [childField]: {
          equals: useRef
            ? referencedFieldRef(
                this.parentIdSource,
                fkField,
                relationName,
                kind
              )
            : referencedFieldValue(
                this.parentIdSource,
                fkField,
                known,
                relationName,
                kind
              ),
        },
      };
    });
  }

  /** The correlated locate probe for a parent-held `update`/`upsert`: `WHERE
   *  <referenced> = <finalFk> [AND <filter>] [AND <pk> = <capturedPk>]`, one row, FOR
   *  UPDATE in tx. `filter` is W4-U3's non-unique `update: { where, data }` term on the
   *  currently connected record — a plain `WhereInput` handed to the find builder whole;
   *  a connected row that fails it leaves the probe empty, which is already this
   *  family's target-not-found abort (`parentHeldCapturedPk`). */
  private parentHeldProbeStatement(
    childScope: QueryScope,
    childPrimaryKey: string,
    correlation: ParentHeldCorrelation,
    capturedPk: unknown,
    useRef: boolean,
    known?: Readonly<Record<string, unknown>>,
    filter?: Record<string, unknown>
  ): Sql {
    return buildFind(
      childScope,
      {
        where: {
          AND: [
            ...this.parentHeldCorrelationFilters(
              correlation,
              "parent-held",
              "update",
              known,
              useRef
            ),
            ...(filter && Object.keys(filter).length > 0 ? [filter] : []),
            ...(capturedPk === undefined
              ? []
              : [{ [childPrimaryKey]: { equals: capturedPk } }]),
          ],
        },
        select: { [childPrimaryKey]: true },
        forUpdate: this.mode === "transaction",
      },
      { limit: 1 }
    );
  }

  /** A parent-held `create` under update: an unconditional before-root target
   *  INSERT, the root UPDATE's FK column referencing its identity by a `Ref`. */
  private interpretParentHeldCreate(
    input: Parameters<UpdateOperation["interpretRelation"]>[0],
    relationName: string,
    relationInfo: RelationInfo,
    fk: FkDirection
  ): ParentHeldTarget {
    this.assertNotSharedPk(relationName, fk, "create");
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const before = this.buildBeforeTarget(
      childScope,
      normalizeSingle(input.parsedRelation.create, relationName, "create"),
      relationName
    );
    return {
      kind: "create",
      relationName,
      relationInfo,
      before,
      fkAssign: this.beforeTargetFkAssign(fk, before, relationName),
    };
  }

  /** A parent-held `connectOrCreate` under update: a global probe decides at
   *  compile — found → FK ← the where's referenced literal (+ batch exists guard);
   *  missing → before-root target INSERT (racePin) + FK ← its `Ref`. */
  private interpretParentHeldConnectOrCreate(
    input: Parameters<UpdateOperation["interpretRelation"]>[0],
    relationName: string,
    relationInfo: RelationInfo,
    fk: FkDirection
  ): ParentHeldTarget {
    this.assertNotSharedPk(relationName, fk, "connectOrCreate");
    const spec = normalizeSingle(
      input.parsedRelation.connectOrCreate,
      relationName,
      "connectOrCreate"
    );
    const where = requireRecord(
      spec.where,
      `${relationName}.connectOrCreate.where`
    );
    const createData = requireRecord(
      spec.create,
      `${relationName}.connectOrCreate.create`
    );
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const before = this.buildBeforeTarget(childScope, createData, relationName);
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    const probeId = input.scope.allocate(`${childName}.find`);
    const guardId = input.scope.allocate(`${childName}.guard.exists`);
    const pkSelect = Object.fromEntries(fk.pkFields.map((f) => [f, true]));
    return {
      kind: "connectOrCreate",
      relationName,
      relationInfo,
      probeId,
      guardId,
      guardProbe: buildFindUnique(childScope, { where, select: pkSelect }),
      probe: {
        id: probeId,
        kind: "read",
        statement: buildFindUnique(childScope, {
          where,
          select: pkSelect,
          forUpdate: input.txMode,
        }),
        outputs: { rows: { kind: "rows" } },
      },
      foundFkAssign: this.toOneFkAssignLiteral(fk, where, relationName),
      before,
      missingFkAssign: this.beforeTargetFkAssign(fk, before, relationName),
      racePin: childRacePin(childScope, where),
    };
  }

  /** A shared-primary-key parent-held edge (the FK IS this record's PK) under
   *  create/connectOrCreate would rewrite the parent PK — a PK transition. Route
   *  the whole tree to V1 (its `getUpdatedPrimaryKeyWhere` resolves it). */
  private assertNotSharedPk(
    relationName: string,
    fk: FkDirection,
    kind: string
  ): void {
    const recordPk = getPrimaryKeyFields(this.model);
    if (fk.fkFields.some((fkField) => recordPk.includes(fkField))) {
      throw new UnsupportedOperationError(
        `query-engine-v2 update does not support a shared-primary-key ${kind} on relation '${relationName}' (the foreign key '${fk.fkFields.join(", ")}' is this record's primary key).`
      );
    }
  }

  /** Build a scalar-only before-root target INSERT plan (defaults materialized,
   *  the generated PK captured). A nested-relation target create routes to V1. */
  private buildBeforeTarget(
    childScope: QueryScope,
    createData: Record<string, unknown>,
    relationName: string
  ): BeforeTarget {
    const separated = separateData(childScope, createData);
    if (Object.keys(separated.relations).length > 0) {
      throw new UnsupportedOperationError(
        `query-engine-v2 update does not support a nested-relation target create on the parent-held to-one relation '${relationName}'.`
      );
    }
    const { identity, generatedField } = planNestedCreateIdentity(
      childScope.model,
      separated.scalarData
    );
    const scalarData = { ...separated.scalarData };
    if (generatedField) delete scalarData[generatedField];
    const childName = getStepModelName(childScope.model, "record");
    const writeStepId = this.scope.allocate(`${childName}.create`);
    return { childScope, scalarData, generatedField, identity, writeStepId };
  }

  /** The record FK columns ← a before-root target's referenced values (a `Ref` to
   *  a captured generated id, or a known literal) — for the root UPDATE's SET. */
  private beforeTargetFkAssign(
    fk: FkDirection,
    before: BeforeTarget,
    relationName: string
  ): Record<string, unknown> {
    const fkAssign: Record<string, unknown> = {};
    for (let index = 0; index < fk.fkFields.length; index += 1) {
      fkAssign[fk.fkFields[index]!] = referenceSql(
        this.engine,
        this.model,
        fk.fkFields[index]!,
        this.beforeTargetReferencedValue(
          before,
          fk.pkFields[index]!,
          relationName
        )
      );
    }
    return fkAssign;
  }

  /** The value a before-root target produces for one referenced field — a `Ref`
   *  to its captured generated id, or its known literal identity. */
  private beforeTargetReferencedValue(
    before: BeforeTarget,
    referencedField: string,
    relationName: string
  ): unknown {
    if (before.generatedField === referencedField) {
      return ref(before.writeStepId, "id");
    }
    if (Object.hasOwn(before.identity, referencedField)) {
      return before.identity[referencedField];
    }
    throw new UnsupportedOperationError(
      `query-engine-v2 update cannot resolve referenced field '${referencedField}' for the before-root target of relation '${relationName}'.`
    );
  }

  /** The record FK columns ← the connectOrCreate found-arm's referenced literals
   *  (from the connect `where`) — the connect-by-non-referenced-unique shape routes
   *  to V1 (needs a lookup subquery). */
  private toOneFkAssignLiteral(
    fk: FkDirection,
    where: Record<string, unknown>,
    relationName: string
  ): Record<string, unknown> {
    const fkAssign: Record<string, unknown> = {};
    for (let index = 0; index < fk.fkFields.length; index += 1) {
      const referenced = fk.pkFields[index]!;
      if (!Object.hasOwn(where, referenced)) {
        throw new UnsupportedOperationError(
          `query-engine-v2 update to-one connectOrCreate for relation '${relationName}' must reference '${referenced}' directly.`
        );
      }
      fkAssign[fk.fkFields[index]!] = referenceSql(
        this.engine,
        this.model,
        fk.fkFields[index]!,
        where[referenced]
      );
    }
    return fkAssign;
  }

  /** The before-root target INSERT step (capturing a generated PK). Mirrors
   *  `CreateOperation.buildInsertStep`: `firstRowField` on a returning driver in
   *  tx mode, the driver `insertId` otherwise. */
  private buildBeforeTargetInsert(before: BeforeTarget): StatementStep {
    const { childScope, generatedField, writeStepId, scalarData } = before;
    const txMode = this.mode === "transaction";
    if (!generatedField) {
      return {
        id: writeStepId,
        kind: "write",
        statement: buildInsert(
          childScope,
          getTableName(childScope.model),
          scalarData
        ),
        outputs: {},
      };
    }
    const returning = this.engine.adapter.capabilities.supportsReturning;
    return {
      id: writeStepId,
      kind: "write",
      statement:
        txMode && returning
          ? buildCreate(childScope, {
              data: scalarData,
              select: { [generatedField]: true },
            })
          : buildInsert(childScope, getTableName(childScope.model), scalarData),
      outputs: {
        id:
          txMode && returning
            ? { kind: "firstRowField", field: generatedField }
            : { kind: "insertId" },
      },
    };
  }

  /**
   * Resolve every parent-held-target arm. `create`/`connectOrCreate` fold their FK
   * into the root UPDATE's SET (returned as `extraSet`) and emit before-root INSERTs
   * (TO-ONE.md §7.0.2). The family-A `update`/`delete`/`upsert` arms emit their OWN
   * correlated child writes (into `writes`, after the root update — V1's
   * root-scalar-then-relations order) and, for `delete`/absent-`upsert`, a dedicated
   * parent-FK write (never a root-SET fold).
   */
  private compileParentHeldTargets(
    known: Readonly<Record<string, unknown>>,
    locatedRow: Record<string, unknown>,
    guards: OperationStep[],
    beforeRootWrites: OperationStep[],
    writes: OperationStep[]
  ): Record<string, unknown> {
    const extraSet: Record<string, unknown> = {};
    for (const target of this.parentHeldTargets) {
      switch (target.kind) {
        case "create":
          beforeRootWrites.push(this.buildBeforeTargetInsert(target.before));
          Object.assign(extraSet, target.fkAssign);
          break;
        case "connectOrCreate":
          this.compileParentHeldConnectOrCreate(
            target,
            known,
            guards,
            beforeRootWrites,
            extraSet
          );
          break;
        case "update":
          this.compileParentHeldUpdate(target, known, guards, writes);
          break;
        case "delete":
          this.compileParentHeldDelete(target, known, locatedRow, writes);
          break;
        default:
          this.compileParentHeldUpsert(
            target,
            known,
            locatedRow,
            guards,
            beforeRootWrites,
            writes
          );
          break;
      }
    }
    return extraSet;
  }

  private compileParentHeldConnectOrCreate(
    target: Extract<ParentHeldTarget, { kind: "connectOrCreate" }>,
    known: Readonly<Record<string, unknown>>,
    guards: OperationStep[],
    beforeRootWrites: OperationStep[],
    extraSet: Record<string, unknown>
  ): void {
    const rows = known[planningKey(target.probeId, "rows")];
    const found = Array.isArray(rows) && rows.length > 0;
    if (found) {
      Object.assign(extraSet, target.foundFkAssign);
      if (this.mode === "batch") {
        guards.push(
          presenceGuard(
            target.guardId,
            target.guardProbe,
            nestedWriteFailure(
              // V1's found-arm captured guard: the planning-seen target vanished
              // before the batch — a replacement race, not a plain not-found
              // (RelationBranches replacementFailure; byte-identical message).
              nestedReplacement("connectOrCreate"),
              target.relationName,
              false
            )
          )
        );
      }
      return;
    }
    beforeRootWrites.push({
      ...this.buildBeforeTargetInsert(target.before),
      racePin: target.racePin,
    });
    Object.assign(extraSet, target.missingFkAssign);
  }

  /** Compile a family-A parent-held `update`: the captured PK addresses the located
   *  target's UPDATE (empty capture is V1's "target record was not found for this
   *  parent"); the batch split-witness guard pins the correlation. */
  private compileParentHeldUpdate(
    target: Extract<ParentHeldTarget, { kind: "update" }>,
    known: Readonly<Record<string, unknown>>,
    guards: OperationStep[],
    writes: OperationStep[]
  ): void {
    const capturedPk = this.parentHeldCapturedPk(
      known,
      target.probeId,
      target.childPrimaryKey,
      target.relationInfo,
      "update"
    );
    if (this.mode === "batch") {
      guards.push(
        presenceGuard(
          target.guardId,
          this.parentHeldProbeStatement(
            target.childScope,
            target.childPrimaryKey,
            target.correlation,
            capturedPk,
            false,
            known,
            // W4-U3: the batch guard re-asserts the wrapper's filter alongside the
            // correlation and the captured PK — a concurrent write that makes the
            // connected row fail the filter aborts the batch typed, exactly as the
            // tx path's locked probe would have.
            target.filter
          ),
          nestedWriteFailure(
            relationTargetNotFound(target.relationInfo, "update"),
            target.relationName,
            false
          )
        )
      );
    }
    // The located target's self-UPDATE (emitted only when its payload carries scalar
    // assignments — a relation-only parent-held update writes no target row) lands
    // BEFORE its child Parts by default, or AFTER them on a PK transition it rewrites
    // (ON UPDATE CASCADE ported to depth). Its child Parts' guards hoist ahead of every
    // write via the bucketing in `compileParentHeldTargets`' caller.
    const selfUpdate =
      Object.keys(target.data).length > 0
        ? {
            id: target.writeId,
            kind: "write" as const,
            statement: buildUpdate(target.childScope, {
              where: { [target.childPrimaryKey]: capturedPk },
              data: target.data,
              select: { [target.childPrimaryKey]: true },
            }),
            outputs: {},
          }
        : undefined;
    const childSteps: OperationStep[] = [];
    for (const part of target.childParts) {
      for (const step of part.compile(this.scope, known)) {
        (step.kind === "guard" ? guards : childSteps).push(step);
      }
    }
    if (selfUpdate && !target.reorderAfterChildren) writes.push(selfUpdate);
    writes.push(...childSteps);
    if (selfUpdate && target.reorderAfterChildren) writes.push(selfUpdate);
  }

  /** Compile a family-A parent-held `delete: true`: NULL the parent FK (V1's
   *  `RelationRemovals.delete` `holdsFK` arm), then correlated bulk-delete the
   *  referenced target by its (pre-null) FK value. Zero matches is silent success. */
  private compileParentHeldDelete(
    target: Extract<ParentHeldTarget, { kind: "delete" }>,
    known: Readonly<Record<string, unknown>>,
    locatedRow: Record<string, unknown>,
    writes: OperationStep[]
  ): void {
    writes.push({
      id: target.nullWriteId,
      kind: "write",
      statement: buildUpdate(
        createQueryScope(this.engine.adapter, this.model),
        {
          where: this.parentPrimaryKeyWhere(locatedRow),
          data: Object.fromEntries(
            target.fkFields.map((field) => [field, { set: null }])
          ),
          select: this.pkSelect(),
        }
      ),
      outputs: {},
    });
    writes.push({
      id: target.deleteWriteId,
      kind: "write",
      statement: buildDeleteMany(target.childScope, {
        where: this.parentHeldCorrelationWhere(
          target.correlation,
          target.relationName,
          "delete",
          known
        ),
      }),
      outputs: {},
    });
  }

  /** Compile a family-A parent-held `upsert`: found → UPDATE the located target
   *  (the parent FK already equals the located value; V1's no-op re-write is
   *  elided); absent → INSERT the target (before root) and set the parent FK to the
   *  created identity. */
  private compileParentHeldUpsert(
    target: Extract<ParentHeldTarget, { kind: "upsert" }>,
    known: Readonly<Record<string, unknown>>,
    locatedRow: Record<string, unknown>,
    guards: OperationStep[],
    beforeRootWrites: OperationStep[],
    writes: OperationStep[]
  ): void {
    const rows = known[planningKey(target.probeId, "rows")];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 upsert probe for relation '${target.relationName}' did not expose rows.`,
        target.relationName
      );
    }
    if (rows.length === 0) {
      // Absent arm: INSERT the target before the root, then rebind the parent's FK
      // to its (possibly generated) identity — V1's `updateParentForeignKey`.
      beforeRootWrites.push(this.buildBeforeTargetInsert(target.before));
      writes.push({
        id: target.parentSetId,
        kind: "write",
        statement: buildUpdate(
          createQueryScope(this.engine.adapter, this.model),
          {
            where: this.parentPrimaryKeyWhere(locatedRow),
            data: target.missingFkAssign,
            select: this.pkSelect(),
          }
        ),
        outputs: {},
      });
      return;
    }
    const capturedPk = this.parentHeldCapturedPk(
      known,
      target.probeId,
      target.childPrimaryKey,
      target.relationInfo,
      "update"
    );
    if (this.mode === "batch") {
      guards.push(
        presenceGuard(
          target.guardId,
          this.parentHeldProbeStatement(
            target.childScope,
            target.childPrimaryKey,
            target.correlation,
            capturedPk,
            false,
            known
          ),
          nestedWriteFailure(
            upsertPremiseChanged(target.relationName),
            target.relationName,
            false
          )
        )
      );
    }
    writes.push({
      id: target.writeId,
      kind: "write",
      statement: buildUpdate(target.childScope, {
        where: { [target.childPrimaryKey]: capturedPk },
        data: target.updateData,
        select: { [target.childPrimaryKey]: true },
      }),
      outputs: {},
    });
  }

  /** The parent's primary-key where-unique for a dedicated parent-FK write. */
  private parentPrimaryKeyWhere(
    locatedRow: Record<string, unknown>
  ): Record<string, unknown> {
    return buildPrimaryKeyWhereUnique(
      this.model,
      Object.fromEntries(
        this.parentPrimaryKeys.map((pk) => [pk, locatedRow[pk]])
      )
    );
  }

  /** The compile-time correlated `WHERE <referenced> = <finalFk>` for a bulk
   *  parent-held write (the `delete` arm). */
  private parentHeldCorrelationWhere(
    correlation: ParentHeldCorrelation,
    relationName: string,
    kind: string,
    known: Readonly<Record<string, unknown>>
  ): Record<string, unknown> {
    const filters = this.parentHeldCorrelationFilters(
      correlation,
      relationName,
      kind,
      known,
      false
    );
    return filters.length === 1 ? filters[0]! : { AND: filters };
  }

  /** The PK the parent-held probe captured at planning — the located target this
   *  arm mutates. An empty capture is V1's verbatim "target record was not found
   *  for this parent" (the parent's FK pointed at nothing / a vanished row). */
  private parentHeldCapturedPk(
    known: Readonly<Record<string, unknown>>,
    probeId: string,
    childPrimaryKey: string,
    relationInfo: RelationInfo,
    op: "update"
  ): unknown {
    const rows = known[planningKey(probeId, "rows")];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 update probe for relation '${relationInfo.name}' did not expose rows.`,
        relationInfo.name
      );
    }
    if (rows.length === 0) {
      throw new NestedWriteError(
        relationTargetNotFound(relationInfo, op),
        relationInfo.name
      );
    }
    const first = rows[0];
    if (!(first && typeof first === "object")) {
      throw new NestedWriteError(
        `query-engine-v2 update probe for relation '${relationInfo.name}' captured no row shape.`,
        relationInfo.name
      );
    }
    return (first as Record<string, unknown>)[childPrimaryKey];
  }

  private interpretToOneLink(
    scope: StepScope,
    relationName: string,
    relationInfo: RelationInfo,
    fk: FkDirection,
    kind: string,
    parsedRelation: Record<string, unknown>
  ): ToOneLink {
    if (kind === "disconnect") {
      // V1-verbatim rejection when a required FK cannot be nulled.
      assertNullable(relationInfo, fk);
      return {
        relationName,
        relationInfo,
        assignment: Object.fromEntries(
          fk.fkFields.map((field) => [field, { set: null }])
        ),
      };
    }
    if (kind !== "connect") {
      // Unreachable by construction (N7-U-A, the X1c disposition): the only two callers
      // reach `interpretToOneLink` on the `connect` / `disconnect` arms, and `disconnect`
      // returned above. The remaining to-one keys (create / connectOrCreate / update /
      // upsert / delete) dispatch elsewhere, and a key outside the factory's set is
      // answered by the parse boundary first (`ValidationError: Unknown key: <kind>`).
      throw new QueryEngineError(
        `query-engine-v2 internal: kind '${kind}' reached the to-one link builder on relation '${relationName}'; only connect and disconnect are routed here.`
      );
    }
    const connect = normalizeSingle(
      parsedRelation.connect,
      relationName,
      "connect"
    );
    const assignment: Record<string, unknown> = {};
    for (let index = 0; index < fk.fkFields.length; index += 1) {
      const referencedField = fk.pkFields[index]!;
      if (!Object.hasOwn(connect, referencedField)) {
        // Connect by a non-referenced unique needs a lookup value; out of P2a
        // scope — route the whole tree to V1.
        throw new UnsupportedOperationError(
          `query-engine-v2 update to-one connect for relation '${relationName}' must reference '${referencedField}' directly.`
        );
      }
      assignment[fk.fkFields[index]!] = { set: connect[referencedField] };
    }
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    const probeId = scope.allocate(`${childName}.find`);
    const guardId = scope.allocate(`${childName}.guard.exists`);
    const probe: StatementStep = {
      id: probeId,
      kind: "read",
      statement: buildFindUnique(childScope, {
        where: connect,
        select: Object.fromEntries(fk.pkFields.map((field) => [field, true])),
        forUpdate: this.mode === "transaction",
      }),
      outputs: { rows: { kind: "rows" } },
    };
    return {
      relationName,
      relationInfo,
      assignment,
      connect: { probeId, guardId, probe },
    };
  }

  private compileToOneConnect(
    link: ToOneLink,
    known: Readonly<Record<string, unknown>>
  ): OperationStep[] {
    if (!link.connect) return [];
    const rows = known[planningKey(link.connect.probeId, "rows")];
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new NestedWriteError(
        relationTargetNotFound(link.relationInfo, "connect"),
        link.relationName
      );
    }
    if (this.mode === "transaction") return [];
    // Batch: pin the connect target's presence before the parent SET.
    return [
      presenceGuard(
        link.connect.guardId,
        link.connect.probe.statement,
        nestedWriteFailure(
          relationTargetNotFound(link.relationInfo, "connect"),
          link.relationName,
          false
        )
      ),
    ];
  }

  private buildRootUpdate(
    locatedRow: Record<string, unknown>,
    extraSet: Record<string, unknown> = {}
  ): StatementStep {
    const parent = createQueryScope(this.engine.adapter, this.model);
    const txMode = this.mode === "transaction";
    const parentName = getStepModelName(this.model, "parent");
    // The exact-affected postcondition is a returning-driver check only. On a
    // non-returning driver V1 uses `affectedRows: unrestricted` (its
    // `compileMutationRefetch`): the locked locate already proved existence, so a
    // MySQL-style no-op UPDATE (0 rows changed because the value is unchanged) is
    // accepted, not a spurious NotFound. The terminal read confirms the final row.
    const enforceAffected =
      txMode && this.engine.adapter.capabilities.supportsReturning;
    return {
      id: this.updateId,
      kind: "write",
      statement: buildUpdate(parent, {
        // Address the row by the PK captured at the (FOR UPDATE) locate — V1's
        // `WHERE id` mechanic (locate by an alternate unique, mutate by the
        // immutable captured PK). Transaction mode only; batch mode keeps the
        // original `where` so the write and its presence guard pin one row.
        where: this.writeWhere(locatedRow),
        // The construction-time SET (scalar ∪ connect/disconnect folds) unioned
        // with the compile-time parent-held create/connectOrCreate FK folds
        // (`extraSet`), which reference the before-root target (TO-ONE.md §7.0.2).
        data: { ...this.parentUpdateData, ...extraSet },
        select: this.pkSelect(),
      }),
      outputs: {},
      ...(enforceAffected
        ? {
            expects: affectedRows(
              1,
              notFoundFailure(
                `query-engine-v2 update located no '${parentName}' row for its unique where.`
              )
            ),
          }
        : {}),
    };
  }

  /** The row's post-locate address: the captured PK in transaction mode (V1's
   *  `WHERE id`), the original `where` in batch mode (guard/write pin one row). A
   *  nested target has no standalone unique `where` (a to-one / parent-held target
   *  locates by correlation) and its batch presence guard already pins the correlated
   *  captured PK, so it addresses by the captured PK on BOTH substrates (X1c). */
  private writeWhere(
    locatedRow: Record<string, unknown>
  ): Record<string, unknown> {
    if (this.mode !== "transaction" && !this.nestedTarget) {
      return this.parentWhere;
    }
    return buildPrimaryKeyWhereUnique(
      this.model,
      Object.fromEntries(
        this.parentPrimaryKeys.map((pk) => [pk, locatedRow[pk]])
      )
    );
  }

  /** The batch-mode root-presence assertion (ATOM §8.1 note (b)). A nested target's
   *  guard is the located-target split-witness (X1c): the original correlation AND the
   *  captured PK must still name the same row, so a concurrent cross-parent move of the
   *  selector leaves no such row and the batch aborts typed, never mutating the
   *  replacement a selector-alone guard would have found. */
  private buildRootPresenceGuard(
    known?: Readonly<Record<string, unknown>>,
    locatedRow?: Record<string, unknown>
  ): OperationStep {
    const parent = createQueryScope(this.engine.adapter, this.model);
    if (this.nestedTarget && known && locatedRow) {
      const capturedPk = Object.fromEntries(
        this.parentPrimaryKeys.map((pk) => [pk, { equals: locatedRow[pk] }])
      );
      return presenceGuard(
        this.rootGuardId,
        buildFind(
          parent,
          {
            where: {
              AND: [
                ...this.nestedTargetWhereFilters(parent),
                ...this.nestedTargetCorrelationFilters(known, false),
                capturedPk,
              ],
            },
            select: this.pkSelect(),
          },
          { limit: 1 }
        ),
        nestedWriteFailure(
          this.nestedTarget.notFoundMessage,
          this.nestedTarget.relationName,
          false
        )
      );
    }
    return presenceGuard(
      this.rootGuardId,
      buildFindUnique(parent, {
        where: this.parentWhere,
        select: this.pkSelect(),
      }),
      notFoundFailure(
        `query-engine-v2 update located no '${getStepModelName(this.model, "record")}' row for its unique where.`
      )
    );
  }

  /** A nested target's own unique-selector conjuncts (a child-held to-many `update`);
   *  `[]` for a to-one / parent-held target located by correlation alone. Since N6-U1
   *  that selector may be EXTENDED, so {@link uniqueSelectorConjuncts} appends its
   *  filter half — the same one home the three Parts use.
   *
   *  W4-U3's separate non-unique `filter` (the to-one `{ where, data }` wrapper) rides
   *  along verbatim afterwards. The two are distinct inputs that happen to land in the
   *  same conjunction: a to-one target has a `filter` and NO `where`, a to-many target
   *  has a `where` (now possibly carrying its own filter half) and no wrapper `filter`.
   *  Both consumers of this list — the locate and the batch presence guard — take the
   *  whole conjunction, so neither can address a row the other excluded. */
  private nestedTargetWhereFilters(
    parent: QueryScope
  ): Record<string, unknown>[] {
    const filters: Record<string, unknown>[] = [];
    const where = this.nestedTarget?.where;
    if (where) filters.push(...uniqueSelectorConjuncts(parent, where));
    const filter = this.nestedTarget?.filter;
    if (filter && Object.keys(filter).length > 0) filters.push(filter);
    return filters;
  }

  /** `child.<childField> = parent.<referenced>` per correlation field — a SQL `Ref` to
   *  the enclosing locate for a `planned` parent in a planning step (technique #1), the
   *  inlined literal at compile (the batch guard) or for a compile-time literal parent
   *  (a depth-composed literal-parent target). Mirrors `RelationWritePart`'s locator. */
  private nestedTargetCorrelationFilters(
    known: PlanningKnown | undefined,
    useRef: boolean
  ): Record<string, unknown>[] {
    const nt = this.nestedTarget;
    if (!nt) return [];
    const refable = useRef && nt.parentId.kind === "planned";
    return nt.childFields.map((childField, index) => ({
      [childField]: {
        equals: refable
          ? referencedFieldRef(
              nt.parentId,
              nt.parentFields[index]!,
              nt.relationName,
              "update"
            )
          : referencedFieldValue(
              nt.parentId,
              nt.parentFields[index]!,
              known,
              nt.relationName,
              "update"
            ),
      },
    }));
  }

  private pkSelect(): Record<string, boolean> {
    return Object.fromEntries(this.parentPrimaryKeys.map((pk) => [pk, true]));
  }

  private buildTerminal(locatedRow: Record<string, unknown>): StatementStep {
    const parent = createQueryScope(this.engine.adapter, this.model);
    const txMode = this.mode === "transaction";
    return {
      id: this.terminalId,
      kind: "read",
      statement: buildFindUnique(parent, {
        // Address the row by its POST-update primary key: a PK the update SET
        // rewrote (literal rename or portable arithmetic) moves the identity, so
        // the located pre-update PK would miss the row. `getUpdatedPrimaryKeyWhere`
        // returns the located PK unchanged when the update leaves it alone, and
        // wraps a compound PK into its where-unique shape. It reuses V1's exact
        // arithmetic (and its typed refusal of an ambiguous PK operation).
        where: getUpdatedPrimaryKeyWhere(
          parent,
          locatedRow,
          this.parentUpdateData,
          getStepModelName(this.model, "record")
        ),
        select: this.parsedSelect,
        ...(this.parsedInclude ? { include: this.parsedInclude } : {}),
      }),
      outputs: { result: { kind: "rows" } },
      ...(txMode
        ? {
            expects: exactlyOneRow(
              queryFailure(
                "query-engine-v2 update terminal read expected exactly one row."
              )
            ),
          }
        : {}),
    };
  }
}

/** CLASS V (T4c): whether an `updateMany` input (one item or an array) carries a
 *  nested relation write in its data — the shape V1 rejects with `NestedWriteError`
 *  ({@link UpdateOperation.assertUpdateManyRelationLegality}). */
function updateManyCarriesRelations(
  childScope: QueryScope,
  input: unknown
): boolean {
  const inputs = Array.isArray(input) ? input : [input];
  return inputs.some((item) => {
    if (!(isRecord(item) && isRecord(item.data))) return false;
    return (
      Object.keys(separateData(childScope, item.data).relations).length > 0
    );
  });
}

function normalizeItems(
  value: unknown,
  relation: string
): Record<string, unknown>[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (!isRecord(item)) {
      throw new QueryEngineError(
        `Relation '${relation}' upsert item must be an object.`
      );
    }
    return item;
  });
}

/** A construction-time scalar literal (a value a nested-create FK can inline). An
 *  object (a `{ increment }` / `{ set }` arithmetic op, a Date is allowed) or null
 *  is not — those route the create to V1 (D4 threads only a plain rewritten value). */
function isConstructionLiteral(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const t = typeof value;
  if (t === "object") return value instanceof Date;
  return t === "string" || t === "number" || t === "bigint" || t === "boolean";
}

/** An `unknown -> Record` narrowing, NOT a shape check (N7-U-A). Every caller reads a
 *  dynamically-keyed slot of an ALREADY-PARSED payload, and every to-ONE arm of
 *  `toOneUpdateFactory` is a single object — never a `singleOrArray`, unlike the to-many
 *  factory. So an array answers at the parse boundary (`ValidationError: Expected object`,
 *  or `Expected boolean` for `disconnect`) and so does a non-record. Both branches are
 *  engine invariants, not routes — the X1c disposition. */
function normalizeSingle(
  value: unknown,
  relation: string,
  kind: string
): Record<string, unknown> {
  if (Array.isArray(value) && value.length !== 1) {
    throw new QueryEngineError(
      `query-engine-v2 internal: the to-one ${kind} for relation '${relation}' carried multiple targets after the parse boundary validated it as a single object.`
    );
  }
  const item = Array.isArray(value) ? value[0] : value;
  if (!isRecord(item)) {
    throw new QueryEngineError(
      `query-engine-v2 internal: the to-one ${kind} for relation '${relation}' reached its builder without the single unique where the parse boundary validated.`
    );
  }
  return item;
}

function defaultSelect(model: Model<any>): Record<string, unknown> {
  // V1's default projection is every scalar EXCEPT `.omit()`-ed fields — the raw
  // scalar names would leak an omitted column into the public result.
  return Object.fromEntries(
    getDefaultScalarFieldNames(model).map((field: string) => [field, true])
  );
}

/** As {@link normalizeSingle}: an `unknown -> Record` narrowing behind the whole-args
 *  update parse, converted by N7-U-A. `update.where` / `update.data` are validated by
 *  `parseValidated(parentSchemas.args.update)` before this runs, and a nested target's
 *  `where` / `data` come from the ENCLOSING parse's output. */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new QueryEngineError(
    `query-engine-v2 internal: '${label}' must be an object after the parse boundary validated the update payload.`
  );
}
