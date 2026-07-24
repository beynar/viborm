import type { InstrumentationContext } from "@instrumentation/context";
import { getNoopTracer, type TracerWrapper } from "@instrumentation/tracer";
import type { InstrumentationConfig } from "@instrumentation/types";
import type { QueryExecutionContext } from "./types";

const EXECUTION_INSTRUMENTATION = Symbol("viborm.executionInstrumentation");

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
    Object.defineProperty(snapshot, EXECUTION_INSTRUMENTATION, {
      configurable: false,
      enumerable: false,
      value: snapshotInstrumentation(instrumentation),
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

export function getExecutionInstrumentation(
  context: QueryExecutionContext | undefined
): InstrumentationContext | undefined {
  if (!context) return undefined;
  try {
    const value = Reflect.get(context, EXECUTION_INSTRUMENTATION);
    return isInstrumentationContext(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function snapshotInstrumentation(
  instrumentation: InstrumentationContext
): InstrumentationContext {
  const config = readRecord(instrumentation, "config");
  const tracer = readTracer(instrumentation) ?? getNoopTracer();
  const logger = readProperty(instrumentation, "logger");
  const snapshotConfig: InstrumentationConfig = Object.freeze({
    diagnostics: snapshotDisclosure(readProperty(config, "diagnostics")),
    logging: snapshotDisclosure(readProperty(config, "logging")),
    tracing: snapshotDisclosure(readProperty(config, "tracing")),
  });
  return Object.freeze({
    config: snapshotConfig,
    tracer,
    ...(isLogger(logger) ? { logger } : {}),
  });
}

function snapshotDisclosure(value: unknown): {
  includeParams: boolean;
  includeSql: boolean;
} {
  return Object.freeze({
    includeParams: readProperty(value, "includeParams") === true,
    includeSql: readProperty(value, "includeSql") === true,
  });
}

function readString(
  value: QueryExecutionContext | undefined,
  key: keyof QueryExecutionContext
): string | undefined {
  const member = readProperty(value, key);
  return typeof member === "string" ? member : undefined;
}

function readRecord(value: unknown, key: string): Record<string, unknown> {
  const member = readProperty(value, key);
  return isRecord(member) ? member : Object.create(null);
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

function readTracer(value: unknown): TracerWrapper | undefined {
  const tracer = readProperty(value, "tracer");
  return isTracerWrapper(tracer) ? tracer : undefined;
}

function isTracerWrapper(value: unknown): value is TracerWrapper {
  return (
    isRecord(value) &&
    typeof readProperty(value, "startActiveSpan") === "function" &&
    typeof readProperty(value, "startActiveSpanSync") === "function" &&
    typeof readProperty(value, "isEnabled") === "function"
  );
}

function isLogger(value: unknown): value is InstrumentationContext["logger"] {
  if (!isRecord(value)) return false;
  return (
    typeof readProperty(value, "log") === "function" &&
    typeof readProperty(value, "query") === "function" &&
    typeof readProperty(value, "cache") === "function" &&
    typeof readProperty(value, "warn") === "function" &&
    typeof readProperty(value, "error") === "function" &&
    typeof readProperty(value, "isLevelEnabled") === "function"
  );
}

function isInstrumentationContext(
  value: unknown
): value is InstrumentationContext {
  return isRecord(value) && readTracer(value) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
