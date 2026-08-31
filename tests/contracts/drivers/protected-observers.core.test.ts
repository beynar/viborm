import { QueryError } from "@errors";
import type { ResolvedExtensionHandler } from "@extensions/chain";
import {
  getTrustedProtectedObserverCapability,
  type LifecycleUnit,
  type ObservationCompletion,
  type ObserveHandler,
  observeDriverLifecycle,
  observeOperation,
  observeStatement,
  prewarmProtectedObservers,
  registerTrustedProtectedObserver,
  runProtectedObservers,
} from "@extensions/observation";
import { createInstrumentationContext } from "@instrumentation/context";
import { afterEach, describe, expect, test, vi } from "vitest";

type ObserverEntry = ResolvedExtensionHandler<ObserveHandler>;

function createDeferred<Value>() {
  let resolveValue: ((value: Value | PromiseLike<Value>) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolveValue = resolve;
  });
  return {
    promise,
    resolve(value: Value): void {
      if (resolveValue === undefined) {
        throw new Error("Deferred promise has no resolve function");
      }
      resolveValue(value);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("protected observer fast path", () => {
  test("returns the exact child promise without inspecting inactive context", async () => {
    const applicationPromise = Promise.resolve({ id: "post-1" });
    const child = vi.fn(() => applicationPromise);
    const hostileUnit = new Proxy<LifecycleUnit>(
      { kind: "operation", operation: "findMany" },
      {
        get() {
          throw new Error("inactive observer path inspected the unit");
        },
        ownKeys() {
          throw new Error("inactive observer path scanned the unit");
        },
      }
    );
    const hostileFacts = new Proxy(
      {},
      {
        get() {
          throw new Error("inactive observer path inspected completion facts");
        },
      }
    );
    const readHostileFacts = vi.fn(() => hostileFacts);
    const emptyObservers = new Proxy<ObserverEntry[]>([], {
      get(target, key, receiver) {
        if (key === "length") return Reflect.get(target, key, receiver);
        throw new Error("inactive observer path scanned handlers");
      },
    });

    expect(
      runProtectedObservers(hostileUnit, undefined, child, readHostileFacts)
    ).toBe(applicationPromise);
    expect(
      runProtectedObservers(
        hostileUnit,
        emptyObservers,
        child,
        readHostileFacts
      )
    ).toBe(applicationPromise);
    expect(child).toHaveBeenCalledTimes(2);
    expect(readHostileFacts).not.toHaveBeenCalled();
    await expect(applicationPromise).resolves.toEqual({ id: "post-1" });
  });

  test("prewarms no absent or ordinary observer and forwards its exact child", async () => {
    const applicationPromise = Promise.resolve("application");
    const child = vi.fn(() => applicationPromise);
    const ordinary: ObserverEntry = {
      extension: "ordinary",
      handler(_unit, proceed) {
        return proceed();
      },
    };

    expect(prewarmProtectedObservers(undefined)).toBeUndefined();
    expect(prewarmProtectedObservers([])).toBeUndefined();
    expect(prewarmProtectedObservers([ordinary])).toBeUndefined();
    expect(
      runProtectedObservers(
        { kind: "operation", operation: "findMany" },
        [ordinary],
        child
      )
    ).toBe(applicationPromise);
    expect(child).toHaveBeenCalledOnce();
    await expect(applicationPromise).resolves.toBe("application");
  });

  test("contains trusted readiness throws and rejections as fulfilled fallthrough", async () => {
    const context = createInstrumentationContext({});
    const throwing = () => undefined;
    registerTrustedProtectedObserver(
      throwing,
      Object.freeze({
        context,
        observesLifecycle: true,
        prewarm() {
          throw new Error("readiness threw");
        },
      }),
      (_unit, proceed) => proceed()
    );
    const rejecting = () => undefined;
    registerTrustedProtectedObserver(
      rejecting,
      Object.freeze({
        context,
        observesLifecycle: true,
        prewarm: () => Promise.reject(new Error("readiness rejected")),
      }),
      (_unit, proceed) => proceed()
    );

    expect(
      prewarmProtectedObservers([{ extension: "throwing", handler: throwing }])
    ).toBeUndefined();
    const rejectingReadiness = prewarmProtectedObservers([
      { extension: "rejecting", handler: rejecting },
    ]);
    if (rejectingReadiness === undefined) {
      throw new Error("Expected asynchronous trusted readiness");
    }
    await expect(rejectingReadiness).resolves.toBeUndefined();
  });
});

describe("protected observer lifecycle projections", () => {
  test("projects exact operation, statement, and driver lifecycle identities", async () => {
    const units: LifecycleUnit[] = [];
    const observer: ObserverEntry = {
      extension: "identity",
      handler(unit, proceed) {
        units.push(unit);
        return proceed();
      },
    };
    const child = () => Promise.resolve("application");

    await observeOperation([observer], "findMany", undefined, child);
    await observeOperation([observer], "create", "post", child);
    await observeStatement([observer], undefined, undefined, child);
    await observeStatement([observer], "$queryRaw", "$raw", child);
    await observeStatement([observer], "create", "post", child);
    await observeDriverLifecycle("connection", [observer], undefined, child);
    await observeDriverLifecycle("transaction", [observer], "commit", child);

    expect(units).toEqual([
      { kind: "operation", operation: "findMany" },
      { kind: "operation", operation: "create", model: "post" },
      { kind: "statement" },
      { kind: "statement", operation: "$queryRaw" },
      { kind: "statement", operation: "create", model: "post" },
      { kind: "connection" },
      { kind: "transaction", operation: "commit" },
    ]);
    expect(units.every(Object.isFrozen)).toBe(true);
  });
});

describe("protected observer lifecycle", () => {
  test("starts the child when trusted setup fulfills without proceed", async () => {
    const handler = () => undefined;
    registerTrustedProtectedObserver(
      handler,
      Object.freeze({
        context: createInstrumentationContext({}),
        observesLifecycle: true,
      }),
      () => undefined
    );
    const childPromise = Promise.resolve("core-result");
    const child = vi.fn(() => childPromise);

    const application = runProtectedObservers(
      { kind: "operation", operation: "findMany" },
      [{ extension: "trusted-no-proceed", handler }],
      child
    );

    expect(application).not.toBe(childPromise);
    await expect(application).resolves.toBe("core-result");
    expect(child).toHaveBeenCalledOnce();
  });

  test("falls through trusted setup rejection and preserves the exact child outcome", async () => {
    const handler = () => undefined;
    const capability = Object.freeze({
      context: createInstrumentationContext({}),
      observesLifecycle: true,
    });
    const setupFailure = new Error("trusted setup failed");
    registerTrustedProtectedObserver(handler, capability, () =>
      Promise.reject(setupFailure)
    );
    expect(getTrustedProtectedObserverCapability(handler)).toBe(capability);

    const value = Object.freeze({ id: "child-result" });
    const childSuccess = Promise.resolve(value);
    const successfulApplication = runProtectedObservers(
      { kind: "operation", operation: "findMany" },
      [{ extension: "trusted", handler }],
      () => childSuccess
    );
    expect(successfulApplication).not.toBe(childSuccess);
    await expect(successfulApplication).resolves.toBe(value);

    const childFailure = new Error("child failed");
    const rejectedChild = Promise.reject(childFailure);
    rejectedChild.catch(() => undefined);
    const failedApplication = runProtectedObservers(
      { kind: "operation", operation: "findMany" },
      [{ extension: "trusted", handler }],
      () => rejectedChild
    );
    await expect(failedApplication).rejects.toBe(childFailure);
  });

  test("forms an active completion onion around the exact child promise", async () => {
    const deferred = createDeferred<string>();
    const order: string[] = [];
    const completions: Promise<ObservationCompletion>[] = [];
    const observedUnits: LifecycleUnit[] = [];
    const observers: ObserverEntry[] = ["a", "b", "c"].map((extension) => ({
      extension,
      handler(unit, proceed) {
        order.push(`${extension}:in`);
        observedUnits.push(unit);
        const completion = proceed();
        completions.push(completion);
        completion.then(() => order.push(`${extension}:out`));
        return { fabricated: `${extension}:result` };
      },
    }));

    const application = runProtectedObservers(
      { kind: "operation", operation: "findMany", model: "post" },
      observers,
      () => {
        order.push("child");
        return deferred.promise;
      }
    );

    expect(application).toBe(deferred.promise);
    expect(order).toEqual(["a:in", "b:in", "c:in", "child"]);
    expect(observedUnits).toHaveLength(3);
    expect(observedUnits[1]).toBe(observedUnits[0]);
    expect(observedUnits[2]).toBe(observedUnits[0]);
    expect(Object.isFrozen(observedUnits[0])).toBe(true);
    expect(Reflect.ownKeys(observedUnits[0] ?? {})).toEqual([
      "kind",
      "operation",
      "model",
    ]);
    expect(completions[1]).toBe(completions[0]);
    expect(completions[2]).toBe(completions[0]);

    deferred.resolve("application-result");
    await expect(application).resolves.toBe("application-result");
    await Promise.all(completions);
    expect(order).toEqual([
      "a:in",
      "b:in",
      "c:in",
      "child",
      "c:out",
      "b:out",
      "a:out",
    ]);
    const firstCompletion = completions[0];
    if (firstCompletion === undefined) {
      throw new Error("Observer did not receive completion");
    }
    await expect(firstCompletion).resolves.toMatchObject({
      status: "success",
    });
  });

  test("starts the protected child after no-proceed and makes a late proceed inert", async () => {
    const applicationPromise = Promise.resolve("core-result");
    const child = vi.fn(() => applicationPromise);
    const inner = vi.fn(
      (_unit: LifecycleUnit, proceed: () => Promise<ObservationCompletion>) =>
        proceed()
    );
    let lateProceed: (() => Promise<ObservationCompletion>) | undefined;

    const application = runProtectedObservers(
      { kind: "transaction" },
      [
        {
          extension: "outer",
          handler(_unit, proceed) {
            lateProceed = proceed;
          },
        },
        { extension: "inner", handler: inner },
      ],
      child
    );

    expect(application).toBe(applicationPromise);
    expect(child).toHaveBeenCalledOnce();
    expect(inner).toHaveBeenCalledOnce();
    if (lateProceed === undefined) throw new Error("Observer did not run");
    const firstLateCompletion = lateProceed();
    expect(lateProceed()).toBe(firstLateCompletion);
    expect(child).toHaveBeenCalledOnce();
    expect(inner).toHaveBeenCalledOnce();
    await expect(firstLateCompletion).resolves.toMatchObject({
      status: "success",
    });
  });

  test("continues through later observers after a throw-before-proceed", async () => {
    const applicationPromise = Promise.resolve("core-result");
    const child = vi.fn(() => applicationPromise);
    const inner = vi.fn(
      (_unit: LifecycleUnit, proceed: () => Promise<ObservationCompletion>) =>
        proceed()
    );

    const application = runProtectedObservers(
      { kind: "connection", operation: "connect" },
      [
        {
          extension: "throwing",
          handler() {
            throw new Error("observer failed before proceed");
          },
        },
        { extension: "inner", handler: inner },
      ],
      child
    );

    expect(application).toBe(applicationPromise);
    expect(inner).toHaveBeenCalledOnce();
    expect(child).toHaveBeenCalledOnce();
    await expect(application).resolves.toBe("core-result");
  });

  test("normalizes a synchronous child throw into the protected completion", async () => {
    const childFailure = new Error("child threw synchronously");
    let completionPromise: Promise<ObservationCompletion> | undefined;

    const application = runProtectedObservers(
      { kind: "operation", model: "post", operation: "findMany" },
      [
        {
          extension: "sync-child",
          handler(_unit, proceed) {
            completionPromise = proceed();
          },
        },
      ],
      () => {
        throw childFailure;
      }
    );

    await expect(application).rejects.toBe(childFailure);
    await expect(completionPromise).resolves.toMatchObject({
      status: "failure",
      error: { name: "Error", message: "Error details redacted" },
    });
  });

  test("makes double proceed idempotent and starts the child once", async () => {
    const applicationPromise = Promise.resolve(42);
    const child = vi.fn(() => applicationPromise);
    const inner = vi.fn(
      (_unit: LifecycleUnit, proceed: () => Promise<ObservationCompletion>) =>
        proceed()
    );
    let firstCompletion: Promise<ObservationCompletion> | undefined;
    let secondCompletion: Promise<ObservationCompletion> | undefined;

    const application = runProtectedObservers(
      { kind: "batch", operation: "$transaction([...])" },
      [
        {
          extension: "outer",
          handler(_unit, proceed) {
            firstCompletion = proceed();
            secondCompletion = proceed();
          },
        },
        { extension: "inner", handler: inner },
      ],
      child
    );

    expect(application).toBe(applicationPromise);
    expect(firstCompletion).toBe(secondCompletion);
    expect(child).toHaveBeenCalledOnce();
    expect(inner).toHaveBeenCalledOnce();
    await expect(application).resolves.toBe(42);
  });

  test.each([
    {
      name: "synchronous throw",
      handler(
        _unit: LifecycleUnit,
        proceed: () => Promise<ObservationCompletion>
      ) {
        proceed();
        throw new Error("observer failed");
      },
    },
    {
      name: "fabricated value",
      handler() {
        return { status: "fabricated", result: "observer-result" };
      },
    },
    {
      name: "returned rejection",
      handler() {
        return Promise.reject(new Error("observer rejected"));
      },
    },
    {
      name: "hostile thenable",
      handler() {
        return Object.defineProperty({}, "then", {
          get() {
            throw new Error("then getter failed");
          },
        });
      },
    },
  ])("contains $name", async ({ handler }) => {
    const applicationPromise = Promise.resolve("application-result");
    const child = vi.fn(() => applicationPromise);

    const application = runProtectedObservers(
      { kind: "statement", model: "post", operation: "update" },
      [{ extension: "hostile", handler }],
      child
    );

    expect(application).toBe(applicationPromise);
    expect(child).toHaveBeenCalledOnce();
    await expect(application).resolves.toBe("application-result");
    await Promise.resolve();
  });

  test("contains hostile observer return prototypes without reading them", async () => {
    const reads: PropertyKey[] = [];
    const returned = new Proxy(
      {},
      {
        get(_target, key) {
          reads.push(key);
          return undefined;
        },
        getPrototypeOf() {
          throw new Error("observer return prototype was inspected");
        },
      }
    );
    const applicationPromise = Promise.resolve("application-result");

    const application = runProtectedObservers(
      { kind: "statement", operation: "findMany" },
      [{ extension: "hostile-prototype", handler: () => returned }],
      () => applicationPromise
    );

    expect(application).toBe(applicationPromise);
    await expect(application).resolves.toBe("application-result");
    expect(reads).toEqual(["then"]);
  });

  test("does not await a never-settling observer return", async () => {
    vi.useFakeTimers();
    let childPromise: Promise<string> | undefined;

    const application = runProtectedObservers(
      { kind: "cache", operation: "get" },
      [
        {
          extension: "never",
          handler() {
            return new Promise(() => undefined);
          },
        },
      ],
      () => {
        childPromise = new Promise((resolve) => {
          setTimeout(() => resolve("application-result"), 20);
        });
        return childPromise;
      }
    );

    expect(application).toBe(childPromise);
    await vi.advanceTimersByTimeAsync(20);
    await expect(application).resolves.toBe("application-result");
  });

  test("preserves child failure identity despite attempted swallowing", async () => {
    const childFailure = new Error("child failed");
    const applicationPromise = Promise.reject<never>(childFailure);

    const application = runProtectedObservers(
      { kind: "segment", model: "post", operation: "create" },
      [
        {
          extension: "swallowing",
          handler(_unit, proceed) {
            return proceed().then(() => "fabricated-success");
          },
        },
      ],
      () => applicationPromise
    );

    expect(application).toBe(applicationPromise);
    await expect(application).rejects.toBe(childFailure);
  });

  test("publishes only a deeply frozen sanitized completion summary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const childFailure = new QueryError("provider failed");
    let completionPromise: Promise<ObservationCompletion> | undefined;

    const application = runProtectedObservers(
      { kind: "savepoint", operation: "$transaction" },
      [
        {
          extension: "summary",
          handler(_unit, proceed) {
            completionPromise = proceed();
            return {
              status: "success",
              result: "fabricated",
              commitCertainty: "committed",
            };
          },
        },
      ],
      () =>
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(childFailure), 25);
        }),
      () => ({ commitCertainty: "may-have-committed" })
    );
    const caughtApplicationFailure = application.catch(
      (failure: unknown) => failure
    );

    await vi.advanceTimersByTimeAsync(25);
    expect(await caughtApplicationFailure).toBe(childFailure);
    if (completionPromise === undefined) {
      throw new Error("Observer did not receive completion");
    }
    const completion = await completionPromise;
    expect(Object.isFrozen(completion)).toBe(true);
    expect(completion).toEqual({
      status: "failure",
      durationMs: 25,
      error: {
        name: childFailure.name,
        message: childFailure.message,
        code: childFailure.code,
      },
      commitCertainty: "may-have-committed",
    });
    expect(Reflect.ownKeys(completion)).toEqual([
      "status",
      "durationMs",
      "error",
      "commitCertainty",
    ]);
    expect(Object.isFrozen(completion.error)).toBe(true);
    expect(Reflect.ownKeys(completion.error ?? {})).toEqual([
      "name",
      "message",
      "code",
    ]);
    expect("result" in completion).toBe(false);
    expect("rows" in completion).toBe(false);
    expect("token" in completion).toBe(false);
    expect("cause" in (completion.error ?? {})).toBe(false);
    expect("stack" in (completion.error ?? {})).toBe(false);
    expect(
      Reflect.set(completion.error ?? {}, "message", "observer mutation")
    ).toBe(false);
  });

  test("reads trusted completion facts only after the child settles", async () => {
    const deferred = createDeferred<string>();
    let certainty: "committed" | undefined;
    let completionPromise: Promise<ObservationCompletion> | undefined;
    const readFacts = vi.fn(() =>
      certainty === undefined ? undefined : { commitCertainty: certainty }
    );

    const application = runProtectedObservers(
      { kind: "statement", operation: "create" },
      [
        {
          extension: "late-facts",
          handler(_unit, proceed) {
            completionPromise = proceed();
          },
        },
      ],
      () => deferred.promise,
      readFacts
    );

    expect(readFacts).not.toHaveBeenCalled();
    certainty = "committed";
    deferred.resolve("done");
    await expect(application).resolves.toBe("done");
    expect(readFacts).toHaveBeenCalledOnce();
    await expect(completionPromise).resolves.toMatchObject({
      status: "success",
      commitCertainty: "committed",
    });
  });

  test("keeps the child failure summary when the late facts reader throws", async () => {
    const childFailure = new QueryError("authoritative child failure");
    let completionPromise: Promise<ObservationCompletion> | undefined;
    const application = runProtectedObservers(
      { kind: "operation", model: "post", operation: "create" },
      [
        {
          extension: "hostile-facts",
          handler(_unit, proceed) {
            completionPromise = proceed();
          },
        },
      ],
      () => Promise.reject(childFailure),
      () => {
        throw new Error("facts reader failed");
      }
    );

    await expect(application).rejects.toBe(childFailure);
    await expect(completionPromise).resolves.toEqual(
      expect.objectContaining({
        status: "failure",
        error: {
          name: childFailure.name,
          message: childFailure.message,
          code: childFailure.code,
        },
      })
    );
    await expect(completionPromise).resolves.not.toHaveProperty(
      "commitCertainty"
    );
  });
});

describe("protected observer failure isolation", () => {
  test("falls through a synchronous trusted setup failure", async () => {
    const handler = () => undefined;
    registerTrustedProtectedObserver(
      handler,
      Object.freeze({
        context: createInstrumentationContext({}),
        observesLifecycle: true,
      }),
      () => {
        throw new Error("trusted setup threw");
      }
    );
    const child = vi.fn(() => Promise.resolve("application"));

    await expect(
      runProtectedObservers(
        { kind: "operation", operation: "findMany" },
        [{ extension: "trusted", handler }],
        child
      )
    ).resolves.toBe("application");
    expect(child).toHaveBeenCalledOnce();
  });

  test("contains instrumentation-fact production failure", async () => {
    const handler = () => undefined;
    registerTrustedProtectedObserver(
      handler,
      Object.freeze({
        context: createInstrumentationContext({}),
        observesLifecycle: true,
      }),
      (_unit, proceed) => proceed()
    );
    const readFacts = vi.fn(() => {
      throw new Error("instrumentation facts failed");
    });

    await expect(
      runProtectedObservers(
        { kind: "statement", operation: "findMany" },
        [{ extension: "trusted-facts", handler }],
        () => Promise.resolve("application"),
        undefined,
        readFacts
      )
    ).resolves.toBe("application");
    expect(readFacts).toHaveBeenCalledOnce();
  });
});

describe("coverage low value", () => {
  test("summarizes a non-Error application rejection", async () => {
    let completionPromise: Promise<ObservationCompletion> | undefined;
    const application = runProtectedObservers(
      { kind: "operation", operation: "findMany" },
      [
        {
          extension: "non-error-child",
          handler(_unit, proceed) {
            completionPromise = proceed();
          },
        },
      ],
      () => Promise.reject("non-error failure")
    );

    await expect(application).rejects.toBe("non-error failure");
    await expect(completionPromise).resolves.toMatchObject({
      status: "failure",
      error: {
        name: "Error",
        message: "Error details redacted",
      },
    });
  });
});
