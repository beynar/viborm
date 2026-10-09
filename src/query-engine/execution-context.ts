import { officialCacheRuntime } from "@cache/capability";
import { attachExecutionContext } from "@drivers/driver-error-context";
import { readDriverIdentity } from "@drivers/driver-identity";
import { normalizeDriverError } from "@drivers/error-mapping";
import {
  createExecutionContext,
  getExecutionCallsite,
  getExecutionExtensionChain,
} from "@drivers/execution-context";
import type { AnyDriver, QueryExecutionContext } from "@drivers/exports";
import { VibORMError } from "@errors";
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
  const disclosure =
    getOfficialInstrumentationChainCapability(extensionChain)?.diagnostics;
  // Capture before asynchronous request/plan/provider work, and allocate no stack by default.
  const origin =
    disclosure?.includeCallsite === true
      ? new Error("VibORM operation created here").stack
      : undefined;
  return createExecutionContext(
    { model, operation },
    createCorrelationId,
    extensionChain,
    origin
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

/** Preserve an ORM failure's deferred origin without wrapping errors returned by user extensions. */
export function withOperationErrorContext<T>(
  context: QueryExecutionContext,
  execute: () => Promise<T>
): Promise<T> {
  const callsite = getExecutionCallsite(context);
  if (callsite === undefined) return execute();
  const diagnostics = getOfficialInstrumentationChainCapability(
    getExecutionExtensionChain(context)
  )?.diagnostics;
  const annotate = (error: unknown): never => {
    throw error instanceof VibORMError
      ? attachExecutionContext(error, {
          forceContext: false,
          driverName:
            typeof error.meta.driver === "string"
              ? error.meta.driver
              : "unknown",
          model: context.model,
          operation: context.operation,
          correlationId: context.correlationId,
          callsite,
          diagnostics,
        })
      : error;
  };
  try {
    return execute().catch(annotate);
  } catch (error) {
    return Promise.reject().catch(() => annotate(error));
  }
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
      identity: readDriverIdentity(driver),
      model,
      requestedOperation,
      operation,
      collection,
      complete(outcome) {
        const readCacheOutcomes = cacheManaged
          ? officialCacheRuntime().readCacheExecutionOutcomes(context)
          : undefined;
        // Core selects the failure: one error, one error log.
        const { failure } = outcome;
        const logged =
          outcome.status === "failure" &&
          official.wants("error-log") &&
          isUnloggedError(failure)
            ? failure
            : undefined;
        const failureForTrace =
          outcome.status === "failure" &&
          failure instanceof Error &&
          official.wants("operation")
            ? failure
            : undefined;
        if (
          readCacheOutcomes === undefined &&
          logged === undefined &&
          failureForTrace === undefined
        ) {
          return undefined;
        }
        return Object.freeze({
          kind: "operation" as const,
          endedAt: Date.now(),
          ...(readCacheOutcomes === undefined ? {} : { readCacheOutcomes }),
          ...((logged ?? failureForTrace) === undefined
            ? {}
            : { failure: logged ?? failureForTrace }),
          ...(logged === undefined ? { skipLog: true as const } : {}),
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
      callsite: getExecutionCallsite(executionContext),
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
