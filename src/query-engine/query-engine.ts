/**
 * Query Engine
 *
 * Main orchestrator that builds and executes queries.
 * Validates input, builds SQL, and parses results.
 */

import type { DatabaseAdapter } from "@adapters";
import type { AnyDriver, QueryExecutionContext } from "@drivers";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import {
  ATTR_DB_COLLECTION,
  ATTR_DB_OPERATION_NAME,
  type InstrumentationContext,
  SPAN_BUILD,
  SPAN_EXECUTE,
  SPAN_PARSE,
  SPAN_VALIDATE,
} from "../instrumentation";
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
  type QueryContext,
  QueryEngineError,
} from "./types";
import { withTransactionIfSupported } from "./utils/transaction-helper";
import { validate } from "./validator";

/**
 * Type guard to check if driver supports context methods
 */
function hasContextSupport(driver: AnyDriver): driver is AnyDriver & {
  setContext(ctx: QueryExecutionContext): void;
  clearContext(): void;
} {
  return "setContext" in driver && "clearContext" in driver;
}

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
  private readonly driver: AnyDriver | undefined;
  private readonly instrumentation: InstrumentationContext | undefined;

  constructor(
    adapter: DatabaseAdapter,
    registry: ModelRegistry,
    driver?: AnyDriver,
    instrumentation?: InstrumentationContext
  ) {
    this.adapter = adapter;
    this.registry = registry;
    this.driver = driver;
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
   * Set context on driver if supported
   */
  private setDriverContext(model: string, operation: string): void {
    if (this.driver && hasContextSupport(this.driver)) {
      this.driver.setContext({ model, operation });
    }
  }

  /**
   * Clear context on driver if supported
   */
  private clearDriverContext(): void {
    if (this.driver && hasContextSupport(this.driver)) {
      this.driver.clearContext();
    }
  }

  /**
   * Execute an operation and return parsed results
   */
  async execute<T>(
    model: Model<any>,
    operation: Operation,
    args: Record<string, unknown>
  ): Promise<T> {
    if (!this.driver) {
      throw new QueryEngineError(
        "No driver provided. Use build() to get SQL without executing."
      );
    }

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
    this.setDriverContext(modelName, operation);

    try {
      // Execute query - driver handles logging with context
      const result = tracer
        ? await tracer.startActiveSpan(
            {
              name: SPAN_EXECUTE,
              attributes: spanAttrs,
            },
            () => this.driver!._execute(sqlQuery)
          )
        : await this.driver!._execute(sqlQuery);

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
      this.clearDriverContext();
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
        if (
          "connect" in obj ||
          "create" in obj ||
          "connectOrCreate" in obj ||
          "disconnect" in obj ||
          "delete" in obj ||
          "set" in obj
        ) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Execute a mutation with nested write operations
   */
  private async executeWithNestedWrites<T>(
    ctx: QueryContext,
    operation: Operation,
    args: Record<string, unknown>
  ): Promise<T> {
    const driver = this.driver!;
    const modelName = ctx.model["~"].names.ts ?? "unknown";

    // Set context for the entire nested write operation
    this.setDriverContext(modelName, operation);

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
            return withTransactionIfSupported(driver, async (tx) => {
              // First, update the scalar fields
              if (Object.keys(scalar).length > 0) {
                const updateSql = buildUpdate(ctx, { where, data: scalar });
                await tx._execute(updateSql);
              }

              // Get the updated record for FK operations
              const selectSql = buildFindUniqueQuery(ctx, { where });
              const selectResult =
                await tx._execute<Record<string, unknown>>(selectSql);
              const updatedRecord = selectResult.rows[0];

              if (!updatedRecord) {
                throw new QueryEngineError("Record to update not found");
              }

              // Handle relation mutations (connect, disconnect, create, delete)
              await executeNestedUpdate(tx, ctx, updatedRecord, relations);

              // Re-fetch with includes if needed
              if (args.include || args.select) {
                const refetchSql = buildFindUniqueQuery(ctx, {
                  where,
                  select: args.select as Record<string, unknown> | undefined,
                  include: args.include as Record<string, unknown> | undefined,
                } as { where: Record<string, unknown> });
                const refetchResult =
                  await tx._execute<Record<string, unknown>>(refetchSql);
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
          return withTransactionIfSupported(driver, async (tx) => {
            const where = args.where as Record<string, unknown>;

            // Check if record exists
            const selectSql = buildFindUniqueQuery(ctx, { where });
            const selectResult =
              await tx._execute<Record<string, unknown>>(selectSql);

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
                await tx._execute(updateSql);
              }

              // Get the updated record for nested operations (use PK, not original where)
              const refetchByPkSql = buildFindUniqueQuery(ctx, {
                where: pkWhere,
              });
              const updatedResult =
                await tx._execute<Record<string, unknown>>(refetchByPkSql);
              const updatedRecord = updatedResult.rows[0];

              if (!updatedRecord) {
                throw new QueryEngineError(
                  "Record was deleted by another transaction during upsert"
                );
              }

              // Handle nested relation mutations (connect, disconnect, create, delete)
              if (Object.keys(relations).length > 0) {
                await executeNestedUpdate(tx, ctx, updatedRecord, relations);
              }

              // Re-fetch to get final state (use PK in case update changed where clause fields)
              const refetchSql = buildFindUniqueQuery(ctx, {
                where: pkWhere,
                select: args.select as Record<string, unknown> | undefined,
                include: args.include as Record<string, unknown> | undefined,
              } as { where: Record<string, unknown> });
              const refetchResult =
                await tx._execute<Record<string, unknown>>(refetchSql);
              return parseResult<T>(ctx, "findUnique", refetchResult.rows);
            }
            // Record doesn't exist - do create
            const createData = args.create as Record<string, unknown>;
            const createResult = await executeNestedCreate(tx, ctx, createData);

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
                  await tx._execute<Record<string, unknown>>(refetchSql);
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
      this.clearDriverContext();
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
 */
export function createModelRegistry(
  models: Record<string, Model<any>>
): ModelRegistry {
  hydrateSchemaNames(models);
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
  adapter: DatabaseAdapter,
  models: Record<string, Model<any>>,
  driver?: AnyDriver,
  instrumentation?: InstrumentationContext
): QueryEngine {
  const registry = createModelRegistry(models);
  return new QueryEngine(adapter, registry, driver, instrumentation);
}
