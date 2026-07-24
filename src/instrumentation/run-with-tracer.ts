import { sanitizeDiagnosticParameters } from "@errors";
import {
  isTrustedTracerWrapper,
  type Span,
  type TracerWrapper,
  type VibORMSpanOptions,
} from "./tracer";

/** Run application work exactly once and treat its promise as authoritative. */
export async function runWithTracer<T>(
  tracer: TracerWrapper,
  options: VibORMSpanOptions,
  operation: (span?: Span) => Promise<T>
): Promise<T> {
  let execution: Promise<T> | undefined;
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const executeOnce = (span?: Span): Promise<T> => {
    if (execution) return execution;

    let resolveExecution: ((value: T | PromiseLike<T>) => void) | undefined;
    let rejectExecution: ((reason?: unknown) => void) | undefined;
    execution = new Promise<T>((resolve, reject) => {
      resolveExecution = resolve;
      rejectExecution = reject;
    });
    signalStarted?.();
    signalStarted = undefined;

    try {
      Promise.resolve(operation(span)).then(resolveExecution, rejectExecution);
    } catch (error) {
      rejectExecution?.(error);
    }
    return execution;
  };
  const observeExecution = (span?: Span): Promise<void> => {
    const observation = executeOnce(span).then(
      () => undefined,
      () => {
        throw createTraceObserverError();
      }
    );
    observation.catch(() => undefined);
    return observation;
  };

  const safeOptions = snapshotSpanOptions(options);
  const isTrustedTracer = isTrustedTracerWrapper(tracer);
  let tracingSettled: Promise<void> | undefined;
  if (safeOptions) {
    try {
      const tracing = isTrustedTracer
        ? tracer.startActiveSpan(safeOptions, executeOnce)
        : tracer.startActiveSpan(safeOptions, observeExecution);
      tracingSettled = Promise.resolve(tracing).then(
        () => undefined,
        () => undefined
      );
    } catch {
      // The unconditional fallback below starts the application operation.
    }
  }

  if (isTrustedTracer && tracingSettled) {
    if (!execution) await Promise.race([started, tracingSettled]);
    const authoritativeExecution = execution ?? executeOnce();
    await tracingSettled;
    return authoritativeExecution;
  }

  const fallbackStarted = Promise.resolve().then(() => {
    executeOnce();
  });
  if (!execution) {
    await Promise.race([
      started,
      tracingSettled ?? Promise.resolve(),
      fallbackStarted,
    ]);
  }
  return execution ?? executeOnce();
}

export function runWithTracerSync<T>(
  tracer: TracerWrapper,
  options: VibORMSpanOptions,
  operation: (span?: Span) => T
): T {
  let outcome:
    | { kind: "pending" }
    | { kind: "running" }
    | { kind: "success"; value: T }
    | { kind: "failure"; error: unknown } = { kind: "pending" };
  const executeOnce = (span?: Span): T => {
    if (outcome.kind === "running") throw createTraceObserverError();
    if (outcome.kind === "failure") throw outcome.error;
    if (outcome.kind === "success") return outcome.value;

    outcome = { kind: "running" };
    try {
      const value = operation(span);
      outcome = { kind: "success", value };
      return value;
    } catch (error) {
      outcome = { kind: "failure", error };
      throw error;
    }
  };
  const observeExecution = (span?: Span): void => {
    try {
      executeOnce(span);
    } catch {
      throw createTraceObserverError();
    }
  };

  const safeOptions = snapshotSpanOptions(options);
  if (safeOptions) {
    try {
      tracer.startActiveSpanSync(
        safeOptions,
        isTrustedTracerWrapper(tracer) ? executeOnce : observeExecution
      );
    } catch {
      // The operation outcome below remains authoritative.
    }
  }
  return executeOnce();
}

function snapshotSpanOptions(
  options: VibORMSpanOptions
): VibORMSpanOptions | undefined {
  try {
    const attributes = snapshotAttributes(options.attributes);

    let sql: VibORMSpanOptions["sql"];
    if (options.sql) {
      sql = {};
      if (options.sql.query !== undefined) sql.query = options.sql.query;
      if (options.sql.params) {
        const params = sanitizeDiagnosticParameters(options.sql.params, {
          includeParams: true,
          includeSql: true,
        });
        sql.params = Array.isArray(params) ? params : [];
        Object.freeze(sql.params);
      }
      Object.freeze(sql);
    }

    const snapshot: VibORMSpanOptions = { name: options.name };
    if (options.kind !== undefined) snapshot.kind = options.kind;
    if (attributes) snapshot.attributes = attributes;
    if (sql) snapshot.sql = sql;
    if (options.root !== undefined) snapshot.root = options.root;
    Object.freeze(snapshot);
    return snapshot;
  } catch {
    return undefined;
  }
}

function snapshotAttributes(
  source: VibORMSpanOptions["attributes"]
): VibORMSpanOptions["attributes"] {
  if (!source) return undefined;
  const snapshot: NonNullable<VibORMSpanOptions["attributes"]> = {};
  for (const key of Object.keys(source)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
    if (!(descriptor && "value" in descriptor)) continue;
    const value = snapshotAttributeValue(descriptor.value);
    if (value !== undefined) snapshot[key] = value;
  }
  Object.freeze(snapshot);
  return snapshot;
}

function snapshotAttributeValue(
  value: unknown
): string | number | boolean | string[] | number[] | boolean[] | undefined {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (!Array.isArray(value)) return undefined;
  const length = Math.min(value.length, 128);
  const elementType = length > 0 ? typeof value[0] : "string";
  if (
    !(
      elementType === "string" ||
      elementType === "number" ||
      elementType === "boolean"
    )
  ) {
    return undefined;
  }
  const snapshot: Array<string | number | boolean> = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (!(descriptor && "value" in descriptor)) return undefined;
    if (typeof descriptor.value !== elementType) return undefined;
    snapshot.push(descriptor.value);
  }
  if (elementType === "string") return freezeArray(snapshot.filter(isString));
  if (elementType === "number") return freezeArray(snapshot.filter(isNumber));
  return freezeArray(snapshot.filter(isBoolean));
}

function freezeArray<T>(value: T[]): T[] {
  Object.freeze(value);
  return value;
}

function isString(value: string | number | boolean): value is string {
  return typeof value === "string";
}

function isNumber(value: string | number | boolean): value is number {
  return typeof value === "number";
}

function isBoolean(value: string | number | boolean): value is boolean {
  return typeof value === "boolean";
}

function createTraceObserverError(): Error {
  const error = new Error("Operation failed");
  error.stack = undefined;
  return error;
}
