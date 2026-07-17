// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this compiler child WritePrograms.
import { getPrimaryKeyFields } from "./builders/correlation-utils";
import { getWhereUniqueEntries } from "./builders/where-unique-builder";
import { getTableName } from "./context";
import {
  type BranchStep,
  createOperationProgram,
  createReadStep,
  createResultSource,
  createWriteStep,
  type OperationProgram,
  type OperationStatement,
  type OperationStep,
  operationSelection,
  type ProducedValue,
  type ProgramFailure,
  type StepResultSource,
} from "./operation-program";
import { buildCreateManyPlan, buildFindUnique } from "./operations";
import {
  assertCreateRefetchIdentity,
  getCreatedRowWhere,
  getPrimaryKeyWhereFromRecord,
  getProvidedPrimaryKeyWhere,
} from "./operations/mutation-identity";
import type { QueryScope } from "./types";
import { QueryEngineError } from "./types";
import type { WriteOperations } from "./WriteOperations";

const UPSERT_DECISION = "read:upsert-target";
const UPSERT_RESULT = "read:result";
const UPSERT_CREATE = "write:upsert-create";

/** Compiles row-shape groups, chunked inserts, and ordered bulk results. */
export class WritePrograms<T> {
  private readonly writes: WriteOperations<T>;

  constructor(writes: WriteOperations<T>) {
    this.writes = writes;
  }

  compileBulk(
    ctx: QueryScope,
    operation: "createMany" | "createManyAndReturn",
    args: Record<string, unknown>
  ): OperationProgram {
    const returnsRows = operation === "createManyAndReturn";
    const supportsReturning = ctx.adapter.capabilities.supportsReturning;
    const plan = buildCreateManyPlan(ctx, args, returnsRows);
    if (returnsRows && !supportsReturning) {
      return this.compileRefetch(ctx, args, plan);
    }
    const recoverUnique =
      plan.skipDuplicates &&
      ctx.adapter.mutations.skipDuplicatesStrategy === "recoverableUniqueError";
    const steps = plan.statements.map((statement, index) =>
      createWriteStep(`write:${index}`, statement.sql, {
        expectedCardinality: "many",
        affectedRows: "unrestricted",
        maximumAffectedRows: statement.inputIndexes.length,
        ...(recoverUnique ? { onUniqueConflict: "skip" as const } : {}),
      })
    );
    const sources = returnsRows
      ? plan.statements.flatMap((statement, index) =>
          statement.inputIndexes.map((inputIndex) =>
            createResultSource(steps[index]!, inputIndex)
          )
        )
      : steps.map((step) => createResultSource(step));
    return createOperationProgram(
      steps.length === 1 && !recoverUnique ? "statement" : "operation",
      steps,
      operation,
      args,
      { kind: returnsRows ? "rows" : "rowCount", results: sources },
      returnsRows ? this.writes.resultShape(operation, args) : undefined
    );
  }

  compileUpsert(
    ctx: QueryScope,
    args: Record<string, unknown>
  ): OperationProgram {
    const where = requireRecord(args.where, "where");
    const create = requireRecord(args.create, "create");
    const update = requireRecord(args.update, "update");
    const primaryKeys = getPrimaryKeyFields(ctx.model);
    if (primaryKeys.length === 0) {
      throw new QueryEngineError(
        `Cannot compile upsert for model '${modelName(ctx)}' without a primary key.`
      );
    }
    const decisionValues = Object.fromEntries(
      primaryKeys.map((field) => [
        field,
        this.writes.compiler.allocateProducedValue(
          UPSERT_DECISION,
          field,
          "row"
        ),
      ])
    );
    const decision = createReadStep(
      UPSERT_DECISION,
      operationStatement(
        "findUnique",
        {
          where,
          select: Object.fromEntries(primaryKeys.map((field) => [field, true])),
        },
        "transaction"
      ),
      { producedValues: Object.values(decisionValues) }
    );
    const capturedWhere = getPrimaryKeyWhereFromRecord(
      ctx.model,
      decisionValues,
      modelName(ctx)
    );
    const branch: BranchStep = {
      id: "branch:upsert-target",
      kind: "branch",
      premise: { step: decision.id, test: "hasRows" },
      pin: {
        whenTrue: guard(
          "guard:upsert-target",
          "exists",
          operationStatement("findUnique", { where: capturedWhere }),
          {
            kind: "nestedWrite",
            message: "Record was replaced by another transaction during upsert",
            relation: getTableName(ctx.model),
            raceable: false,
          }
        ),
        whenFalse: {
          kind: "uniqueConflict",
          step: UPSERT_CREATE,
          where,
          create,
          target: uniqueConflictTarget(ctx, where),
        },
      },
      whenTrue: this.compileExistingUpsert(ctx, args, update, capturedWhere),
      whenFalse: this.compileCreateUpsert(ctx, args, create),
    };
    return createOperationProgram(
      "operation",
      [decision, branch],
      "upsert",
      args,
      {
        kind: "rows",
        results: [{ step: UPSERT_RESULT, result: `${UPSERT_RESULT}:result` }],
      },
      this.writes.resultShape("upsert", args),
      !ctx.adapter.capabilities.supportsReturning
    );
  }

  private compileCreateUpsert(
    ctx: QueryScope,
    args: Record<string, unknown>,
    data: Record<string, unknown>
  ): readonly OperationStep[] {
    let where = getProvidedPrimaryKeyWhere(ctx.model, data);
    let producedValues: readonly ProducedValue[] | undefined;
    if (!where) {
      assertCreateRefetchIdentity(ctx, data, modelName(ctx));
      const primaryKeys = getPrimaryKeyFields(ctx.model);
      const field = primaryKeys[0];
      if (primaryKeys.length !== 1 || !field) {
        throw new QueryEngineError(
          `Cannot capture a generated compound identity for model '${modelName(ctx)}'.`
        );
      }
      const generated = this.writes.compiler.allocateProducedValue(
        UPSERT_CREATE,
        field,
        "insertId"
      );
      producedValues = [generated];
      where = { [field]: generated };
    }
    const write = createWriteStep(
      UPSERT_CREATE,
      operationStatement("create", { data }),
      {
        expectedCardinality: "one",
        affectedRows: "exact",
        ...(producedValues ? { producedValues } : {}),
      }
    );
    return [
      write,
      createReadStep(
        UPSERT_RESULT,
        operationStatement("findUnique", {
          where,
          ...operationSelection(args),
        }),
        { expectedRows: { kind: "exact", count: 1 } }
      ),
    ];
  }

  private compileExistingUpsert(
    ctx: QueryScope,
    args: Record<string, unknown>,
    data: Record<string, unknown>,
    capturedWhere: Record<string, unknown>
  ): readonly OperationStep[] {
    const filters = [args.targetWhere, args.setWhere].filter(hasKeys);
    if (filters.length === 0) return this.compileUpsertUpdate(args, data);
    const probe = operationStatement("probe", {
      where: capturedWhere,
      filter: filters.length === 1 ? filters[0]! : { AND: filters },
    });
    const read = createReadStep("read:upsert-filter", probe);
    const message = `Upsert precondition failed for model '${getTableName(ctx.model)}'.`;
    const failure: ProgramFailure = {
      kind: "nestedWrite",
      message,
      relation: getTableName(ctx.model),
      raceable: false,
    };
    const branch: BranchStep = {
      id: "branch:upsert-filter",
      kind: "branch",
      premise: { step: read.id, test: "hasRows" },
      pin: {
        whenTrue: guard("guard:upsert-filter-found", "exists", probe, failure),
        whenFalse: guard(
          "guard:upsert-filter-missing",
          "notExists",
          probe,
          failure
        ),
      },
      whenTrue: this.compileUpsertUpdate(args, data),
      whenFalse: [this.compileUpsertRead(args)],
    };
    return [read, branch];
  }

  private compileUpsertUpdate(
    args: Record<string, unknown>,
    data: Record<string, unknown>
  ): readonly OperationStep[] {
    return [
      createWriteStep(
        "write:upsert-update",
        {
          kind: "capturedMutation",
          operation: "update",
          rowsFrom: UPSERT_DECISION,
          data,
        },
        {
          expectedCardinality: "many",
          affectedRows: "unrestricted",
          maximumAffectedRows: 1,
        }
      ),
      this.compileUpsertRead(args, data),
    ];
  }

  private compileUpsertRead(
    args: Record<string, unknown>,
    afterUpdate?: Record<string, unknown>
  ): import("./operation-program").ReadStep {
    return createReadStep(
      UPSERT_RESULT,
      {
        kind: "capturedRead",
        rowsFrom: UPSERT_DECISION,
        cardinality: "one",
        ...(afterUpdate ? { afterUpdate } : {}),
        ...operationSelection(args),
      },
      { expectedRows: { kind: "exact", count: 1 } }
    );
  }

  private compileRefetch(
    ctx: QueryScope,
    args: Record<string, unknown>,
    plan: ReturnType<typeof buildCreateManyPlan>
  ): OperationProgram {
    const data = requireRecordArray(args.data);
    if (plan.statements.length !== data.length) {
      throw new QueryEngineError(
        `createManyAndReturn planned ${plan.statements.length} inserts for ${data.length} inputs.`
      );
    }
    const steps: OperationStep[] = [];
    const sources: StepResultSource[] = [];
    const recoverUnique =
      plan.skipDuplicates &&
      ctx.adapter.mutations.skipDuplicatesStrategy === "recoverableUniqueError";
    for (let index = 0; index < plan.statements.length; index++) {
      const statement = plan.statements[index]!;
      const inputIndex = statement.inputIndexes[0];
      if (inputIndex === undefined) {
        throw new QueryEngineError("createManyAndReturn lost an input index.");
      }
      const write = createWriteStep(`write:${index}`, statement.sql, {
        expectedCardinality: "one",
        affectedRows: plan.skipDuplicates ? "unrestricted" : "exact",
        ...(plan.skipDuplicates ? { maximumAffectedRows: 1 } : {}),
        ...(recoverUnique ? { onUniqueConflict: "skip" as const } : {}),
      });
      const read = createReadStep(
        `read:${index}`,
        buildFindUnique(ctx, {
          where: getCreatedRowWhere(
            ctx,
            data[inputIndex]!,
            this.writes.compiler.pending.modelName
          ),
          ...(isRecord(args.select) ? { select: args.select } : {}),
        }),
        {
          expectedRows: { kind: "exact", count: 1 },
          requiresRowsFrom: write.id,
        }
      );
      steps.push(write, read);
      sources.push(createResultSource(read, inputIndex));
    }
    return createOperationProgram(
      "operation",
      steps,
      "createManyAndReturn",
      args,
      { kind: "rows", results: sources },
      this.writes.resultShape("createManyAndReturn", args),
      true
    );
  }
}

function requireRecordArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value) && value.every(isRecord)) return value;
  throw new QueryEngineError(
    "Validated createManyAndReturn arguments are missing a data array."
  );
}

function operationStatement(
  operation: OperationStatement["operation"],
  args: Record<string, unknown>,
  lock?: OperationStatement["lock"]
): OperationStatement {
  return { kind: "operation", operation, args, ...(lock ? { lock } : {}) };
}

function guard(
  id: string,
  kind: "exists" | "notExists",
  statement: import("./operation-program").ProgramStatement,
  failure: ProgramFailure
): import("./operation-program").GuardStep {
  return {
    id,
    kind: "guard",
    premise: { kind, statement },
    failure,
  };
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new QueryEngineError(`Validated upsert is missing '${field}'.`);
}

function hasKeys(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0;
}

function modelName(ctx: QueryScope): string {
  return ctx.model["~"].names.ts ?? getTableName(ctx.model);
}

export function uniqueConflictTarget(
  ctx: QueryScope,
  where: Record<string, unknown>
): import("./operation-program").UniqueConflictPin["target"] {
  const entries = getWhereUniqueEntries(ctx, where);
  const fields = entries.map(({ fieldName }) => fieldName);
  const columns = entries.map(
    ({ fieldName }) => ctx.model["~"].getFieldName(fieldName).sql
  );
  const table = getTableName(ctx.model);
  const primaryKeys = getPrimaryKeyFields(ctx.model);
  const isPrimary =
    primaryKeys.length === entries.length &&
    primaryKeys.every((field, index) => field === entries[index]?.fieldName);
  const [selector] = Object.keys(where).filter(
    (key) => where[key] !== undefined
  );
  let constraints: string[];
  if (isPrimary) {
    constraints = [`${table}_pkey`, "PRIMARY"];
  } else if (selector && ctx.model["~"].state.compoundUniques?.[selector]) {
    constraints = [`${table}_${selector}_key`];
  } else {
    const [column] = columns;
    if (!column) {
      throw new QueryEngineError("Unique conflict target has no column.");
    }
    constraints = [`${table}_${column}_key`];
  }
  return { fields, table, columns, constraints };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
