import type { InstrumentationContext } from "@instrumentation/context";
import type { QueryExecutionContext } from "./types";

const executionInstrumentation = new WeakMap<object, InstrumentationContext>();

export function createExecutionContext(
  values: QueryExecutionContext,
  instrumentation?: InstrumentationContext
): QueryExecutionContext {
  return snapshotExecutionContext(
    values,
    undefined,
    undefined,
    instrumentation
  );
}

export function snapshotExecutionContext(
  context: QueryExecutionContext | undefined,
  boundContext?: QueryExecutionContext,
  fallbackOperation?: string,
  instrumentationOverride?: InstrumentationContext
): QueryExecutionContext {
  const model =
    readString(context, "model") ?? readString(boundContext, "model");
  const operation =
    readString(context, "operation") ??
    readString(boundContext, "operation") ??
    fallbackOperation;
  const correlationId =
    readString(context, "correlationId") ??
    readString(boundContext, "correlationId");
  const snapshot: QueryExecutionContext = {
    ...(model ? { model } : {}),
    operation,
    ...(correlationId ? { correlationId } : {}),
  };
  const instrumentation =
    getExecutionInstrumentation(context) ??
    getExecutionInstrumentation(boundContext) ??
    instrumentationOverride;
  if (instrumentation) {
    executionInstrumentation.set(snapshot, instrumentation);
  }
  return Object.freeze(snapshot);
}

export function getExecutionInstrumentation(
  context: QueryExecutionContext | undefined
): InstrumentationContext | undefined {
  if (!context) return undefined;
  return executionInstrumentation.get(context);
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
