// biome-ignore-all lint/style/useFilenamingConvention: DeleteOperation is the architecture name.
import { NotFoundError, QueryEngineError } from "@errors";
import type { Model } from "@schema/model";
import {
  buildPrimaryKeyWhereUnique,
  getPrimaryKeyFields,
} from "../builders/correlation-utils";
import {
  createQueryScope,
  getDefaultScalarFieldNames,
} from "../context/query-scope";
import { buildDelete, buildFindUnique } from "../operations";
import type { QueryEngine } from "../query-engine";
import { ResultParser } from "../result/ResultParser";
import {
  affectedRows,
  exactlyOneRow,
  notFoundFailure,
  presenceGuard,
} from "./fragment-builders";
import {
  type OperationFragment,
  type OperationStep,
  type PlanningFragment,
  type ReadStep,
  ref,
  type WriteStep,
} from "./OperationFragment";
import { planningKey, planningOutputs } from "./Part";
import { parseValidated } from "./parse-boundary";
import { StepScope } from "./StepScope";
import {
  getStepModelName,
  isRecord,
  projectionNamesNoRelation,
  selectExecutionMode,
} from "./shared";

type ExecutionMode = "transaction" | "batch";

/**
 * The root `delete` locates the row by any unique `where`,
 * captures its selected shape as the result **before** removing it (portable
 * across drivers with and without `RETURNING`), then deletes it. The `notFound`
 * postcondition is a locate-read postcondition enforced at planning on both
 * substrates; batch mode additionally pins the row's presence inside the atomic
 * unit so a concurrent delete aborts the batch typed (ATOM “Branch premises and pins”).
 *
 * The mainstream shape folds (query-performance-plan Phase 3): a scalar-projected
 * delete on a RETURNING driver in transaction mode is ONE
 * `DELETE … WHERE <unique where> RETURNING <select>` — see {@link foldStep}. The
 * three-statement shape above is what the other cases keep.
 */
export class DeleteOperation {
  readonly mode: ExecutionMode;

  private readonly engine: QueryEngine;
  private readonly model: Model<any>;
  private readonly scope: StepScope;
  private readonly resultArgs: Record<string, unknown>;
  private readonly parentWhere: Record<string, unknown>;
  private readonly parsedSelect: Record<string, unknown> | undefined;
  private readonly parsedInclude: Record<string, unknown> | undefined;
  private readonly parentPrimaryKeys: readonly string[];
  private readonly locate: ReadStep;
  private readonly readId: string;
  private readonly deleteId: string;
  private readonly rootGuardId: string;
  private readonly foldStep: WriteStep | undefined;
  /** THE projection predicate, in ONE spelling: does the result shape name no
   *  relation at all? Two sites need exactly this question — the Phase 3 fold gate
   *  and the terminal read's `FOR UPDATE` — so they ask it once. See
   *  {@link projectionNamesNoRelation}. */
  private readonly projectionIsScalarOnly: boolean;
  /** The fold's presence premise on a batch-only driver, where
   *  no JS postcondition can run. `undefined` in transaction mode (the fold's
   *  own `expects` carries it) and wherever `foldStep` is undefined. */
  private readonly foldGuard: OperationStep | undefined;

  constructor(
    engine: QueryEngine,
    model: Model<any>,
    args: Record<string, unknown>
  ) {
    this.engine = engine;
    this.model = model;
    this.mode = selectExecutionMode(engine, "delete");
    const txMode = this.mode === "transaction";
    this.scope = new StepScope();
    const scope = this.scope;

    // THE one home for delete's legality (X2): the whole-args `args.delete` schema is
    // the front line. V1 runs the same `getDeleteArgs` (it validates `where` against
    // whereUnique, `select`/`include` against their core schemas, enforces the
    // select/include exclusivity, and rejects a missing `where` or an unknown
    // top-level key with a byte-identical ValidationError). V2 previously validated
    // only the pieces behind a coarser `assertDeleteKeys`/`requireRecord` key gate; the
    // whole-args parse is the single home, and `where` needs no re-parse (it is
    // whereUnique-validated by it). `select` is optional (default the scalar
    // projection, exactly as V1's no-select delete returns the whole row) and
    // `include` rides alongside it — the same result-shaping surface `create` owns.
    const parent = createQueryScope(engine.adapter, model);

    const parentPrimaryKeys = getPrimaryKeyFields(model);
    if (parentPrimaryKeys.length === 0) {
      // Unreachable by construction (N7-U-A, the X1c disposition): the whole-args
      // `args.delete` parse below validates `where` against a PK-less model's
      // discriminator-free whereUnique, which answers first with
      // `ValidationError: Missing required field: one of …` — measured. §3.A A16 states
      // every model must have a PK.
      throw new QueryEngineError(
        "query-engine-v2 internal: delete reached a model with no primary key; the where-unique parse admits none."
      );
    }
    // Compound primary keys are supported: the locate/guard select every PK
    // field, and the delete targets the parsed compound where-unique.
    this.parentPrimaryKeys = parentPrimaryKeys;

    const parentSchemas = engine.schemaRegistry.getModelSchemas(model);
    const validated = parseValidated(
      parentSchemas.args.delete,
      args,
      "delete",
      ""
    );
    this.parentWhere = validated.where;
    // The projection: an explicit `select`, else the default scalar projection
    // (respecting `.omit()`). `include` rides alongside the default scalars —
    // when both are absent the row is captured with every non-omitted scalar,
    // V1's default delete shape. An all-`.omit()` model with no include yields
    // undefined (the read builder + parser then produce `{}`, as ReadOperation
    // does), preserved here so a delete cannot leak an omitted column.
    this.parsedInclude = isRecord(validated.include)
      ? validated.include
      : undefined;
    this.parsedSelect = isRecord(validated.select)
      ? validated.select
      : defaultSelect(model);
    this.resultArgs = {
      ...(this.parsedSelect ? { select: this.parsedSelect } : {}),
      ...(this.parsedInclude ? { include: this.parsedInclude } : {}),
    };

    const parentName = getStepModelName(model, "parent");
    const locateId = scope.allocate(`${parentName}.locate`);
    this.readId = scope.allocate(`${parentName}.read`);
    this.deleteId = scope.allocate(`${parentName}.delete`);
    this.rootGuardId = scope.allocate(`${parentName}.guard.exists`);

    // The locate planning read enforces notFound before any write on both
    // substrates (a missing row aborts at planning; batch adds the in-unit
    // presence guard). It selects only the PK — the row's public shape is
    // captured by the final-fragment read below, whose output is fragment-local.
    this.locate = {
      id: locateId,
      kind: "read",
      statement: buildFindUnique(parent, {
        where: this.parentWhere,
        select: this.pkSelect(),
        forUpdate: txMode,
      }),
      outputs: { rows: { kind: "rows" } },
      expects: exactlyOneRow(
        notFoundFailure(
          `query-engine-v2 delete located no '${parentName}' row for its unique where.`
        )
      ),
    };

    // The statement-atomic fast path (query-performance-plan Phase 3), mirroring
    // `UpdateOperation`'s `canFold` gate and `CreateOperation.foldStep`: the
    // mainstream delete is ONE `DELETE … WHERE <unique where> RETURNING <select>`.
    // Empty planning + one step → the executor runs it directly, with no
    // transaction envelope at all: five round trips (BEGIN, locate, snapshot,
    // DELETE, COMMIT) become one.
    //
    // The DELETE already carried a RETURNING clause and threw the rows away — the
    // snapshot SELECT re-read what the write was handing back. The fold is that
    // clause put to use; for a scalar projection the snapshot `buildFindUnique`
    // and `buildDelete`'s RETURNING name the same columns, so the parsed result is
    // byte-identical.
    //
    // Gated to:
    //  - a RETURNING driver. MySQL cannot hand the row back from a DELETE, and
    //    after the delete there is nothing left to read, so it keeps the
    //    read-then-delete path (the same reason `deleteMany` + `select` keeps it,
    //    pinned by non-returning-delete-plan.test.ts).
    //  - a SCALAR-ONLY projection. A relation `include`/`select` must read the
    //    related rows BEFORE the row is gone — a cascade takes them with it — and
    //    a lateral join has no RETURNING spelling anyway. `_count` is a relation
    //    projection too (`selectProjectsRelation`): it is not a `relationSet`
    //    member, and a fold that judged it scalar answered a WRONG count from the
    //    name-captured correlation, not merely a stale one.
    //
    // The race protection the multi-statement path buys with its captured PK
    // (locate FOR UPDATE by an alternate unique, then `WHERE id`, so a concurrent
    // rewrite of that alternate unique cannot redirect the write to another row)
    // is preserved BY CONSTRUCTION here: there is no window between the locate and
    // the write to race, because there is no separate locate. One statement
    // matches, locks and removes one row atomically. This is the identical
    // argument the update fold makes for `UPDATE … WHERE selector RETURNING`.
    this.projectionIsScalarOnly = projectionNamesNoRelation(
      model,
      this.parsedSelect,
      this.parsedInclude
    );
    const canFold =
      engine.adapter.capabilities.supportsReturning &&
      this.projectionIsScalarOnly;
    const foldNotFound = notFoundFailure(
      `query-engine-v2 delete located no '${parentName}' row for its unique where.`
    );
    this.foldStep = canFold
      ? {
          id: this.deleteId,
          kind: "write",
          statement: buildDelete(parent, {
            where: this.parentWhere,
            ...(this.parsedSelect ? { select: this.parsedSelect } : {}),
          }),
          outputs: { result: { kind: "rows" } },
          // The same `affectedRows(1, notFound)` the multi-statement DELETE
          // carries, enforced in JS after the single round-trip. `failureError`
          // builds the public error from the execution context, so a missing row
          // raises the byte-identical `NotFoundError` the locate's `exactlyOneRow`
          // raised at planning — same class, same message, same V6001 code.
          // Batch mode has no JS postcondition available; `foldGuard` carries the
          // identical premise inside the atomic unit instead.
          ...(txMode ? { expects: affectedRows(1, foldNotFound) } : {}),
        }
      : undefined;
    // On a batch-only driver, the delete projection of the update fold is
    // driver the plan is `[presence guard, DELETE … RETURNING]` — one round trip,
    // no postcondition, so the `$transaction([...])` array seam (which merges
    // operations into ONE batch and therefore cannot honour a JS check that runs
    // after the commit) keeps working. This is the SAME guard the unfolded batch
    // path already puts in front of its read+delete pair, on the same selector
    // and with the same failure, so nothing about the batch's presence premise or
    // its attribution changes — only the read and the locate go away.
    this.foldGuard =
      canFold && !txMode ? this.buildRootPresenceGuard() : undefined;
  }

  planning(): PlanningFragment {
    // The RETURNING fold is a single self-contained statement — it consumes no
    // planning value, and empty planning is what makes it statement-atomic.
    if (this.foldStep) return { steps: [], outputs: {} };
    const steps = [this.locate];
    return { steps, outputs: planningOutputs(steps) };
  }

  compile(known: Readonly<Record<string, unknown>>): OperationFragment {
    // The fold compiles regardless of `known`: the `DELETE … WHERE unique
    // RETURNING select` locates, removes and returns the row in one statement.
    // Transaction mode runs it alone with its notFound postcondition enforced
    // after; batch mode puts the same premise in front of it as a guard, so the
    // pair is one atomic batch and one round trip.
    if (this.foldStep) {
      return {
        steps: this.foldGuard
          ? [this.foldGuard, this.foldStep]
          : [this.foldStep],
        outputs: { result: ref(this.deleteId, "result") },
      };
    }
    // Defensive: the locate postcondition already aborts a missing root at
    // planning; this keeps compile fail-closed if it is ever called directly.
    const rows = known[planningKey(this.locate.id, "rows")];
    if (!Array.isArray(rows)) {
      throw new QueryEngineError(
        "query-engine-v2 delete planning did not expose the locate rows."
      );
    }
    if (rows.length === 0) {
      throw new NotFoundError(getStepModelName(this.model, "record"), "delete");
    }
    const locatedRow = rows[0] as Record<string, unknown>;
    const parent = createQueryScope(this.engine.adapter, this.model);
    const txMode = this.mode === "transaction";
    // Address the row by the PK captured at the (FOR UPDATE) locate rather than
    // the original `where`: locating by an alternate unique then mutating by the
    // immutable captured PK is V1's `WHERE id` mechanic (the alternate unique
    // could be concurrently rewritten). Transaction mode only — batch mode keeps
    // the original `where` so the write and its presence guard pin the same row.
    const where = this.writeWhere(locatedRow);
    const readFull: ReadStep = {
      id: this.readId,
      kind: "read",
      statement: buildFindUnique(parent, {
        where,
        ...(this.parsedSelect ? { select: this.parsedSelect } : {}),
        ...(this.parsedInclude ? { include: this.parsedInclude } : {}),
        // `FOR UPDATE` cannot be applied to a relation projection's join/aggregate
        // (Postgres 0A000). The PK-only locate above already took the row lock in
        // transaction mode, so the shape-capturing read never needs to re-lock —
        // it drops `FOR UPDATE` whenever a relation projection is present, exactly
        // as the create/update terminal reads (which never re-lock) do.
        //
        // THE SAME predicate the fold gate asks, not a second spelling of it: the
        // question at both sites is "does the projection name no relation?", and
        // `include` is only one of the two ways to name one. A `!parsedInclude`
        // proxy here missed a relation nested in `select` and emitted the join
        // WITH the lock — MEASURED on PGlite in transaction mode, both spellings:
        //   select: { id, notes: { select: { body } } }  (to-many, LATERAL json_agg)
        //     -> 0A000 "FOR UPDATE is not allowed with aggregate functions"
        //   select: { id, account: { select: { label } } } (to-one, LEFT JOIN LATERAL)
        //     -> 0A000 "FOR UPDATE cannot be applied to the nullable side of an
        //        outer join"
        // Neither shape can fold (the fold gate declines every relation
        // projection), so this read is what runs, and it crashed the delete.
        forUpdate: txMode && this.projectionIsScalarOnly,
      }),
      outputs: { result: { kind: "rows" } },
    };
    const deleteRow: WriteStep = {
      id: this.deleteId,
      kind: "write",
      statement: buildDelete(parent, { where }),
      outputs: {},
      ...(txMode
        ? {
            expects: affectedRows(
              1,
              notFoundFailure(
                `query-engine-v2 delete located no '${getStepModelName(this.model, "parent")}' row for its unique where.`
              )
            ),
          }
        : {}),
    };
    const steps: OperationStep[] = [];
    if (this.mode === "batch") {
      steps.push(this.buildRootPresenceGuard());
    }
    // Capture the row, then delete it — both in the final fragment, so the
    // result output resolves fragment-locally at parse (ATOM “Proof obligations”).
    steps.push(readFull, deleteRow);
    return { steps, outputs: { result: ref(this.readId, "result") } };
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

  parse<T>(outputs: Readonly<Record<string, unknown>>): T {
    if (!Object.hasOwn(outputs, "result")) {
      throw new QueryEngineError(
        "query-engine-v2 delete did not expose its result."
      );
    }
    return new ResultParser(
      this.engine.adapter,
      this.model,
      this.engine.driver,
      this.engine.decimalDecode
    ).parse<T>("delete", outputs.result, this.resultArgs);
  }

  private pkSelect(): Record<string, boolean> {
    return Object.fromEntries(this.parentPrimaryKeys.map((pk) => [pk, true]));
  }

  private buildRootPresenceGuard(): OperationStep {
    const parent = createQueryScope(this.engine.adapter, this.model);
    return presenceGuard(
      this.rootGuardId,
      buildFindUnique(parent, {
        where: this.parentWhere,
        select: this.pkSelect(),
      }),
      notFoundFailure(
        `query-engine-v2 delete located no '${getStepModelName(this.model, "record")}' row for its unique where.`
      )
    );
  }
}

function defaultSelect(model: Model<any>): Record<string, unknown> | undefined {
  // V1's default projection is every scalar EXCEPT `.omit()`-ed fields. An
  // all-omitted model yields undefined (the read builder + parser then produce
  // `{}`, as ReadOperation does with no select), so a delete never leaks an
  // omitted column.
  const fields = getDefaultScalarFieldNames(model);
  if (fields.length === 0) return undefined;
  return Object.fromEntries(fields.map((field: string) => [field, true]));
}
