import type { AnyDriver, QueryExecutionContext, QueryResult } from "@drivers";
import { InvalidTransactionInputError } from "@errors";
import type { ObservationCompletionFactsReader } from "@extensions/observation";
import type {
  QueryInterceptorExecutionControl,
  TransactionWriteOutcomes,
  WriteOutcomeNotifications,
} from "@extensions/query";
import type { PreparedBatchOperation, PreparedQuery } from "./types";

/** One shared owner table registered once by each genuine operation class. */
export interface TransactionOperationOwner<Owner extends object = object> {
  clientId(owner: Owner): symbol;
  scopeId(owner: Owner): symbol;
  model(owner: Owner): string;
  operation(owner: Owner): string;
  context(owner: Owner): QueryExecutionContext;
  requiresInterception(owner: Owner): boolean;
  prepareAdmission(owner: Owner): void;
  stagePackageWriteOutcomes(
    owner: Owner,
    outcomes: TransactionWriteOutcomes
  ): void;
  startInterception(
    owner: Owner,
    child: (notifications?: WriteOutcomeNotifications) => Promise<unknown>,
    outcomes: TransactionWriteOutcomes,
    control: QueryInterceptorExecutionControl
  ): Promise<unknown>;
  executeCore(
    owner: Owner,
    driver: AnyDriver,
    notifications?: WriteOutcomeNotifications
  ): Promise<unknown>;
  isWrite(owner: Owner): boolean;
  hasObservation(owner: Owner): boolean;
  observe(
    owner: Owner,
    child: () => Promise<unknown>,
    readCompletionFacts?: ObservationCompletionFactsReader
  ): Promise<unknown>;
  reserveWith(owner: Owner, driver: AnyDriver): void;
  executeWith(owner: Owner, driver: AnyDriver): Promise<unknown>;
  prepare(owner: Owner, driver?: AnyDriver): PreparedQuery | undefined;
  prepareBatch(
    owner: Owner,
    driver?: AnyDriver
  ): Promise<PreparedBatchOperation<unknown> | undefined>;
  parseResult(owner: Owner, raw: QueryResult<unknown>): unknown;
  observeBatchPhase<Result>(
    owner: Owner,
    driver: AnyDriver,
    execute: () => Result | Promise<Result>
  ): Promise<Result>;
}

/** The private authority resolved only while coordinating an array. */
export type TransactionOperationCapability = object;

interface RegisteredTransactionOperationOwner {
  readonly resolve: TransactionOperationResolver;
}

type TransactionOperationResolver = (
  value: object
) => TransactionOperationOwner<TransactionOperationCapability> | undefined;

const transactionOperationOwners: RegisteredTransactionOperationOwner[] = [];
const transactionOperationOwnersByPrototype = new WeakMap<
  object,
  TransactionOperationOwner<TransactionOperationCapability>
>();

/** Resolve the one class owner after the capability passed admission. */
export function transactionOperationOwner(
  operation: TransactionOperationCapability
): TransactionOperationOwner<TransactionOperationCapability> {
  const prototype = Object.getPrototypeOf(operation);
  const owner = transactionOperationOwnersByPrototype.get(prototype);
  if (owner === undefined) throw new InvalidTransactionInputError();
  return owner;
}

/** Register one class-owned array authority for its exact private brand. */
export function registerTransactionOperationOwner<Owner extends object>(
  prototype: object,
  authenticate: (value: object) => value is Owner,
  owner: TransactionOperationOwner<Owner>
): void {
  const resolvedOwner: TransactionOperationOwner<TransactionOperationCapability> =
    owner;
  const resolve = (
    value: object
  ): TransactionOperationOwner<TransactionOperationCapability> | undefined =>
    authenticate(value) && Object.getPrototypeOf(value) === prototype
      ? resolvedOwner
      : undefined;
  const registration: RegisteredTransactionOperationOwner = Object.freeze({
    resolve,
  });
  transactionOperationOwners.push(registration);
  transactionOperationOwnersByPrototype.set(prototype, resolvedOwner);
}

/** Resolve one owner only for an object constructed by its registered class. */
export function readTransactionOperation(
  value: object
): TransactionOperationOwner<TransactionOperationCapability> | undefined {
  for (const registration of transactionOperationOwners) {
    try {
      const owner = registration.resolve(value);
      if (owner !== undefined) return owner;
    } catch {
      // A hostile candidate cannot interrupt the remaining genuine owners.
    }
  }
  return undefined;
}

/** The static thenable accepted by internal transaction composition. */
export interface TransactionOperation<T> extends PromiseLike<T> {}
