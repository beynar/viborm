import type {
  AnyDriver,
  QueryExecutionContext,
  QueryResult,
} from "@drivers/exports";
import { InvalidTransactionInputError } from "@errors";
import type {
  AroundHandlers,
  PreparedQueryContext,
  WriteOutcomeNotifications,
  WriteOutcomeRegistration,
} from "@extensions/query";
import type { UnitSource } from "@extensions/unit-source";
import type { PreparedBatchOperation, PreparedQuery } from "./types";

/** What may intercept one array member (see `interception`). */
export interface MemberInterception {
  readonly context: PreparedQueryContext | undefined;
  readonly handlers: AroundHandlers | undefined;
  readonly write: boolean;
  readonly registration?: WriteOutcomeRegistration | undefined;
}

/** One shared owner table registered once by each genuine operation class. */
export interface TransactionOperationOwner<Owner extends object = object> {
  clientId(owner: Owner): symbol;
  scopeId(owner: Owner): symbol;
  model(owner: Owner): string;
  operation(owner: Owner): string;
  context(owner: Owner): QueryExecutionContext;
  prepareAdmission(owner: Owner, phase?: "input" | "plan"): void;
  /**
   * What may intercept the member in an array, read once it is prepared:
   * the handlers around it and the context they see, whether it writes, and
   * its package's write-outcome listener.
   */
  interception(owner: Owner): MemberInterception;
  executeCore(
    owner: Owner,
    driver: AnyDriver,
    notifications?: WriteOutcomeNotifications
  ): Promise<unknown>;
  /** The member's `operation` unit, where its chain observes units. */
  unit(owner: Owner): UnitSource;
  reserveWith(owner: Owner, driver: AnyDriver): void;
  executeWith(owner: Owner, driver: AnyDriver): Promise<unknown>;
  /** The member's value as its caller receives it (its computed fields). */
  finishResult?(owner: Owner, value: unknown): unknown;
  prepare(owner: Owner, driver?: AnyDriver): PreparedQuery | undefined;
  prepareBatch(
    owner: Owner
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
