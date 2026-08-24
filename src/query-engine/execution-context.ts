import type { AnyDriver, QueryExecutionContext } from "@drivers";
import { normalizeDriverError } from "@drivers/error-mapping";
import {
  createExecutionContext,
  getExecutionInstrumentation,
} from "@drivers/execution-context";
import { sanitizeErrorForLogging } from "@errors";
import {
  ATTR_DB_COLLECTION,
  ATTR_DB_OPERATION_NAME,
  ATTR_VIBORM_CORRELATION_ID,
  createErrorLogEvent,
  SPAN_OPERATION,
} from "@instrumentation";
import type { InstrumentationContext } from "@instrumentation/context";
import { isErrorLogged } from "@instrumentation/logged-errors";
import type { VibORMSpanOptions } from "@instrumentation/tracer";
import { isCacheManagedExecution } from "./cache-flow";
import type { PendingOperation } from "./pending-operation";
import type { TransactionOperation } from "./transaction-operation";
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
  instrumentation?: InstrumentationContext
): QueryExecutionContext {
  return createExecutionContext(
    { model, operation, correlationId: createCorrelationId() },
    instrumentation
  );
}

export function createPendingOperationContext(
  model: string,
  operation: Operation,
  instrumentation: InstrumentationContext | undefined,
  clientId: symbol,
  scopeId: symbol
): OperationExecutionContext {
  return Object.freeze({
    clientId,
    scopeId,
    attribution: createOperationExecutionContext(
      model,
      operation,
      instrumentation
    ),
  });
}

type OperationSpanAttributes = VibORMSpanOptions["attributes"];

/** Observe one operation without changing its execution or failure semantics. */
export function observeOperationExecution<T>(
  pending: PendingOperation<T>,
  execute: (spanAttributes: OperationSpanAttributes) => Promise<T>
): Promise<T> {
  const { engine, model, operation, options } = pending;
  const executionContext = pending.context.attribution;
  const tracer = engine.instrumentation?.tracer;
  const logger = engine.instrumentation?.logger;
  const displayOperation = options.originalOperation ?? operation;
  const spanAttributes = tracer
    ? {
        ...engine.driver.getBaseAttributes(),
        [ATTR_DB_COLLECTION]: model["~"].names.sql ?? pending.modelName,
        [ATTR_DB_OPERATION_NAME]: displayOperation,
        [ATTR_VIBORM_CORRELATION_ID]: executionContext.correlationId,
      }
    : undefined;
  const startedAt = Date.now();
  const executeObserved = async (): Promise<T> => {
    try {
      return await execute(spanAttributes);
    } catch (error) {
      if (isUnloggedError(error)) {
        logger?.error(
          createErrorLogEvent({
            error: sanitizeErrorForLogging(error),
            model: pending.modelName,
            operation,
            correlationId: executionContext.correlationId,
            duration: Date.now() - startedAt,
          })
        );
      }
      throw error;
    }
  };

  if (!isCacheManagedExecution(options) && tracer) {
    return tracer.startActiveSpan(
      { name: SPAN_OPERATION, attributes: spanAttributes },
      executeObserved
    );
  }
  return executeObserved();
}

/** Observe native-batch preparation and parsing as one logical operation. */
export async function observeTransactionBatchPhase<T, R>(
  operation: TransactionOperation<T>,
  driver: AnyDriver,
  execute: () => R | Promise<R>
): Promise<R> {
  const executionContext = operation.getExecutionContext();
  const instrumentation = getExecutionInstrumentation(executionContext);
  const hasTracing = instrumentation?.config.tracing !== undefined;
  const hasLogging = instrumentation?.config.logging !== undefined;
  if (!(hasTracing || hasLogging)) {
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

  const startedAt = Date.now();
  const run = async (): Promise<R> => {
    try {
      return await execute();
    } catch (error) {
      const attributed = normalizeTransactionBatchPhaseError(
        error,
        executionContext,
        instrumentation,
        driver
      );
      if (hasLogging) {
        instrumentation?.logger?.error(
          createErrorLogEvent({
            error: attributed,
            model: executionContext.model,
            operation: executionContext.operation,
            correlationId: executionContext.correlationId,
            duration: Date.now() - startedAt,
          })
        );
      }
      throw attributed;
    }
  };

  if (instrumentation?.config.tracing === undefined) return run();
  return instrumentation.tracer.startActiveSpan(
    {
      name: SPAN_OPERATION,
      attributes: {
        ...driver.getBaseAttributes(),
        [ATTR_DB_COLLECTION]: operation.getModel(),
        [ATTR_DB_OPERATION_NAME]: operation.getOperation(),
        [ATTR_VIBORM_CORRELATION_ID]: executionContext.correlationId,
      },
    },
    run
  );
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

/**
 * Whether the driver layer has NOT already reported this failure. The record
 * is kept beside the error rather than on it — see `@instrumentation/logged-errors`.
 */
function isUnloggedError(error: unknown): error is Error {
  try {
    return error instanceof Error && !isErrorLogged(error);
  } catch {
    return false;
  }
}
