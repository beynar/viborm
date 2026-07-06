import { PendingOperation } from "@client/pending-operation";
import type { AnyDriver } from "@drivers";
import {
  ATTR_DB_COLLECTION,
  ATTR_DB_OPERATION_NAME,
  createErrorLogEvent,
  SPAN_BUILD,
  SPAN_OPERATION,
  SPAN_PARSE,
  SPAN_VALIDATE,
} from "@instrumentation";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import {
  buildConnectFkValues,
  type RelationMutation,
  separateData,
} from "./builders/relation-data-builder";
import { isCacheManagedExecution } from "./cache-flow";
import { createQueryContext } from "./context";
import {
  buildAggregate,
  buildCount,
  buildCreate,
  buildCreateMany,
  buildCreateManyAndReturn,
  buildDelete,
  buildDeleteMany,
  buildFindFirst,
  buildFindMany,
  buildFindUnique,
  buildGroupBy,
  buildUpdate,
  buildUpdateMany,
  buildUpdateManyAndReturn,
  buildUpsert,
} from "./operations";
import {
  executeManyReturnWithoutReturning,
  needsManyReturnRefetch,
} from "./operations/many-returns";
import {
  canRefetchNativeUpsert,
  needsMutationRefetch,
} from "./operations/mutation-returns";
import { prepareNestedWriteBatch } from "./operations/nested-writes/batch-plan";
import {
  runInterpreter,
  selectMode,
} from "./operations/nested-writes/interpreter";
import { assertPlanExecutable } from "./operations/nested-writes/legality";
import { assertNoPlannedNestedMutationExecution } from "./operations/nested-writes/planned-mutation";
import { isTreeEligible } from "./operations/nested-writes/routing";
import { assertNestedUpdatePlanIsExecutable } from "./operations/nested-writes/update-plan";
import {
  applyPaginationPostProcessing,
  applyPostProcessing,
  createParseResultFunction,
  executeNonReturningMutation,
  parseOperationResult,
  throwIfSingleRecordMutationMiss,
} from "./result-flow";
import {
  executeWithNestedWrites,
  hasNestedWrites,
  isNestedBatchOperation,
  needsUpsertWhereFallback,
} from "./transaction-flow";
import {
  type BatchPreparationContext,
  isBatchOperation,
  type Operation,
  type PreparedBatchOperation,
  type PreparedQuery,
  type PrepareOptions,
  type QueryContext,
  type QueryEngineDependencies,
  QueryEngineError,
  type QueryMetadata,
} from "./types";
import { validate } from "./validator";

const OR_THROW_SUFFIX = "OrThrow";

export function buildValidatedOperation(
  dependencies: QueryEngineDependencies,
  model: Model<any>,
  operation: Operation,
  args: Record<string, unknown>
): Sql {
  const validated = validate<Record<string, unknown>>(
    dependencies.schemaRegistry,
    model,
    operation,
    args
  );

  const ctx = createQueryContext(
    dependencies.adapter,
    model,
    dependencies.registry,
    dependencies.driver
  );

  if (operation === "create" || operation === "update") {
    const processedArgs = processConnectOperations(ctx, operation, validated);
    return buildOperation(ctx, operation, processedArgs);
  }

  if (operation === "upsert") {
    assertUpsertNestedMutationsAreExecutable(ctx, validated);
    if (hasNestedWrites(operation, validated)) {
      throw new QueryEngineError(
        "Cannot build a single SQL statement for nested upsert writes. Execute the operation instead."
      );
    }
  }

  return buildOperation(ctx, operation, validated);
}

export function createPreparedOperation<T>(
  dependencies: QueryEngineDependencies,
  model: Model<any>,
  operation: Operation | `${Operation}OrThrow`,
  args: Record<string, unknown>,
  options?: PrepareOptions
): PendingOperation<T> {
  const modelName = model["~"].names.ts ?? "unknown";
  const isOrThrow = operation.endsWith(OR_THROW_SUFFIX);
  const baseOperation = isOrThrow
    ? (operation.slice(0, -OR_THROW_SUFFIX.length) as Operation)
    : (operation as Operation);

  const prepareOptions: PrepareOptions = {
    ...options,
    throwIfNotFound: isOrThrow || options?.throwIfNotFound,
    originalOperation: options?.originalOperation ?? operation,
  };

  const executor = createExecutor<T>(
    dependencies,
    model,
    baseOperation,
    args,
    prepareOptions
  );

  const hasNested = hasNestedWrites(baseOperation, args);
  const hasNonReturningSingleRecordMutation =
    !dependencies.adapter.capabilities.supportsReturning &&
    [
      "create",
      "update",
      "delete",
      "upsert",
      "createManyAndReturn",
      "updateManyAndReturn",
    ].includes(baseOperation);
  const prepareFunc =
    hasNested || hasNonReturningSingleRecordMutation
      ? undefined
      : createPrepareFunction(dependencies, model, baseOperation, args);
  const prepareBatchFunc =
    hasNested && isNestedBatchOperation(baseOperation)
      ? createNestedBatchPrepareFunction<T>(
          dependencies,
          model,
          baseOperation,
          args
        )
      : undefined;

  const parseResultFunc = createParseResultFunction<T>(
    dependencies,
    model,
    baseOperation,
    args,
    prepareOptions
  );

  const metadata: QueryMetadata<T> = {
    clientId: dependencies.clientId,
    args,
    operation: baseOperation,
    model: modelName,
    execute: executor,
    prepare: prepareFunc,
    prepareBatch: prepareBatchFunc,
    parseResult: parseResultFunc,
    isBatchOperation: isBatchOperation(baseOperation),
    hasNestedWrites: hasNested,
  };

  return new PendingOperation<T>(metadata);
}

function createNestedBatchPrepareFunction<T>(
  dependencies: QueryEngineDependencies,
  model: Model<any>,
  operation: Extract<Operation, "create" | "update" | "upsert">,
  args: Record<string, unknown>
) {
  return async (
    driverOverride?: AnyDriver,
    context?: BatchPreparationContext
  ) => {
    const driver = driverOverride ?? dependencies.driver;
    const ctx = createQueryContext(
      dependencies.adapter,
      model,
      dependencies.registry,
      driver
    );
    const validated = validate<Record<string, unknown>>(
      dependencies.schemaRegistry,
      model,
      operation,
      args
    );
    // The shared `$transaction([...])` batch-prepare path (§8.6). A tree whose
    // every nested kind and relation class is migrated routes through the
    // interpreter's SHARED PlannedMode — one `PlanState` across the batch's
    // operations (map-oracle §B.2/§B.3) — after the uniform legality gate (§6.3).
    // The interpreter's shared scope returns a `PreparedBatchOperation`. Anything
    // ineligible falls back to the frozen batch planner.
    const mode = selectMode(driver, operation, context);
    assertPlanExecutable(ctx, operation, validated, mode);
    if (isTreeEligible(ctx, operation, validated)) {
      return runInterpreter<PreparedBatchOperation<T>>(
        ctx,
        operation,
        validated,
        mode
      );
    }
    return prepareNestedWriteBatch<T>(
      driver,
      ctx,
      operation,
      validated,
      context
    );
  };
}

export function buildOperation(
  ctx: QueryContext,
  operation: Operation,
  args: Record<string, unknown>
): Sql {
  switch (operation) {
    case "findFirst":
      return buildFindFirst(ctx, args);

    case "findMany":
      return buildFindMany(ctx, args);

    case "findUnique":
      return buildFindUnique(ctx, args as { where: Record<string, unknown> });

    case "create":
      return buildCreate(ctx, args as { data: Record<string, unknown> });

    case "createMany":
      return buildCreateMany(
        ctx,
        args.data as Record<string, unknown>[],
        args.skipDuplicates as boolean | undefined
      );

    case "createManyAndReturn":
      return buildCreateManyAndReturn(
        ctx,
        args as {
          data: Record<string, unknown>[];
          skipDuplicates?: boolean;
          select?: Record<string, unknown>;
        }
      );

    case "update":
      return buildUpdate(
        ctx,
        args as {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }
      );

    case "updateMany":
      return buildUpdateMany(
        ctx,
        args as {
          where?: Record<string, unknown>;
          data: Record<string, unknown>;
        }
      );

    case "updateManyAndReturn":
      return buildUpdateManyAndReturn(
        ctx,
        args as {
          where?: Record<string, unknown>;
          data: Record<string, unknown>;
          select?: Record<string, unknown>;
        }
      );

    case "delete":
      return buildDelete(ctx, args as { where: Record<string, unknown> });

    case "deleteMany":
      return buildDeleteMany(ctx, args as { where?: Record<string, unknown> });

    case "upsert":
      return buildUpsert(
        ctx,
        args as {
          where: Record<string, unknown>;
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }
      );

    case "count":
      return buildCount(ctx, args);

    case "aggregate":
      return buildAggregate(ctx, args);

    case "groupBy":
      return buildGroupBy(ctx, args as { by: string | string[] });

    case "exist": {
      const existArgs: { where?: Record<string, unknown> } = {};
      if (args.where) existArgs.where = args.where as Record<string, unknown>;
      return buildCount(ctx, existArgs);
    }

    default:
      throw new QueryEngineError(`Unknown operation: ${operation}`);
  }
}

function createExecutor<T>(
  dependencies: QueryEngineDependencies,
  model: Model<any>,
  operation: Operation,
  args: Record<string, unknown>,
  options?: PrepareOptions
): (driverOverride?: AnyDriver) => Promise<T> {
  const tracer = dependencies.instrumentation?.tracer;
  const logger = dependencies.instrumentation?.logger;
  const modelName = model["~"].names.ts ?? "unknown";
  const tableName = model["~"].names.sql ?? modelName;
  const displayOperation = options?.originalOperation ?? operation;

  // Every span call is guarded by `tracer`, so skip building the attributes
  // object (and the getBaseAttributes() spread) when tracing is off.
  const spanAttrs = tracer
    ? {
        ...dependencies.driver.getBaseAttributes(),
        [ATTR_DB_COLLECTION]: tableName,
        [ATTR_DB_OPERATION_NAME]: displayOperation,
      }
    : undefined;

  return async (driverOverride?: AnyDriver): Promise<T> => {
    const startTime = Date.now();
    const driver = driverOverride ?? dependencies.driver;

    const executeCore = async (): Promise<T> => {
      try {
        const ctx = createQueryContext(
          dependencies.adapter,
          model,
          dependencies.registry,
          driver
        );

        const validated = tracer
          ? tracer.startActiveSpanSync(
              { name: SPAN_VALIDATE, attributes: spanAttrs },
              () =>
                validate<Record<string, unknown>>(
                  dependencies.schemaRegistry,
                  model,
                  operation,
                  args
                )
            )
          : validate<Record<string, unknown>>(
              dependencies.schemaRegistry,
              model,
              operation,
              args
            );

        const needsWhereFallback = needsUpsertWhereFallback(
          ctx,
          operation,
          validated
        );
        const needsUpsertReturnFallback =
          operation === "upsert" &&
          !dependencies.adapter.capabilities.supportsReturning &&
          !canRefetchNativeUpsert(ctx, validated);

        if (
          hasNestedWrites(operation, validated) ||
          needsWhereFallback ||
          needsUpsertReturnFallback
        ) {
          const result = await executeWithNestedWrites<T>(
            ctx,
            operation,
            validated,
            driver
          );
          return applyPostProcessing<T>(result, operation, options, modelName);
        }

        const sql = tracer
          ? tracer.startActiveSpanSync(
              { name: SPAN_BUILD, attributes: spanAttrs },
              () => buildOperation(ctx, operation, validated)
            )
          : buildOperation(ctx, operation, validated);

        driver.setContext({ model: modelName, operation });

        try {
          let result: { rows: unknown[]; rowCount: number };
          if (needsMutationRefetch(ctx, operation)) {
            result = await executeNonReturningMutation(
              ctx,
              operation,
              validated,
              sql,
              driver,
              modelName
            );
          } else if (needsManyReturnRefetch(ctx, operation)) {
            result = await executeManyReturnWithoutReturning(
              ctx,
              operation,
              validated,
              sql,
              driver,
              modelName
            );
          } else {
            result = await driver._execute(sql);
          }
          await throwIfSingleRecordMutationMiss(
            ctx,
            operation,
            result.rowCount,
            modelName,
            validated,
            driver
          );

          const parseInput = isBatchOperation(operation)
            ? { rowCount: result.rowCount }
            : result.rows;

          const parsed = tracer
            ? tracer.startActiveSpanSync(
                { name: SPAN_PARSE, attributes: spanAttrs },
                () => parseOperationResult<T>(ctx, operation, parseInput)
              )
            : parseOperationResult<T>(ctx, operation, parseInput);

          const paginated = applyPaginationPostProcessing<T>(
            parsed,
            operation,
            validated
          );
          return applyPostProcessing<T>(
            paginated,
            operation,
            options,
            modelName
          );
        } finally {
          driver.clearContext();
        }
      } catch (error) {
        if (error instanceof Error && !("logged" in error)) {
          logger?.error(
            createErrorLogEvent({
              error,
              model: modelName,
              operation,
              duration: Date.now() - startTime,
            })
          );
        }
        throw error;
      }
    };

    if (!isCacheManagedExecution(options) && tracer) {
      return tracer.startActiveSpan(
        { name: SPAN_OPERATION, attributes: spanAttrs },
        executeCore
      );
    }

    return executeCore();
  };
}

function createPrepareFunction(
  dependencies: QueryEngineDependencies,
  model: Model<any>,
  operation: Operation,
  args: Record<string, unknown>
): (driverOverride?: AnyDriver) => PreparedQuery {
  return (driverOverride?: AnyDriver): PreparedQuery => {
    const driver = driverOverride ?? dependencies.driver;

    const ctx = createQueryContext(
      dependencies.adapter,
      model,
      dependencies.registry,
      driver
    );

    const validated = validate<Record<string, unknown>>(
      dependencies.schemaRegistry,
      model,
      operation,
      args
    );

    if (operation === "create" || operation === "update") {
      const processedArgs = processConnectOperations(ctx, operation, validated);
      const sql = buildOperation(ctx, operation, processedArgs);
      return toPreparedQuery(sql, driver);
    }

    const sql = buildOperation(ctx, operation, validated);
    return toPreparedQuery(sql, driver);
  };
}

function processConnectOperations(
  ctx: QueryContext,
  operation: Operation,
  args: Record<string, unknown>
): Record<string, unknown> {
  const data =
    operation === "create" || operation === "update"
      ? (args.data as Record<string, unknown>)
      : undefined;

  if (!data) return args;

  const { scalarData, relations } = separateData(ctx, data);

  if (Object.keys(relations).length === 0) {
    return args;
  }

  assertInlineNestedRelationBuildIsSupported(operation, relations);

  const processedData = { ...scalarData };

  for (const [, mutation] of Object.entries(relations)) {
    if (mutation.connect && mutation.relationInfo.fields?.length) {
      const connectInput = Array.isArray(mutation.connect)
        ? mutation.connect[0]
        : mutation.connect;

      if (connectInput) {
        const fkValues = buildConnectFkValues(
          ctx,
          mutation.relationInfo,
          connectInput
        );
        Object.assign(processedData, fkValues);
      }
    }

    if (mutation.disconnect && mutation.relationInfo.fields?.length) {
      for (const fkField of mutation.relationInfo.fields) {
        processedData[fkField] = null;
      }
    }
  }

  return { ...args, data: processedData };
}

function assertInlineNestedRelationBuildIsSupported(
  operation: Operation,
  relations: Record<string, RelationMutation>
): void {
  for (const mutation of Object.values(relations)) {
    if (canBuildInlineRelationMutation(operation, mutation)) {
      continue;
    }

    throw new QueryEngineError(
      `Cannot build a single SQL statement for nested ${operation} writes. Execute the operation instead.`
    );
  }
}

function canBuildInlineRelationMutation(
  operation: Operation,
  mutation: RelationMutation
): boolean {
  const keys = getRelationMutationOperationKeys(mutation);
  if (keys.length !== 1 || !mutation.relationInfo.fields?.length) {
    return false;
  }

  const [key] = keys;
  return key === "connect" || (operation === "update" && key === "disconnect");
}

function getRelationMutationOperationKeys(
  mutation: RelationMutation
): string[] {
  return [
    "connect",
    "disconnect",
    "create",
    "createMany",
    "connectOrCreate",
    "delete",
    "set",
    "update",
    "updateMany",
    "upsert",
    "deleteMany",
  ].filter((key) => mutation[key as keyof typeof mutation] !== undefined);
}

function assertUpsertNestedMutationsAreExecutable(
  ctx: QueryContext,
  args: Record<string, unknown>
): void {
  const createData = args.create as Record<string, unknown> | undefined;
  if (createData) {
    const { relations } = separateData(ctx, createData);
    assertNoPlannedNestedMutationExecution(relations, "upsertCreate");
  }

  const updateData = args.update as Record<string, unknown> | undefined;
  if (updateData) {
    const { relations } = separateData(ctx, updateData);
    assertNestedUpdatePlanIsExecutable(ctx, relations);
  }
}

function toPreparedQuery(sql: Sql, driver: AnyDriver): PreparedQuery {
  const prepared = driver._prepare(sql);
  return { sql: prepared.sql, params: prepared.params ?? [] };
}
