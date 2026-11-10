/**
 * A tracer the project's instrumentation presents its spans through (`tracing.tracer`), which keeps them for the
 * query page instead of sending them anywhere: each span's name, the span it ran inside, when it started and how
 * long it took, its attributes and its error. A span is inside the one active where it started, as an
 * OpenTelemetry tracer nests them, across the awaits between.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { StudioSpan } from "./api";

type Attribute = string | number | boolean;

/** The members of `SpanTracer` (`viborm/instrumentation`) the instrumentation calls. */
export interface RecordingTracer {
  startActiveSpan<T>(
    name: string,
    fn: (span: {
      setAttribute(key: string, value: Attribute): unknown;
      setStatus(status: { code: number; message?: string }): unknown;
      recordException(exception: Error): unknown;
      end(): unknown;
    }) => T
  ): T;
}

/** OpenTelemetry's `SpanStatusCode.ERROR`. */
const ERROR = 2;

export function recordingTracer(
  record: (span: StudioSpan) => void
): RecordingTracer {
  const active = new AsyncLocalStorage<number>();
  let last = 0;
  return {
    startActiveSpan(name, fn) {
      last += 1;
      const id = last;
      const parent = active.getStore();
      const start = performance.now();
      const attributes: Record<string, Attribute> = {};
      let error: string | undefined;
      let ended = false;
      return active.run(id, () =>
        fn({
          setAttribute(key, value) {
            attributes[key] = value;
          },
          setStatus({ code, message }) {
            if (code === ERROR) error ??= message ?? "error";
          },
          recordException(exception) {
            error = exception.message;
          },
          end() {
            if (ended) return;
            ended = true;
            record({
              id,
              ...(parent === undefined ? {} : { parent }),
              name,
              start,
              duration: performance.now() - start,
              attributes,
              ...(error === undefined ? {} : { error }),
            });
          },
        })
      );
    },
  };
}
