// biome-ignore-all lint/style/useFilenamingConvention: ManyAndReturnOperation is the architecture name.
import {
  publicOperationName,
  QueryEngineError,
  TransactionError,
} from "@errors";
import type { Model } from "@schema/model";
import { getPrimaryKeyFields } from "../query-engine/builders/correlation-utils";
import { createQueryScope } from "../query-engine/context/query-scope";
import {
  buildCreateManyPlan,
  buildDeleteMany,
  buildDeleteManyAndReturn,
  buildFind,
  buildFindUnique,
  buildUpdateMany,
  buildUpdateManyAndReturn,
} from "../query-engine/operations";
import {
  getCreatedRowWhere,
  getPrimaryKeyValuesFromRecord,
  getUpdatedPrimaryKeyValues,
} from "../query-engine/operations/mutation-identity";
import type { QueryEngine } from "../query-engine/query-engine";
import { ResultParser } from "../query-engine/result/ResultParser";
import type { Operation, QueryScope } from "../query-engine/types";
import { validate } from "../query-engine/validator";
import {
  type FragmentOutputSource,
  type OperationFragment,
  type OperationStep,
  type OperationValueReference,
  ref,
  type StatementStep,
} from "./OperationFragment";
import { planningKey, planningOutputs } from "./Part";
import { StepScope } from "./StepScope";
import {
  isRecord,
  selectExecutionMode,
  UnsupportedOperationError,
} from "./shared";

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
 * The row-returning arm of the bulk mutations (PLAN P4 item 2a; W3-B made it
 * implicit). Reached only when the client payload carries a `select`. Both kinds
 * return the affected rows, and both are the consumer that makes the census's
 * **ordered source list whose rows concatenate** (ATOM §1) live:
 *
 * - **returning drivers** (`supportsReturning`): `createManyAndReturn` is one
 *   `INSERT … RETURNING` per input row, whose rows concatenate in input order
 *   (the ordered source list); `updateManyAndReturn` is one `UPDATE … RETURNING`.
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
 *   KEPT AS CONTRACT (ATOM §7) and now names the public spelling — a bulk write
 *   `with 'select'` — never weakened into a route or a silent divergence. The
 *   `{ count }` arm of the same family is unaffected and still runs there.
 *
 * `updateMany`/`deleteMany` `limit` (Prisma 6.x) caps this arm exactly as it
 * caps `{ count }`: the rows returned ARE the rows affected, so a capped write
 * hands back at most `limit` of them. `limit: 0` compiles to the empty plan and
 * parses to `[]` — the row-shaped spelling of `{ count: 0 }`.
 *
 * One operation, two leaves (WHY §4.1); no new step kind, no new executor branch.
 */
export class ManyAndReturnOperation {
  readonly mode: ExecutionMode;

  private readonly engine: QueryEngine;
  private readonly model: Model<any>;
  private readonly kind: AndReturnKind;
  private readonly args: Record<string, unknown>;
  private readonly select: Record<string, unknown> | undefined;
  /** A statically-built fragment (returning, or non-returning createMany). */
  private readonly staticSteps: readonly OperationStep[] | undefined;
  private readonly staticOutput: FragmentOutputSource | undefined;
  /** The updateManyAndReturn non-returning capture (built in `planning`). */
  private readonly captureRead: StatementStep | undefined;
  private readonly updateData: Record<string, unknown> | undefined;
  private readonly scope: StepScope;

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

    this.args = validate<Record<string, unknown>>(
      engine.schemaRegistry,
      model,
      kind as Operation,
      args
    );
    this.select = isRecord(this.args.select) ? this.args.select : undefined;

    const supportsReturning = engine.adapter.capabilities.supportsReturning;
    // ATOM §7 refusal (kept as contract): a non-returning driver in forced batch
    // cannot resolve the returned identity atomically, because result parsing
    // happens after the atomic unit commits and cannot be rolled back.
    if (this.mode === "batch" && !supportsReturning) {
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
        const step: StatementStep = {
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
    const data = requireRecord(this.args.data, "updateMany", "data");
    if (supportsReturning) {
      const step: StatementStep = {
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
    return typeof this.args.limit === "number" ? this.args.limit : undefined;
  }

  /** The `where`/`limit` pair the bulk builders take, both optional. */
  private bulkScope(): { where?: Record<string, unknown>; limit?: number } {
    const limit = this.limit();
    return {
      ...(isRecord(this.args.where) ? { where: this.args.where } : {}),
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
  private buildPkCapture(label: string): StatementStep {
    const limit = this.limit();
    return {
      id: this.scope.allocate(`${this.modelName()}.${label}.capture`),
      kind: "read",
      statement: buildFind(
        this.ctx(),
        {
          ...(isRecord(this.args.where) ? { where: this.args.where } : {}),
          select: this.pkSelect(),
          forUpdate: true,
        },
        limit === undefined ? {} : { limit }
      ),
      outputs: { rows: { kind: "rows" } },
    };
  }

  planning(): OperationFragment {
    if (this.captureRead) {
      const steps = [this.captureRead];
      return { steps, outputs: planningOutputs(steps) };
    }
    return { steps: [], outputs: {} };
  }

  compile(known: Readonly<Record<string, unknown>>): OperationFragment {
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
      this.engine.adapter,
      this.model,
      this.engine.driver
    ).parse<T>(this.kind as Operation, rows, this.args);
  }

  /**
   * The planning capture's rows, or `undefined` when nothing matched (both
   * non-returning arms then compile to an empty plan and parse to `[]`, the way
   * V1's `requiresRowsFrom` skipped the write and the read).
   */
  private capturedRows(
    known: Readonly<Record<string, unknown>>
  ): Record<string, unknown>[] | undefined {
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
    return captured as Record<string, unknown>[];
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
    const readStep: StatementStep = {
      id: this.scope.allocate(`${this.modelName()}.deleteManyReturn.read`),
      kind: "read",
      statement: buildFind(ctx, {
        where: targetWhere,
        ...(this.select ? { select: this.select } : {}),
      }),
      outputs: { result: { kind: "rows" } },
    };
    const writeStep: StatementStep = {
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
    const writeStep: StatementStep = {
      id: this.scope.allocate(`${this.modelName()}.updateManyReturn.write`),
      kind: "write",
      statement: buildUpdateMany(ctx, {
        where: beforeWhere,
        data: this.updateData,
      }),
      outputs: {},
    };
    const readStep: StatementStep = {
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

  private buildCreateManyReturn(supportsReturning: boolean): {
    steps: readonly OperationStep[];
    output: FragmentOutputSource | undefined;
  } {
    const data = this.args.data;
    if (!Array.isArray(data)) {
      throw new QueryEngineError(
        "query-engine-v2 createMany with 'select' requires a data array."
      );
    }
    if (data.length === 0) return { steps: [], output: undefined };

    const skipDuplicates = this.args.skipDuplicates === true;
    // Non-returning `skipDuplicates` + `select` cannot be expressed as linear
    // steps: a skipped INSERT still refetches into an unconditional read, which
    // would hand back the PRE-EXISTING row as though it had just been created.
    // There is no portable statement that reports which rows a skip actually
    // inserted, so this is a typed V8003 refusal — never a silently wrong row set.
    // (The `{ count }` arm of `createMany` supports `skipDuplicates` everywhere;
    // only asking for the rows back is refused here.)
    if (skipDuplicates && !supportsReturning) {
      throw new UnsupportedOperationError(
        "createMany with 'select' does not support 'skipDuplicates' on a driver without RETURNING: the rows a skip actually inserted cannot be identified. Drop 'select' to get { count }, or drop 'skipDuplicates'."
      );
    }

    const ctx = this.ctx();
    const plan = buildCreateManyPlan(
      ctx,
      {
        data,
        skipDuplicates,
        ...(this.select ? { select: this.select } : {}),
      },
      true
    );
    const steps: OperationStep[] = [];
    const resultRefs: Array<OperationValueReference | undefined> = new Array(
      data.length
    );
    const name = this.modelName();

    for (const statement of plan.statements) {
      const inputIndex = statement.inputIndexes[0];
      if (inputIndex === undefined || statement.inputIndexes.length !== 1) {
        throw new QueryEngineError(
          "query-engine-v2 createMany with 'select' expected one input per statement."
        );
      }
      if (supportsReturning) {
        const id = this.scope.allocate(`${name}.createManyReturn`);
        steps.push({
          id,
          kind: "write",
          statement: statement.sql,
          outputs: { result: { kind: "rows" } },
        });
        resultRefs[inputIndex] = ref(id, "result");
        continue;
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
      resultRefs[inputIndex] = ref(readId, "result");
    }

    const output: OperationValueReference[] = [];
    for (const reference of resultRefs) {
      if (reference === undefined) {
        throw new QueryEngineError(
          "query-engine-v2 createMany with 'select' left an input row without a result."
        );
      }
      output.push(reference);
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
    return createQueryScope(this.engine.adapter, this.model);
  }

  private modelName(): string {
    return this.model["~"].names.ts ?? "unknown";
  }

  private pkSelect(): Record<string, true> {
    const fields = getPrimaryKeyFields(this.model);
    if (fields.length === 0) {
      throw new QueryEngineError(
        `Cannot execute an atomic non-returning mutation for model '${this.modelName()}' because it has no primary key.`
      );
    }
    return Object.fromEntries(fields.map((field) => [field, true]));
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
