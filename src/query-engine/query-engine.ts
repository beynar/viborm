import type { AnyDriver } from "@drivers/exports";
import type { ResolvedExtensionChain } from "@extensions/chain";
import type { TransactionWriteOutcomes } from "@extensions/query";
import type { Model } from "@schema/model";
import {
  createPendingOperation,
  type PendingOperation,
  type PrepareOperationInput,
  type PrepareWriteOutcomeRegistration,
} from "./pending-operation";
import type { ClientOperationRoute } from "./raptor3/route/client-route";
import type { Operation, PrepareOptions } from "./types";

/** Client-scoped owner of query infrastructure and operation creation. */
export class QueryEngine {
  readonly driver: AnyDriver;
  readonly extensionChain: ResolvedExtensionChain | undefined;
  readonly transactionWriteOutcomes: TransactionWriteOutcomes | undefined;

  /**
   * Identity of the originating client lineage. Transaction-bound engines
   * preserve this identifier.
   */
  readonly clientId: symbol;
  /** Identity of the current root or transaction-bound execution scope. */
  readonly scopeId: symbol;
  /**
   * The ONE operation owner of this engine (C-01). A client builds it in
   * `VibORM`'s constructor over the one resolved topology index and schema
   * registry, and `bind()` forwards it, so every engine of a lineage shares it
   * by identity and no engine has two.
   */
  readonly route: ClientOperationRoute;

  constructor(
    driver: AnyDriver,
    route: ClientOperationRoute,
    clientId = Symbol("viborm.client"),
    scopeId = Symbol("viborm.scope"),
    extensionChain?: ResolvedExtensionChain,
    transactionWriteOutcomes?: TransactionWriteOutcomes
  ) {
    this.driver = driver;
    this.route = route;
    this.extensionChain = extensionChain;
    this.transactionWriteOutcomes = transactionWriteOutcomes;
    this.clientId = clientId;
    this.scopeId = scopeId;
  }

  bind(
    driver: AnyDriver,
    extensionChain: ResolvedExtensionChain | undefined = this.extensionChain,
    transactionWriteOutcomes: TransactionWriteOutcomes | undefined = this
      .transactionWriteOutcomes
  ): QueryEngine {
    return new QueryEngine(
      driver,
      this.route,
      this.clientId,
      Symbol("viborm.scope"),
      extensionChain,
      transactionWriteOutcomes
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
      prepareInput,
      prepareWriteOutcomeRegistration
    );
  }
}
