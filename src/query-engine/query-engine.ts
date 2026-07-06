/**
 * Query Engine
 *
 * Public orchestration shell for validated query execution.
 */

import type { DatabaseAdapter } from "@adapters";
import type { PendingOperation } from "@client/pending-operation";
import type { AnyDriver } from "@drivers";
import type { InstrumentationContext } from "@instrumentation";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import type { SchemaRegistryLookup } from "@validation";
import { buildValidatedOperation, createPreparedOperation } from "./executor";
import {
  type ModelRegistry,
  type Operation,
  type PrepareOptions,
  type QueryEngineDependencies,
  QueryEngineError,
} from "./types";

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
  private readonly schemaRegistry: SchemaRegistryLookup;

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
    if (!registry.schemas) {
      throw new QueryEngineError(
        "Schema registry is required for query engine"
      );
    }
    this.schemaRegistry = registry.schemas;
    this.instrumentation = instrumentation;
    this.clientId = Symbol("viborm.client");
  }

  /**
   * Build SQL for an operation without executing.
   * Useful for debugging or using with a different executor.
   */
  build(
    model: Model<any>,
    operation: Operation,
    args: Record<string, unknown>
  ): Sql {
    return buildValidatedOperation(
      this.getDependencies(),
      model,
      operation,
      args
    );
  }

  /**
   * Prepare an operation and return a PendingOperation ready for execution.
   */
  prepare<T>(
    model: Model<any>,
    operation: Operation | `${Operation}OrThrow`,
    args: Record<string, unknown>,
    options?: PrepareOptions
  ): PendingOperation<T> {
    return createPreparedOperation<T>(
      this.getDependencies(),
      model,
      operation,
      args,
      options
    );
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
   * Get the driver instance for direct access.
   */
  getDriver(): AnyDriver | undefined {
    return this.driver;
  }

  private getDependencies(): QueryEngineDependencies {
    return {
      adapter: this.adapter,
      registry: this.registry,
      driver: this.driver,
      schemaRegistry: this.schemaRegistry,
      instrumentation: this.instrumentation,
      clientId: this.clientId,
    };
  }
}

/**
 * Create a simple in-memory model registry.
 * Note: Assumes schema is already hydrated via hydrateSchemaNames().
 */
export function createModelRegistry(
  models: Record<string, Model<any>>,
  schemaRegistry: SchemaRegistryLookup
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
    schemas: schemaRegistry,
  };
}

/**
 * Factory function to create a query engine.
 */
export function createQueryEngine(
  driver: AnyDriver,
  models: Record<string, Model<any>>,
  schemaRegistry: SchemaRegistryLookup,
  instrumentation?: InstrumentationContext
): QueryEngine {
  const registry = createModelRegistry(models, schemaRegistry);
  return new QueryEngine(driver, registry, instrumentation);
}
