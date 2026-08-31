// biome-ignore-all lint/style/useFilenamingConvention: ManyAndReturnOperation is the architecture name.
import {
  publicOperationName,
  QueryEngineError,
  TransactionError,
} from "@errors";
import type { Model } from "@schema/model";
import { isSql } from "@sql";
import { getPrimaryKeyFields } from "../builders/correlation-utils";
import { createQueryScope } from "../context/query-scope";
import {
  buildCreateManyPlan,
  buildDeleteMany,
  buildDeleteManyAndReturn,
  buildFind,
  buildFindUnique,
  buildUpdateMany,
  buildUpdateManyAndReturn,
} from "../operations";
import {
  getCreatedRowWhere,
  getPrimaryKeyValuesFromRecord,
  getUpdatedPrimaryKeyValues,
} from "../operations/mutation-identity";
import type { QueryEngine } from "../query-engine";
import { ResultParser } from "../result/ResultParser";
import type { Operation, QueryScope } from "../types";
import { validate } from "../validator";
import {
  type PreparedBulkPolymorphicConnects,
  prepareBulkPolymorphicConnects,
} from "./bulk-polymorphic-connect";
import {
  type FragmentOutputSource,
  type OperationFragment,
  type OperationStep,
  type OperationValueReference,
  type PlanningFragment,
  type ReadStep,
  ref,
  type WriteStep,
} from "./OperationFragment";
import { planningKey } from "./Part";
import { StepScope } from "./StepScope";
import { parseCapturedRowKeys } from "./series-result-read";
import { isRecord, selectExecutionMode } from "./shared";

type ExecutionMode = "transaction" | "batch";
/**
 * INTERNAL names only (see {@link Operation} in query-engine/types). The client
 * spells these as `createMany` / `updateMany` **with a `select`** — the
 * `createManyAndReturn` / `updateManyAndReturn` operations were removed from the
 * public surface (maintainer decision D-1) and replaced by implicit returning.
 *
 * {@link publicOperationName} (the ONE map, in @errors, so `ValidationError`
 * applies it too) maps back for every user-facing message. Nothing a caller can
 * read may name one of these tokens: the same client answers
 * `Unknown operation 'createManyAndReturn'` if one is actually spelled.
 */
type AndReturnKind =
  | "createManyAndReturn"
  | "updateManyAndReturn"
  | "deleteManyAndReturn";

/**
 * Does THIS substrate make the row-returning arm impossible? One condition, two
 * readers: this operation's constructor (which raises the sentence below) and
 * `routing.ts`, which must know the answer BEFORE it picks a shell — `createMany` has
 * a third destination, and a relation-bearing payload with `select` has
 * to reach this owner so the specific sentence answers instead of a record series'
 * generic "no interactive transaction" one.
 *
 * Exported rather than mirrored: the router used to restate these two clauses, so a
 * future widening here would have silently stopped matching there and downgraded the
 * message with every test still green.
 */
export function refusesRowReturningSubstrate(
  engine: QueryEngine,
  kind: AndReturnKind
): boolean {
  return (
    selectExecutionMode(engine, kind) === "batch" &&
    !engine.adapter.capabilities.supportsReturning
  );
}

/**
 * The row-returning arm of the bulk mutations. Reached only when the client
 * payload carries a `select`. Both kinds
 * return the affected rows, and both are the consumer that makes the census's
 * **ordered source list whose rows concatenate** (ATOM “The execution vocabulary”) live:
 *
 * - **returning drivers** (`supportsReturning`): `createManyAndReturn` is one
 *   multi-row `INSERT … VALUES (…),(…) RETURNING …` per contiguous same-shape
 *   run of input rows — usually ONE statement for the whole call (Phase 7.2,
 *   query-performance-plan Decision 7.2). The runs' rows concatenate in input
 *   order (the ordered source list), and each run's rows are trusted to come
 *   back in its own `VALUES` order; `updateManyAndReturn` is one
 *   `UPDATE … RETURNING`.
 * - **non-returning drivers in a transaction** (MySQL): the mutation-identity
 *   pre/post-read technique — `createManyAndReturn` interleaves each `INSERT`
 *   with a refetch located by the created row's identity (`getCreatedRowWhere`,
 *   reused verbatim, so the DB's session `lastInsertId()` resolves per row);
 *   `updateManyAndReturn` captures the target PK set at planning (locked),
 *   applies one bulk `UPDATE`, then re-reads the (possibly PK-shifted) rows —
 *   the captured set is planning-time only and inlined at compile (§3 corollary).
 *   `deleteManyAndReturn` is the same technique with the two statements SWAPPED:
 *   the projection must be read BEFORE the `DELETE`, because a deleted row cannot
 *   be read back. Both live in the same atomic scope and address the same
 *   FOR-UPDATE-locked PK set, so the rows returned are exactly the rows deleted.
 *
 * - **non-returning drivers in forced batch**: refused, because public result
 *   parsing cannot be rolled back after an atomic batch commits. That refusal is
 *   KEPT AS CONTRACT (ATOM “Error-order rules”) and now names the public spelling — a bulk write
 *   `with 'select'` — never weakened into a route or a silent divergence. The
 *   `{ count }` arm of the same family is unaffected and still runs there.
 *
 * `updateMany`/`deleteMany` `limit` (Prisma 6.x) caps this arm exactly as it
 * caps `{ count }`: the rows returned ARE the rows affected, so a capped write
 * hands back at most `limit` of them. `limit: 0` compiles to the empty plan and
 * parses to `[]` — the row-shaped spelling of `{ count: 0 }`.
 *
 * One operation, two statement shapes; no new step kind or executor branch.
 */
export class ManyAndReturnOperation {
  readonly mode: ExecutionMode;
  /** The canonical payload validated at construction. */
  readonly validatedArgs: Record<string, unknown>;

  private readonly engine: QueryEngine;
  private readonly model: Model<any>;
  private readonly kind: AndReturnKind;
  private readonly select: Record<string, unknown> | undefined;
  /** A statically-built fragment (returning, or non-returning createMany). */
  private readonly staticSteps: readonly OperationStep[] | undefined;
  private readonly staticOutput: FragmentOutputSource | undefined;
  /** The updateManyAndReturn non-returning capture (built in `planning`). */
  private readonly captureRead: ReadStep | undefined;
  private readonly updateData: Record<string, unknown> | undefined;
  /**
   * The non-returning `createMany` + `select` + `skipDuplicates` capture: one
   * skippable INSERT per input row, in input order. They are the operation's WRITES, and
   * they run in the CAPTURE fragment because their own outcome is what the final fragment
   * is built from — which row was inserted, and what id it got. See
   * {@link buildCreateManySkipCapture}.
   */
  private readonly skipInserts?: readonly WriteStep[];
  /** Per input row, the created-row identity `getCreatedRowWhere` answers (the session
   *  `lastInsertId()` sentinel included — `compile` replaces it with the captured id). */
  private readonly skipWheres?: readonly Record<string, unknown>[];
  private readonly scope: StepScope;
  private readonly bulkPolymorphic?: PreparedBulkPolymorphicConnects;
  private readonly createManySupportsReturning?: boolean;

  constructor(
    engine: QueryEngine,
    model: Model<any>,
    kind: AndReturnKind,
    args: Record<string, unknown>
  ) {
    this.engine = engine;
    this.model = model;
    this.kind = kind;
    this.mode = selectExecutionMode(engine, kind);
    this.scope = new StepScope();

    this.validatedArgs = validate<Record<string, unknown>>(
      engine.schemaRegistry,
      model,
      kind as Operation,
      args
    );
    this.select = isRecord(this.validatedArgs.select)
      ? this.validatedArgs.select
      : undefined;

    const supportsReturning = engine.adapter.capabilities.supportsReturning;
    // ATOM “Error-order rules” refusal (kept as contract): a non-returning driver in forced batch
    // cannot resolve the returned identity atomically, because result parsing
    // happens after the atomic unit commits and cannot be rolled back.
    if (refusesRowReturningSubstrate(engine, kind)) {
      throw new TransactionError(
        `Driver '${engine.driver.driverName}' cannot execute '${publicOperationName(kind)}' with 'select' because public result parsing cannot be rolled back.`,
        {
          meta: {
            driver: engine.driver.driverName,
            operation: publicOperationName(kind),
          },
        }
      );
    }

    if (kind === "createManyAndReturn") {
      const data = this.validatedArgs.data;
      if (!Array.isArray(data)) {
        throw new QueryEngineError(
          "query-engine-v2 createMany with 'select' requires a data array."
        );
      }
      this.bulkPolymorphic = prepareBulkPolymorphicConnects(
        engine,
        createQueryScope(engine, model),
        data,
        this.scope,
        this.mode === "transaction"
      );
      this.createManySupportsReturning = supportsReturning;
      if (this.bulkPolymorphic.probes.length > 0) {
        if (!supportsReturning && this.validatedArgs.skipDuplicates === true) {
          throw new TransactionError(
            `Driver '${engine.driver.driverName}' cannot execute 'createMany' with 'select', 'skipDuplicates', and polymorphic connects because skipped insert identities cannot be observed.`,
            {
              meta: {
                driver: engine.driver.driverName,
                operation: "createMany",
              },
            }
          );
        }
        this.staticSteps = undefined;
        this.staticOutput = undefined;
        this.captureRead = undefined;
        this.updateData = undefined;
        return;
      }
      const skipCapture = this.buildCreateManySkipCapture(supportsReturning);
      if (skipCapture) {
        this.skipInserts = skipCapture.inserts;
        this.skipWheres = skipCapture.wheres;
        this.staticSteps = undefined;
        this.staticOutput = undefined;
        this.captureRead = undefined;
        this.updateData = undefined;
        return;
      }
      const built = this.buildCreateManyReturn(supportsReturning);
      this.staticSteps = built.steps;
      this.staticOutput = built.output;
      this.captureRead = undefined;
      this.updateData = undefined;
      return;
    }

    // `limit: 0` on a returning bulk write: nothing is affected, so nothing
    // comes back and no statement runs — the same short-circuit the `{ count }`
    // arm applies (BulkCountOperation), reached through the empty static plan.
    if (this.limit() === 0) {
      this.staticSteps = [];
      this.staticOutput = undefined;
      this.captureRead = undefined;
      this.updateData = undefined;
      return;
    }

    if (kind === "deleteManyAndReturn") {
      this.updateData = undefined;
      if (supportsReturning) {
        const step: WriteStep = {
          id: this.scope.allocate(`${this.modelName()}.deleteManyReturn`),
          kind: "write",
          statement: buildDeleteManyAndReturn(this.ctx(), {
            ...this.bulkScope(),
            ...(this.select ? { select: this.select } : {}),
          }),
          outputs: { result: { kind: "rows" } },
        };
        this.staticSteps = [step];
        this.staticOutput = ref(step.id, "result");
        this.captureRead = undefined;
        return;
      }
      // Non-returning: lock the target PK set at planning, then read-then-delete
      // that exact set at compile.
      this.staticSteps = undefined;
      this.staticOutput = undefined;
      this.captureRead = this.buildPkCapture("deleteManyReturn");
      return;
    }

    // updateMany with select
    const data = requireRecord(
      this.validatedArgs.data,
      "updateMany",
      "data"
    );
    if (supportsReturning) {
      const step: WriteStep = {
        id: this.scope.allocate(`${this.modelName()}.updateManyReturn`),
        kind: "write",
        statement: buildUpdateManyAndReturn(this.ctx(), {
          ...this.bulkScope(),
          data,
          ...(this.select ? { select: this.select } : {}),
        }),
        outputs: { result: { kind: "rows" } },
      };
      this.staticSteps = [step];
      this.staticOutput = ref(step.id, "result");
      this.captureRead = undefined;
      this.updateData = undefined;
      return;
    }

    // Non-returning updateManyAndReturn (transaction): capture the target PK set
    // at planning (locked), then bulk-update + re-read at compile.
    this.staticSteps = undefined;
    this.staticOutput = undefined;
    this.updateData = data;
    this.captureRead = this.buildPkCapture("updateManyReturn");
  }

  /** The validated `limit`, or `undefined` when the caller omitted it. */
  private limit(): number | undefined {
    return typeof this.validatedArgs.limit === "number"
      ? this.validatedArgs.limit
      : undefined;
  }

  /** The `where`/`limit` pair the bulk builders take, both optional. */
  private bulkScope(): { where?: Record<string, unknown>; limit?: number } {
    const limit = this.limit();
    return {
      ...(isRecord(this.validatedArgs.where)
        ? { where: this.validatedArgs.where }
        : {}),
      ...(limit === undefined ? {} : { limit }),
    };
  }

  /**
   * The planning capture shared by both non-returning arms: the target primary
   * keys, FOR UPDATE, so the affected set cannot drift between planning and the
   * write inside the same transaction envelope.
   *
   * `limit` is applied HERE rather than on the write. The capture already
   * decides the affected set — the write and the re-read both address it by
   * captured PK — so capping the capture caps everything downstream, and the
   * dialect that takes this path (MySQL) never needs its native `UPDATE … LIMIT`
   * in this arm.
   */
  private buildPkCapture(label: string): ReadStep {
    const limit = this.limit();
    return {
      id: this.scope.allocate(`${this.modelName()}.${label}.capture`),
      kind: "read",
      statement: buildFind(
        this.ctx(),
        {
          ...(isRecord(this.validatedArgs.where)
            ? { where: this.validatedArgs.where }
            : {}),
          select: this.pkSelect(),
          forUpdate: true,
        },
        limit === undefined ? {} : { limit }
      ),
      outputs: { rows: { kind: "rows" } },
    };
  }

  planning(): PlanningFragment {
    if (this.bulkPolymorphic?.probes.length) {
      const steps = this.bulkPolymorphic.probes;
      return { steps };
    }
    if (this.skipInserts) {
      // The capture is the WRITES, and what crosses into `compile` is each one's own
      // outcome — see {@link buildCreateManySkipCapture} for why that is this phase.
      const steps = [...this.skipInserts];
      return { steps };
    }
    if (this.captureRead) {
      const steps = [this.captureRead];
      return { steps };
    }
    return { steps: [] };
  }

  compile(known: Readonly<Record<string, unknown>>): OperationFragment {
    if (this.bulkPolymorphic?.probes.length) {
      const built = this.buildCreateManyReturn(
        this.createManySupportsReturning === true,
        known
      );
      return built.output
        ? { steps: [...built.steps], outputs: { result: built.output } }
        : { steps: [...built.steps], outputs: {} };
    }
    if (this.skipInserts) return this.compileCapturedSkip(known);
    if (this.staticSteps) {
      if (this.staticSteps.length === 0 || this.staticOutput === undefined) {
        return { steps: [], outputs: {} };
      }
      return {
        steps: [...this.staticSteps],
        outputs: { result: this.staticOutput },
      };
    }
    return this.kind === "deleteManyAndReturn"
      ? this.compileCapturedDelete(known)
      : this.compileCapturedUpdate(known);
  }

  parse<T>(outputs: Readonly<Record<string, unknown>>): T {
    if (!Object.hasOwn(outputs, "result")) {
      // The empty-plan case (no data / nothing matched): an empty result set.
      return [] as T;
    }
    const rows = outputs.result;
    if (!Array.isArray(rows)) {
      throw new QueryEngineError(
        `query-engine-v2 ${publicOperationName(this.kind)} with 'select' did not expose its result rows.`
      );
    }
    return new ResultParser(
      this.engine,
      this.model,
      this.engine.driver
    ).parse<T>(this.kind as Operation, rows, this.validatedArgs);
  }

  /**
   * The planning capture's rows, or `undefined` when nothing matched (both
   * non-returning arms then compile to an empty plan and parse to `[]`, the way
   * V1's `requiresRowsFrom` skipped the write and the read).
   */
  private capturedRows(
    known: Readonly<Record<string, unknown>>
  ): readonly Record<string, unknown>[] | undefined {
    if (!this.captureRead) {
      throw new QueryEngineError(
        `query-engine-v2 ${publicOperationName(this.kind)} with 'select' lost its capture plan.`
      );
    }
    const captured = known[planningKey(this.captureRead.id, "rows")];
    if (!Array.isArray(captured)) {
      throw new QueryEngineError(
        `query-engine-v2 ${publicOperationName(this.kind)} with 'select' planning did not expose the captured rows.`
      );
    }
    if (captured.length === 0) return undefined;
    return parseCapturedRowKeys(this.engine, this.model, captured);
  }

  /**
   * Non-returning `deleteMany` with `select`: read the projection of the locked
   * PK set, THEN delete that same set, both in one atomic scope. The order is the
   * whole point — after the DELETE there is nothing left to read — and addressing
   * both statements by the captured PKs (not by the user's filter) is what makes
   * "the rows returned are the rows deleted" true even if the filter is over a
   * column the delete would have changed the visibility of.
   */
  private compileCapturedDelete(
    known: Readonly<Record<string, unknown>>
  ): OperationFragment {
    const rows = this.capturedRows(known);
    if (!rows) return { steps: [], outputs: {} };

    const ctx = this.ctx();
    const targetWhere = this.capturedFilterWhere(ctx, rows);
    const readStep: ReadStep = {
      id: this.scope.allocate(`${this.modelName()}.deleteManyReturn.read`),
      kind: "read",
      statement: buildFind(ctx, {
        where: targetWhere,
        ...(this.select ? { select: this.select } : {}),
      }),
      outputs: { result: { kind: "rows" } },
    };
    const writeStep: WriteStep = {
      id: this.scope.allocate(`${this.modelName()}.deleteManyReturn.write`),
      kind: "write",
      statement: buildDeleteMany(ctx, { where: targetWhere }),
      outputs: {},
    };
    return {
      steps: [readStep, writeStep],
      outputs: { result: ref(readStep.id, "result") },
    };
  }

  private compileCapturedUpdate(
    known: Readonly<Record<string, unknown>>
  ): OperationFragment {
    if (!this.updateData) {
      throw new QueryEngineError(
        "query-engine-v2 updateMany with 'select' lost its update data."
      );
    }
    const rows = this.capturedRows(known);
    if (!rows) return { steps: [], outputs: {} };

    const ctx = this.ctx();
    const beforeWhere = this.capturedFilterWhere(ctx, rows);
    const afterWhere = this.capturedFilterWhere(ctx, rows, this.updateData);

    // V1 additionally pinned this write with `maximumAffectedRows`/
    // `expectedRows` postconditions. They are structurally unnecessary here:
    // the captured rows are FOR-UPDATE-locked in the same transaction envelope
    // as this UPDATE, so the affected set cannot drift from the capture, and a
    // PK collision surfaces as the UPDATE's own constraint error.
    const writeStep: WriteStep = {
      id: this.scope.allocate(`${this.modelName()}.updateManyReturn.write`),
      kind: "write",
      statement: buildUpdateMany(ctx, {
        where: beforeWhere,
        data: this.updateData,
      }),
      outputs: {},
    };
    const readStep: ReadStep = {
      id: this.scope.allocate(`${this.modelName()}.updateManyReturn.read`),
      kind: "read",
      statement: buildFind(ctx, {
        where: afterWhere,
        ...(this.select ? { select: this.select } : {}),
      }),
      outputs: { result: { kind: "rows" } },
    };
    return {
      steps: [writeStep, readStep],
      outputs: { result: ref(readStep.id, "result") },
    };
  }

  /**
   * `createMany` + `select` + `skipDuplicates` on a driver with no `RETURNING`.
   *
   * MEASURED FIRST (Docker MySQL 8.4, HEAD e37c611): a typed `UnsupportedOperationError`
   * (V8003), "createMany with 'select' does not support 'skipDuplicates' on a driver
   * without RETURNING: the rows a skip actually inserted cannot be identified." The
   * recorded reason was "inexpressible". The measured truth is narrower: it is
   * inexpressible as ONE STATEMENT, and it was inexpressible as a fragment whose reads are
   * decided before the writes run. It is expressible when the writes are OBSERVED.
   *
   * The maintainer authorized the mechanism (expressible-shapes-plan.md, Risks item 3):
   * per-row savepoints, the id of each non-raising row, a refetch by the collected ids.
   * That is what this builds, out of parts that already exist:
   *
   *  - **the savepoint** is the `onUniqueConflict: "skip"` effect (ATOM “Bulk specializations”), served
   *    by `executeSkippableWrite` — the SAME executor effect the `{ count }` arm has used
   *    on this dialect since P6. Nothing is re-derived here; the step just declares it.
   *  - **the split into one INSERT per row** is `buildCreateManyPlan`'s own
   *    `recoverDuplicateErrors` arm. A run cannot be absorbed row-wise, so it already
   *    splits — this arm asks for the split it was going to get.
   *  - **the identity** is `getCreatedRowWhere`, verbatim: a row that spells its own
   *    primary key names itself; a generated key resolves to the session's
   *    `lastInsertId()`. That sentinel is the ONE thing this arm cannot use, because the
   *    reads happen after ALL the inserts and the session's last id belongs to the last of
   *    them. `compile` substitutes the id THIS row's own INSERT produced (the step's
   *    `insertId` output) — the row the step made, never a value re-derived from input.
   *
   * **Which phase the writes run in.** They are the capture fragment. That fragment is not
   * "the reads" — it is what the operation must OBSERVE before the final fragment can be
   * constructed (`Part.PlanningKnown`, the sanctioned crossing, ATOM “Planning fragments”), and here
   * the thing to observe is a write's own outcome: no read can tell you whether an INSERT
   * you have not run yet will be skipped. The linearization invariant (§4) is untouched —
   * this arm makes no branch decision from a READ, so there is no decision read to order
   * against a write; and the capture carries no read at all.
   *
   * **The stale-insertId hazard is structurally absent**, not guarded against: a skipped
   * write's own `rowCount` is 0, `compile` emits no read for it, and its `insertId` output
   * is never dereferenced. (The executor resolves that output to `undefined` for exactly
   * this case — `extractOutputs` — so an absent id on a NON-skipped write still fails
   * closed.) The witness that says so has a decoy: a duplicate whose insert fails must not
   * hand back the row that was already there.
   *
   * **The cost, accepted.** N round trips for the inserts plus one per surviving row —
   * 2N-1 for a payload with one duplicate, against 2N for the same payload without the
   * flag. There is no folding: a fold is what makes a skip unobservable. This is the
   * maintainer's accepted trade for the shape existing at all on this driver.
   *
   * **The atomic batch stays refused.** A forced-batch non-returning driver never reaches
   * here: the constructor's ATOM “Error-order rules” refusal answers first, and it names the substrate
   * ("because public result parsing cannot be rolled back"). The skip effect's own wall
   * (`OperationExecutor.compileToEntries`, "no atomic-batch lowering") stands behind it.
   * Two reasons, one refusal — a second, skip-specific throw would be a redundant guard.
   *
   * Returns `undefined` when this arm does not apply (a returning driver, or no flag), so
   * the caller falls through to the statically-built fragment.
   */
  private buildCreateManySkipCapture(supportsReturning: boolean):
    | {
        inserts: readonly WriteStep[];
        wheres: readonly Record<string, unknown>[];
      }
    | undefined {
    if (supportsReturning || this.validatedArgs.skipDuplicates !== true) return;
    const data = this.validatedArgs.data;
    if (!Array.isArray(data)) {
      throw new QueryEngineError(
        "query-engine-v2 createMany with 'select' requires a data array."
      );
    }
    if (data.length === 0) return { inserts: [], wheres: [] };
    // `Array.isArray` on the unknown args narrows to `any[]`; the parse boundary has
    // already validated each element as a record, so this alias states the element
    // type once instead of casting per use.
    const rows: readonly Record<string, unknown>[] = data;

    const ctx = this.ctx();
    const name = this.modelName();
    const plan = buildCreateManyPlan(
      ctx,
      {
        data,
        skipDuplicates: true,
        ...(this.select ? { select: this.select } : {}),
      },
      true,
      undefined,
      this.engine.maxBindParametersPerStatement
    );
    // A dialect whose skip IS a SQL leaf carries it in the statement and reports the skip
    // as a zero row count; MySQL's is the savepoint effect. Both are read the same way
    // below (`affected`), so this arm is not MySQL-specific — only the effect flag is.
    const recoverUnique =
      this.engine.adapter.mutations.skipDuplicatesStrategy ===
      "recoverableUniqueError";
    const inserts: WriteStep[] = [];
    const wheres: Record<string, unknown>[] = [];
    for (const [position, statement] of plan.statements.entries()) {
      // THE ORDINAL CONTRACT, in its skippable form. The answer is the input order minus
      // the skipped rows, so each statement must own exactly one input and they must
      // arrive in input order — then `compile` preserves the order by construction and
      // needs no second check. `recoverDuplicateErrors` splits every run into rows, so
      // this holds today; asserting it is what keeps a future regrouping from silently
      // addressing the answers to the wrong inputs.
      const [inputIndex] = statement.inputIndexes;
      if (statement.inputIndexes.length !== 1 || inputIndex !== position) {
        throw new QueryEngineError(
          "query-engine-v2 createMany with 'select' and 'skipDuplicates' expected one input per statement, in input order."
        );
      }
      const row = rows[inputIndex]!;
      // Raises the same "final primary key cannot be determined atomically" refusal the
      // non-skip arm raises, at construction, before any write.
      const where = getCreatedRowWhere(ctx, row, name);
      const generated = Object.values(where).some(isSql);
      wheres.push(where);
      inserts.push({
        id: this.scope.allocate(`${name}.createReturn.skip`),
        kind: "write",
        statement: statement.sql,
        outputs: generated
          ? { affected: { kind: "rowCount" }, id: { kind: "insertId" } }
          : { affected: { kind: "rowCount" } },
        ...(recoverUnique ? { onUniqueConflict: "skip" as const } : {}),
      });
    }
    return { inserts, wheres };
  }

  /**
   * The final fragment of {@link buildCreateManySkipCapture}: one refetch per row the
   * capture actually inserted, in input order, riding the frozen ordered reference-list
   * output (ATOM “The execution vocabulary” — the sources concatenate). A skipped row contributes no read and no
   * source, which is exactly "input order minus skipped".
   */
  private compileCapturedSkip(
    known: Readonly<Record<string, unknown>>
  ): OperationFragment {
    const inserts = this.skipInserts ?? [];
    const wheres = this.skipWheres ?? [];
    const ctx = this.ctx();
    const name = this.modelName();
    const steps: OperationStep[] = [];
    const output: OperationValueReference[] = [];
    for (const [index, insert] of inserts.entries()) {
      const affected = known[planningKey(insert.id, "affected")];
      if (affected === 0) continue;
      if (affected !== 1) {
        throw new QueryEngineError(
          `query-engine-v2 createMany with 'select' and 'skipDuplicates' got ${String(affected)} affected rows from a single-row insert.`
        );
      }
      // The id THIS insert produced replaces the session sentinel. It is defined whenever
      // the row count is 1: the executor resolves an `insertId` output to `undefined` only
      // for a write the skip effect absorbed, and such a write reports zero rows.
      const captured = known[planningKey(insert.id, "id")];
      const where = Object.fromEntries(
        Object.entries(wheres[index] ?? {}).map(([field, value]) =>
          isSql(value) ? [field, captured] : [field, value]
        )
      );
      const readId = this.scope.allocate(`${name}.createReturn.skip.read`);
      steps.push({
        id: readId,
        kind: "read",
        statement: buildFindUnique(ctx, {
          where,
          ...(this.select ? { select: this.select } : {}),
        }),
        outputs: { result: { kind: "rows" } },
      });
      output.push(ref(readId, "result"));
    }
    if (output.length === 0) return { steps: [], outputs: {} };
    return { steps, outputs: { result: output } };
  }

  private buildCreateManyReturn(
    supportsReturning: boolean,
    known?: Readonly<Record<string, unknown>>
  ): {
    steps: readonly OperationStep[];
    output: FragmentOutputSource | undefined;
  } {
    const data = this.bulkPolymorphic?.scalarRows ?? this.validatedArgs.data;
    if (!Array.isArray(data)) {
      throw new QueryEngineError(
        "query-engine-v2 createMany with 'select' requires a data array."
      );
    }
    if (data.length === 0) return { steps: [], output: undefined };

    const skipDuplicates = this.validatedArgs.skipDuplicates === true;
    const ctx = this.ctx();
    const resolved =
      this.bulkPolymorphic && known
        ? this.bulkPolymorphic.resolve(known)
        : undefined;
    const plan = buildCreateManyPlan(
      ctx,
      {
        data,
        skipDuplicates,
        ...(this.select ? { select: this.select } : {}),
      },
      true,
      resolved?.storageByRow,
      this.engine.maxBindParametersPerStatement
    );
    const steps: OperationStep[] = [...(resolved?.guards ?? [])];
    const output: OperationValueReference[] = [];
    const covered: number[] = [];
    const name = this.modelName();

    for (const statement of plan.statements) {
      if (supportsReturning) {
        // Phase 7.2: the statement is the whole contiguous same-shape RUN, so
        // one `INSERT … VALUES (…),(…) RETURNING …` answers for all of its
        // input rows at once. Its rows enter the ordered source list in the
        // run's input order; the ordinal check below is what makes that order
        // the operation's answer rather than an assumption.
        const id = this.scope.allocate(`${name}.createManyReturn`);
        steps.push({
          id,
          kind: "write",
          statement: statement.sql,
          outputs: { result: { kind: "rows" } },
        });
        output.push(ref(id, "result"));
        covered.push(...statement.inputIndexes);
        continue;
      }
      const inputIndex = statement.inputIndexes[0];
      if (inputIndex === undefined || statement.inputIndexes.length !== 1) {
        throw new QueryEngineError(
          "query-engine-v2 createMany with 'select' expected one input per statement."
        );
      }
      // Non-returning: INSERT then refetch by the created identity, interleaved
      // so the DB session `lastInsertId()` in the refetch reflects this INSERT.
      const insertId = this.scope.allocate(`${name}.createReturn.insert`);
      const readId = this.scope.allocate(`${name}.createReturn.read`);
      const where = getCreatedRowWhere(
        ctx,
        data[inputIndex] as Record<string, unknown>,
        name
      );
      steps.push(
        { id: insertId, kind: "write", statement: statement.sql, outputs: {} },
        {
          id: readId,
          kind: "read",
          statement: buildFindUnique(ctx, {
            where,
            ...(this.select ? { select: this.select } : {}),
          }),
          outputs: { result: { kind: "rows" } },
        }
      );
      output.push(ref(readId, "result"));
      covered.push(inputIndex);
    }

    // THE ORDINAL CONTRACT. The sources concatenate, so the answer is right
    // only if the statements cover every input row exactly once, in input
    // order. Checked here rather than assumed of `buildCreateManyPlan`: a
    // regrouping that dropped, duplicated or reordered a row would otherwise
    // return a plausible row list addressed to the wrong inputs.
    if (
      covered.length !== data.length ||
      covered.some((inputIndex, position) => inputIndex !== position)
    ) {
      throw new QueryEngineError(
        "query-engine-v2 createMany with 'select' left an input row without a result in its input ordinal."
      );
    }
    return { steps, output };
  }

  private capturedFilterWhere(
    ctx: QueryScope,
    rows: readonly Record<string, unknown>[],
    afterUpdate?: Record<string, unknown>
  ): Record<string, unknown> {
    const name = this.modelName();
    const conditions = rows.map((row) => {
      const values = afterUpdate
        ? getUpdatedPrimaryKeyValues(ctx, row, afterUpdate, name)
        : getPrimaryKeyValuesFromRecord(this.model, row, name);
      return Object.fromEntries(
        Object.entries(values).map(([field, value]) => [
          field,
          { equals: value },
        ])
      );
    });
    return conditions.length === 1
      ? (conditions[0] as Record<string, unknown>)
      : { OR: conditions };
  }

  private ctx(): QueryScope {
    return createQueryScope(this.engine, this.model);
  }

  private modelName(): string {
    return this.model["~"].names.ts ?? "unknown";
  }

  /**
   * `getPrimaryKeyFields` is TOTAL — a model with no declared id answers `["id"]`
   * — so the empty-list refusal that stood here could not fire, and a check whose
   * unique coverage cannot be named is not kept. Deleting it turns nothing red,
   * which IS the falsification for this class.
   *
   * NOT THE WHOLE CLASS: the same dead predicate also stands at `DeleteOperation`,
   * `UpdateOperation` and `UpsertOperation`. Those three STAY — they are members of
   * the converted dead-guard family, each names the boundary that answers instead
   * (the where-unique parse) and each is pinned by a behavioral witness in
   * `operation-construction-witnesses.test.ts`. That is this estate's disposition
   * for a branch unreachable by construction: convert, name the owner, pin it.
   * These two had no witness and named no owner. Retire the family as five, or
   * not at all.
   */
  private pkSelect(): Record<string, true> {
    return Object.fromEntries(
      getPrimaryKeyFields(this.model).map((field) => [field, true])
    );
  }
}

function requireRecord(
  value: unknown,
  operation: string,
  field: string
): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new QueryEngineError(
    `query-engine-v2 ${operation} is missing a ${field} object.`
  );
}
