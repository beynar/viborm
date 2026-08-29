import type { AnyDriver } from "@drivers";
import { normalizedBindParameterLimit } from "@drivers/bind-parameter-capacity";
import { resolveConsumableResultCandidate } from "@drivers/consumable-result-candidate";
import type { ResolvedExtensionChain } from "@extensions/chain";
import type { TransactionWriteOutcomes } from "@extensions/query";
import type { InstrumentationContext } from "@instrumentation";
import { getOfficialInstrumentationChainCapability } from "@instrumentation/extension";
import type { Model } from "@schema/model";
import type { ResolvedRelationIndex } from "@schema/validation/relation-resolution";
import { resolveSchemaOrThrow } from "@schema/validation/validator";
import type { Sql } from "@sql";
import type { SchemaRegistryLookup } from "@validation";
import {
  createPendingOperation,
  type PendingOperation,
  type PrepareOperationInput,
  type PrepareWriteOutcomeRegistration,
} from "./pending-operation";
import {
  type ModelRegistry,
  type Operation,
  type PrepareOptions,
  QueryEngineError,
} from "./types";
import { OperationExecutor } from "./write-engine/OperationExecutor";

/** Client-scoped owner of query infrastructure and operation creation. */
export class QueryEngine {
  readonly driver: AnyDriver;
  readonly registry: ModelRegistry;
  readonly instrumentation: InstrumentationContext | undefined;
  readonly extensionChain: ResolvedExtensionChain | undefined;
  readonly transactionWriteOutcomes: TransactionWriteOutcomes | undefined;

  /**
   * Identity of the originating client lineage. Transaction-bound engines
   * preserve this identifier.
   */
  readonly clientId: symbol;
  /** Identity of the current root or transaction-bound execution scope. */
  readonly scopeId: symbol;
  private readonly operationExecutor: OperationExecutor;
  private readonly cacheOperationExecutor: OperationExecutor;

  constructor(
    driver: AnyDriver,
    registry: ModelRegistry,
    clientId = Symbol("viborm.client"),
    scopeId = Symbol("viborm.scope"),
    extensionChain?: ResolvedExtensionChain,
    transactionWriteOutcomes?: TransactionWriteOutcomes
  ) {
    this.driver = driver;
    this.registry = registry;
    if (!registry.schemas) {
      throw new QueryEngineError(
        "Schema registry is required for query engine"
      );
    }
    this.instrumentation =
      getOfficialInstrumentationChainCapability(extensionChain)?.context;
    this.extensionChain = extensionChain;
    this.transactionWriteOutcomes = transactionWriteOutcomes;
    this.clientId = clientId;
    this.scopeId = scopeId;
    const candidate = resolveConsumableResultCandidate(driver);
    this.operationExecutor = new OperationExecutor(this, candidate);
    this.cacheOperationExecutor = candidate
      ? new OperationExecutor(this)
      : this.operationExecutor;
  }

  get adapter() {
    return this.driver.adapter;
  }

  /**
   * The one resolved topology index this client was composed over, exposed so a
   * scope opened from the engine shares it BY IDENTITY (§11.4.10).
   */
  get relations(): ResolvedRelationIndex {
    return this.registry.relations;
  }

  /**
   * The active driver's verified per-statement bind budget, normalized once for
   * semantic builders and final executor enforcement. A missing or invalid
   * declaration is UNKNOWN capacity: builders keep their existing statement
   * shape and let the provider own any native capacity failure.
   */
  get maxBindParametersPerStatement(): number | undefined {
    return normalizedBindParameterLimit(
      this.driver.maxBindParametersPerStatement
    );
  }

  get schemaRegistry(): SchemaRegistryLookup {
    return this.registry.schemas;
  }

  bind(
    driver: AnyDriver,
    extensionChain: ResolvedExtensionChain | undefined = this.extensionChain,
    transactionWriteOutcomes: TransactionWriteOutcomes | undefined = this
      .transactionWriteOutcomes
  ): QueryEngine {
    return new QueryEngine(
      driver,
      this.registry,
      this.clientId,
      Symbol("viborm.scope"),
      extensionChain,
      transactionWriteOutcomes
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
    options?: PrepareOptions,
    prepareInput?: PrepareOperationInput,
    prepareWriteOutcomeRegistration?: PrepareWriteOutcomeRegistration
  ): PendingOperation<T> {
    return createPendingOperation<T>(
      this,
      model,
      operation,
      args,
      options,
      this.operationExecutor,
      prepareInput,
      prepareWriteOutcomeRegistration
    );
  }

  /** Prepare a cache-managed read without granting consumable provider rows. */
  prepareCacheManaged<T>(
    model: Model<any>,
    operation: Operation | `${Operation}OrThrow`,
    args: Record<string, unknown>,
    options: PrepareOptions,
    prepareInput?: PrepareOperationInput
  ): PendingOperation<T> {
    return createPendingOperation<T>(
      this,
      model,
      operation,
      args,
      options,
      this.cacheOperationExecutor,
      prepareInput
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
    return this.prepare<T>(model, operation, args);
  }
}

/**
 * Create a simple in-memory model registry.
 * Note: Assumes schema is already hydrated via hydrateSchemaNames().
 *
 * The DEFAULT `relations` is the standalone-composition case: a registry built
 * on its own resolves once for its own lifecycle (§11.4.10). A CLIENT passes its
 * gate's index positionally instead, so registry, omit rewriting and every query
 * scope share one object by identity.
 */
export function createModelRegistry(
  models: Record<string, Model<any>>,
  schemaRegistry: SchemaRegistryLookup,
  relations: ResolvedRelationIndex = resolveSchemaOrThrow(models)
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
    relations,
  };
}
