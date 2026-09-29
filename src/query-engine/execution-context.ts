import { readCacheExecutionOutcomes } from "@cache/driver";
import type { AnyDriver, QueryExecutionContext } from "@drivers";
import { normalizeDriverError } from "@drivers/error-mapping";
import {
  createExecutionContext,
  getExecutionExtensionChain,
} from "@drivers/execution-context";
import type { ResolvedExtensionChain } from "@extensions/chain";
import { getOfficialInstrumentationChainCapability } from "@extensions/observation";
import type { OfficialLifecycleFactsReader } from "@extensions/official-facts";
import { isErrorLogged } from "../errors/logged-errors";
import type { Operation } from "./types";

/** Immutable ownership and attribution captured when an operation is created. */
export interface OperationExecutionContext {
  readonly clientId: symbol;
  readonly scopeId: symbol;
  readonly attribution: QueryExecutionContext;
}

export function createOperationExecutionContext(
  model: string,
  operation: Operation | string,
  extensionChain?: ResolvedExtensionChain
): QueryExecutionContext {
  return createExecutionContext(
    { model, operation },
    createCorrelationId,
    extensionChain
  );
}

export function createPendingOperationContext(
  model: string,
  operation: Operation,
  clientId: symbol,
  scopeId: symbol,
  extensionChain?: ResolvedExtensionChain
): OperationExecutionContext {
  return Object.freeze({
    clientId,
    scopeId,
    attribution: createOperationExecutionContext(
      model,
      operation,
      extensionChain
    ),
  });
}

/** Build the private official-operation facts only for an official chain. */
export function createPendingOperationInstrumentationFacts(
  driver: AnyDriver,
  context: QueryExecutionContext,
  model: string,
  requestedOperation: string,
  operation: string,
  collection: string,
  cacheManaged: boolean
): OfficialLifecycleFactsReader | undefined {
  return createOperationInstrumentationFacts(
    driver,
    context,
    model,
    requestedOperation,
    operation,
    collection,
    cacheManaged
  );
}

/** Build the corresponding private facts for a raw logical operation. */
export function createRawOperationInstrumentationFacts(
  driver: AnyDriver,
  context: QueryExecutionContext,
  operation: string
): OfficialLifecycleFactsReader | undefined {
  return createOperationInstrumentationFacts(
    driver,
    context,
    undefined,
    operation,
    operation,
    undefined,
    false
  );
}

function createOperationInstrumentationFacts(
  driver: AnyDriver,
  context: QueryExecutionContext,
  model: string | undefined,
  requestedOperation: string,
  operation: string,
  collection: string | undefined,
  cacheManaged: boolean
): OfficialLifecycleFactsReader | undefined {
  const official = getOfficialInstrumentationChainCapability(
    getExecutionExtensionChain(context)
  );
  if (official?.observesLifecycle !== true) return undefined;

  return () =>
    Object.freeze({
      kind: "operation" as const,
      context,
      driver,
      model,
      requestedOperation,
      operation,
      collection,
      complete(outcome) {
        const readCacheOutcomes = cacheManaged
          ? readCacheExecutionOutcomes(context)
          : undefined;
        // Core selects the failure: one error, one error log.
        const { failure } = outcome;
        const logged =
          outcome.status === "failure" &&
          official.wants("error-log") &&
          isUnloggedError(failure)
            ? failure
            : undefined;
        if (readCacheOutcomes === undefined && logged === undefined) {
          return undefined;
        }
        return Object.freeze({
          kind: "operation" as const,
          endedAt: Date.now(),
          ...(readCacheOutcomes === undefined ? {} : { readCacheOutcomes }),
          ...(logged === undefined ? {} : { failure: logged }),
        });
      },
    });
}

/** Observe native-batch preparation and parsing as one logical operation. */
export async function observeTransactionBatchPhase<R>(
  executionContext: QueryExecutionContext,
  driver: AnyDriver,
  execute: () => R | Promise<R>
): Promise<R> {
  const diagnostics = getOfficialInstrumentationChainCapability(
    getExecutionExtensionChain(executionContext)
  )?.diagnostics;
  try {
    return await execute();
  } catch (error) {
    throw normalizeDriverError(error, {
      driverName: driver.driverName,
      dialect: driver.dialect,
      model: executionContext.model,
      operation: executionContext.operation,
      correlationId: executionContext.correlationId,
      diagnostics,
      forceContext: true,
    });
  }
}

export function createCorrelationId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Whether the exact failure has not already been presented downstream. */
function isUnloggedError(error: unknown): error is Error {
  return error instanceof Error && !isErrorLogged(error);
}
