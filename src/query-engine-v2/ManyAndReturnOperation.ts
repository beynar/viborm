// biome-ignore-all lint/style/useFilenamingConvention: ManyAndReturnOperation is the architecture name.
import { QueryEngineError, TransactionError } from "@errors";
import type { Model } from "@schema/model";
import { getPrimaryKeyFields } from "../query-engine/builders/correlation-utils";
import { createQueryScope } from "../query-engine/context/query-scope";
import {
  buildCreateManyPlan,
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
import { isRecord, UnsupportedOperationError } from "./shared";

type ExecutionMode = "transaction" | "batch";
type AndReturnKind = "createManyAndReturn" | "updateManyAndReturn";

/**
 * The `*AndReturn` batch mutations (PLAN P4 item 2a) — the named non-boring
 * stragglers. Both return the affected rows, and both are the consumer that
 * makes the census's **ordered source list whose rows concatenate** (ATOM §1)
 * live:
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
 *
 * - **non-returning drivers in forced batch**: V1 refuses because public result
 *   parsing cannot be rolled back after an atomic batch commits. That refusal is
 *   KEPT AS CONTRACT (ATOM §7): V2 refuses with the byte-identical typed
 *   `TransactionError` — never weakened into a route or a silent divergence.
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
    this.mode = selectExecutionMode(engine);
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
        `Driver '${engine.driver.driverName}' cannot execute '${kind}' because public result parsing cannot be rolled back.`,
        {
          meta: {
            driver: engine.driver.driverName,
            operation: kind,
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

    // updateManyAndReturn
    const data = requireRecord(this.args.data, "updateManyAndReturn", "data");
    if (supportsReturning) {
      const step: StatementStep = {
        id: this.scope.allocate(`${this.modelName()}.updateManyReturn`),
        kind: "write",
        statement: buildUpdateManyAndReturn(this.ctx(), {
          ...(isRecord(this.args.where) ? { where: this.args.where } : {}),
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
    this.captureRead = {
      id: this.scope.allocate(`${this.modelName()}.updateManyReturn.capture`),
      kind: "read",
      statement: buildFind(this.ctx(), {
        ...(isRecord(this.args.where) ? { where: this.args.where } : {}),
        select: this.pkSelect(),
        forUpdate: true,
      }),
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
    return this.compileCapturedUpdate(known);
  }

  parse<T>(outputs: Readonly<Record<string, unknown>>): T {
    if (!Object.hasOwn(outputs, "result")) {
      // The empty-plan case (no data / nothing matched): an empty result set.
      return [] as T;
    }
    const rows = outputs.result;
    if (!Array.isArray(rows)) {
      throw new QueryEngineError(
        `query-engine-v2 ${this.kind} did not expose its result rows.`
      );
    }
    return new ResultParser(
      this.engine.adapter,
      this.model,
      this.engine.driver
    ).parse<T>(this.kind as Operation, rows, this.args);
  }

  private compileCapturedUpdate(
    known: Readonly<Record<string, unknown>>
  ): OperationFragment {
    if (!(this.captureRead && this.updateData)) {
      throw new QueryEngineError(
        "query-engine-v2 updateManyAndReturn lost its capture plan."
      );
    }
    const captured = known[planningKey(this.captureRead.id, "rows")];
    if (!Array.isArray(captured)) {
      throw new QueryEngineError(
        "query-engine-v2 updateManyAndReturn planning did not expose the captured rows."
      );
    }
    // Nothing matched: no update, an empty result (V1 skips the write and read
    // when the capture is empty — `requiresRowsFrom`).
    if (captured.length === 0) return { steps: [], outputs: {} };

    const ctx = this.ctx();
    const rows = captured as Record<string, unknown>[];
    const beforeWhere = this.capturedFilterWhere(ctx, rows);
    const afterWhere = this.capturedFilterWhere(ctx, rows, this.updateData);

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
        "query-engine-v2 createManyAndReturn requires a data array."
      );
    }
    if (data.length === 0) return { steps: [], output: undefined };

    const skipDuplicates = this.args.skipDuplicates === true;
    // Non-returning skipDuplicates cannot be expressed as linear steps: a skipped
    // INSERT still refetches into an unconditional read, which would return the
    // pre-existing row V1 correctly omits. This shape routes to V1 whole-tree —
    // an honest per-tree route, not a weakened refusal (the refusal is ATOM §7's
    // batch case, above).
    if (skipDuplicates && !supportsReturning) {
      throw new UnsupportedOperationError(
        "query-engine-v2 createManyAndReturn does not support skipDuplicates on a non-returning driver."
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
          "query-engine-v2 createManyAndReturn expected one input per statement."
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
          "query-engine-v2 createManyAndReturn left an input row without a result."
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

function selectExecutionMode(engine: QueryEngine): ExecutionMode {
  if (engine.driver.supportsTransactions) return "transaction";
  if (engine.driver.supportsBatch) return "batch";
  throw new QueryEngineError(
    `Driver '${engine.driver.driverName}' supports neither transactions nor atomic batch execution.`
  );
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
