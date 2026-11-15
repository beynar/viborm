/**
 * Closing review of the extension host (2026-11-15): failing tracers,
 * loggers, handlers and cache backends under workerd, where a rejection no
 * handler holds by the end of its microtask is reported as unhandled (three
 * such defects in this program: an `async` step around a promise that may
 * reject). Shared by the D1 lane (`closing-review-d1.test.ts`) and the Durable
 * Object lane (`durable-object/closing-review.test.ts`): each case resolves
 * or rejects as the public contract says, and the lane fails if any of them
 * leaves an unhandled rejection behind.
 *
 * The two passes "write less" (`c41f3aff3..dcc705544`) rewrote the tracer
 * (`runOnce`), the presenters (`spanned`), the logger (`log`), the cache's
 * drop (`[DROP]`), the miss's background set and the revalidation unit, and
 * the methods and `on()`: each case below crosses one of them.
 */

import { CacheDriver, type CacheEntry } from "@cache/driver";
import { cache } from "@cache/extension";
import { s } from "@schema";
import {
  around,
  call,
  extension,
  settled,
  target,
  unit,
  writes,
} from "@src/index";
import { instrumentation } from "@src/instrumentation/exports";
import type { SpanTracer } from "@src/instrumentation/types";
import { on } from "@src/on";

export const record = s.model({
  id: s.string().id(),
  name: s.string().unique(),
});
export const closingSchema = { record };

/** A backend whose steps named in `failing` fail. */
export class FailingBackend extends CacheDriver {
  failing: ReadonlySet<string> = new Set();
  readonly #store = new Map<string, CacheEntry>();
  constructor() {
    super("failing");
  }
  #check(step: string): void {
    if (this.failing.has(step)) throw new Error(`backend ${step} failed`);
  }
  protected async get<T>(key: string): Promise<CacheEntry<T> | null> {
    this.#check("get");
    return (this.#store.get(key) as CacheEntry<T> | undefined) ?? null;
  }
  protected async set<T>(
    key: string,
    _ttl: number,
    entry: CacheEntry<T>
  ): Promise<void> {
    this.#check("set");
    this.#store.set(key, entry);
  }
  protected async delete(keys: string[]): Promise<void> {
    this.#check("delete");
    for (const key of keys) this.#store.delete(key);
  }
  protected async clear(prefix: string): Promise<void> {
    this.#check("clear");
    for (const key of [...this.#store.keys()])
      if (key.startsWith(prefix)) this.#store.delete(key);
  }
}

/** A span whose every member throws. */
const throwingSpan = {
  setAttribute() {
    throw new Error("span setAttribute failed");
  },
  setStatus() {
    throw new Error("span setStatus failed");
  },
  recordException() {
    throw new Error("span recordException failed");
  },
  end() {
    throw new Error("span end failed");
  },
};

/** Tracers a platform may hand over that fail in each way a tracer can. */
export const FAILING_TRACERS: Record<string, SpanTracer> = {
  "throws before calling back": {
    startActiveSpan() {
      throw new Error("tracer failed");
    },
  },
  "calls back, then returns a rejected promise": {
    startActiveSpan(_name, fn) {
      const value = fn(throwingSpan);
      return Promise.resolve(value).then(() => {
        throw new Error("tracer failed late");
      });
    },
  },
  "hands a span whose members throw": {
    startActiveSpan(_name, fn) {
      return fn(throwingSpan);
    },
  },
  "never calls back, and rejects": {
    startActiveSpan() {
      return Promise.reject(new Error("tracer rejected"));
    },
  },
};

/** The lanes hand clients of their own driver; the cases call the public surface only. */
type AnyClient = any;

/** What every failing-tracer and failing-logger client is asked. */
export async function exercise(db: AnyClient): Promise<string[]> {
  const seen: string[] = [];
  const outcome = async (label: string, work: () => Promise<unknown>) => {
    try {
      await work();
      seen.push(`${label}: ok`);
    } catch (error) {
      seen.push(`${label}: ${(error as Error).name}`);
    }
  };
  await outcome("create", () =>
    db.record.create({ data: { id: "a", name: "Ada" } })
  );
  await outcome("duplicate", () =>
    db.record.create({ data: { id: "b", name: "Ada" } })
  );
  await outcome("read", () => db.record.findMany({ where: { name: "Ada" } }));
  await outcome("array", () =>
    db.$transaction([
      db.record.create({ data: { id: "c", name: "Cy" } }),
      db.record.create({ data: { id: "d", name: "Cy" } }),
    ])
  );
  await outcome("raw", () =>
    db.$executeRawUnsafe('UPDATE "nope_table" SET x = 1')
  );
  // Let any span or log the calls left behind settle.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return seen;
}

/** The answers of `exercise` on a chain whose observers cannot fail it. */
export const EXERCISED = [
  "create: ok",
  "duplicate: UniqueConstraintError",
  "read: ok",
  "array: UniqueConstraintError",
  "raw: QueryError",
];

export const withTracer = (base: AnyClient, tracer: SpanTracer) =>
  base.$extends(
    instrumentation({
      tracing: { tracer, includeSql: true, includeParams: true },
    })
  );

export const withFailingLogger = (base: AnyClient, rejects: boolean) => {
  const handler = rejects
    ? () => Promise.reject(new Error("logger rejected"))
    : () => {
        throw new Error("logger failed");
      };
  return base.$extends(
    instrumentation({
      logging: { query: handler, error: handler, cache: handler },
    })
  );
};

/** Handlers that fail: the call fails as the handler did, nothing else. */
export const FAILING_HANDLERS: Record<
  string,
  { readonly chain: (base: AnyClient) => AnyClient; readonly name: string }
> = {
  "a unit handler that throws synchronously": {
    chain: (base) =>
      base.$extends(
        extension(
          "u",
          unit(() => {
            throw new Error("unit failed");
          }, ["operation"])
        )
      ),
    name: "unit failed",
  },
  "a statement unit that rejects after next()": {
    chain: (base) =>
      base.$extends(
        extension(
          "u",
          unit(
            async (_u, next) => {
              await next();
              throw new Error("statement unit failed");
            },
            ["statement"]
          )
        )
      ),
    name: "statement unit failed",
  },
  "an around that throws synchronously": {
    chain: (base) =>
      base.$extends(
        extension(
          "a",
          around(() => () => {
            throw new Error("around failed");
          })
        )
      ),
    name: "around failed",
  },
  "a settled that rejects": {
    chain: (base) =>
      base.$extends(
        extension(
          "s",
          call((c) => {
            settled(c, () => Promise.reject(new Error("settled failed")));
          }, target(writes))
        )
      ),
    name: "settled() failed",
  },
};

/** An `on()` hook that fails: reported, never a failure of the write. */
export const withFailingHook = (base: AnyClient, reported: string[]) =>
  base.$extends(
    on(
      {
        record: {
          create: () => Promise.reject(new Error("hook failed")),
        },
      },
      {
        onError: (error) => {
          reported.push(error.message);
          return Promise.reject(new Error("onError failed too"));
        },
      }
    )
  );

export const withFailingCache = (base: AnyClient, backend: FailingBackend) =>
  base.$extends(cache({ driver: backend }));
