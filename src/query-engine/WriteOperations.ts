// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this child WriteOperations.
import type { QueryResult } from "@drivers/types";
import { isSql, type Sql } from "@sql";
import {
  buildPrimaryKeyWhereUnique,
  getPrimaryKeyFields,
} from "./builders/correlation-utils";
import { separateData } from "./builders/relation-data-builder";
import { buildWhereWith } from "./builders/where-builder";
import { buildWhereUnique } from "./builders/where-unique-builder";
import { createQueryScope, getTableName } from "./context";
import { MutationStatements } from "./MutationStatements";
import type { OperationCompiler } from "./OperationCompiler";
import {
  type OperationProgram,
  type OperationStep,
  operationSelection,
  type ProgramStatement,
  type ProgramWriteOperation,
  createOperationProgram as program,
  type ReadStep,
  createReadStep as readStep,
  resolveOperationValues,
  createResultSource as source,
  createWriteStep as writeStep,
} from "./operation-program";
import {
  buildCreate,
  buildDelete,
  buildFind,
  buildFindUnique,
  buildUpdate,
  buildUpdateMany,
} from "./operations";
import {
  getCreatedRowWhere,
  getPrimaryKeyValuesFromRecord,
  getUpdatedPrimaryKeyValues,
} from "./operations/mutation-identity";
import { RelationMutations } from "./RelationMutations";
import { buildExpectedResultShape } from "./result/result-shape";
import type { Operation, QueryScope } from "./types";
import { QueryEngineError } from "./types";
import { WritePrograms } from "./WritePrograms";

export type StepResults = ReadonlyMap<string, QueryResult<unknown>>;

const SINGLE_WRITES: ReadonlySet<ProgramWriteOperation> = new Set([
  "create",
  "update",
  "delete",
  "upsert",
]);
const COUNT_WRITES: ReadonlySet<ProgramWriteOperation> = new Set([
  "createMany",
  "updateMany",
  "deleteMany",
]);

export class WriteOperations<T> {
  readonly compiler: OperationCompiler<T>;
  readonly relations: RelationMutations<T>;
  readonly statements: MutationStatements<T>;
  private readonly programs: WritePrograms<T>;

  constructor(compiler: OperationCompiler<T>) {
    this.compiler = compiler;
    this.statements = new MutationStatements(this);
    this.relations = new RelationMutations(this);
    this.programs = new WritePrograms(this);
  }

  compile(
    ctx: QueryScope,
    operation: Exclude<
      Operation,
      import("./operation-program").ProgramReadOperation
    >,
    args: Record<string, unknown>
  ): OperationProgram {
    if (operation === "create") {
      const data = requireRecord(args.data, operation, "data");
      if (hasRelationMutations(ctx, data)) {
        return this.relations.compileCreate(ctx, args);
      }
    }
    if (operation === "update") {
      const data = requireRecord(args.data, operation, "data");
      if (hasRelationMutations(ctx, data)) {
        return this.relations.compileUpdate(ctx, args);
      }
    }
    if (operation === "upsert") {
      const create = requireRecord(args.create, operation, "create");
      const update = requireRecord(args.update, operation, "update");
      if (
        hasRelationMutations(ctx, create) ||
        hasRelationMutations(ctx, update)
      ) {
        return this.relations.compileUpsert(ctx, args);
      }
      const hasFilteredArm =
        (isRecord(args.targetWhere) &&
          Object.keys(args.targetWhere).length > 0) ||
        (isRecord(args.setWhere) && Object.keys(args.setWhere).length > 0);
      if (
        !ctx.adapter.capabilities.supportsReturning ||
        (!ctx.adapter.capabilities.supportsUpsertWhere && hasFilteredArm)
      ) {
        return this.programs.compileUpsert(ctx, args);
      }
    }
    if (operation === "createMany" || operation === "createManyAndReturn") {
      return this.programs.compileBulk(ctx, operation, args);
    }
    if (operation === "create" && !ctx.adapter.capabilities.supportsReturning) {
      return this.compileCreateRefetch(ctx, args);
    }
    if (
      (operation === "update" || operation === "delete") &&
      !ctx.adapter.capabilities.supportsReturning
    ) {
      return this.compileMutationRefetch(ctx, operation, args);
    }
    if (
      operation === "updateManyAndReturn" &&
      !ctx.adapter.capabilities.supportsReturning
    ) {
      return this.compileUpdateManyRefetch(ctx, args);
    }
    return this.compileDirect(ctx, operation, args);
  }

  materialize(
    statement: ProgramStatement,
    results: StepResults,
    values: ReadonlyMap<string, unknown>,
    lockReads: boolean
  ): Sql {
    if (isSql(statement)) return statement;
    const ctx = createQueryScope(
      this.compiler.pending.engine.adapter,
      this.compiler.pending.model
    );
    if (statement.kind === "relation") {
      return this.statements.relation(statement, values, lockReads);
    }
    if (statement.kind === "operation") {
      if (statement.model) {
        return this.statements.operation(statement, values, lockReads);
      }
      const args = resolveOperationValues(statement.args, values);
      if (statement.operation === "create") {
        return buildCreate(ctx, {
          data: requireRecord(args.data, "create", "data"),
          ...operationSelection(args),
        });
      }
      if (statement.operation === "findUnique") {
        return buildFindUnique(ctx, {
          where: requireRecord(args.where, "findUnique", "where"),
          ...operationSelection(args),
          ...(statement.lock === "transaction" && lockReads
            ? { forUpdate: true }
            : {}),
        });
      }
      const where = requireRecord(args.where, "probe", "where");
      const filter = requireRecord(args.filter, "probe", "filter");
      return ctx.adapter.assemble.select({
        columns: ctx.adapter.literals.value(1),
        from: ctx.adapter.identifiers.escape(getTableName(ctx.model)),
        where: buildWhereWith(
          ctx,
          buildWhereUnique(ctx, where, ""),
          filter,
          ""
        ),
        limit: ctx.adapter.literals.value(1),
      });
    }
    const rows = readRecordRows(results, statement.rowsFrom);
    if (statement.kind === "capturedMutation") {
      const where =
        statement.operation === "updateMany"
          ? buildCapturedFilterWhere(ctx, rows)
          : buildCapturedWhere(ctx, rows);
      if (statement.operation === "delete") return buildDelete(ctx, { where });
      const data = requireRecord(statement.data, statement.operation, "data");
      return statement.operation === "update"
        ? buildUpdate(ctx, { where, data })
        : buildUpdateMany(ctx, { where, data });
    }
    const where =
      statement.cardinality === "many"
        ? buildCapturedFilterWhere(ctx, rows, statement.afterUpdate)
        : buildCapturedWhere(ctx, rows, statement.afterUpdate);
    const selection = {
      ...(statement.select ? { select: statement.select } : {}),
      ...(statement.include ? { include: statement.include } : {}),
    };
    return statement.cardinality === "one"
      ? buildFindUnique(ctx, { where, ...selection })
      : buildFind(ctx, { where, ...selection });
  }

  private compileDirect(
    ctx: QueryScope,
    operation: ProgramWriteOperation,
    args: Record<string, unknown>
  ): OperationProgram {
    const statement = this.statements.direct(ctx, operation, args);
    const returnsRows = !COUNT_WRITES.has(operation);
    const shape = returnsRows ? this.resultShape(operation, args) : undefined;
    const step = writeStep("write:0", statement, {
      expectedCardinality: SINGLE_WRITES.has(operation) ? "one" : "many",
      affectedRows: SINGLE_WRITES.has(operation) ? "exact" : "unrestricted",
      ...(operation === "update" || operation === "delete"
        ? { missing: "not-found" as const }
        : {}),
    });
    return program(
      "statement",
      [step],
      operation,
      args,
      {
        kind: returnsRows ? "rows" : "rowCount",
        results: [source(step)],
      },
      shape
    );
  }

  private compileCreateRefetch(
    ctx: QueryScope,
    args: Record<string, unknown>
  ): OperationProgram {
    const data = requireRecord(args.data, "create", "data");
    const where = getCreatedRowWhere(
      ctx,
      data,
      this.compiler.pending.modelName
    );
    const write = writeStep("write:0", buildCreate(ctx, { data }), {
      expectedCardinality: "one",
      affectedRows: "exact",
    });
    const read = readStep(
      "read:1",
      buildFindUnique(ctx, {
        where,
        ...operationSelection(args),
      }),
      { expectedRows: { kind: "exact", count: 1 }, missing: "not-found" }
    );
    return program(
      "operation",
      [write, read],
      "create",
      args,
      { kind: "rows", results: [source(read)] },
      this.resultShape("create", args),
      true
    );
  }

  private compileMutationRefetch(
    ctx: QueryScope,
    operation: "update" | "delete",
    args: Record<string, unknown>
  ): OperationProgram {
    const where = requireRecord(args.where, operation, "where");
    const capture = readStep(
      "read:0",
      buildFindUnique(ctx, {
        where,
        select: primaryKeySelect(ctx),
        forUpdate: true,
      }),
      { expectedRows: { kind: "exact", count: 1 }, missing: "not-found" }
    );
    const steps: OperationStep[] = [capture];
    let resultStep: ReadStep;
    if (operation === "update") {
      const data = requireRecord(args.data, operation, "data");
      const write = writeStep(
        "write:1",
        { kind: "capturedMutation", operation, rowsFrom: capture.id, data },
        {
          expectedCardinality: "many",
          affectedRows: "unrestricted",
          maximumAffectedRows: 1,
        }
      );
      resultStep = readStep(
        "read:2",
        {
          kind: "capturedRead",
          rowsFrom: capture.id,
          cardinality: "one",
          afterUpdate: data,
          ...operationSelection(args),
        },
        { expectedRows: { kind: "exact", count: 1 }, missing: "not-found" }
      );
      steps.push(write, resultStep);
    } else {
      resultStep = readStep(
        "read:1",
        {
          kind: "capturedRead",
          rowsFrom: capture.id,
          cardinality: "one",
          ...operationSelection(args),
        },
        { expectedRows: { kind: "exact", count: 1 }, missing: "not-found" }
      );
      const write = writeStep(
        "write:2",
        { kind: "capturedMutation", operation, rowsFrom: capture.id },
        { expectedCardinality: "one", affectedRows: "exact" }
      );
      steps.push(resultStep, write);
    }
    return program(
      "operation",
      steps,
      operation,
      args,
      { kind: "rows", results: [source(resultStep)] },
      this.resultShape(operation, args),
      true
    );
  }

  private compileUpdateManyRefetch(
    ctx: QueryScope,
    args: Record<string, unknown>
  ): OperationProgram {
    const data = requireRecord(args.data, "updateManyAndReturn", "data");
    const where = optionalRecord(args.where, "updateManyAndReturn", "where");
    const capture = readStep(
      "read:0",
      buildFind(ctx, {
        ...(where ? { where } : {}),
        select: primaryKeySelect(ctx),
        forUpdate: true,
      })
    );
    const write = writeStep(
      "write:1",
      {
        kind: "capturedMutation",
        operation: "updateMany",
        rowsFrom: capture.id,
        data,
      },
      {
        expectedCardinality: "many",
        affectedRows: "unrestricted",
        maximumAffectedRows: { rowsFrom: capture.id },
        requiresRowsFrom: capture.id,
      }
    );
    const read = readStep(
      "read:2",
      {
        kind: "capturedRead",
        rowsFrom: capture.id,
        cardinality: "many",
        afterUpdate: data,
        ...(isRecord(args.select) ? { select: args.select } : {}),
      },
      {
        expectedRows: { kind: "sameAs", step: capture.id },
        requiresRowsFrom: capture.id,
      }
    );
    return program(
      "operation",
      [capture, write, read],
      "updateManyAndReturn",
      args,
      { kind: "rows", results: [source(read)] },
      this.resultShape("updateManyAndReturn", args),
      true
    );
  }

  resultShape(
    operation: ProgramWriteOperation,
    args: Record<string, unknown>
  ): import("./types").ExpectedResultShape {
    const shape = buildExpectedResultShape(
      this.compiler.pending.model,
      operation,
      args
    );
    if (shape) return shape;
    throw new QueryEngineError(
      `Operation '${operation}' has no declared row result shape.`
    );
  }
}

function hasRelationMutations(
  ctx: QueryScope,
  data: Record<string, unknown>
): boolean {
  return Object.keys(separateData(ctx, data).relations).length > 0;
}

function primaryKeySelect(ctx: QueryScope): Record<string, true> {
  const fields = getPrimaryKeyFields(ctx.model);
  if (fields.length === 0) {
    throw new QueryEngineError(
      `Cannot execute an atomic non-returning mutation for model '${ctx.model["~"].names.ts ?? "unknown"}' because it has no primary key.`
    );
  }
  return Object.fromEntries(fields.map((field) => [field, true]));
}

function buildCapturedWhere(
  ctx: QueryScope,
  rows: readonly Record<string, unknown>[],
  afterUpdate?: Record<string, unknown>
): Record<string, unknown> {
  const identities = capturedPrimaryKeyValues(ctx, rows, afterUpdate).map(
    (values) => buildPrimaryKeyWhereUnique(ctx.model, values)
  );
  return identities.length === 1 ? identities[0]! : { OR: identities };
}

function buildCapturedFilterWhere(
  ctx: QueryScope,
  rows: readonly Record<string, unknown>[],
  afterUpdate?: Record<string, unknown>
): Record<string, unknown> {
  const conditions = capturedPrimaryKeyValues(ctx, rows, afterUpdate).map(
    (values) =>
      Object.fromEntries(
        Object.entries(values).map(([field, value]) => [
          field,
          { equals: value },
        ])
      )
  );
  return conditions.length === 1 ? conditions[0]! : { OR: conditions };
}

function capturedPrimaryKeyValues(
  ctx: QueryScope,
  rows: readonly Record<string, unknown>[],
  afterUpdate?: Record<string, unknown>
): Record<string, unknown>[] {
  if (rows.length === 0) {
    throw new QueryEngineError(
      "Cannot materialize a captured statement from zero rows."
    );
  }
  const modelName = ctx.model["~"].names.ts ?? "unknown";
  return rows.map((row) =>
    afterUpdate
      ? getUpdatedPrimaryKeyValues(ctx, row, afterUpdate, modelName)
      : getPrimaryKeyValuesFromRecord(ctx.model, row, modelName)
  );
}

function readRecordRows(
  results: StepResults,
  step: string
): Record<string, unknown>[] {
  const output = results.get(step);
  if (!output)
    throw new QueryEngineError(
      `Program step '${step}' has no completed result.`
    );
  if (!output.rows.every(isRecord)) {
    throw new QueryEngineError(
      `Program step '${step}' returned a malformed row.`
    );
  }
  return output.rows;
}

function requireRecord(
  value: unknown,
  operation: string,
  field: string
): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new QueryEngineError(
    `Validated ${operation} arguments are missing a ${field} object.`
  );
}

function optionalRecord(
  value: unknown,
  operation: string,
  field: string
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return requireRecord(value, operation, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
