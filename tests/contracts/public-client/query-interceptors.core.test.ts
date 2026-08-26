import type { Operations } from "@client/types";
import { QueryError } from "@errors";
import type { GenericQueryKind } from "@extensions/query";
import {
  executePreparedQuery,
  type PreparedModelQueryContext,
  type PreparedRawQueryContext,
  type QueryInterceptionMode,
  type QueryInterceptor,
  runQueryInterceptors,
  type WriteOutcomeListener,
  type WriteOutcomeRegistration,
} from "@extensions/query";
import { describe, expect, test, vi } from "vitest";

type Rows = { id: string }[];
type Count = { count: number };

const ignoreRegistration = (_registration: WriteOutcomeRegistration): void =>
  undefined;

function modelContext(
  operation: Operations,
  mode: QueryInterceptionMode = "direct"
): PreparedModelQueryContext<Record<string, unknown>> {
  return Object.freeze({
    mode,
    kind: "model",
    model: "post",
    operation,
    input: Object.freeze({ where: Object.freeze({ published: true }) }),
  });
}

type RawKind = Exclude<GenericQueryKind, "model">;

function rawContext(
  kind: RawKind,
  operation:
    | "$queryRaw"
    | "$executeRaw"
    | "$queryRawUnsafe"
    | "$executeRawUnsafe",
  mode: QueryInterceptionMode = "direct"
): PreparedRawQueryContext<Record<string, unknown>> {
  return Object.freeze({
    mode,
    kind,
    model: undefined,
    operation,
    input: Object.freeze({}),
  });
}

async function captureFailure(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the query interceptor runner to fail");
}

function requireError(error: unknown): Error {
  if (!(error instanceof Error)) throw new Error("Expected an Error");
  return error;
}

function requireQueryError(error: unknown): QueryError {
  if (!(error instanceof QueryError)) throw new Error("Expected a QueryError");
  return error;
}

describe("standalone query interceptor runner", () => {
  test("the no-handler path returns the child promise by identity", () => {
    const childPromise = Promise.resolve<Rows>([{ id: "child" }]);
    const child = vi.fn(() => childPromise);
    const capture = vi.fn(ignoreRegistration);
    const contextReads: PropertyKey[] = [];
    const hostileContext = new Proxy(modelContext("findMany"), {
      get(_target, key) {
        contextReads.push(key);
        throw new Error(`Unexpected query-context read: ${String(key)}`);
      },
      getOwnPropertyDescriptor(_target, key) {
        contextReads.push(key);
        throw new Error(
          `Unexpected query-context descriptor read: ${String(key)}`
        );
      },
      has(_target, key) {
        contextReads.push(key);
        throw new Error(
          `Unexpected query-context membership read: ${String(key)}`
        );
      },
      ownKeys() {
        contextReads.push("ownKeys");
        throw new Error("Unexpected query-context key scan");
      },
    });

    expect(
      runQueryInterceptors(hostileContext, undefined, child, capture)
    ).toBe(childPromise);
    expect(runQueryInterceptors(hostileContext, [], child, capture)).toBe(
      childPromise
    );
    expect(child).toHaveBeenCalledTimes(2);
    expect(capture).not.toHaveBeenCalled();
    expect(contextReads).toEqual([]);
  });

  test("composes A to B to C in nested application order", async () => {
    const order: string[] = [];
    const child = vi.fn(async () => {
      order.push("child");
      return [{ id: "authoritative" }];
    });
    const interceptor = (extension: string): QueryInterceptor<Rows> => ({
      extension,
      async handler({ proceed }) {
        order.push(`${extension}-in`);
        const rows = await proceed();
        order.push(`${extension}-out`);
        return rows;
      },
    });

    await expect(
      runQueryInterceptors<Rows>(
        modelContext("findMany"),
        [interceptor("A"), interceptor("B"), interceptor("C")],
        child,
        ignoreRegistration
      )
    ).resolves.toEqual([{ id: "authoritative" }]);
    expect(order).toEqual([
      "A-in",
      "B-in",
      "C-in",
      "child",
      "C-out",
      "B-out",
      "A-out",
    ]);
    expect(child).toHaveBeenCalledOnce();
  });

  test("exposes only frozen operation identity, mode, input, and capabilities", async () => {
    const input = Object.freeze({ where: Object.freeze({ id: "post-1" }) });
    const context: PreparedModelQueryContext<typeof input> = Object.freeze({
      mode: "direct",
      kind: "model",
      model: "post",
      operation: "findUnique",
      input,
    });

    await runQueryInterceptors(
      context,
      [
        {
          extension: "identity",
          async handler(handlerContext) {
            expect(Object.isFrozen(handlerContext)).toBe(true);
            expect(handlerContext.input).toBe(input);
            expect(Object.isFrozen(handlerContext.input)).toBe(true);
            expect(Reflect.ownKeys(handlerContext)).toEqual([
              "mode",
              "kind",
              "model",
              "operation",
              "input",
              "proceed",
              "onWriteOutcome",
            ]);
            expect("program" in handlerContext).toBe(false);
            expect("driver" in handlerContext).toBe(false);
            expect("rows" in handlerContext).toBe(false);
            expect("result" in handlerContext).toBe(false);
            return handlerContext.proceed();
          },
        },
      ],
      async () => [{ id: "post-1" }],
      ignoreRegistration
    );
  });
});

describe("prepared query execution outcomes", () => {
  test("does not publish write outcomes for read operations", async () => {
    const listener = vi.fn();
    const interceptor: QueryInterceptor<Rows> = {
      extension: "read-outcome",
      async handler({ onWriteOutcome, proceed }) {
        onWriteOutcome(listener);
        return proceed();
      },
    };

    await executePreparedQuery(
      modelContext("findMany"),
      [interceptor],
      async () => [{ id: "read" }],
      false
    );

    expect(listener).not.toHaveBeenCalled();
  });

  test("publishes every exact committed segment without a synthetic final duplicate", async () => {
    const certainties: string[] = [];
    const interceptor: QueryInterceptor<Rows> = {
      extension: "segments",
      async handler({ onWriteOutcome, proceed }) {
        onWriteOutcome(({ certainty }) => {
          certainties.push(certainty);
        });
        return proceed();
      },
    };

    await executePreparedQuery(
      modelContext("createMany"),
      [interceptor],
      async (notifications) => {
        await notifications?.committed();
        await notifications?.committed();
        return [{ id: "written" }];
      },
      true
    );

    expect(certainties).toEqual(["committed", "committed"]);
  });
});

describe("query continuation authority", () => {
  test("an eligible direct read can short-circuit and closes detached proceed", async () => {
    let detachedProceed: (() => Promise<Rows>) | undefined;
    const child = vi.fn(async () => [{ id: "child" }]);

    await expect(
      runQueryInterceptors<Rows>(
        modelContext("findMany"),
        [
          {
            extension: "read-cache",
            async handler({ proceed }) {
              detachedProceed = proceed;
              return [{ id: "cached" }];
            },
          },
        ],
        child,
        ignoreRegistration
      )
    ).resolves.toEqual([{ id: "cached" }]);

    if (detachedProceed === undefined) {
      throw new Error("The read interceptor did not expose proceed");
    }
    expect(detachedProceed).toThrowError(QueryError);
    expect(child).not.toHaveBeenCalled();
  });

  test("mutations and every raw family reject no-proceed with extension identity", async () => {
    const mutationChild = vi.fn(async (): Promise<Count> => ({ count: 1 }));
    const mutationError = await captureFailure(
      runQueryInterceptors<Count, Record<string, unknown>>(
        modelContext("updateMany", "transaction"),
        [
          {
            extension: "mutation-no-proceed",
            async handler() {
              return { count: 99 };
            },
          },
        ],
        mutationChild,
        ignoreRegistration
      )
    );
    expect(requireQueryError(mutationError).message).toContain(
      'Extension "mutation-no-proceed"'
    );
    expect(mutationChild).not.toHaveBeenCalled();

    const rawCases: readonly {
      readonly kind: RawKind;
      readonly operation:
        | "$queryRaw"
        | "$executeRaw"
        | "$queryRawUnsafe"
        | "$executeRawUnsafe";
    }[] = [
      { kind: "queryRaw", operation: "$queryRaw" },
      { kind: "executeRaw", operation: "$executeRaw" },
      { kind: "queryRawUnsafe", operation: "$queryRawUnsafe" },
      { kind: "executeRawUnsafe", operation: "$executeRawUnsafe" },
    ];

    for (const rawCase of rawCases) {
      const rawChild = vi.fn(async () => [{ id: "raw" }]);
      const rawError = await captureFailure(
        runQueryInterceptors(
          rawContext(rawCase.kind, rawCase.operation, "transaction"),
          [
            {
              extension: rawCase.kind,
              async handler() {
                return [{ id: "fabricated" }];
              },
            },
          ],
          rawChild,
          ignoreRegistration
        )
      );
      expect(requireQueryError(rawError).message).toContain(
        `Extension "${rawCase.kind}"`
      );
      expect(rawChild).not.toHaveBeenCalled();
    }
  });

  test("a transaction read can short-circuit and reports transaction mode", async () => {
    const child = vi.fn(async () => [{ id: "child" }]);
    await expect(
      runQueryInterceptors(
        modelContext("findMany", "transaction"),
        [
          {
            extension: "transaction-read",
            async handler(handlerContext) {
              expect(handlerContext.mode).toBe("transaction");
              return [{ id: "transaction-cache" }];
            },
          },
        ],
        child,
        ignoreRegistration
      )
    ).resolves.toEqual([{ id: "transaction-cache" }]);
    expect(child).not.toHaveBeenCalled();
  });

  test("array mode refuses read short-circuiting", async () => {
    const child = vi.fn(async () => [{ id: "child" }]);
    const error = await captureFailure(
      runQueryInterceptors(
        modelContext("findMany", "array"),
        [
          {
            extension: "array-read",
            async handler(handlerContext) {
              expect(handlerContext.mode).toBe("array");
              return [{ id: "short-circuit" }];
            },
          },
        ],
        child,
        ignoreRegistration
      )
    );

    expect(requireQueryError(error).message).toContain(
      'Extension "array-read"'
    );
    expect(child).not.toHaveBeenCalled();
  });

  test("a caught double proceed still fails and starts the child once", async () => {
    const child = vi.fn(async () => [{ id: "child" }]);
    let caught: unknown;

    const error = await captureFailure(
      runQueryInterceptors(
        modelContext("findMany"),
        [
          {
            extension: "double-proceed",
            async handler({ proceed }) {
              const childResult = proceed();
              try {
                proceed();
              } catch (error) {
                caught = error;
              }
              await childResult;
              return [{ id: "fabricated" }];
            },
          },
        ],
        child,
        ignoreRegistration
      )
    );

    expect(caught).toBeInstanceOf(QueryError);
    expect(error).toBe(caught);
    expect(requireError(error).message).toContain('Extension "double-proceed"');
    expect(child).toHaveBeenCalledOnce();
  });

  test("preserves a caught protocol failure and a later handler failure", async () => {
    const postFailure = new Error("post-work also failed");
    let protocolFailure: unknown;
    const error = await captureFailure(
      runQueryInterceptors(
        modelContext("findMany"),
        [
          {
            extension: "protocol-and-post",
            async handler({ proceed }) {
              const childResult = proceed();
              try {
                proceed();
              } catch (error) {
                protocolFailure = error;
              }
              await childResult;
              throw postFailure;
            },
          },
        ],
        async () => [{ id: "child" }],
        ignoreRegistration
      )
    );

    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) {
      throw new Error("Expected both extension failures");
    }
    expect(error.cause).toBe(protocolFailure);
    expect(error.errors[0]).toBe(protocolFailure);
    expect(requireQueryError(error.errors[1]).message).toContain(
      'Extension "protocol-and-post"'
    );
  });

  test("preserves child, protocol, and handler failures in deterministic order", async () => {
    const childFailure = new Error("child failed");
    const postFailure = new Error("post-work also failed");
    let protocolFailure: unknown;
    const error = await captureFailure(
      runQueryInterceptors(
        modelContext("findMany"),
        [
          {
            extension: "triple-failure",
            async handler({ proceed }) {
              const childResult = proceed();
              try {
                proceed();
              } catch (error) {
                protocolFailure = error;
              }
              try {
                await childResult;
              } catch {
                // Replace the child rejection with distinct post-work failure.
              }
              throw postFailure;
            },
          },
        ],
        async () => {
          throw childFailure;
        },
        ignoreRegistration
      )
    );

    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) {
      throw new Error("Expected child and extension failure evidence");
    }
    expect(error.cause).toBe(childFailure);
    expect(error.errors[0]).toBe(childFailure);
    expect(error.errors[1]).toBe(protocolFailure);
    expect(requireQueryError(error.errors[2]).message).toContain(
      'Extension "triple-failure"'
    );
  });

  test("a detached mutation proceed cannot start the child after no-proceed refusal", async () => {
    let detachedProceed: (() => Promise<Count>) | undefined;
    const child = vi.fn(async (): Promise<Count> => ({ count: 1 }));

    await expect(
      runQueryInterceptors<Count, Record<string, unknown>>(
        modelContext("deleteMany"),
        [
          {
            extension: "detached-mutation",
            async handler({ proceed }) {
              detachedProceed = proceed;
              return { count: 99 };
            },
          },
        ],
        child,
        ignoreRegistration
      )
    ).rejects.toBeInstanceOf(QueryError);

    if (detachedProceed === undefined) {
      throw new Error("The mutation interceptor did not expose proceed");
    }
    expect(detachedProceed).toThrowError(QueryError);
    expect(child).not.toHaveBeenCalled();
  });

  test("ignores fabricated success after proceed", async () => {
    const childRows = [{ id: "child" }];
    const result = await runQueryInterceptors(
      modelContext("findMany"),
      [
        {
          extension: "fabrication",
          async handler({ proceed }) {
            await proceed();
            return [{ id: "fabricated" }];
          },
        },
      ],
      async () => childRows,
      ignoreRegistration
    );

    expect(result).toBe(childRows);
  });

  test("awaits handler post-work after the child fulfills", async () => {
    let finishPostWork: (() => void) | undefined;
    const postWork = new Promise<void>((resolve) => {
      finishPostWork = resolve;
    });
    let settled = false;
    const running = runQueryInterceptors(
      modelContext("findMany"),
      [
        {
          extension: "post-work-wait",
          async handler({ proceed }) {
            const rows = await proceed();
            await postWork;
            return rows;
          },
        },
      ],
      async () => [{ id: "child" }],
      ignoreRegistration
    ).then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    if (finishPostWork === undefined) {
      throw new Error("Post-work release was not initialized");
    }
    finishPostWork();
    await running;
    expect(settled).toBe(true);
  });

  test("keeps a swallowed child failure authoritative by identity", async () => {
    const childFailure = new Error("child failed");
    const error = await captureFailure(
      runQueryInterceptors(
        modelContext("findMany"),
        [
          {
            extension: "swallow-attempt",
            async handler({ proceed }) {
              try {
                await proceed();
              } catch {
                // The runner, not this handler, owns the child outcome.
              }
              return [{ id: "fabricated" }];
            },
          },
        ],
        async () => {
          throw childFailure;
        },
        ignoreRegistration
      )
    );

    expect(error).toBe(childFailure);
  });

  test("child success plus post-work failure reports the named extension", async () => {
    const postFailure = new Error("post-work failed");
    const error = await captureFailure(
      runQueryInterceptors(
        modelContext("findMany"),
        [
          {
            extension: "post-work",
            async handler({ proceed }) {
              await proceed();
              throw postFailure;
            },
          },
        ],
        async () => [{ id: "child" }],
        ignoreRegistration
      )
    );

    const queryError = requireQueryError(error);
    expect(queryError.message).toContain('Extension "post-work"');
    expect(queryError.originalCause).toBeInstanceOf(Error);
  });

  test("dual failure keeps the child primary and named extension failure second", async () => {
    const childFailure = new Error("child failed");
    const postFailure = new Error("post-work failed");
    const error = await captureFailure(
      runQueryInterceptors(
        modelContext("findMany"),
        [
          {
            extension: "dual-failure",
            async handler({ proceed }) {
              try {
                await proceed();
              } catch {
                // Deliberately replace the child rejection with a post failure.
              }
              throw postFailure;
            },
          },
        ],
        async () => {
          throw childFailure;
        },
        ignoreRegistration
      )
    );

    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) {
      throw new Error("Expected dual failure evidence");
    }
    expect(error.cause).toBe(childFailure);
    expect(error.errors[0]).toBe(childFailure);
    expect(error.errors[1]).toBeInstanceOf(QueryError);
    const extensionFailure = requireQueryError(error.errors[1]);
    expect(extensionFailure.message).toContain('Extension "dual-failure"');
  });

  test("keeps the child primary when hostile query post-work hides Error identity", async () => {
    const childFailure = new Error("child failed");
    const hostilePostFailure = new Proxy(
      new Error("private query post-work failure"),
      {
        getPrototypeOf() {
          throw new Error("hostile query prototype read");
        },
      }
    );
    const error = await captureFailure(
      runQueryInterceptors(
        modelContext("findMany"),
        [
          {
            extension: "hostile-query-error",
            async handler({ proceed }) {
              try {
                await proceed();
              } catch {
                // Deliberately replace the child rejection with hostile post-work.
              }
              throw hostilePostFailure;
            },
          },
        ],
        async () => {
          throw childFailure;
        },
        ignoreRegistration
      )
    );

    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) {
      throw new Error("Expected child and hostile post-work evidence");
    }
    expect(error.cause).toBe(childFailure);
    expect(error.errors[0]).toBe(childFailure);
    const extensionFailure = requireQueryError(error.errors[1]);
    expect(extensionFailure.message).toContain(
      'Extension "hostile-query-error"'
    );
    expect(extensionFailure.originalCause).toBeInstanceOf(Error);
    expect(extensionFailure.originalCause).not.toBe(hostilePostFailure);
  });

  test("nested dual failures retain the original child and suppression order", async () => {
    const childFailure = new Error("child failed");
    const error = await captureFailure(
      runQueryInterceptors(
        modelContext("findMany"),
        [
          {
            extension: "outer",
            async handler({ proceed }) {
              try {
                await proceed();
              } catch {
                // Replace the inner chain failure with outer post-work failure.
              }
              throw new Error("outer post-work failed");
            },
          },
          {
            extension: "inner",
            async handler({ proceed }) {
              try {
                await proceed();
              } catch {
                // Replace the child failure with inner post-work failure.
              }
              throw new Error("inner post-work failed");
            },
          },
        ],
        async () => {
          throw childFailure;
        },
        ignoreRegistration
      )
    );

    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) {
      throw new Error("Expected outer dual failure evidence");
    }
    expect(error.errors[1]).toBeInstanceOf(QueryError);
    const outerFailure = requireQueryError(error.errors[1]);
    expect(outerFailure.message).toContain('Extension "outer"');
    expect(error.cause).toBeInstanceOf(AggregateError);
    if (!(error.cause instanceof AggregateError)) {
      throw new Error("Expected nested inner dual failure evidence");
    }
    expect(error.errors[0]).toBe(error.cause);
    expect(error.cause.cause).toBe(childFailure);
    expect(error.cause.errors[0]).toBe(childFailure);
    expect(error.cause.errors[1]).toBeInstanceOf(QueryError);
    const innerFailure = requireQueryError(error.cause.errors[1]);
    expect(innerFailure.message).toContain('Extension "inner"');
  });
});

describe("query write-outcome registration", () => {
  test("captures listeners in registration order across nested handlers", async () => {
    const registrations: WriteOutcomeRegistration[] = [];
    const listenerA: WriteOutcomeListener = () => undefined;
    const listenerB1: WriteOutcomeListener = () => undefined;
    const listenerB2: WriteOutcomeListener = () => undefined;

    await runQueryInterceptors(
      modelContext("update"),
      [
        {
          extension: "A",
          async handler({ proceed, onWriteOutcome }) {
            onWriteOutcome(listenerA);
            return proceed();
          },
        },
        {
          extension: "B",
          async handler({ proceed, onWriteOutcome }) {
            onWriteOutcome(listenerB1);
            onWriteOutcome(listenerB2);
            return proceed();
          },
        },
      ],
      async () => [{ id: "updated" }],
      (registration) => registrations.push(registration)
    );

    expect(registrations.map(({ extension }) => extension)).toEqual([
      "A",
      "B",
      "B",
    ]);
    expect(registrations.map(({ listener }) => listener)).toEqual([
      listenerA,
      listenerB1,
      listenerB2,
    ]);
    expect(registrations.every(Object.isFrozen)).toBe(true);
  });

  test("late registration throws synchronously, records the violation, and has no effect", async () => {
    const registrations: WriteOutcomeRegistration[] = [];
    const before: WriteOutcomeListener = () => undefined;
    const late: WriteOutcomeListener = () => undefined;
    let caught: unknown;

    const error = await captureFailure(
      runQueryInterceptors(
        modelContext("update"),
        [
          {
            extension: "late-registration",
            async handler({ proceed, onWriteOutcome }) {
              onWriteOutcome(before);
              const childResult = proceed();
              try {
                onWriteOutcome(late);
              } catch (error) {
                caught = error;
              }
              return childResult;
            },
          },
        ],
        async () => [{ id: "updated" }],
        (registration) => registrations.push(registration)
      )
    );

    expect(caught).toBeInstanceOf(QueryError);
    expect(error).toBe(caught);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.listener).toBe(before);
  });

  test("rejects a hostile non-function listener before capture even when caught", async () => {
    const registrations: WriteOutcomeRegistration[] = [];
    let caught: unknown;
    const error = await captureFailure(
      runQueryInterceptors(
        modelContext("update"),
        [
          {
            extension: "invalid-listener",
            async handler({ proceed, onWriteOutcome }) {
              try {
                // @ts-expect-error - runtime falsifier for hostile JavaScript
                onWriteOutcome(1);
              } catch (error) {
                caught = error;
              }
              return proceed();
            },
          },
        ],
        async () => [{ id: "updated" }],
        (registration) => registrations.push(registration)
      )
    );

    expect(caught).toBeInstanceOf(QueryError);
    expect(error).toBe(caught);
    expect(registrations).toEqual([]);
  });
});

describe("hostile query thenables", () => {
  test("attributes a hostile handler thenable to its extension", async () => {
    const thenFailure = new Error("handler then getter failed");
    const hostileThenable = Object.defineProperty({}, "then", {
      get() {
        throw thenFailure;
      },
    });
    const interceptor: QueryInterceptor<Rows> = {
      extension: "hostile-handler",
      // @ts-expect-error - runtime falsifier for hostile JavaScript
      handler() {
        return hostileThenable;
      },
    };

    const error = await captureFailure(
      runQueryInterceptors(
        modelContext("findMany"),
        [interceptor],
        async () => [{ id: "child" }],
        ignoreRegistration
      )
    );

    expect(requireQueryError(error).message).toContain(
      'Extension "hostile-handler"'
    );
  });

  test("keeps a hostile child thenable failure authoritative", async () => {
    const childFailure = new Error("child then getter failed");
    const hostileThenable = Object.defineProperty({}, "then", {
      get() {
        throw childFailure;
      },
    });

    const error = await captureFailure(
      runQueryInterceptors(
        modelContext("findMany"),
        [
          {
            extension: "child-thenable",
            async handler({ proceed }) {
              try {
                await proceed();
              } catch {
                // The runner still publishes the child rejection.
              }
              return [{ id: "fabricated" }];
            },
          },
        ],
        // @ts-expect-error - runtime falsifier for hostile JavaScript
        () => hostileThenable,
        ignoreRegistration
      )
    );

    expect(error).toBe(childFailure);
  });
});
