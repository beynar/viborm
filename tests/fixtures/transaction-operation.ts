import type { AnyDriver, QueryResult } from "@drivers";
import {
  readTransactionOperation,
  registerTransactionOperationOwner,
  type TransactionOperationCapability,
  type TransactionOperationOwner,
} from "@query-engine/transaction-operation";
import type {
  PreparedBatchOperation,
  PreparedQuery,
} from "@query-engine/types";

export interface TransactionOperationOverrides {
  parseResult?(raw: QueryResult<unknown>): unknown;
  prepare?(driver?: AnyDriver): PreparedQuery | undefined;
  prepareBatch?(
    driver?: AnyDriver
  ): Promise<PreparedBatchOperation<unknown> | undefined>;
}

/** Test-only method view over the production operation's opaque authority. */
export class TestTransactionOperationView {
  readonly #capability: TransactionOperationCapability;
  readonly #owner: TransactionOperationOwner<TransactionOperationCapability>;

  constructor(
    capability: TransactionOperationCapability,
    owner: TransactionOperationOwner<TransactionOperationCapability>
  ) {
    this.#capability = capability;
    this.#owner = owner;
  }

  get clientId(): symbol {
    return this.#owner.clientId(this.#capability);
  }

  get scopeId(): symbol {
    return this.#owner.scopeId(this.#capability);
  }

  get model(): string {
    return this.#owner.model(this.#capability);
  }

  get operation(): string {
    return this.#owner.operation(this.#capability);
  }

  get context() {
    return this.#owner.context(this.#capability);
  }

  requiresInterception(): boolean {
    return this.#owner.requiresInterception(this.#capability);
  }

  hasObservation(): boolean {
    return this.#owner.hasObservation(this.#capability);
  }

  executeWith(driver: AnyDriver): Promise<unknown> {
    return this.#owner.executeWith(this.#capability, driver);
  }

  prepare(driver?: AnyDriver): PreparedQuery | undefined {
    return this.#owner.prepare(this.#capability, driver);
  }

  prepareBatch(
    driver?: AnyDriver
  ): Promise<PreparedBatchOperation<unknown> | undefined> {
    return this.#owner.prepareBatch(this.#capability, driver);
  }

  parseResult(raw: QueryResult<unknown>): unknown {
    return this.#owner.parseResult(this.#capability, raw);
  }
}

export function readTestTransactionOperation(
  operation: unknown
): TestTransactionOperationView | undefined {
  if (operation === null || typeof operation !== "object") return undefined;
  const owner = readTransactionOperation(operation);
  return owner === undefined
    ? undefined
    : new TestTransactionOperationView(operation, owner);
}

let testTransactionOperationOwner: TransactionOperationOwner<
  TestTransactionOperation<unknown>
>;

/** Test-only operation shell for falsifying array planning boundaries. */
export class TestTransactionOperation<T> implements PromiseLike<T> {
  readonly #source: PromiseLike<T>;
  readonly #capability: TransactionOperationCapability;
  readonly #owner: TransactionOperationOwner<TransactionOperationCapability>;
  readonly #overrides: TransactionOperationOverrides;

  static {
    testTransactionOperationOwner = Object.freeze({
      clientId: (operation) => operation.#owner.clientId(operation.#capability),
      scopeId: (operation) => operation.#owner.scopeId(operation.#capability),
      model: (operation) => operation.#owner.model(operation.#capability),
      operation: (operation) =>
        operation.#owner.operation(operation.#capability),
      context: (operation) => operation.#owner.context(operation.#capability),
      requiresInterception: (operation) =>
        operation.#owner.requiresInterception(operation.#capability),
      prepareAdmission: (operation) =>
        operation.#owner.prepareAdmission(operation.#capability),
      stagePackageWriteOutcomes: (operation, outcomes) =>
        operation.#owner.stagePackageWriteOutcomes(
          operation.#capability,
          outcomes
        ),
      startInterception: (operation, child, outcomes, control) =>
        operation.#owner.startInterception(
          operation.#capability,
          child,
          outcomes,
          control
        ),
      executeCore: (operation, driver, notifications) =>
        operation.#owner.executeCore(
          operation.#capability,
          driver,
          notifications
        ),
      isWrite: (operation) => operation.#owner.isWrite(operation.#capability),
      hasObservation: (operation) =>
        operation.#owner.hasObservation(operation.#capability),
      observe: (operation, child, readCompletionFacts) =>
        operation.#owner.observe(
          operation.#capability,
          child,
          readCompletionFacts
        ),
      reserveWith: (operation, driver) =>
        operation.#owner.reserveWith(operation.#capability, driver),
      executeWith: (operation, driver) =>
        operation.#owner.executeWith(operation.#capability, driver),
      prepare: (operation, driver) =>
        operation.#overrides.prepare === undefined
          ? operation.#owner.prepare(operation.#capability, driver)
          : operation.#overrides.prepare(driver),
      prepareBatch: (operation, driver) =>
        operation.#overrides.prepareBatch === undefined
          ? operation.#owner.prepareBatch(operation.#capability, driver)
          : operation.#overrides.prepareBatch(driver),
      parseResult: (operation, raw) =>
        operation.#overrides.parseResult === undefined
          ? operation.#owner.parseResult(operation.#capability, raw)
          : operation.#overrides.parseResult(raw),
      observeBatchPhase: (operation, driver, execute) =>
        operation.#owner.observeBatchPhase(
          operation.#capability,
          driver,
          execute
        ),
    } satisfies TransactionOperationOwner<TestTransactionOperation<unknown>>);
    registerTransactionOperationOwner(
      TestTransactionOperation.prototype,
      (value): value is TestTransactionOperation<unknown> =>
        #capability in value,
      testTransactionOperationOwner
    );
  }

  constructor(
    source: PromiseLike<T>,
    capability: TransactionOperationCapability,
    owner: TransactionOperationOwner<TransactionOperationCapability>,
    overrides: TransactionOperationOverrides
  ) {
    this.#source = source;
    this.#capability = capability;
    this.#owner = owner;
    this.#overrides = overrides;
    Object.freeze(this);
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.#source.then(onfulfilled, onrejected);
  }
}

export function overrideTransactionOperation<T>(
  operation: PromiseLike<T>,
  overrides: TransactionOperationOverrides
): TestTransactionOperation<T> {
  const owner = readTransactionOperation(operation);
  if (owner === undefined) {
    throw new Error("Expected a transaction operation");
  }
  return new TestTransactionOperation(operation, operation, owner, overrides);
}
