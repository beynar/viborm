import type { AnyDriver } from "@drivers";
import type { InstrumentationContext } from "@instrumentation";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import type { SchemaRegistryLookup } from "@validation";
import { PendingOperation } from "./pending-operation";
import {
  type ModelRegistry,
  type Operation,
  type PrepareOptions,
  QueryEngineError,
} from "./types";

/** Client-scoped owner of query infrastructure and operation creation. */
export class QueryEngine {
  readonly driver: AnyDriver;
  readonly registry: ModelRegistry;
  readonly instrumentation: InstrumentationContext | undefined;

  /**
   * Identity of the originating client lineage. Transaction-bound engines
   * preserve this identifier.
   */
  readonly clientId: symbol;
  /** Identity of the current root or transaction-bound execution scope. */
  readonly scopeId: symbol;

  /**
   * TRANSITIONAL (W6-U1, removed next release). `"number"` restores the old
   * lossy decimal decode at RUNTIME ONLY — the static types still say `string`,
   * so the hatch is deliberately type-incoherent. It exists to unblock a deploy
   * that cannot migrate its decimal reads in one step, not to be a mode anyone
   * should stay on: a `number` cannot hold what a `numeric` column holds, which
   * is the whole reason this wave happened.
   */
  readonly decimalDecode: "string" | "number";

  constructor(
    driver: AnyDriver,
    registry: ModelRegistry,
    instrumentation?: InstrumentationContext,
    clientId = Symbol("viborm.client"),
    scopeId = Symbol("viborm.scope"),
    decimalDecode: "string" | "number" = "string"
  ) {
    this.decimalDecode = decimalDecode;
    this.driver = driver;
    this.registry = registry;
    if (!registry.schemas) {
      throw new QueryEngineError(
        "Schema registry is required for query engine"
      );
    }
    this.instrumentation = instrumentation;
    this.clientId = clientId;
    this.scopeId = scopeId;
  }

  get adapter() {
    return this.driver.adapter;
  }

  get schemaRegistry(): SchemaRegistryLookup {
    return this.registry.schemas;
  }

  bind(driver: AnyDriver): QueryEngine {
    return new QueryEngine(
      driver,
      this.registry,
      this.instrumentation,
      this.clientId,
      Symbol("viborm.scope"),
      // A transaction-bound engine keeps the client's decode setting; the hatch
      // is a property of the lineage, not of one scope.
      this.decimalDecode
    );
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
    const statement = this.prepare<unknown>(
      model,
      operation,
      args
    ).buildStatement();
    if (statement) {
      return statement;
    }
    throw new QueryEngineError(
      `Operation '${operation}' does not compile to one SQL statement. Execute the operation instead.`
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
    return PendingOperation.create<T>(this, model, operation, args, options);
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
