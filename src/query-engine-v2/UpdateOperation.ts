// biome-ignore-all lint/style/useFilenamingConvention: UpdateOperation is the architecture name.
import {
  NestedWriteError,
  NotFoundError,
  QueryEngineError,
  ValidationError,
} from "@errors";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import { parse, type VibSchema } from "@validation";
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
  getUpdatedPrimaryKeyWhere,
  planNestedCreateIdentity,
} from "../query-engine/operations/mutation-identity";
import type { QueryEngine } from "../query-engine/query-engine";
import { assertNullable } from "../query-engine/RelationProgramValues";
import { ResultParser } from "../query-engine/result/ResultParser";
import { classifyRelationKeyScalarUpdate } from "../query-engine/TargetConstraint";
import type { QueryScope, RelationInfo } from "../query-engine/types";
import {
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
  relationTargetNotFound,
  upsertPremiseChanged,
} from "./messages";
import { buildNestedTargetChildParts } from "./nested-target-parts";
import {
  type OperationFragment,
  type OperationStep,
  ref,
  type StatementStep,
  type TargetConstraintPin,
} from "./OperationFragment";
import { OwnWritePreflight } from "./OwnWritePreflight";
import type { Part } from "./Part";
import { planningKey, planningOutputs } from "./Part";
import { referencedFieldRef, referencedFieldValue } from "./parent-reference";
import { buildJunctionParts } from "./RelationJunctionPart";
import { buildToManyLinkParts } from "./RelationLinkPart";
import {
  buildConnectOrCreateParts,
  buildToManyUpsertParts,
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
  selectExecutionMode,
  UnsupportedOperationError,
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
      readonly racePin: TargetConstraintPin;
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
      readonly data: Record<string, unknown>;
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
  private readonly model: Model<any>;
  private readonly scope: StepScope;
  private readonly resultArgs: Record<string, unknown>;
  private readonly childParts: readonly Part[];
  private readonly toOneLinks: readonly ToOneLink[];
  // Parent-held to-one `create`/`connectOrCreate` under update: a before-root
  // target INSERT whose identity the root parent UPDATE's FK column references
  // (TO-ONE.md §7.0.2). Emitted between the guards and the root UPDATE at compile.
  private readonly parentHeldTargets: readonly ParentHeldTarget[];
  // The located-parent id source (a planning read inlined at compile) — consumed by
  // the family-A parent-held correlation filters, which read/ref the parent's FK
  // columns from the located row.
  private readonly parentIdSource!: ReturnType<typeof plannedParentId>;
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
  private readonly terminalId: string;
  private readonly rootGuardId: string;
  // The parent SET (scalar data ∪ to-one FK folds), retained so the terminal read
  // addresses the row by its POST-update primary key — a literal rename or a
  // portable arithmetic increment on a PK field moves the identity the located
  // (pre-update) row no longer answers to (the `DerivedValue` disposition, ATOM §3).
  private readonly parentUpdateData: Record<string, unknown>;

  constructor(
    engine: QueryEngine,
    model: Model<any>,
    args: Record<string, unknown>
  ) {
    this.engine = engine;
    this.model = model;
    this.mode = selectExecutionMode(engine, "update");
    const txMode = this.mode === "transaction";
    this.scope = new StepScope();
    const scope = this.scope;

    // 1. Validate the argument shape. `where` locates by any unique; `data`
    //    mixes scalar assignments and nested relation mutations; `select` is
    //    optional and shapes the terminal read (Prisma's default is all scalars).
    assertUpdateKeys(args);
    const parentSchemas = engine.schemaRegistry.getModelSchemas(model);
    // V1's shared validator (validator.ts) validates the WHOLE args against the
    // `args.update` schema BEFORE any relation parsing. V2's per-field parse path
    // reaches `separateData`'s relation-mutation parser first, so an unknown nested
    // key — a `deleteMany` on a to-one relation — surfaced V2's "Nested operation …
    // is not supported for to-one relation" where V1 rejects "Unknown key:
    // deleteMany" at schema validation, before the parent mutation. Run V1's
    // whole-args validation first so the rejection ordering AND message match.
    validateUpdateArgs(parentSchemas.args.update, args);
    const where = requireRecord(args.where, "update.where");
    const data = requireRecord(args.data, "update.data");
    // V1 runs this in its shared `validator` (validator.ts) for every operation;
    // V2's per-schema parse path bypasses it, so a top-level PK arithmetic that
    // is not portable (float/decimal), divides by zero, or stacks operations was
    // caught late (at the terminal read's `getUpdatedPrimaryKeyWhere`, after the
    // locate ran) with V1's OTHER message. Run it at construction, before any I/O.
    assertPortablePrimaryKeyUpdateInput(model, "update", args);
    const parent = createQueryScope(engine.adapter, model);
    const separated = separateData(parent, data);

    const parentPrimaryKeys = getPrimaryKeyFields(model);
    if (parentPrimaryKeys.length === 0) {
      throw new UnsupportedOperationError(
        "query-engine-v2 update requires a parent with a primary key."
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
    assertRelationKeyUpdatesAreCompilable(
      parent,
      separated.scalarData,
      separated.relations
    );

    this.parentWhere = parseRecord(
      parentSchemas.core.whereUnique,
      where,
      "where"
    );
    this.parsedSelect = isRecord(args.select)
      ? parseRecord(parentSchemas.core.select, args.select, "select")
      : defaultSelect(model);
    this.resultArgs = { select: this.parsedSelect };

    // 2. Own-write preflight (ATOM §4): any decision read overlapping this
    //    operation's own writes is rejected here with V1's typed "split these
    //    operations" error, before planning — identically on both substrates.
    new OwnWritePreflight().assertUpdate(parent, data, where);

    const parentName = getStepModelName(model, "parent");
    const locateId = scope.allocate(`${parentName}.locate`);
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
    const toOneLinks: ToOneLink[] = [];
    const parentHeldTargets: ParentHeldTarget[] = [];
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
        throw new UnsupportedOperationError(
          `No validation schema exists for relation '${relationName}'.`
        );
      }
      const parsedRelation = parseRecord(
        relationSchemas.update,
        requireRecord(data[relationName], relationName),
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
        toOneLinks,
        parentHeldTargets,
        locateFields,
        parentFkLocateFields,
        rootScalarData: separated.scalarData,
      });
    }
    this.childParts = childParts;
    this.toOneLinks = toOneLinks;
    this.parentHeldTargets = parentHeldTargets;

    // 4. The parent SET = validated scalar data ∪ to-one FK folds. Emitted only
    //    when non-empty (a relation-only update never writes the parent row;
    //    Prisma's `update({ data: { posts: { connect } } })`).
    const parentSet: Record<string, unknown> = {};
    if (Object.keys(separated.scalarData).length > 0) {
      Object.assign(
        parentSet,
        parseRecord(
          parentSchemas.core.scalarUpdate,
          separated.scalarData,
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
      engine.adapter.capabilities.supportsReturning &&
      childParts.length === 0 &&
      toOneLinks.length === 0 &&
      parentHeldTargets.length === 0 &&
      selectIsScalarOnly &&
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
    this.locate = {
      id: locateId,
      kind: "read",
      statement: buildFindUnique(parent, {
        where: this.parentWhere,
        select: Object.fromEntries(
          locateSelectFields.map((field) => [field, true])
        ),
        forUpdate: txMode,
      }),
      // Each PK field AND each child-FK-referenced field is a firstRowField
      // output so a per-field child FK edge can ref it (compound keys / D4-style
      // non-PK references — the census's multi-field produces).
      outputs: {
        rows: { kind: "rows" },
        ...Object.fromEntries(
          locateSelectFields.map((field) => [
            field,
            { kind: "firstRowField", field },
          ])
        ),
      },
      expects: exactlyOneRow(
        notFoundFailure(
          `query-engine-v2 update located no '${parentName}' row for its unique where.`
        )
      ),
    };
  }

  planning(): OperationFragment {
    // The RETURNING fold is a single self-contained statement — no planning read
    // (the located id it would carry is unused; the RETURNING clause returns the
    // mutated row directly). Empty planning is what makes it statement-atomic.
    if (this.directWrite) return { steps: [], outputs: {} };
    const steps: OperationStep[] = [this.locate];
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
    }
    for (const part of this.childParts)
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
      guards.push(this.buildRootPresenceGuard());
    }
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
      this.engine.driver
    ).parse<T>("update", outputs.result, this.resultArgs);
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
    toOneLinks: ToOneLink[];
    parentHeldTargets: ParentHeldTarget[];
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
      input.childParts.push(
        ...buildJunctionParts({
          scope: input.scope,
          engine: this.engine,
          parentScope: input.parent,
          relationName,
          relationInfo,
          mutation,
          parsedRelation,
          parentId: input.parentIdSource,
          txMode: input.txMode,
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
      throw new UnsupportedOperationError(
        `query-engine-v2 update supports only one-to-many or inverse-side one-to-one child-held relations; relation '${relationName}' is '${relationInfo.type}'.`
      );
    }
    // Compound foreign keys are per-field (ATOM §1): every referenced parent
    // column — the PK, a subset of it, or a non-PK unique (D4-style) — is added
    // to the locate read's select/outputs so a per-field child part reads or refs
    // each one. The whole family (link/adopt/write/set) generalizes together; no
    // shape routes to V1 on account of compound arity any longer.
    for (const field of fk.pkFields) input.locateFields.add(field);
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
      });
    }
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
    } = args;
    const push = (parts: readonly Part[]) => input.childParts.push(...parts);

    switch (kind) {
      case "upsert":
        push(
          buildToManyUpsertParts(
            input.scope,
            input.parent,
            this.engine,
            relationName,
            relationInfo,
            normalizeItems(parsedRelation.upsert, relationName),
            input.parentIdSource,
            "correlated",
            input.txMode
          )
        );
        return;
      case "connectOrCreate":
        // Still a GLOBAL lookup-and-adopt under update (found → reparent, absent
        // → create), never correlated (PLAN P−1.2) — composed like the upsert part.
        push(
          buildConnectOrCreateParts(
            input.scope,
            input.parent,
            this.engine,
            relationName,
            relationInfo,
            normalizeItems(parsedRelation.connectOrCreate, relationName),
            input.parentIdSource,
            input.txMode
          )
        );
        return;
      case "connect":
      case "disconnect":
        if (kind === "disconnect") {
          // A required child FK cannot be nulled — V1's verbatim typed rejection.
          assertNullable(
            relationInfo,
            getFkDirection(input.parent, relationInfo)
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
            kind,
            kind === "connect"
              ? parsedRelation.connect
              : parsedRelation.disconnect,
            input.parentIdSource,
            input.txMode
          )
        );
        return;
      case "update":
        push(buildToManyUpdateParts(writeBase, parsedRelation.update));
        return;
      case "updateMany":
        push(buildToManyUpdateManyParts(writeBase, parsedRelation.updateMany));
        return;
      case "delete":
        push(buildToManyDeleteParts(writeBase, parsedRelation.delete));
        return;
      case "deleteMany":
        push(buildToManyDeleteManyParts(writeBase, parsedRelation.deleteMany));
        return;
      case "set":
        input.childParts.push(
          buildToManySetPart(writeBase, parsedRelation.set)
        );
        return;
      default:
        // create / createMany nested under update are V1's surface, not P2c's.
        throw new UnsupportedOperationError(
          `query-engine-v2 update does not support nested '${kind}' on relation '${relationName}'.`
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
   * F, scalar arms). `create` / non-boolean disconnect/delete / `set` / a
   * relation-carrying upsert arm route the whole tree to V1 (documented boundaries,
   * mirroring the to-many surface).
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
    input: {
      scope: StepScope;
      parent: QueryScope;
      parentIdSource: ReturnType<typeof plannedParentId>;
      txMode: boolean;
      childParts: Part[];
      rootScalarData: Record<string, unknown>;
    };
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
    } = args;
    const push = (parts: readonly Part[]) => input.childParts.push(...parts);

    switch (kind) {
      case "connect":
        // Global lookup-and-adopt: UPDATE child SET fk = parent WHERE unique, pinned
        // by an exists guard — V1's child-held connect arm. A one-to-one FK carries a
        // UNIQUE constraint, so a second row already pointing at this parent makes the
        // reparent collide (V1's steal semantics, the DB enforces the invariant).
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
            "connect",
            parsedRelation.connect,
            input.parentIdSource,
            input.txMode
          )
        );
        return;
      case "connectOrCreate":
        push(
          buildConnectOrCreateParts(
            input.scope,
            input.parent,
            this.engine,
            relationName,
            relationInfo,
            normalizeItems(parsedRelation.connectOrCreate, relationName),
            input.parentIdSource,
            input.txMode
          )
        );
        return;
      case "update":
        // Correlated targeted update with NO unique selector — the FK correlation
        // (fk = parent) is the whole locator (TO-ONE.md §7.2).
        input.childParts.push(
          buildToOneUpdatePart(writeBase, parsedRelation.update)
        );
        return;
      case "upsert":
        // Correlated to-one upsert (TO-ONE.md §7.2, family F): the correlated probe
        // decides found → update / absent → create (fk = parent), no unique `where`.
        // The same correlated locator as the `update` arm, with a create branch.
        //
        // NARROWER BOUNDARY: if the SAME root update transitions a parent column this
        // child FK references (a referenced-key transition — the root `data` writes
        // one of `referencedFields`), V1 runs its referential-action legality engine
        // (reject-occupied for non-cascade, staged setNull/restrict re-point for an
        // empty slot) around the upsert. Family F composes plain create/update leaves
        // and does NOT replicate that engine, so it would diverge (accept an occupied
        // non-cascade transition V1 rejects; mis-order the create's FK against the
        // pre-transition id). Route the whole tree to V1 for that shape — exactly as
        // the certified `nb` census case (no referenced-key write) stays on V2.
        if (
          referencedFields.some((f) => Object.hasOwn(input.rootScalarData, f))
        ) {
          throw new UnsupportedOperationError(
            `query-engine-v2 update does not support a nested upsert on the inverse-side to-one relation '${relationName}' while the root update transitions a referenced key.`
          );
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
        // create/createMany/set/updateMany/deleteMany — V1's surface under an
        // inverse-side to-one; route the whole tree to V1.
        throw new UnsupportedOperationError(
          `query-engine-v2 update does not support nested '${kind}' on the inverse-side to-one relation '${relationName}'.`
        );
    }
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
      case "update":
        input.parentHeldTargets.push(
          this.interpretParentHeldUpdate(input, relationName, relationInfo, fk)
        );
        return;
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
        // set / other kinds on the FK-holder-side to-one — V1's surface; route the
        // whole tree to V1.
        throw new UnsupportedOperationError(
          `query-engine-v2 update does not support '${kind}' on the parent-held to-one relation '${relationName}'.`
        );
    }
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
    fk: FkDirection
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
    const data = this.parentHeldScalarUpdateData(
      childScope,
      normalizeSingle(input.parsedRelation.update, relationName, "update"),
      relationName,
      "update"
    );
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    const probeId = input.scope.allocate(`${childName}.find`);
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
      data,
    };
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
   *  <referenced> = <finalFk> [AND <pk> = <capturedPk>]`, one row, FOR UPDATE in tx. */
  private parentHeldProbeStatement(
    childScope: QueryScope,
    childPrimaryKey: string,
    correlation: ParentHeldCorrelation,
    capturedPk: unknown,
    useRef: boolean,
    known?: Readonly<Record<string, unknown>>
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
            known
          ),
          nestedWriteFailure(
            relationTargetNotFound(target.relationInfo, "update"),
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
        data: target.data,
        select: { [target.childPrimaryKey]: true },
      }),
      outputs: {},
    });
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
      throw new UnsupportedOperationError(
        `query-engine-v2 update does not support nested '${kind}' on to-one relation '${relationName}'.`
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
   *  `WHERE id`), the original `where` in batch mode (guard/write pin one row). */
  private writeWhere(
    locatedRow: Record<string, unknown>
  ): Record<string, unknown> {
    if (this.mode !== "transaction") return this.parentWhere;
    return buildPrimaryKeyWhereUnique(
      this.model,
      Object.fromEntries(
        this.parentPrimaryKeys.map((pk) => [pk, locatedRow[pk]])
      )
    );
  }

  /** The batch-mode root-presence assertion (ATOM §8.1 note (b)). */
  private buildRootPresenceGuard(): OperationStep {
    const parent = createQueryScope(this.engine.adapter, this.model);
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

/**
 * V1's `RelationUpdates.assertRelationKeyUpdatesAreCompilable`, ported byte-for-
 * byte (including its message and `NestedWriteError` meta). For every non-M2M
 * relation being mutated, the relation-key fields (the FK when the parent holds
 * it, else the parent column the child FK references) may not be rewritten by a
 * non-literal operation: a `DerivedValue` on the referenced key would break the
 * correlation the nested write depends on.
 */
function assertRelationKeyUpdatesAreCompilable(
  parent: QueryScope,
  scalarData: Record<string, unknown>,
  relations: Record<string, RelationMutation>
): void {
  const primaryKeyFields = new Set(getPrimaryKeyFields(parent.model));
  for (const mutation of Object.values(relations)) {
    if (mutation.relationInfo.type === "manyToMany") continue;
    const fk = getFkDirection(parent, mutation.relationInfo);
    const relationKeyFields = fk.holdsFK ? fk.fkFields : fk.pkFields;
    for (const field of relationKeyFields) {
      if (scalarData[field] === undefined) continue;
      if (primaryKeyFields.has(field) && !fk.holdsFK) continue;
      if (classifyRelationKeyScalarUpdate(scalarData[field]).resolved) continue;
      throw new NestedWriteError(
        `Cannot update relation key field '${field}' with a non-literal operation while mutating relation '${mutation.relationInfo.name}'. Use a literal value or '{ set: ... }'.`,
        mutation.relationInfo.name,
        {
          meta: {
            operation: "update",
            field,
            relation: mutation.relationInfo.name,
          },
        }
      );
    }
  }
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

function normalizeSingle(
  value: unknown,
  relation: string,
  kind: string
): Record<string, unknown> {
  if (Array.isArray(value) && value.length !== 1) {
    throw new UnsupportedOperationError(
      `query-engine-v2 update to-one ${kind} for relation '${relation}' does not support multiple targets.`
    );
  }
  const item = Array.isArray(value) ? value[0] : value;
  if (!isRecord(item)) {
    throw new UnsupportedOperationError(
      `query-engine-v2 update to-one ${kind} for relation '${relation}' requires a single unique where.`
    );
  }
  return item;
}

/**
 * V1's whole-args `args.update` validation (validator.ts's `validate`), ported so
 * the schema-level rejection (an unknown nested key, a type mismatch) fires
 * BEFORE `separateData`'s relation-mutation parser and before any I/O — V1's
 * ordering and byte-identical `ValidationError` message. The validated value is
 * discarded: V2 re-parses each piece from the original args, so this call is a
 * pure legality gate, not a transform.
 */
function validateUpdateArgs(schema: VibSchema, args: unknown): void {
  const result = parse(schema, args);
  if ("issues" in result && result.issues) {
    throw new ValidationError(
      "update",
      result.issues.map((issue) => ({
        path: issue.path?.map(String).join(".") || "root",
        message: issue.message,
      }))
    );
  }
}

function parseRecord(
  schema: VibSchema,
  value: unknown,
  path: string
): Record<string, unknown> {
  const result = parse(schema, value);
  if ("issues" in result && result.issues) {
    throw new ValidationError(
      "update",
      result.issues.map((issue) => ({
        path: [path, ...(issue.path?.map(String) ?? [])].join("."),
        message: issue.message,
      }))
    );
  }
  if (!isRecord(result.value)) {
    throw new QueryEngineError(`Validated '${path}' is not an object.`);
  }
  return result.value;
}

function assertUpdateKeys(value: Record<string, unknown>): void {
  const required = ["where", "data"] as const;
  const allowed = new Set<string>([...required, "select"]);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length === 0 && missing.length === 0) return;
  throw new UnsupportedOperationError(
    `update arguments require where, data (optional select); received ${Object.keys(value).join(", ") || "none"}.`
  );
}

function defaultSelect(model: Model<any>): Record<string, unknown> {
  // V1's default projection is every scalar EXCEPT `.omit()`-ed fields — the raw
  // scalar names would leak an omitted column into the public result.
  return Object.fromEntries(
    getDefaultScalarFieldNames(model).map((field: string) => [field, true])
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new UnsupportedOperationError(`'${label}' must be an object.`);
}
