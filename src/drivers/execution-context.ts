import type { ResolvedExtensionChain } from "@extensions/chain";
import type { InstrumentationContext } from "@instrumentation/context";
import type { QueryExecutionContext } from "./types";

interface TrustedExecutionContext {
  readonly correlationId?: string;
  readonly correlationIdGetter?: () => string;
  readonly extensionChain?: ResolvedExtensionChain;
  readonly instrumentation?: InstrumentationContext;
  readonly model?: string;
  readonly operation?: string;
  readonly transactionPhases?: TransactionPhaseNotifications;
}

/** Private exact transaction lifecycle facts attached only to trusted contexts. */
export interface TransactionPhaseNotifications {
  readonly readyToCommit: () => void;
  readonly committed: () => void;
}

const trustedExecutionContexts = new WeakMap<object, TrustedExecutionContext>();

export function createExecutionContext(
  values: QueryExecutionContext,
  instrumentation?: InstrumentationContext,
  correlationIdFactory?: () => string,
  extensionChain?: ResolvedExtensionChain
): QueryExecutionContext {
  if (!correlationIdFactory) {
    return snapshotExecutionContext(
      values,
      undefined,
      undefined,
      instrumentation,
      extensionChain
    );
  }

  let correlationId: string | undefined;
  const correlationIdGetter = () => {
    correlationId ??= correlationIdFactory();
    return correlationId;
  };
  return createTrustedExecutionContext({
    correlationIdGetter,
    extensionChain,
    instrumentation,
    model: readString(values, "model"),
    operation: readString(values, "operation"),
  });
}

export function snapshotExecutionContext(
  context: QueryExecutionContext | undefined,
  boundContext?: QueryExecutionContext,
  fallbackOperation?: string,
  instrumentationOverride?: InstrumentationContext,
  extensionChainOverride?: ResolvedExtensionChain
): QueryExecutionContext {
  const trustedContext = context
    ? trustedExecutionContexts.get(context)
    : undefined;
  const contextValues =
    trustedContext ?? snapshotExternalExecutionContext(context);
  const trustedBoundContext = boundContext
    ? trustedExecutionContexts.get(boundContext)
    : undefined;
  const boundValues =
    context === boundContext
      ? contextValues
      : (trustedBoundContext ?? snapshotExternalExecutionContext(boundContext));
  const model = contextValues.model ?? boundValues.model;
  const operation =
    contextValues.operation ?? boundValues.operation ?? fallbackOperation;
  const correlationIdGetter =
    contextValues.correlationIdGetter ??
    (contextValues.correlationId === undefined
      ? boundValues.correlationIdGetter
      : undefined);
  const correlationId = correlationIdGetter
    ? undefined
    : (contextValues.correlationId ?? boundValues.correlationId);
  const instrumentation =
    contextValues.instrumentation ??
    boundValues.instrumentation ??
    instrumentationOverride;
  const extensionChain =
    contextValues.extensionChain ??
    boundValues.extensionChain ??
    extensionChainOverride;
  const transactionPhases =
    contextValues.transactionPhases ?? boundValues.transactionPhases;

  if (
    context &&
    trustedContext &&
    representsExecutionContext(
      trustedContext,
      model,
      operation,
      correlationId,
      correlationIdGetter,
      instrumentation,
      extensionChain,
      transactionPhases
    )
  ) {
    return context;
  }
  if (
    boundContext &&
    trustedBoundContext &&
    representsExecutionContext(
      trustedBoundContext,
      model,
      operation,
      correlationId,
      correlationIdGetter,
      instrumentation,
      extensionChain,
      transactionPhases
    )
  ) {
    return boundContext;
  }

  return createTrustedExecutionContext({
    correlationId,
    correlationIdGetter,
    extensionChain,
    instrumentation,
    model,
    operation,
    transactionPhases,
  });
}

/**
 * Re-attribute a trusted context to the model one statement addresses, keeping
 * the correlation id, instrumentation and extension provenance of the operation
 * it belongs to. Only the snapshot owner can do this without losing the private
 * values, which is why the query engine asks for it rather than rebuilding one.
 */
export function deriveStatementExecutionContext(
  context: QueryExecutionContext,
  model: string
): QueryExecutionContext {
  const values =
    trustedExecutionContexts.get(context) ??
    snapshotExternalExecutionContext(context);
  return createTrustedExecutionContext({ ...values, model });
}

export function getExecutionInstrumentation(
  context: QueryExecutionContext | undefined
): InstrumentationContext | undefined {
  if (!context) return undefined;
  return trustedExecutionContexts.get(context)?.instrumentation;
}

/** Read only the chain attached by the trusted context owner. */
export function getExecutionExtensionChain(
  context: QueryExecutionContext | undefined
): ResolvedExtensionChain | undefined {
  if (!context) return undefined;
  return trustedExecutionContexts.get(context)?.extensionChain;
}

/** Attach private lifecycle notifications without accepting caller-spoofed state. */
export function bindExecutionTransactionPhases(
  context: QueryExecutionContext,
  transactionPhases: TransactionPhaseNotifications
): QueryExecutionContext {
  const values =
    trustedExecutionContexts.get(context) ??
    snapshotExternalExecutionContext(context);
  return createTrustedExecutionContext({ ...values, transactionPhases });
}

/** Add one private lifecycle reader without replacing an existing consumer. */
export function appendExecutionTransactionPhases(
  context: QueryExecutionContext,
  appendedPhases: TransactionPhaseNotifications
): QueryExecutionContext {
  const values =
    trustedExecutionContexts.get(context) ??
    snapshotExternalExecutionContext(context);
  const existingPhases = values.transactionPhases;
  if (existingPhases === undefined) {
    return createTrustedExecutionContext({
      ...values,
      transactionPhases: appendedPhases,
    });
  }
  return createTrustedExecutionContext({
    ...values,
    transactionPhases: {
      readyToCommit: () => {
        appendedPhases.readyToCommit();
        existingPhases.readyToCommit();
      },
      committed: () => {
        appendedPhases.committed();
        existingPhases.committed();
      },
    },
  });
}

/** Read lifecycle notifications only from a context created by this owner. */
export function getExecutionTransactionPhases(
  context: QueryExecutionContext | undefined
): TransactionPhaseNotifications | undefined {
  if (!context) return undefined;
  return trustedExecutionContexts.get(context)?.transactionPhases;
}

function createTrustedExecutionContext(
  values: TrustedExecutionContext
): QueryExecutionContext {
  const snapshot: QueryExecutionContext = {
    ...(values.model ? { model: values.model } : {}),
    operation: values.operation,
    ...(values.correlationId ? { correlationId: values.correlationId } : {}),
  };
  if (values.correlationIdGetter) {
    Object.defineProperty(snapshot, "correlationId", {
      configurable: false,
      enumerable: true,
      get: values.correlationIdGetter,
    });
  }
  Object.freeze(snapshot);
  trustedExecutionContexts.set(snapshot, values);
  return snapshot;
}

function snapshotExternalExecutionContext(
  value: QueryExecutionContext | undefined
): TrustedExecutionContext {
  return {
    correlationId: readString(value, "correlationId"),
    model: readString(value, "model"),
    operation: readString(value, "operation"),
  };
}

function representsExecutionContext(
  values: TrustedExecutionContext,
  model: string | undefined,
  operation: string | undefined,
  correlationId: string | undefined,
  correlationIdGetter: (() => string) | undefined,
  instrumentation: InstrumentationContext | undefined,
  extensionChain: ResolvedExtensionChain | undefined,
  transactionPhases: TransactionPhaseNotifications | undefined
): boolean {
  return (
    values.model === model &&
    values.operation === operation &&
    values.correlationId === correlationId &&
    values.correlationIdGetter === correlationIdGetter &&
    values.instrumentation === instrumentation &&
    values.extensionChain === extensionChain &&
    values.transactionPhases === transactionPhases
  );
}

function readString(
  value: QueryExecutionContext | undefined,
  key: keyof QueryExecutionContext
): string | undefined {
  const member = readProperty(value, key);
  return typeof member === "string" ? member : undefined;
}

function readProperty(value: unknown, key: PropertyKey): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || !value) {
    return undefined;
  }
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}
