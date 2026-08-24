import type { InstrumentationContext } from "@instrumentation/context";
import type { QueryExecutionContext } from "./types";

interface TrustedExecutionContext {
  readonly correlationId?: string;
  readonly correlationIdGetter?: () => string;
  readonly instrumentation?: InstrumentationContext;
  readonly model?: string;
  readonly operation?: string;
}

const trustedExecutionContexts = new WeakMap<object, TrustedExecutionContext>();

export function createExecutionContext(
  values: QueryExecutionContext,
  instrumentation?: InstrumentationContext,
  correlationIdFactory?: () => string
): QueryExecutionContext {
  if (!correlationIdFactory) {
    return snapshotExecutionContext(
      values,
      undefined,
      undefined,
      instrumentation
    );
  }

  let correlationId: string | undefined;
  const correlationIdGetter = () => {
    correlationId ??= correlationIdFactory();
    return correlationId;
  };
  return createTrustedExecutionContext({
    correlationIdGetter,
    instrumentation,
    model: readString(values, "model"),
    operation: readString(values, "operation"),
  });
}

export function snapshotExecutionContext(
  context: QueryExecutionContext | undefined,
  boundContext?: QueryExecutionContext,
  fallbackOperation?: string,
  instrumentationOverride?: InstrumentationContext
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

  if (
    context &&
    trustedContext &&
    representsExecutionContext(
      trustedContext,
      model,
      operation,
      correlationId,
      correlationIdGetter,
      instrumentation
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
      instrumentation
    )
  ) {
    return boundContext;
  }

  return createTrustedExecutionContext({
    correlationId,
    correlationIdGetter,
    instrumentation,
    model,
    operation,
  });
}

export function getExecutionInstrumentation(
  context: QueryExecutionContext | undefined
): InstrumentationContext | undefined {
  if (!context) return undefined;
  return trustedExecutionContexts.get(context)?.instrumentation;
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
  instrumentation: InstrumentationContext | undefined
): boolean {
  return (
    values.model === model &&
    values.operation === operation &&
    values.correlationId === correlationId &&
    values.correlationIdGetter === correlationIdGetter &&
    values.instrumentation === instrumentation
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
