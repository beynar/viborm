import { createOfficialCacheExecutionLogReader } from "@cache/cache-instrumentation";
import type { AnyDriver, QueryExecutionContext } from "@drivers";
import { normalizeDriverError } from "@drivers/error-mapping";
import {
  createExecutionContext,
  getExecutionExtensionChain,
  getExecutionInstrumentation,
} from "@drivers/execution-context";
import { sanitizeErrorForLogging } from "@errors";
import type { ResolvedExtensionChain } from "@extensions/chain";
import {
  ATTR_DB_COLLECTION,
  ATTR_DB_OPERATION_NAME,
  ATTR_VIBORM_CORRELATION_ID,
  createErrorLogEvent,
  SPAN_OPERATION,
} from "@instrumentation";
import type { InstrumentationContext } from "@instrumentation/context";
import { getOfficialInstrumentationChainCapability } from "@instrumentation/extension";
import type { InstrumentationLifecycleFactsReader } from "@instrumentation/lifecycle-facts";
import { isErrorLogged } from "@instrumentation/logged-errors";
import type { VibORMSpanOptions } from "@instrumentation/tracer";
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
  instrumentation?: InstrumentationContext,
  extensionChain?: ResolvedExtensionChain
): QueryExecutionContext {
  return createExecutionContext(
    { model, operation },
    instrumentation,
    createCorrelationId,
    extensionChain
  );
}

export function createPendingOperationContext(
  model: string,
  operation: Operation,
  instrumentation: InstrumentationContext | undefined,
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
      instrumentation,
      extensionChain
    ),
  });
}

/** Build the private official-operation facts only for an official chain. */
export function createPendingOperationInstrumentationFacts(
  driver: AnyDriver,
  context: QueryExecutionContext,
  model: string,
  spanOperation: string,
  logOperation: string,
  collection: string,
  skipSpan: boolean
): InstrumentationLifecycleFactsReader | undefined {
  return createOperationInstrumentationFacts(
    driver,
    context,
    model,
    spanOperation,
    logOperation,
    collection,
    skipSpan
  );
}

/** Build the corresponding private facts for a raw logical operation. */
export function createRawOperationInstrumentationFacts(
  driver: AnyDriver,
  context: QueryExecutionContext,
  operation: string
): InstrumentationLifecycleFactsReader | undefined {
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
  spanOperation: string,
  logOperation: string,
  collection: string | undefined,
  skipSpan: boolean
): InstrumentationLifecycleFactsReader | undefined {
  const official = getOfficialInstrumentationChainCapability(
    getExecutionExtensionChain(context)
  );
  if (official?.observesLifecycle !== true) return undefined;

  return () => {
    const correlationId = context.correlationId;
    const spanOptions: VibORMSpanOptions | undefined =
      official.context.config.tracing !== undefined
        ? {
            name: SPAN_OPERATION,
            attributes: {
              ...driver.getBaseAttributes(),
              ...(collection === undefined
                ? {}
                : { [ATTR_DB_COLLECTION]: collection }),
              [ATTR_DB_OPERATION_NAME]: spanOperation,
              ...(correlationId === undefined
                ? {}
                : { [ATTR_VIBORM_CORRELATION_ID]: correlationId }),
            },
          }
        : undefined;
    return Object.freeze({
      kind: "operation" as const,
      ...(spanOptions === undefined ? {} : { spanOptions }),
      complete(outcome) {
        const readCacheLogEvents = skipSpan
          ? createOfficialCacheExecutionLogReader(context)
          : undefined;
        const errorLogEvent =
          outcome.status === "failure" &&
          official.context.logger !== undefined &&
          isUnloggedError(outcome.failure)
            ? createErrorLogEvent({
                error: sanitizeErrorForLogging(outcome.failure),
                model,
                operation: logOperation,
                correlationId,
                duration: outcome.durationMs,
              })
            : undefined;
        if (readCacheLogEvents === undefined && errorLogEvent === undefined) {
          return undefined;
        }
        return Object.freeze({
          ...(readCacheLogEvents === undefined ? {} : { readCacheLogEvents }),
          ...(errorLogEvent === undefined ? {} : { errorLogEvent }),
        });
      },
    });
  };
}

/** Observe native-batch preparation and parsing as one logical operation. */
export async function observeTransactionBatchPhase<R>(
  executionContext: QueryExecutionContext,
  driver: AnyDriver,
  execute: () => R | Promise<R>
): Promise<R> {
  const instrumentation = getExecutionInstrumentation(executionContext);
  try {
    return await execute();
  } catch (error) {
    throw normalizeTransactionBatchPhaseError(
      error,
      executionContext,
      instrumentation,
      driver
    );
  }
}

function normalizeTransactionBatchPhaseError(
  error: unknown,
  executionContext: QueryExecutionContext,
  instrumentation: InstrumentationContext | undefined,
  driver: AnyDriver
) {
  return normalizeDriverError(error, {
    driverName: driver.driverName,
    model: executionContext.model,
    operation: executionContext.operation,
    correlationId: executionContext.correlationId,
    diagnostics: instrumentation?.config.diagnostics,
    forceContext: true,
  });
}

export function createCorrelationId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Whether the exact failure has not already been presented downstream. */
function isUnloggedError(error: unknown): error is Error {
  try {
    return error instanceof Error && !isErrorLogged(error);
  } catch {
    return false;
  }
}
