/**
 * The `vitest` the driver contracts (`tests/contracts/drivers/behaviors/`) see
 * in this project: `vitest.durable-object.config.ts` resolves their `vitest`
 * import here. It runs every test, with its `beforeEach`/`afterEach` hooks,
 * inside a fresh SQLite Durable Object, whose storage is usable only inside
 * its `runInDurableObject` callback; `durableObjectDriver()` is that object's
 * driver, so each test starts on an empty database, as on in-memory sqlite3.
 *
 * Hooks are replayed here rather than registered with vitest because they
 * must share the test's object. A contract that reads `createDriver()` while
 * collecting gets a driver whose storage throws on use: only its declared
 * facts are meaningful there.
 */
import type {
  DurableObjectState,
  DurableObjectStorage,
} from "@cloudflare/workers-types";
import { createDurableObjectDriver } from "@src/drivers/durable-object";
// biome-ignore lint/performance/noNamespaceImport: the shim re-registers vitest's own functions generically.
import * as vitest from "vitest";
import { inObject } from "./objects";

export { assert, expect, vi } from "vitest";

type Hook = () => unknown;
type Body = (...args: never[]) => unknown;
type Options = number | { timeout?: number } | undefined;
type Register = (name: string, fn: () => unknown, timeout?: number) => unknown;

interface Scope {
  readonly parent: Scope | undefined;
  readonly before: Hook[];
  readonly after: Hook[];
}

const root: Scope = { parent: undefined, before: [], after: [] };
let collecting: Scope = root;
let running: DurableObjectState | undefined;

const unusable = (): never => {
  throw new Error(
    "This driver has no storage: create the driver inside a test."
  );
};
const detached = createDurableObjectDriver({
  // The driver's key: one object, whose every use throws.
  sql: new Proxy({} as DurableObjectStorage["sql"], { get: unusable }),
  transaction: unusable,
  sync: unusable,
});

/** The driver of the Durable Object the current test runs in. */
export function durableObjectDriver() {
  return running ? createDurableObjectDriver(running.storage) : detached;
}

const TEST_TIMEOUT = 60_000;

function chain(scope: Scope): Scope[] {
  const scopes: Scope[] = [];
  for (let s: Scope | undefined = scope; s; s = s.parent) scopes.unshift(s);
  return scopes;
}

function runTest(scope: Scope, body: () => unknown): Promise<void> {
  return inObject(async (state) => {
    running = state;
    const scopes = chain(scope);
    const cleanups: Hook[] = [];
    let failure: { error: unknown } | undefined;
    try {
      for (const { before } of scopes) {
        for (const hook of before) {
          const cleanup = await hook();
          if (typeof cleanup === "function") cleanups.push(cleanup as Hook);
        }
      }
      await body();
    } catch (error) {
      failure = { error };
    }
    for (const hook of [
      ...cleanups,
      ...scopes.reverse().flatMap(({ after }) => after),
    ]) {
      try {
        await hook();
      } catch (error) {
        failure ??= { error };
      }
    }
    running = undefined;
    if (failure) throw failure.error;
  });
}

export function beforeEach(hook: Hook): void {
  collecting.before.push(hook);
}

export function afterEach(hook: Hook): void {
  collecting.after.push(hook);
}

function suite(
  name: string,
  factory: Body,
  register: (name: string, factory: Body) => unknown
): unknown {
  const parent = collecting;
  return register(name, (...args: never[]) => {
    const previous = collecting;
    collecting = { parent, before: [], after: [] };
    try {
      factory(...args);
    } finally {
      collecting = previous;
    }
  });
}

export const describe = Object.assign(
  (name: string, factory: Body) =>
    suite(name, factory, (n, f) => vitest.describe(n, f as () => void)),
  {
    each:
      (cases: readonly unknown[]) =>
      (name: string, factory: Body): unknown =>
        suite(name, factory, (n, f) =>
          vitest.describe.each(cases)(n, f as (...args: unknown[]) => void)
        ),
  }
);

/** vitest takes `(name, fn, options)` and `(name, options, fn)`. */
function normalize(first: Body | Options, second: Body | Options) {
  const fn = (typeof first === "function" ? first : second) as Body;
  const options = typeof first === "function" ? second : first;
  const timeout =
    typeof options === "number"
      ? options
      : (options as Options & object)?.timeout;
  return { fn, timeout: timeout ?? TEST_TIMEOUT };
}

function register(
  base: Register,
  name: string,
  first?: Body | Options,
  second?: Body | Options
): unknown {
  const scope = collecting;
  const { fn, timeout } = normalize(first, second);
  return base(name, () => runTest(scope, () => fn()), timeout);
}

export const test = Object.assign(
  (name: string, first?: Body | Options, second?: Body | Options) =>
    register(vitest.test, name, first, second),
  {
    each:
      (cases: readonly unknown[]) =>
      (name: string, first?: Body | Options, second?: Body | Options) => {
        const scope = collecting;
        const { fn, timeout } = normalize(first, second);
        return vitest.test.each(cases)(
          name,
          (...args: unknown[]) =>
            runTest(scope, () => fn(...(args as never[]))),
          timeout
        );
      },
  }
);

export const it = test;
