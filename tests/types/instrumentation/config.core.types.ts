import {
  createClient as createPGliteClient,
  PGliteDriver,
} from "@drivers/pglite";
import type { Tracer } from "@opentelemetry/api";
import { s } from "@schema";
import { createClient } from "@src/index";
import { instrumentation } from "@src/instrumentation/exports";

type ExpectFalse<Value extends false> = Value;
type _rootInstrumentationIsAbsent = ExpectFalse<
  "instrumentation" extends keyof typeof import("@src/index") ? true : false
>;

const user = s.model({ id: s.string().id(), email: s.string() });
const schema = { user };

const _removedFreshCoreConfig = () =>
  createClient({
    schema,
    driver: new PGliteDriver(),
    // @ts-expect-error - instrumentation is configured only through $extends
    instrumentation: { tracing: true },
  });

const heldRemovedCoreConfig = {
  schema,
  driver: new PGliteDriver(),
  instrumentation: { logging: true },
} as const;
// @ts-expect-error - held config cannot restore the removed core key
const _removedHeldCoreConfig = createClient(heldRemovedCoreConfig);

const _removedWrapperConfig = () =>
  createPGliteClient({
    schema,
    // @ts-expect-error - wrapper entrypoints inherit the removed core key
    instrumentation: { tracing: true },
  });

const _officialInstrumentation = () =>
  instrumentation({
    diagnostics: { includeSql: true },
    logging: { error: true },
    tracing: { includeParams: true },
  });

const _officialTopLevelTypo = () =>
  instrumentation({
    tracing: true,
    // @ts-expect-error - "loging" is refused beside the real "tracing"
    loging: true,
  });

const _officialNestedTypo = () =>
  instrumentation({
    // @ts-expect-error - "includeSqll" is not a TracingConfig key
    tracing: { includeSql: true, includeSqll: true },
  });

declare const platformTracer: Tracer;

const _platformTracer = () =>
  instrumentation({ tracing: { tracer: platformTracer } });

/** Cloudflare Workers' `tracing`, as its documentation declares it. */
declare namespace workersTracing {
  type Exception =
    | string
    | { code: string | number; name?: string; message?: string; stack?: string }
    | { code?: string | number; name: string; message?: string; stack?: string }
    | {
        code?: string | number;
        name?: string;
        message: string;
        stack?: string;
      };
  class Span {
    readonly isTraced: boolean;
    setAttribute(key: string, value: string | number | boolean): this;
    setAttributes(
      attributes: Record<string, string | number | boolean | undefined>
    ): this;
    recordException(exception: Exception): void;
    end(): void;
  }
  function enterSpan<T, A extends unknown[]>(
    name: string,
    callback: (span: Span, ...args: A) => T,
    ...args: A
  ): T;
  function startActiveSpan<T, A extends unknown[]>(
    name: string,
    callback: (span: Span, ...args: A) => T,
    ...args: A
  ): T;
  function startSpan(name: string): Span;
  function getActiveSpan(): Span | undefined;
}

const _workersTracer = () =>
  instrumentation({ tracing: { tracer: workersTracing } });

const _platformTracerBesideOptions = () =>
  instrumentation({
    tracing: {
      tracer: platformTracer,
      includeSql: true,
      ignoreSpanTypes: ["viborm.connect"],
    },
  });

const _notATracer = () =>
  instrumentation({
    // @ts-expect-error - an empty object cannot start spans
    tracing: { tracer: {} },
  });

const _typoBesideTracer = () =>
  instrumentation({
    // @ts-expect-error - "tracr" is refused beside the real "tracer"
    tracing: { tracer: platformTracer, tracr: platformTracer },
  });

const heldOfficialTypo = {
  logging: { query: true, queyr: true },
} as const;
// @ts-expect-error - held nested instrumentation typos are refused structurally
const _heldOfficialTypo = instrumentation(heldOfficialTypo);

const _privateOfficialSurface = instrumentation({ tracing: true });
// @ts-expect-error - the official capability is not a public extension member
_privateOfficialSurface.instrumentationCapability;
// @ts-expect-error - lifecycle facts stay behind the protected runner
_privateOfficialSurface.lifecycleFacts;
