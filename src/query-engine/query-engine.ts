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
  type VibORMSpanOptions,
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

  constructor(
    driver: AnyDriver,
    registry: ModelRegistry,
    instrumentation?: InstrumentationContext
  ) {
    this.driver = driver;
    this.adapter = driver.adapter;
    this.registry = registry;
    this.instrumentation = instrumentation;
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
   * Prepare an operation and return query metadata for batch execution.
   * For simple operations: precomputes SQL.
   * For nested writes: returns null SQL (can't be precomputed).
   *
   * This is used by the client to get precomputed SQL for native batch execution
   * on drivers that support it (D1, Neon-HTTP).
   *
   * Note: This only builds query metadata, not an executor. The client creates
   * the executor that routes through executeWithValidatedArgs for proper instrumentation.
   *
   * Note: Validation span is not recorded here because this runs before the
   * viborm.operation span starts. The span will be recorded in executeCore().
   */
  prepareMetadata(
    model: Model<any>,
    operation: Operation,
    args: Record<string, unknown>
  ): QueryMetadata<unknown> {
    // Validate input eagerly (fail fast) - only place validation happens
    const validated = validate<Record<string, unknown>>(model, operation, args);

    // Create context
    const ctx = createQueryContext(
      this.adapter,
      model,
      this.registry,
      this.driver
    );

    // Check if this has nested writes - can't precompute
    if (this.hasNestedWrites(operation, validated)) {
      return {
        sql: null,
        validatedArgs: validated,
        parseResult: (rows) => rows,
        isBatchOperation: isBatchOperation(operation),
      };
    }

    // Build SQL eagerly
    const sql = this.buildOperation(ctx, operation, validated);

    return {
      sql,
      validatedArgs: validated,
      parseResult: (rows) => parseResult(ctx, operation, rows),
      isBatchOperation: isBatchOperation(operation),
    };
  }

  /**
   * Prepare an operation and return a PendingOperation ready for execution.
   *
   * This is the primary entry point for creating database operations.
   * The returned PendingOperation contains a full executor with instrumentation.
   *
   * Handles: validation, SQL building, execution, parsing, all instrumentation spans,
   * OrThrow semantics, and exist operation conversion.
   *
   * @param model - The model to operate on
   * @param operation - The base operation (without OrThrow suffix)
   * @param args - Raw operation arguments (will be validated)
   * @param options - Prepare options (throwIfNotFound, originalOperation)
   */
  prepare<T>(
    model: Model<any>,
    operation: Operation | `${Operation}OrThrow`,
    args: Record<string, unknown>,
    options?: PrepareOptions
  ): PendingOperation<T> {
    const modelName = model["~"].names.ts ?? "unknown";
    const tableName = model["~"].names.sql ?? modelName;

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

    // Validate input eagerly (fail fast) - capture timing for span
    const tracer = this.instrumentation?.tracer;
    const validation = tracer
      ? tracer.capture(() =>
          validate<Record<string, unknown>>(model, baseOperation, args)
        )
      : {
          result: validate<Record<string, unknown>>(model, baseOperation, args),
          record: undefined,
        };
    const validated = validation.result;

    // Create context for SQL building and result parsing
    const ctx = createQueryContext(
      this.adapter,
      model,
      this.registry,
      this.driver
    );

    // Check if this has nested writes (can't precompute SQL)
    const hasNested = this.hasNestedWrites(baseOperation, validated);

    // Build SQL if possible (non-nested operations) - capture timing for span
    let sql: ReturnType<typeof this.buildOperation> | null = null;
    let recordBuild: ((options: VibORMSpanOptions) => void) | undefined;
    if (!hasNested) {
      const build = tracer
        ? tracer.capture(() =>
            this.buildOperation(ctx, baseOperation, validated)
          )
        : {
            result: this.buildOperation(ctx, baseOperation, validated),
            record: undefined,
          };
      sql = build.result;
      recordBuild = build.record;
    }

    // Create metadata for batch execution
    // Wrap parseResult with applyPostProcessing for OrThrow and exist conversion
    const metadata: QueryMetadata<T> = {
      sql,
      validatedArgs: validated,
      parseResult: (rows) => {
        const result = parseResult(ctx, baseOperation, rows) as T;
        return this.applyPostProcessing(
          result,
          baseOperation,
          prepareOptions,
          modelName
        );
      },
      isBatchOperation: isBatchOperation(baseOperation),
      model: modelName,
      operation: baseOperation,
    };

    // Create the executor with full instrumentation
    const executor = this.createExecutor<T>(
      ctx,
      model,
      baseOperation,
      validated,
      sql,
      prepareOptions,
      validation.record,
      recordBuild
    );

    return new PendingOperation(executor, metadata);
  }

  /**
   * Create an executor function with full instrumentation.
   * The executor handles: SPAN_OPERATION wrapping, all sub-spans,
   * OrThrow semantics, exist conversion, and error logging.
   *
   * The returned executor accepts an optional driver override for transaction-bound
   * execution. When provided, nested writes will use that driver (and its transaction
   * context) instead of the base driver.
   */
  private createExecutor<T>(
    ctx: QueryContext,
    model: Model<any>,
    operation: Operation,
    validatedArgs: Record<string, unknown>,
    precomputedSql: Sql | null,
    options?: PrepareOptions,
    recordValidation?: (options: VibORMSpanOptions) => void,
    recordBuild?: (options: VibORMSpanOptions) => void
  ): (driverOverride?: AnyDriver) => Promise<T> {
    const tracer = this.instrumentation?.tracer;
    const logger = this.instrumentation?.logger;
    const modelName = model["~"].names.ts ?? "unknown";
    const tableName = model["~"].names.sql ?? modelName;
    const displayOperation = options?.originalOperation ?? operation;
    const startTime = Date.now();

    const spanAttrs = {
      ...this.driver.getBaseAttributes(),
      [ATTR_DB_COLLECTION]: tableName,
      [ATTR_DB_OPERATION_NAME]: displayOperation,
    };

    return async (driverOverride?: AnyDriver): Promise<T> => {
      // Use override driver if provided (for transaction-bound execution)
      const driver = driverOverride ?? this.driver;

      // Core execution logic wrapped in SPAN_OPERATION
      const executeCore = async (): Promise<T> => {
        try {
          // Record validation span with actual timing from prepare()
          recordValidation?.({ name: SPAN_VALIDATE, attributes: spanAttrs });

          // Handle nested writes separately
          if (precomputedSql === null) {
            const result = await this.executeWithNestedWrites<T>(
              ctx,
              operation,
              validatedArgs,
              driver
            );
            return this.applyPostProcessing<T>(
              result,
              operation,
              options,
              modelName
            );
          }

          // Record build span with actual timing from prepare()
          recordBuild?.({ name: SPAN_BUILD, attributes: spanAttrs });

          // Set context on driver for logging
          driver.setContext({ model: modelName, operation });

          try {
            // Execute query
            const result = await driver._execute(precomputedSql);

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
          // Error logging
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

      // Wrap with SPAN_OPERATION (unless skipSpan is set, e.g., cache driver provides its own)
      if (tracer && !options?.skipSpan) {
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
   * Execute an operation and return parsed results
   * Note: Validates args - if you have pre-validated args, use executeWithValidatedArgs instead
   */
  async execute<T>(
    model: Model<any>,
    operation: Operation,
    args: Record<string, unknown>
  ): Promise<T> {
    const tracer = this.instrumentation?.tracer;
    const modelName = model["~"].names.ts ?? "unknown";
    const tableName = model["~"].names.sql ?? modelName;
    const spanAttrs = {
      ...this.driver.getBaseAttributes(),
      [ATTR_DB_COLLECTION]: tableName,
      [ATTR_DB_OPERATION_NAME]: operation,
    };

    // Validate input (synchronous - use sync span method)
    const validated = tracer
      ? tracer.startActiveSpanSync(
          { name: SPAN_VALIDATE, attributes: spanAttrs },
          () => validate<Record<string, unknown>>(model, operation, args)
        )
      : validate<Record<string, unknown>>(model, operation, args);

    return this.executeCore<T>(model, operation, validated);
  }

  /**
   * Execute an operation with pre-validated args (skips validation)
   * Use this when args have already been validated by prepareMetadata()
   *
   * @param recordValidateSpan - If true, records a validation span for tracing
   *   (even though validation already happened at prepare time)
   */
  async executeWithValidatedArgs<T>(
    model: Model<any>,
    operation: Operation,
    validatedArgs: Record<string, unknown>,
    recordValidateSpan = true
  ): Promise<T> {
    return this.executeCore<T>(
      model,
      operation,
      validatedArgs,
      recordValidateSpan
    );
  }

  /**
   * Core execution logic (assumes args are already validated)
   *
   * @param recordValidateSpan - If true, records a validation span for tracing
   */
  private async executeCore<T>(
    model: Model<any>,
    operation: Operation,
    validated: Record<string, unknown>,
    recordValidateSpan = false
  ): Promise<T> {
    const tracer = this.instrumentation?.tracer;
    const modelName = model["~"].names.ts ?? "unknown";
    const tableName = model["~"].names.sql ?? modelName;
    const spanAttrs = {
      ...this.driver.getBaseAttributes(),
      [ATTR_DB_COLLECTION]: tableName,
      [ATTR_DB_OPERATION_NAME]: operation,
    };

    // Record validation span if requested (validation already happened at prepare time)
    if (recordValidateSpan && tracer) {
      tracer.startActiveSpanSync(
        { name: SPAN_VALIDATE, attributes: spanAttrs },
        () => {} // No-op - validation already done
      );
    }

    // Create context once and reuse for both building and parsing
    const ctx = createQueryContext(
      this.adapter,
      model,
      this.registry,
      this.driver
    );

    // Check if this is a mutation with nested writes
    if (this.hasNestedWrites(operation, validated)) {
      return this.executeWithNestedWrites<T>(ctx, operation, validated);
    }

    // Build SQL (synchronous - use sync span method)
    const sqlQuery = tracer
      ? tracer.startActiveSpanSync(
          { name: SPAN_BUILD, attributes: spanAttrs },
          () => this.buildOperation(ctx, operation, validated)
        )
      : this.buildOperation(ctx, operation, validated);

    // Set context on driver for logging
    this.driver.setContext({ model: modelName, operation });

    try {
      // Execute query - driver handles logging with context
      const result = await this.driver._execute(sqlQuery);

      // Parse result (synchronous - use sync span method)
      if (isBatchOperation(operation)) {
        return tracer
          ? tracer.startActiveSpanSync(
              { name: SPAN_PARSE, attributes: spanAttrs },
              () =>
                parseResult<T>(ctx, operation, { rowCount: result.rowCount })
            )
          : parseResult<T>(ctx, operation, { rowCount: result.rowCount });
      }

      return tracer
        ? tracer.startActiveSpanSync(
            { name: SPAN_PARSE, attributes: spanAttrs },
            () => parseResult<T>(ctx, operation, result.rows)
          )
        : parseResult<T>(ctx, operation, result.rows);
    } finally {
      // Clear context after execution
      this.driver.clearContext();
    }
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
   * Execute a mutation with nested write operations
   *
   * @param ctx - Query context
   * @param operation - The operation type
   * @param args - Validated arguments
   * @param driver - Driver to use (may be transaction-bound for proper nesting)
   */
  private async executeWithNestedWrites<T>(
    ctx: QueryContext,
    operation: Operation,
    args: Record<string, unknown>,
    driver: AnyDriver = this.driver
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
          // Upsert with nested writes - delegate to transaction
          return driver.withTransaction(async (txDriver) => {
            const where = args.where as Record<string, unknown>;

            // Check if record exists
            const selectSql = buildFindUniqueQuery(ctx, { where });
            const selectResult =
              await txDriver._execute<Record<string, unknown>>(selectSql);

            if (selectResult.rows.length > 0) {
              // Record exists - do update with nested operations
              const existingRecord = selectResult.rows[0]!;
              const updateData = args.update as Record<string, unknown>;
              const { scalar, relations } = separateData(ctx, updateData);

              // Get PK for re-fetching (in case update changes where clause fields)
              const pkField = getPrimaryKeyField(ctx.model);
              const pkValue = existingRecord[pkField];
              const pkWhere = { [pkField]: pkValue };

              // Update scalar fields
              if (Object.keys(scalar).length > 0) {
                const updateSql = buildUpdate(ctx, { where, data: scalar });
                await txDriver._execute(updateSql);
              }

              // Get the updated record for nested operations (use PK, not original where)
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

              // Handle nested relation mutations (connect, disconnect, create, delete)
              if (Object.keys(relations).length > 0) {
                await executeNestedUpdate(
                  txDriver,
                  ctx,
                  updatedRecord,
                  relations
                );
              }

              // Re-fetch to get final state (use PK in case update changed where clause fields)
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
