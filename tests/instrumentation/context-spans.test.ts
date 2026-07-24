/**
 * context.ts + spans.ts coverage.
 *
 * context.ts: createInstrumentationContext assembling tracer + logger from an
 * InstrumentationConfig across every logging/tracing combination, and the
 * hasActiveInstrumentation / isTracingActive / isLoggingActive booleans.
 *
 * spans.ts: the SPAN_* / ATTR_* constants asserted by their name -> string
 * value mapping (never X === X), plus uniqueness of the span-name set.
 *
 * Note on the OTel recorder: OpenTelemetry's global tracer provider can only be
 * registered once per process; a second registration is silently ignored. The
 * shared `_capture.withOtelRecorder()` therefore only records for whichever
 * provider is currently registered, so the span-recording tests here share a
 * single recorder registered in beforeAll and use distinct span names per test
 * to stay isolated.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { Driver } from "@drivers/driver";
import type { QueryResult } from "@drivers/types";
import { isVibORMError } from "@errors";
import { sql } from "@sql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createInstrumentationContext,
  hasActiveInstrumentation,
  isLoggingActive,
  isTracingActive,
} from "../../src/instrumentation/context";
import {
  runWithTracer,
  runWithTracerSync,
} from "../../src/instrumentation/run-with-tracer";
import {
  ATTR_CACHE_DRIVER,
  ATTR_CACHE_KEY,
  ATTR_CACHE_RESULT,
  ATTR_CACHE_TTL,
  ATTR_DB_COLLECTION,
  ATTR_DB_DRIVER,
  ATTR_DB_OPERATION_NAME,
  ATTR_DB_QUERY_PARAMETER_PREFIX,
  ATTR_DB_QUERY_TEXT,
  ATTR_DB_SYSTEM,
  ATTR_VIBORM_CORRELATION_ID,
  SPAN_BUILD,
  SPAN_CACHE_GET,
  SPAN_CACHE_SET,
  SPAN_EXECUTE,
  SPAN_OPERATION,
  SPAN_PARSE,
  SPAN_VALIDATE,
} from "../../src/instrumentation/spans";
import {
  createTracerWrapper,
  getNoopTracer,
  type TracerWrapper,
  type VibORMSpanOptions,
} from "../../src/instrumentation/tracer";
import {
  captureLogs,
  type OtelRecorder,
  primeTracer,
  withOtelRecorder,
} from "./_capture";

// A single globally-registered recorder for all span-recording tests. Distinct
// span names per test keep assertions from colliding.
let recorder: OtelRecorder;
beforeAll(() => {
  recorder = withOtelRecorder();
});
afterAll(async () => {
  await recorder.dispose();
});

// ---------------------------------------------------------------------------
// createInstrumentationContext — tracer assembly
// ---------------------------------------------------------------------------

describe("createInstrumentationContext — tracer", () => {
  it("nothing configured: tracer is the noop singleton (disabled), no logger, config preserved", () => {
    const config = {};
    const ctx = createInstrumentationContext(config);
    expect(ctx.tracer).toBe(getNoopTracer());
    expect(ctx.tracer.isEnabled()).toBe(false);
    expect(ctx.logger).toBeUndefined();
    expect(ctx.config).toBe(config);
  });

  it("tracing: true creates a real tracer (not the noop singleton), enabled once primed", async () => {
    const ctx = createInstrumentationContext({ tracing: true });
    expect(ctx.tracer).not.toBe(getNoopTracer());
    // Real tracer loads OTel lazily: disabled until a span primes it.
    expect(ctx.tracer.isEnabled()).toBe(false);
    await primeTracer(ctx.tracer);
    expect(ctx.tracer.isEnabled()).toBe(true);
  });

  it("tracing object forwards includeSql/includeParams to the tracer (visible on span attrs)", async () => {
    const ctx = createInstrumentationContext({
      tracing: { includeSql: false, includeParams: true },
    });
    await ctx.tracer.startActiveSpan(
      { name: SPAN_EXECUTE, sql: { query: "SELECT 1", params: ["a", 2] } },
      () => undefined
    );
    const span = recorder.find(SPAN_EXECUTE);
    expect(span).toBeDefined();
    // includeSql:false -> query text attribute absent.
    expect(span?.attributes[ATTR_DB_QUERY_TEXT]).toBeUndefined();
    // includeParams:true -> per-index parameter attributes; non-string stringified.
    expect(span?.attributes[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.0`]).toBe("a");
    expect(span?.attributes[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.1`]).toBe("2");
  });

  it("tracing object forwards ignoreSpanTypes (matching span not recorded)", async () => {
    const ctx = createInstrumentationContext({
      tracing: { ignoreSpanTypes: [SPAN_VALIDATE] },
    });
    const value = await ctx.tracer.startActiveSpan(
      { name: SPAN_VALIDATE },
      () => "ran"
    );
    // Callback still runs...
    expect(value).toBe("ran");
    // ...but the ignored span is not recorded.
    expect(recorder.find(SPAN_VALIDATE)).toBeUndefined();
    // A non-ignored span from the SAME wrapper IS recorded, proving the wrapper
    // is otherwise live (SPAN_BUILD is used by no other test here).
    await ctx.tracer.startActiveSpan({ name: SPAN_BUILD }, () => undefined);
    expect(recorder.find(SPAN_BUILD)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// createInstrumentationContext — logger assembly
// ---------------------------------------------------------------------------

describe("createInstrumentationContext — logger", () => {
  it("logging: true maps to { all: true } — every level enabled", () => {
    const ctx = createInstrumentationContext({ logging: true });
    expect(ctx.logger).toBeDefined();
    for (const level of ["query", "cache", "warning", "error"] as const) {
      expect(ctx.logger?.isLevelEnabled(level)).toBe(true);
    }
  });

  it("logging object forwards per-level handlers (only configured levels enabled)", () => {
    const ctx = createInstrumentationContext({ logging: { query: true } });
    expect(ctx.logger?.isLevelEnabled("query")).toBe(true);
    expect(ctx.logger?.isLevelEnabled("cache")).toBe(false);
    expect(ctx.logger?.isLevelEnabled("error")).toBe(false);
  });

  it("logging object handler actually receives routed events (real emit path)", () => {
    const cap = captureLogs();
    const ctx = createInstrumentationContext({
      logging: { query: cap.callback },
    });
    ctx.logger?.query({
      timestamp: new Date(),
      model: "user",
      operation: "findMany",
    });
    ctx.logger?.error({ timestamp: new Date(), error: new Error("nope") });
    // Only the query handler is configured, so only the query event lands.
    expect(cap.events).toHaveLength(1);
    expect(cap.events[0]?.level).toBe("query");
    expect(cap.events[0]?.model).toBe("user");
  });

  it("logging omitted: context.logger is undefined", () => {
    const ctx = createInstrumentationContext({ tracing: true });
    expect(ctx.logger).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// hasActiveInstrumentation / isTracingActive / isLoggingActive
// ---------------------------------------------------------------------------

describe("instrumentation predicates", () => {
  it("all predicates are false for undefined context", () => {
    expect(hasActiveInstrumentation(undefined)).toBe(false);
    expect(isTracingActive(undefined)).toBe(false);
    expect(isLoggingActive(undefined)).toBe(false);
  });

  it("neither tracing nor logging: no active instrumentation", () => {
    const ctx = createInstrumentationContext({});
    expect(hasActiveInstrumentation(ctx)).toBe(false);
    expect(isTracingActive(ctx)).toBe(false);
    expect(isLoggingActive(ctx)).toBe(false);
  });

  it("logging only: active via logger, tracing inactive", () => {
    const ctx = createInstrumentationContext({ logging: true });
    expect(hasActiveInstrumentation(ctx)).toBe(true);
    expect(isLoggingActive(ctx)).toBe(true);
    expect(isTracingActive(ctx)).toBe(false);
  });

  it("tracing only: inactive until primed, then active; logging stays inactive", async () => {
    const ctx = createInstrumentationContext({ tracing: true });
    // Before priming the real tracer is not yet enabled...
    expect(isTracingActive(ctx)).toBe(false);
    expect(hasActiveInstrumentation(ctx)).toBe(false);
    await primeTracer(ctx.tracer);
    // ...and enabled after.
    expect(isTracingActive(ctx)).toBe(true);
    expect(hasActiveInstrumentation(ctx)).toBe(true);
    expect(isLoggingActive(ctx)).toBe(false);
  });

  it("both configured: everything active once primed", async () => {
    const ctx = createInstrumentationContext({
      tracing: true,
      logging: true,
    });
    await primeTracer(ctx.tracer);
    expect(hasActiveInstrumentation(ctx)).toBe(true);
    expect(isTracingActive(ctx)).toBe(true);
    expect(isLoggingActive(ctx)).toBe(true);
  });

  it("logging present makes hasActiveInstrumentation true even with a noop tracer", () => {
    // logging only -> tracer is noop (disabled) but logger flips the OR.
    const ctx = createInstrumentationContext({ logging: { error: true } });
    expect(ctx.tracer.isEnabled()).toBe(false);
    expect(hasActiveInstrumentation(ctx)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// spans.ts constants — name -> value mapping (no self-equality)
// ---------------------------------------------------------------------------

describe("span + attribute constants", () => {
  it("span names carry their documented viborm.* values", () => {
    expect(SPAN_OPERATION).toBe("viborm.operation");
    expect(SPAN_VALIDATE).toBe("viborm.validate");
    expect(SPAN_BUILD).toBe("viborm.build");
    expect(SPAN_EXECUTE).toBe("viborm.execute");
    expect(SPAN_PARSE).toBe("viborm.parse");
    expect(SPAN_CACHE_GET).toBe("viborm.cache.get");
    expect(SPAN_CACHE_SET).toBe("viborm.cache.set");
  });

  it("attribute constants map to their OTel / custom keys", () => {
    expect(ATTR_DB_SYSTEM).toBe("db.system.name");
    expect(ATTR_DB_COLLECTION).toBe("db.collection.name");
    expect(ATTR_DB_OPERATION_NAME).toBe("db.operation.name");
    expect(ATTR_DB_QUERY_TEXT).toBe("db.query.text");
    expect(ATTR_DB_DRIVER).toBe("db.system.driver");
    expect(ATTR_DB_QUERY_PARAMETER_PREFIX).toBe("db.query.parameter");
    expect(ATTR_CACHE_DRIVER).toBe("cache.driver");
    expect(ATTR_CACHE_KEY).toBe("cache.key");
    expect(ATTR_CACHE_RESULT).toBe("cache.result");
    expect(ATTR_CACHE_TTL).toBe("cache.ttl");
  });

  it("all span-name constants are distinct (no accidental collisions)", () => {
    const names = [
      SPAN_OPERATION,
      SPAN_VALIDATE,
      SPAN_BUILD,
      SPAN_EXECUTE,
      SPAN_PARSE,
      SPAN_CACHE_GET,
      SPAN_CACHE_SET,
    ];
    expect(new Set(names).size).toBe(names.length);
  });
});

function createGate() {
  let resolveGate: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });

  return {
    promise,
    open(): void {
      if (!resolveGate) {
        throw new Error("gate was not initialized");
      }
      resolveGate();
    },
  };
}

class AttributionTracer implements TracerWrapper {
  readonly attributions: Array<{
    model: unknown;
    operation: unknown;
    correlationId: unknown;
  }> = [];

  async startActiveSpan<T>(
    options: VibORMSpanOptions,
    fn: () => T | Promise<T>
  ): Promise<T> {
    if (options.name === SPAN_EXECUTE) {
      this.attributions.push({
        model: options.attributes?.[ATTR_DB_COLLECTION],
        operation: options.attributes?.[ATTR_DB_OPERATION_NAME],
        correlationId: options.attributes?.[ATTR_VIBORM_CORRELATION_ID],
      });
    }
    return fn();
  }

  startActiveSpanSync<T>(options: VibORMSpanOptions, fn: () => T): T {
    if (options.name === SPAN_EXECUTE) {
      this.attributions.push({
        model: options.attributes?.[ATTR_DB_COLLECTION],
        operation: options.attributes?.[ATTR_DB_OPERATION_NAME],
        correlationId: options.attributes?.[ATTR_VIBORM_CORRELATION_ID],
      });
    }
    return fn();
  }

  isEnabled(): boolean {
    return true;
  }
}

class OverlappingFailureDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly initializationStarted = createGate();
  readonly allowInitialization = createGate();

  constructor() {
    super("sqlite", "overlapping-failure");
  }

  protected async initClient(): Promise<object> {
    this.initializationStarted.open();
    await this.allowInitialization.promise;
    return {};
  }

  protected async closeClient(): Promise<void> {
    // No provider resource to release.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    throw new Error("fixture execution failure");
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    throw new Error("fixture execution failure");
  }

  protected async transaction<T>(
    _client: object,
    fn: (tx: object) => Promise<T>
  ): Promise<T> {
    return fn({});
  }
}

describe("overlapping driver operation attribution", () => {
  it("retains each operation's model and action in its span and error", async () => {
    const driver = new OverlappingFailureDriver();
    const tracer = new AttributionTracer();
    driver.setInstrumentation({ config: { tracing: true }, tracer });

    const first = driver
      ._execute(sql`SELECT ${"first"}`, {
        model: "user",
        operation: "findMany",
        correlationId: "first-operation",
      })
      .catch((error) => error);
    await driver.initializationStarted.promise;

    const second = driver
      ._execute(sql`SELECT ${"second"}`, {
        model: "post",
        operation: "delete",
        correlationId: "second-operation",
      })
      .catch((error) => error);
    driver.allowInitialization.open();

    const errors = await Promise.all([first, second]);
    const errorAttributions = errors.map((error) => {
      if (!isVibORMError(error)) {
        throw new Error("expected a VibORMError");
      }
      return {
        model: error.meta.model,
        operation: error.meta.operation,
        correlationId: error.meta.correlationId,
      };
    });

    expect({
      errors: errorAttributions,
      spans: tracer.attributions,
    }).toEqual({
      errors: [
        {
          model: "user",
          operation: "findMany",
          correlationId: "first-operation",
        },
        {
          model: "post",
          operation: "delete",
          correlationId: "second-operation",
        },
      ],
      spans: [
        {
          model: "user",
          operation: "findMany",
          correlationId: "first-operation",
        },
        {
          model: "post",
          operation: "delete",
          correlationId: "second-operation",
        },
      ],
    });
  });
});

describe("synchronous tracer isolation", () => {
  it("returns the operation outcome once when a tracer throws after invoking it", () => {
    const operation = vi.fn(() => "operation-result");
    const tracer: TracerWrapper = {
      async startActiveSpan(_options, fn) {
        return fn();
      },
      startActiveSpanSync(_options, fn) {
        fn();
        throw new Error("tracer hook failed");
      },
      isEnabled: () => true,
    };

    expect(runWithTracerSync(tracer, { name: SPAN_VALIDATE }, operation)).toBe(
      "operation-result"
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("runs async application work once under re-entrant tracer callbacks", async () => {
    let outerCallback: (() => Promise<void>) | undefined;
    let operationCount = 0;
    const tracer: TracerWrapper = {
      async startActiveSpan(options, fn) {
        if (options.name === SPAN_OPERATION) {
          outerCallback = () => Promise.resolve(fn()).then(() => undefined);
        }
        return fn();
      },
      startActiveSpanSync(options, fn) {
        if (options.name === SPAN_VALIDATE) {
          outerCallback?.().catch(() => undefined);
        }
        return fn();
      },
      isEnabled: () => true,
    };

    const result = await runWithTracer(
      tracer,
      { name: SPAN_OPERATION },
      async () => {
        operationCount += 1;
        return runWithTracerSync(
          tracer,
          { name: SPAN_VALIDATE },
          () => "authoritative"
        );
      }
    );

    expect(result).toBe("authoritative");
    expect(operationCount).toBe(1);
  });

  it("runs sync application work once under re-entrant tracer callbacks", () => {
    let outerCallback: (() => void) | undefined;
    let operationCount = 0;
    const tracer: TracerWrapper = {
      async startActiveSpan(_options, fn) {
        return fn();
      },
      startActiveSpanSync(options, fn) {
        if (options.name === SPAN_OPERATION) outerCallback = fn;
        if (options.name === SPAN_VALIDATE) outerCallback?.();
        return fn();
      },
      isEnabled: () => true,
    };

    const result = runWithTracerSync(tracer, { name: SPAN_OPERATION }, () => {
      operationCount += 1;
      return runWithTracerSync(
        tracer,
        { name: SPAN_VALIDATE },
        () => "authoritative"
      );
    });

    expect(result).toBe("authoritative");
    expect(operationCount).toBe(1);
  });

  it("snapshots and freezes span attribution before custom tracer hooks", async () => {
    const tags = ["read", "portable"];
    const attributes = {
      [ATTR_DB_COLLECTION]: "user",
      [ATTR_DB_OPERATION_NAME]: "findMany",
      [ATTR_VIBORM_CORRELATION_ID]: "original-correlation",
      "test.tags": tags,
    };
    const observed: unknown[] = [];
    const tracer: TracerWrapper = {
      async startActiveSpan(options, fn) {
        const receivedTags = options.attributes?.["test.tags"];
        observed.push({
          ...options.attributes,
          "test.tags": Array.isArray(receivedTags)
            ? [...receivedTags]
            : receivedTags,
        });
        expect(Object.isFrozen(options)).toBe(true);
        expect(Object.isFrozen(options.attributes)).toBe(true);
        expect(Object.isFrozen(receivedTags)).toBe(true);
        try {
          Object.assign(options.attributes ?? {}, {
            [ATTR_DB_COLLECTION]: "mutated",
            [ATTR_DB_OPERATION_NAME]: "mutated",
            [ATTR_VIBORM_CORRELATION_ID]: "mutated",
          });
        } catch {
          // Frozen snapshots reject hostile mutation in strict mode.
        }
        if (Array.isArray(receivedTags)) {
          try {
            receivedTags[0] = "mutated";
          } catch {
            // Nested attribute arrays are frozen snapshots too.
          }
        }
        return fn();
      },
      startActiveSpanSync(_options, fn) {
        return fn();
      },
      isEnabled: () => true,
    };

    await runWithTracer(tracer, { name: SPAN_OPERATION, attributes }, () =>
      Promise.resolve()
    );
    await runWithTracer(tracer, { name: SPAN_EXECUTE, attributes }, () =>
      Promise.resolve()
    );

    expect(observed).toEqual([attributes, attributes]);
    expect(attributes).toEqual({
      [ATTR_DB_COLLECTION]: "user",
      [ATTR_DB_OPERATION_NAME]: "findMany",
      [ATTR_VIBORM_CORRELATION_ID]: "original-correlation",
      "test.tags": ["read", "portable"],
    });
    expect(tags).toEqual(["read", "portable"]);
  });

  it("does not trust a custom tracer with a copied wrapper prototype", async () => {
    const genuine = createTracerWrapper();
    let patchedWrapperCalled = false;
    const patch = () => {
      patchedWrapperCalled = true;
      return Promise.resolve("patched");
    };
    expect(Reflect.set(genuine, "startActiveSpan", patch)).toBe(false);
    expect(Reflect.get(genuine, "constructor")).toBeUndefined();
    expect(
      Reflect.set(Object.getPrototypeOf(genuine), "startActiveSpan", patch)
    ).toBe(false);
    await expect(
      runWithTracer(genuine, { name: SPAN_VALIDATE }, () =>
        Promise.resolve("trusted-result")
      )
    ).resolves.toBe("trusted-result");
    expect(patchedWrapperCalled).toBe(false);

    let observedResult: unknown = "not-called";
    const forged: TracerWrapper = {
      async startActiveSpan(_options, fn) {
        const result = await fn();
        observedResult = result;
        return result;
      },
      startActiveSpanSync(_options, fn) {
        return fn();
      },
      isEnabled: () => true,
    };
    Object.setPrototypeOf(forged, Object.getPrototypeOf(genuine));

    await expect(
      runWithTracer(forged, { name: SPAN_OPERATION }, () =>
        Promise.resolve("private-result")
      )
    ).resolves.toBe("private-result");
    expect(observedResult).toBeUndefined();
  });
});
