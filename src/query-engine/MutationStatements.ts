// biome-ignore-all lint/style/useFilenamingConvention: Architecture names this compiler child MutationStatements.
import type { Sql } from "@sql";
import { buildSelect } from "./builders/select-builder";
import { buildWhereWith } from "./builders/where-builder";
import { buildWhereUnique } from "./builders/where-unique-builder";
import { createQueryScope, getTableName } from "./context";
import { ManyToManyStatements } from "./ManyToManyStatements";
import {
  type OperationStatement,
  operationSelection,
  type ProgramWriteOperation,
  type RelationStatement,
  resolveOperationValues,
} from "./operation-program";
import {
  buildCreate,
  buildCreateMany,
  buildCreateManyAndReturn,
  buildDelete,
  buildDeleteMany,
  buildFind,
  buildFindUnique,
  buildUpdate,
  buildUpdateMany,
  buildUpdateManyAndReturn,
  buildUpsert,
} from "./operations";
import type { QueryScope } from "./types";
import { QueryEngineError } from "./types";
import type { WriteOperations } from "./WriteOperations";

/** Materializes compiler-owned mutation statements after program values resolve. */
export class MutationStatements<T> {
  private readonly writes: WriteOperations<T>;

  constructor(writes: WriteOperations<T>) {
    this.writes = writes;
  }

  direct(
    ctx: QueryScope,
    operation: ProgramWriteOperation,
    args: Record<string, unknown>
  ): Sql {
    switch (operation) {
      case "create":
        return buildCreate(ctx, {
          data: requireRecord(args.data, operation, "data"),
          ...operationSelection(args),
        });
      case "createMany":
        return buildCreateMany(
          ctx,
          requireRecordArray(args.data, operation),
          args.skipDuplicates === true
        );
      case "createManyAndReturn":
        return buildCreateManyAndReturn(ctx, {
          data: requireRecordArray(args.data, operation),
          ...(args.skipDuplicates === true ? { skipDuplicates: true } : {}),
          ...(isRecord(args.select) ? { select: args.select } : {}),
        });
      case "update":
        return buildUpdate(ctx, {
          where: requireRecord(args.where, operation, "where"),
          data: requireRecord(args.data, operation, "data"),
          ...operationSelection(args),
        });
      case "updateMany": {
        const where = optionalRecord(args.where, operation, "where");
        return buildUpdateMany(ctx, {
          ...(where ? { where } : {}),
          data: requireRecord(args.data, operation, "data"),
        });
      }
      case "updateManyAndReturn": {
        const where = optionalRecord(args.where, operation, "where");
        return buildUpdateManyAndReturn(ctx, {
          ...(where ? { where } : {}),
          data: requireRecord(args.data, operation, "data"),
          ...(isRecord(args.select) ? { select: args.select } : {}),
        });
      }
      case "delete":
        return buildDelete(ctx, {
          where: requireRecord(args.where, operation, "where"),
          ...operationSelection(args),
        });
      case "deleteMany": {
        const where = optionalRecord(args.where, operation, "where");
        return buildDeleteMany(ctx, { ...(where ? { where } : {}) });
      }
      case "upsert":
        return buildUpsert(ctx, {
          where: requireRecord(args.where, operation, "where"),
          create: requireRecord(args.create, operation, "create"),
          update: requireRecord(args.update, operation, "update"),
          ...operationSelection(args),
          ...(isRecord(args.targetWhere)
            ? { targetWhere: args.targetWhere }
            : {}),
          ...(isRecord(args.setWhere) ? { setWhere: args.setWhere } : {}),
        });
      default: {
        const exhaustive: never = operation;
        throw new QueryEngineError(`Unknown write operation: ${exhaustive}`);
      }
    }
  }

  operation(
    statement: OperationStatement,
    values: ReadonlyMap<string, unknown>,
    lockReads: boolean
  ): Sql {
    const engine = this.writes.compiler.pending.engine;
    const model = statement.model
      ? engine.registry.getByTableName(statement.model)
      : undefined;
    if (!model) {
      throw new QueryEngineError(
        `Operation program references unknown model table '${statement.model ?? ""}'.`
      );
    }
    const ctx = createQueryScope(engine.adapter, model);
    const args = resolveOperationValues(statement.args, values);
    switch (statement.operation) {
      case "create":
        return buildCreate(ctx, {
          data: requireRecord(args.data, "create", "data"),
          ...operationSelection(args),
        });
      case "createMany":
        return buildCreateMany(
          ctx,
          requireRecordArray(args.data, "createMany"),
          args.skipDuplicates === true
        );
      case "findUnique":
        return buildFindUnique(ctx, {
          where: requireRecord(args.where, "findUnique", "where"),
          ...operationSelection(args),
          ...(statement.lock === "transaction" && lockReads
            ? { forUpdate: true }
            : {}),
        });
      case "findMany":
        return this.findMany(statement, args, ctx, lockReads);
      case "update":
        return buildUpdate(ctx, {
          where: requireRecord(args.where, "update", "where"),
          data: requireRecord(args.data, "update", "data"),
        });
      case "updateMany":
        return buildUpdateMany(ctx, {
          ...(isRecord(args.where) ? { where: args.where } : {}),
          data: requireRecord(args.data, "updateMany", "data"),
        });
      case "delete":
        return buildDelete(ctx, {
          where: requireRecord(args.where, "delete", "where"),
        });
      case "deleteMany":
        return buildDeleteMany(ctx, {
          ...(isRecord(args.where) ? { where: args.where } : {}),
        });
      default:
        throw new QueryEngineError(
          `Relation program cannot materialize '${statement.operation}'.`
        );
    }
  }

  relation(
    statement: RelationStatement,
    values: ReadonlyMap<string, unknown>,
    lockReads: boolean
  ): Sql {
    const engine = this.writes.compiler.pending.engine;
    const model = engine.registry.getByTableName(statement.model);
    if (!model) {
      throw new QueryEngineError(
        `Relation program references unknown model table '${statement.model}'.`
      );
    }
    const ctx = createQueryScope(engine.adapter, model);
    return new ManyToManyStatements(ctx, lockReads).materialize({
      ...statement,
      args: resolveOperationValues(statement.args, values),
    });
  }

  private findMany(
    statement: OperationStatement,
    args: Record<string, unknown>,
    ctx: import("./types").QueryScope,
    lockReads: boolean
  ): Sql {
    if (isRecord(args.whereUnique)) {
      const alias = ctx.rootAlias;
      const base = buildWhereUnique(ctx, args.whereUnique, alias);
      const where = isRecord(args.filter)
        ? buildWhereWith(ctx, base, args.filter, alias)
        : base;
      return ctx.adapter.assemble.select({
        columns: buildSelect(
          ctx,
          isRecord(args.select) ? args.select : undefined,
          isRecord(args.include) ? args.include : undefined,
          alias
        ),
        from: ctx.adapter.identifiers.table(getTableName(ctx.model), alias),
        where,
        ...(typeof args.take === "number"
          ? { limit: ctx.adapter.literals.value(args.take) }
          : {}),
        ...((statement.lock === "transaction" || args.lock === "transaction") &&
        lockReads
          ? { forUpdate: true }
          : {}),
      });
    }
    let where: Record<string, unknown> | undefined;
    if (isRecord(args.filter)) where = args.filter;
    else if (isRecord(args.where)) where = args.where;
    return buildFind(
      ctx,
      {
        ...(where ? { where } : {}),
        ...(isRecord(args.select) ? { select: args.select } : {}),
        ...(isRecord(args.include) ? { include: args.include } : {}),
        ...((statement.lock === "transaction" || args.lock === "transaction") &&
        lockReads
          ? { forUpdate: true }
          : {}),
      },
      { limit: typeof args.take === "number" ? args.take : undefined }
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
    `Validated ${operation} arguments are missing a ${field} object.`
  );
}

function requireRecordArray(
  value: unknown,
  operation: string
): Record<string, unknown>[] {
  if (Array.isArray(value) && value.every(isRecord)) return value;
  throw new QueryEngineError(
    `Validated ${operation} arguments are missing a data array.`
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
