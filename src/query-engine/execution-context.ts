import { attachExecutionContext } from "@drivers/driver-error-context";
import { normalizeDriverError } from "@drivers/error-mapping";
import {
  createExecutionContext,
  getExecutionCallsite,
  getExecutionExtensionChain,
} from "@drivers/execution-context";
import type { AnyDriver, QueryExecutionContext } from "@drivers/exports";
import { VibORMError } from "@errors";
import type { ResolvedExtensionChain } from "@extensions/chain";
import type { Operation } from "./types";

export function createOperationExecutionContext(
  model: string,
  operation: Operation | string,
  extensionChain?: ResolvedExtensionChain,
  named?: boolean
): QueryExecutionContext {
  // Capture before asynchronous request/plan/provider work, and allocate no stack by default.
  const origin =
    extensionChain?.disclosure?.includeCallsite === true
      ? new Error("VibORM operation created here").stack
      : undefined;
  return createExecutionContext(
    { model, operation, named },
    createCorrelationId,
    extensionChain,
    origin
  );
}

/** Preserve an ORM failure's deferred origin without wrapping errors returned by user extensions. */
export function withOperationErrorContext<T>(
  context: QueryExecutionContext,
  execute: () => Promise<T>
): Promise<T> {
  const callsite = getExecutionCallsite(context);
  if (callsite === undefined) return execute();
  const diagnostics = getExecutionExtensionChain(context)?.disclosure;
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

/** Observe native-batch preparation and parsing as one logical operation. */
export async function observeTransactionBatchPhase<R>(
  executionContext: QueryExecutionContext,
  driver: AnyDriver,
  execute: () => R | Promise<R>
): Promise<R> {
  const diagnostics = getExecutionExtensionChain(executionContext)?.disclosure;
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
