/**
 * Query Engine
 *
 * Main orchestrator that builds and executes queries.
 * Validates input, builds SQL, and parses results.
 */

import type { DatabaseAdapter } from "@adapters";
import { PendingOperation } from "@client/pending-operation";
import type { AnyDriver } from "@drivers";
import { NotFoundError } from "@errors";
import {
  ATTR_DB_COLLECTION,
  ATTR_DB_OPERATION_NAME,
  createErrorLogEvent,
  type InstrumentationContext,
  SPAN_BUILD,
  SPAN_OPERATION,
  SPAN_PARSE,
  SPAN_VALIDATE,
} from "@instrumentation";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import { getPrimaryKeyField } from "./builders/correlation-utils";
import { buildCreateWithNested } from "./builders/nested-create-builder";
import {
  buildConnectFkValues,
  canUseSubqueryOnly,
  needsTransaction,
  separateData,
} from "./builders/relation-data-builder";
import { createQueryContext } from "./context";
import {
  buildAggregate,
  buildCount,
  buildCreate,
  buildCreateMany,
  buildDelete,
  buildDeleteMany,
  buildFindFirst,
  buildFindMany,
  buildFindUnique,
  buildGroupBy,
  buildUpdate,
  buildUpdateMany,
  buildUpsert,
  executeNestedCreate,
  executeNestedUpdate,
} from "./operations";
import { buildFindUnique as buildFindUniqueQuery } from "./operations/find-unique";
import { parseResult } from "./result";
import {
  isBatchOperation,
  type ModelRegistry,
  type Operation,
  type PreparedQuery,
  type PrepareOptions,
  type QueryContext,
  QueryEngineError,
  type QueryMetadata,
} from "./types";

import { validate } from "./validator";

/**
 * Query Engine class
 *
 * Responsible for:
 * 1. Validating input against model schemas
 * 2. Building SQL using the adapter
 * 3. Executing queries via driver
 * 4. Parsing results into typed objects
 */
export class QueryEngine {
  private readonly adapter: DatabaseAdapter;
  private readonly registry: ModelRegistry;
  private readonly driver: AnyDriver;
  private readonly instrumentation: InstrumentationContext | undefined;

  /**
   * Unique identifier for this engine instance.
   * Used to verify that operations belong to the same client in $transaction.
   */
  readonly clientId: symbol;

  constructor(
    driver: AnyDriver,
    registry: ModelRegistry,
    instrumentation?: InstrumentationContext
  ) {
    this.driver = driver;
    this.adapter = driver.adapter;
    this.registry = registry;
    this.instrumentation = instrumentation;
    this.clientId = Symbol("viborm.client");
  }

  /**
   * Build SQL for an operation without executing
   * Useful for debugging or using with a different executor
   */
  build(
    model: Model<any>,
    operation: Operation,
    args: Record<string, unknown>
  ): Sql {
    // Validate input
    const validated = validate<Record<string, unknown>>(model, operation, args);

    // Create context
    const ctx = createQueryContext(
      this.adapter,
      model,
      this.registry,
      this.driver
    );

    // For create operations, check for nested creates and use CTE-based builder
    if (operation === "create" && validated.data) {
      const data = validated.data as Record<string, unknown>;
      const { relations } = separateData(ctx, data);

      // Check for nested creates
      const hasNestedCreates = Object.values(relations).some((m) => m.create);

      if (hasNestedCreates) {
        // Use multi-statement nested create builder
        const result = buildCreateWithNested(
          ctx,
          data,
          validated.select as Record<string, unknown> | undefined,
          validated.include as Record<string, unknown> | undefined
        );
        return result.sql;
      }

      // No nested creates - process connect operations and use standard builder
      const processedArgs = this.processConnectOperations(
        ctx,
        operation,
        validated
      );
      return this.buildOperation(ctx, operation, processedArgs);
    }

    // For update operations, process connect operations to inline FK values
    if (operation === "update") {
      const processedArgs = this.processConnectOperations(
        ctx,
        operation,
        validated
      );
      return this.buildOperation(ctx, operation, processedArgs);
    }

    // Build SQL
    return this.buildOperation(ctx, operation, validated);
  }

  /**
   * Prepare an operation and return a PendingOperation ready for execution.
   *
   * This is the primary entry point for creating database operations.
   * The returned PendingOperation contains metadata and an executor.
   *
   * Validation and SQL building are DEFERRED to execution time.
   * This enables proper span ordering and prepares for future prepared statement support.
   *
   * @param model - The model to operate on
   * @param operation - The base operation (without OrThrow suffix)
   * @param args - Raw operation arguments (will be validated at execution time)
   * @param options - Prepare options (throwIfNotFound, originalOperation)
   */
  prepare<T>(
    model: Model<any>,
    operation: Operation | `${Operation}OrThrow`,
    args: Record<string, unknown>,
    options?: PrepareOptions
  ): PendingOperation<T> {
    const modelName = model["~"].names.ts ?? "unknown";

    // Strip OrThrow suffix if present
    const OR_THROW_SUFFIX = "OrThrow";
    const isOrThrow = operation.endsWith(OR_THROW_SUFFIX);
    const baseOperation = isOrThrow
      ? (operation.slice(0, -OR_THROW_SUFFIX.length) as Operation)
      : (operation as Operation);

    // Merge OrThrow into options
    const prepareOptions: PrepareOptions = {
      ...options,
      throwIfNotFound: isOrThrow || options?.throwIfNotFound,
      originalOperation: options?.originalOperation ?? operation,
    };

    // Create the executor (validation and SQL building happen at execution time)
    const executor = this.createExecutor<T>(
      model,
      baseOperation,
      args,
      prepareOptions
    );

    // Check if this operation has nested writes (can't be batched)
    const hasNestedWrites = this.hasNestedWrites(baseOperation, args);

    // Create prepare function for batch execution (only if no nested writes)
    const prepareFunc = hasNestedWrites
      ? undefined
      : this.createPrepareFunction(model, baseOperation, args);

    // Create parseResult function for batch execution
    const parseResultFunc = this.createParseResultFunction<T>(
      model,
      baseOperation,
      prepareOptions
    );

    // Create metadata for batch execution
    // Note: hasNestedWrites check is done with raw args - it only looks at structure
    const metadata: QueryMetadata<T> = {
      clientId: this.clientId,
      args,
      operation: baseOperation,
      model: modelName,
      execute: executor,
      prepare: prepareFunc,
      parseResult: parseResultFunc,
      isBatchOperation: isBatchOperation(baseOperation),
      hasNestedWrites,
    };

    return new PendingOperation<T>(metadata);
  }

  /**
   * Create an executor function with full instrumentation.
   *
   * The executor performs validation and SQL building at execution time,
   * ensuring all spans occur within SPAN_OPERATION.
   *
   * @param model - The model to operate on
   * @param operation - The operation type
   * @param args - Raw arguments (will be validated)
   * @param options - Prepare options
   */
  private createExecutor<T>(
    model: Model<any>,
    operation: Operation,
    args: Record<string, unknown>,
    options?: PrepareOptions
  ): (driverOverride?: AnyDriver) => Promise<T> {
    const tracer = this.instrumentation?.tracer;
    const logger = this.instrumentation?.logger;
    const modelName = model["~"].names.ts ?? "unknown";
    const tableName = model["~"].names.sql ?? modelName;
    const displayOperation = options?.originalOperation ?? operation;

    const spanAttrs = {
      ...this.driver.getBaseAttributes(),
      [ATTR_DB_COLLECTION]: tableName,
      [ATTR_DB_OPERATION_NAME]: displayOperation,
    };

    return async (driverOverride?: AnyDriver): Promise<T> => {
      const startTime = Date.now();
      const driver = driverOverride ?? this.driver;

      const executeCore = async (): Promise<T> => {
        try {
          // Create context for SQL building and result parsing
          const ctx = createQueryContext(
            this.adapter,
            model,
            this.registry,
            driver
          );

          // Validate at execution time (inside SPAN_OPERATION)
          const validated = tracer
            ? tracer.startActiveSpanSync(
                { name: SPAN_VALIDATE, attributes: spanAttrs },
                () => validate<Record<string, unknown>>(model, operation, args)
              )
            : validate<Record<string, unknown>>(model, operation, args);

          // Check for nested writes OR upsert with WHERE clauses
          // Both require transaction-based execution
          const hasNested = this.hasNestedWrites(operation, validated);
          const needsWhereFallback = this.needsUpsertWhereFallback(
            operation,
            validated
          );

          // Check if upsert has WHERE options that need handling in transaction path
          const hasUpsertWhereOptions =
            operation === "upsert" &&
            ((validated.targetWhere !== undefined &&
              Object.keys(validated.targetWhere as object).length > 0) ||
              (validated.setWhere !== undefined &&
                Object.keys(validated.setWhere as object).length > 0));

          if (hasNested || needsWhereFallback) {
            const result = await this.executeWithNestedWrites<T>(
              ctx,
              operation,
              validated,
              driver,
              needsWhereFallback || hasUpsertWhereOptions // Handle WHERE when provided
            );
            return this.applyPostProcessing<T>(
              result,
              operation,
              options,
              modelName
            );
          }

          // Build SQL at execution time (inside SPAN_OPERATION)
          const sql = tracer
            ? tracer.startActiveSpanSync(
                { name: SPAN_BUILD, attributes: spanAttrs },
                () => this.buildOperation(ctx, operation, validated)
              )
            : this.buildOperation(ctx, operation, validated);

          // Set context on driver for logging
          driver.setContext({ model: modelName, operation });

          try {
            // Execute query
            const result = await driver._execute(sql);

            // Parse result
            const parseInput = isBatchOperation(operation)
              ? { rowCount: result.rowCount }
              : result.rows;

            const parsed = tracer
              ? tracer.startActiveSpanSync(
                  { name: SPAN_PARSE, attributes: spanAttrs },
                  () => parseResult<T>(ctx, operation, parseInput)
                )
              : parseResult<T>(ctx, operation, parseInput);

            return this.applyPostProcessing<T>(
              parsed,
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

      // Wrap with SPAN_OPERATION (unless skipSpan is set)
      if (!options?.skipSpan && tracer) {
        return tracer.startActiveSpan(
          { name: SPAN_OPERATION, attributes: spanAttrs },
          executeCore
        );
      }

      return executeCore();
    };
  }

  /**
   * Apply post-processing: OrThrow check and exist conversion
   */
  private applyPostProcessing<T>(
    result: T,
    operation: Operation,
    options: PrepareOptions | undefined,
    modelName: string
  ): T {
    // Handle OrThrow
    if (options?.throwIfNotFound && result === null) {
      throw new NotFoundError(
        modelName,
        options.originalOperation ?? operation
      );
    }

    // Handle exist operation (convert count to boolean)
    if (operation === "exist") {
      return ((result as number) > 0) as unknown as T;
    }

    return result;
  }

  /**
   * Process connect operations in data to inline FK values
   * This allows build() to generate correct SQL for simple connect cases
   * without needing a transaction.
   */
  private processConnectOperations(
    ctx: QueryContext,
    operation: Operation,
    args: Record<string, unknown>
  ): Record<string, unknown> {
    const data =
      operation === "create" || operation === "update"
        ? (args.data as Record<string, unknown>)
        : undefined;

    if (!data) return args;

    const { scalar, relations } = separateData(ctx, data);

    // Check if any relations need processing
    if (Object.keys(relations).length === 0) {
      return args;
    }

    // Process connect operations where current model holds FK
    const processedData = { ...scalar };

    for (const [, mutation] of Object.entries(relations)) {
      // Handle connect: inline FK value or subquery
      if (mutation.connect && mutation.relationInfo.fields?.length) {
        // For subquery approach, we only handle single connect
        const connectInput = Array.isArray(mutation.connect)
          ? mutation.connect[0]
          : mutation.connect;

        if (connectInput) {
          const fkValues = buildConnectFkValues(
            ctx,
            mutation.relationInfo,
            connectInput
          );
          // Add FK values to processed data
          Object.assign(processedData, fkValues);
        }
      }

      // Handle disconnect: set FK to NULL
      if (mutation.disconnect && mutation.relationInfo.fields?.length) {
        for (const fkField of mutation.relationInfo.fields) {
          processedData[fkField] = null;
        }
      }
    }

    return { ...args, data: processedData };
  }

  /**
   * Execute an operation and return parsed results.
   * This is a convenience method that creates a PendingOperation and executes it.
   */
  async execute<T>(
    model: Model<any>,
    operation: Operation,
    args: Record<string, unknown>
  ): Promise<T> {
    return this.prepare<T>(model, operation, args).execute();
  }

  /**
   * Check if an operation has nested write operations
   */
  private hasNestedWrites(
    operation: Operation,
    args: Record<string, unknown>
  ): boolean {
    // Only create, update, and upsert can have nested writes
    if (!["create", "update", "upsert"].includes(operation)) {
      return false;
    }

    const data =
      operation === "upsert"
        ? (args.create as Record<string, unknown>) ||
          (args.update as Record<string, unknown>)
        : (args.data as Record<string, unknown>);

    if (!data) return false;

    // Check for any relation mutations in the data
    for (const value of Object.values(data)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        // Check for relation mutation keywords
        // Note: "set" is also used for scalar updates like { set: "value" }
        // Relation "set" is always an array: { set: [...] }
        if (
          "connect" in obj ||
          "create" in obj ||
          "connectOrCreate" in obj ||
          "disconnect" in obj ||
          "delete" in obj ||
          ("set" in obj && Array.isArray(obj.set))
        ) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if upsert requires transaction-based fallback for WHERE clauses
   *
   * MySQL's ON DUPLICATE KEY UPDATE doesn't support:
   * - targetWhere: WHERE clause for partial unique index matching
   * - setWhere: WHERE clause for conditional updates
   *
   * When these are used with MySQL, we fall back to:
   * SELECT FOR UPDATE + conditional INSERT/UPDATE in a transaction
   */
  private needsUpsertWhereFallback(
    operation: Operation,
    args: Record<string, unknown>
  ): boolean {
    if (operation !== "upsert") {
      return false;
    }

    // Check if adapter supports upsert WHERE clauses natively
    if (this.adapter.capabilities.supportsUpsertWhere) {
      return false;
    }

    // Check if targetWhere or setWhere are provided
    const hasTargetWhere =
      args.targetWhere !== undefined &&
      Object.keys(args.targetWhere as object).length > 0;
    const hasSetWhere =
      args.setWhere !== undefined &&
      Object.keys(args.setWhere as object).length > 0;

    return hasTargetWhere || hasSetWhere;
  }

  /**
   * Execute a mutation with nested write operations or transaction-based upsert
   *
   * This unified method handles:
   * 1. Nested writes (create/update/upsert with relation mutations)
   * 2. MySQL upsert with setWhere/targetWhere (transaction-based fallback)
   *
   * @param ctx - Query context
   * @param operation - The operation type
   * @param args - Validated arguments
   * @param driver - Driver to use (may be transaction-bound for proper nesting)
   * @param handleSetWhere - Whether to handle setWhere for upsert operations
   */
  private async executeWithNestedWrites<T>(
    ctx: QueryContext,
    operation: Operation,
    args: Record<string, unknown>,
    driver: AnyDriver = this.driver,
    handleSetWhere = false
  ): Promise<T> {
    const modelName = ctx.model["~"].names.ts ?? "unknown";

    // Set context for the entire nested write operation
    driver.setContext({ model: modelName, operation });

    try {
      switch (operation) {
        case "create": {
          const data = args.data as Record<string, unknown>;
          const { scalar, relations } = separateData(ctx, data);

          // Check if we can use subquery-only approach (no transaction needed)
          // Additional check: if any connect has multiple items, force transaction
          // (because we can only set one FK value per INSERT)
          const hasMultipleConnects = Object.values(relations).some(
            (mutation) =>
              mutation.connect &&
              Array.isArray(mutation.connect) &&
              mutation.connect.length > 1
          );

          if (canUseSubqueryOnly(relations) && !hasMultipleConnects) {
            // Add FK values from connect operations as subqueries
            const dataWithFks = { ...scalar };
            for (const [, mutation] of Object.entries(relations)) {
              if (mutation.connect && mutation.relationInfo.fields?.length) {
                // For subquery approach, we only handle single connect
                // (array connects with >1 item are handled by transaction path above)
                const connectInput = Array.isArray(mutation.connect)
                  ? mutation.connect[0]!
                  : mutation.connect;
                const fkValues = buildConnectFkValues(
                  ctx,
                  mutation.relationInfo,
                  connectInput
                );
                // Add FK values to scalar data (they are Sql subqueries)
                Object.assign(dataWithFks, fkValues);
              }
            }

            // Build and execute single INSERT with subqueries
            const sqlQuery = buildCreate(ctx, {
              data: dataWithFks,
              select: args.select as Record<string, unknown>,
              include: args.include as Record<string, unknown>,
            });
            const result = await driver._execute(sqlQuery);
            return parseResult<T>(ctx, operation, result.rows);
          }

          // Need transaction for complex nested writes
          const createResult = await executeNestedCreate(driver, ctx, data);

          // Handle include/select for return value
          if (args.include || args.select) {
            // Re-fetch the created record with includes
            const pkField = getPrimaryKeyField(ctx.model);
            const pkValue = createResult.record[pkField];
            if (pkValue !== undefined) {
              const refetchArgs = {
                where: { [pkField]: pkValue },
                select: args.select,
                include: args.include,
              };
              const refetchSql = buildFindUniqueQuery(
                ctx,
                refetchArgs as { where: Record<string, unknown> }
              );
              const refetchResult = await driver._execute(refetchSql);
              if (refetchResult.rows.length > 0) {
                return parseResult<T>(ctx, "findUnique", refetchResult.rows);
              }
            }
          }

          // Return the created record with nested records merged
          const finalRecord = {
            ...createResult.record,
            ...createResult.related,
          };
          return finalRecord as T;
        }

        case "update": {
          // For update, we first execute the update, then handle nested operations
          const data = args.data as Record<string, unknown>;
          const where = args.where as Record<string, unknown>;
          const { scalar, relations } = separateData(ctx, data);

          // Check if we need a transaction for nested operations
          if (
            Object.keys(relations).length > 0 &&
            needsTransaction(relations)
          ) {
            return driver.withTransaction(async (txDriver) => {
              // First, update the scalar fields
              if (Object.keys(scalar).length > 0) {
                const updateSql = buildUpdate(ctx, { where, data: scalar });
                await txDriver._execute(updateSql);
              }

              // Get the updated record for FK operations
              const selectSql = buildFindUniqueQuery(ctx, { where });
              const selectResult =
                await txDriver._execute<Record<string, unknown>>(selectSql);
              const updatedRecord = selectResult.rows[0];

              if (!updatedRecord) {
                throw new QueryEngineError("Record to update not found");
              }

              // Handle relation mutations (connect, disconnect, create, delete)
              await executeNestedUpdate(
                txDriver,
                ctx,
                updatedRecord,
                relations
              );

              // Re-fetch with includes if needed
              if (args.include || args.select) {
                const refetchSql = buildFindUniqueQuery(ctx, {
                  where,
                  select: args.select as Record<string, unknown> | undefined,
                  include: args.include as Record<string, unknown> | undefined,
                } as { where: Record<string, unknown> });
                const refetchResult =
                  await txDriver._execute<Record<string, unknown>>(refetchSql);
                return parseResult<T>(ctx, "findUnique", refetchResult.rows);
              }

              return updatedRecord as T;
            });
          }

          // Simple update without nested operations
          const updateSql = buildUpdate(
            ctx,
            args as {
              where: Record<string, unknown>;
              data: Record<string, unknown>;
            }
          );
          const result = await driver._execute(updateSql);
          return parseResult<T>(ctx, operation, result.rows);
        }

        case "upsert": {
          // Upsert with nested writes or WHERE clauses - delegate to transaction
          return driver.withTransaction(async (txDriver) => {
            const where = args.where as Record<string, unknown>;
            const targetWhere = handleSetWhere
              ? (args.targetWhere as Record<string, unknown> | undefined)
              : undefined;
            const setWhere = handleSetWhere
              ? (args.setWhere as Record<string, unknown> | undefined)
              : undefined;

            // Step 1: Check if record exists using SELECT FOR UPDATE for row locking
            // This prevents race conditions in concurrent upserts
            const selectSql = buildFindUniqueQuery(ctx, {
              where,
              forUpdate: true,
            });
            const selectResult =
              await txDriver._execute<Record<string, unknown>>(selectSql);

            if (selectResult.rows.length > 0) {
              // Record exists - check targetWhere to determine if this is a "conflict"
              const existingRecord = selectResult.rows[0]!;

              // Get PK for re-fetching (in case update changes where clause fields)
              const pkField = getPrimaryKeyField(ctx.model);
              const pkValue = existingRecord[pkField];
              const pkWhere = { [pkField]: pkValue };

              // Check if targetWhere condition is met (if provided)
              // targetWhere emulates partial unique index behavior:
              // - If targetWhere matches → treat as conflict → UPDATE
              // - If targetWhere doesn't match → row exists but no conflict → return existing
              let isConflict = true;
              if (targetWhere && Object.keys(targetWhere).length > 0) {
                const combinedWhere = { ...pkWhere, ...targetWhere };
                const checkSql = buildFindUniqueQuery(ctx, {
                  where: combinedWhere,
                });
                const checkResult =
                  await txDriver._execute<Record<string, unknown>>(checkSql);
                isConflict = checkResult.rows.length > 0;
              }

              if (!isConflict) {
                // targetWhere didn't match - row exists but isn't a "conflict"
                // Return the existing record without modification
                // (INSERT would fail with unique constraint violation)
                const refetchSql = buildFindUniqueQuery(ctx, {
                  where: pkWhere,
                  select: args.select as Record<string, unknown> | undefined,
                  include: args.include as Record<string, unknown> | undefined,
                } as { where: Record<string, unknown> });
                const refetchResult =
                  await txDriver._execute<Record<string, unknown>>(refetchSql);
                return parseResult<T>(ctx, "findUnique", refetchResult.rows);
              }

              // This is a conflict - do update
              const updateData = args.update as Record<string, unknown>;
              const { scalar, relations } = separateData(ctx, updateData);

              // Check if setWhere condition is met (if provided)
              // setWhere controls whether the UPDATE actually executes
              let shouldUpdate = true;
              if (setWhere && Object.keys(setWhere).length > 0) {
                const combinedWhere = { ...pkWhere, ...setWhere };
                const checkSql = buildFindUniqueQuery(ctx, {
                  where: combinedWhere,
                });
                const checkResult =
                  await txDriver._execute<Record<string, unknown>>(checkSql);
                shouldUpdate = checkResult.rows.length > 0;
              }

              if (shouldUpdate) {
                // Update scalar fields
                if (Object.keys(scalar).length > 0) {
                  const updateSql = buildUpdate(ctx, {
                    where: pkWhere,
                    data: scalar,
                  });
                  await txDriver._execute(updateSql);
                }

                // Get the updated record for nested operations
                const refetchByPkSql = buildFindUniqueQuery(ctx, {
                  where: pkWhere,
                });
                const updatedResult =
                  await txDriver._execute<Record<string, unknown>>(
                    refetchByPkSql
                  );
                const updatedRecord = updatedResult.rows[0];

                if (!updatedRecord) {
                  throw new QueryEngineError(
                    "Record was deleted by another transaction during upsert"
                  );
                }

                // Handle nested relation mutations
                if (Object.keys(relations).length > 0) {
                  await executeNestedUpdate(
                    txDriver,
                    ctx,
                    updatedRecord,
                    relations
                  );
                }
              }

              // Re-fetch to get final state
              const refetchSql = buildFindUniqueQuery(ctx, {
                where: pkWhere,
                select: args.select as Record<string, unknown> | undefined,
                include: args.include as Record<string, unknown> | undefined,
              } as { where: Record<string, unknown> });
              const refetchResult =
                await txDriver._execute<Record<string, unknown>>(refetchSql);
              return parseResult<T>(ctx, "findUnique", refetchResult.rows);
            }

            // Record doesn't exist - do create
            const createData = args.create as Record<string, unknown>;
            const createResult = await executeNestedCreate(
              txDriver,
              ctx,
              createData
            );

            // Handle include/select for return value (same as create operation)
            if (args.include || args.select) {
              const pkField = getPrimaryKeyField(ctx.model);
              const pkValue = createResult.record[pkField];
              if (pkValue !== undefined) {
                const refetchSql = buildFindUniqueQuery(ctx, {
                  where: { [pkField]: pkValue },
                  select: args.select as Record<string, unknown> | undefined,
                  include: args.include as Record<string, unknown> | undefined,
                } as { where: Record<string, unknown> });
                const refetchResult =
                  await txDriver._execute<Record<string, unknown>>(refetchSql);
                if (refetchResult.rows.length > 0) {
                  return parseResult<T>(ctx, "findUnique", refetchResult.rows);
                }
              }
            }

            // Return the created record with nested records merged
            return { ...createResult.record, ...createResult.related } as T;
          });
        }

        default:
          throw new QueryEngineError(
            `Nested writes not supported for operation: ${operation}`
          );
      }
    } finally {
      // Clear context after nested writes complete
      driver.clearContext();
    }
  }

  /**
   * Get the driver instance for direct access
   */
  getDriver(): AnyDriver | undefined {
    return this.driver;
  }

  /**
   * Build SQL for a specific operation
   */
  private buildOperation(
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

      case "delete":
        return buildDelete(ctx, args as { where: Record<string, unknown> });

      case "deleteMany":
        return buildDeleteMany(
          ctx,
          args as { where?: Record<string, unknown> }
        );

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
        // Exist is a simple count > 0 check
        const existArgs: { where?: Record<string, unknown> } = {};
        if (args.where) existArgs.where = args.where as Record<string, unknown>;
        return buildCount(ctx, existArgs);
      }

      default:
        throw new QueryEngineError(`Unknown operation: ${operation}`);
    }
  }

  /**
   * Create a prepare function that validates and builds SQL without executing.
   * Used for batch execution on drivers that support native batching.
   *
   * @param model - The model to operate on
   * @param operation - The operation type
   * @param args - Raw arguments (will be validated)
   */
  private createPrepareFunction(
    model: Model<any>,
    operation: Operation,
    args: Record<string, unknown>
  ): (driverOverride?: AnyDriver) => PreparedQuery {
    return (driverOverride?: AnyDriver): PreparedQuery => {
      const driver = driverOverride ?? this.driver;

      // Create context for SQL building
      const ctx = createQueryContext(
        this.adapter,
        model,
        this.registry,
        driver
      );

      // Validate arguments
      const validated = validate<Record<string, unknown>>(
        model,
        operation,
        args
      );

      // For create/update, process connect operations to inline FK values
      if (operation === "create" || operation === "update") {
        const processedArgs = this.processConnectOperations(
          ctx,
          operation,
          validated
        );
        const sql = this.buildOperation(ctx, operation, processedArgs);
        return {
          sql: sql.toStatement(driver.dialect === "postgresql" ? "$n" : "?"),
          params: sql.values,
        };
      }

      // Build SQL
      const sql = this.buildOperation(ctx, operation, validated);

      return {
        sql: sql.toStatement(driver.dialect === "postgresql" ? "$n" : "?"),
        params: sql.values,
      };
    };
  }

  /**
   * Create a parseResult function for batch execution.
   * Used to transform raw query results into typed results after batch execution.
   *
   * @param model - The model to operate on
   * @param operation - The operation type
   * @param options - Prepare options (for throwIfNotFound)
   */
  private createParseResultFunction<T>(
    model: Model<any>,
    operation: Operation,
    options?: PrepareOptions
  ): (raw: { rows: unknown[]; rowCount: number }) => T {
    const modelName = model["~"].names.ts ?? "unknown";

    return (raw: { rows: unknown[]; rowCount: number }): T => {
      // Create context for result parsing
      const ctx = createQueryContext(
        this.adapter,
        model,
        this.registry,
        this.driver
      );

      // Determine parse input based on operation type
      const parseInput = isBatchOperation(operation)
        ? { rowCount: raw.rowCount }
        : raw.rows;

      // Parse result
      const parsed = parseResult<T>(ctx, operation, parseInput);

      // Apply post-processing (throwIfNotFound, exist conversion)
      return this.applyPostProcessing(parsed, operation, options, modelName);
    };
  }
}

/**
 * Create a simple in-memory model registry
 * Note: Assumes schema is already hydrated via hydrateSchemaNames()
 */
export function createModelRegistry(
  models: Record<string, Model<any>>
): ModelRegistry {
  const byName = new Map<string, Model<any>>();
  const byTableName = new Map<string, Model<any>>();

  for (const [name, model] of Object.entries(models)) {
    byName.set(name, model);
    const tableName = model["~"].names.sql ?? name;
    byTableName.set(tableName, model);
  }

  return {
    get(name: string): Model<any> | undefined {
      return byName.get(name);
    },
    getByTableName(tableName: string): Model<any> | undefined {
      return byTableName.get(tableName);
    },
  };
}

/**
 * Factory function to create a query engine
 */
export function createQueryEngine(
  driver: AnyDriver,
  models: Record<string, Model<any>>,
  instrumentation?: InstrumentationContext
): QueryEngine {
  const registry = createModelRegistry(models);
  return new QueryEngine(driver, registry, instrumentation);
}
