/**
 * The runner of `around`'s second moments (`src/extensions/query.ts`): what
 * runs each part's second moment around the prepared call, the first
 * applied outermost, and what makes the child's outcome the call's.
 *
 * Each second moment here is the function an `around` part's first moment
 * returns: it receives `run` from the runner and calls it, or answers
 * without it where a call allows. What a client-level test would only reach
 * through a driver's timing (a child that never settles, a hostile
 * thenable, a commit certainty) is driven on the runner itself; what an
 * application writes (`settled`) runs on a client.
 */
import { createClient } from "@client/client";
import { QueryError, retainWriteOutcomeFailure } from "@errors";
import type { ResolvedOperationHandler } from "@extensions/chain";
import {
  type AroundRunner,
  executePreparedQuery,
  type PreparedModelQueryContext,
  type PreparedRawQueryContext,
  publishWriteOutcomes,
  type QueryInterceptionMode,
  type RawQueryKind,
  runArounds,
  TransactionWriteOutcomes,
  type WriteOutcomeListener,
  type WriteOutcomeNotifications,
  type WriteOutcomeRegistration,
} from "@extensions/query";
import { s } from "@schema";
import { sql } from "@sql";
import {
  around,
  call,
  extension,
  methods,
  settled,
  target,
  writes,
} from "@src/index";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test, vi } from "vitest";

type Rows = { id: string }[];
type Count = { count: number };
type Run = () => Promise<unknown>;

/** One `around` part's second moment, as the runner calls it. */
function second(
  extension: string,
  moment: (run: Run) => unknown
): ResolvedOperationHandler<AroundRunner> {
  return { extension, handler: (_prepared, run) => moment(run) };
}

const ignoreRegistration = (_registration: WriteOutcomeRegistration): void =>
  undefined;

/** The runner over `parts`, around `child`. */
const runSeconds = <Result>(
  context: PreparedModelQueryContext<object> | PreparedRawQueryContext<object>,
  parts: readonly ResolvedOperationHandler<AroundRunner>[] | undefined,
  child: () => Promise<Result>
): Promise<Result> => runArounds(context, parts, child, ignoreRegistration);

function modelContext(
  operation: string,
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

function rawContext(
  kind: RawQueryKind,
  mode: QueryInterceptionMode = "direct"
): PreparedRawQueryContext<Record<string, unknown>> {
  return Object.freeze({
    mode,
    kind,
    model: undefined,
    operation: `$${kind}`,
    input: Object.freeze({}),
  });
}

async function captureFailure(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the runner to fail");
}

function requireQueryError(error: unknown): QueryError {
  if (!(error instanceof QueryError)) throw new Error("Expected a QueryError");
  return error;
}

const post = s.model({ id: s.string().id(), title: s.string() });
const clients: { $disconnect(): Promise<void> }[] = [];

async function seededClient() {
  const client = createClient({
    schema: { post },
    driver: createInMemorySQLite3Driver(),
  });
  clients.push(client);
  await syncLiveSchema(client);
  await client.post.create({ data: { id: "p1", title: "one" } });
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

describe("the runner of second moments", () => {
  test("a call without second moments runs its child, and returns its promise itself", () => {
    const childPromise = Promise.resolve<Rows>([{ id: "child" }]);
    const child = vi.fn(() => childPromise);
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

    expect(runSeconds(hostileContext, undefined, child)).toBe(childPromise);
    expect(runSeconds(hostileContext, [], child)).toBe(childPromise);
    expect(child).toHaveBeenCalledTimes(2);
    expect(contextReads).toEqual([]);
  });

  test("nests A around B around C, the first applied outermost", async () => {
    const order: string[] = [];
    const child = vi.fn(async () => {
      order.push("child");
      return [{ id: "authoritative" }];
    });
    const part = (name: string) =>
      second(name, async (run) => {
        order.push(`${name}-in`);
        const rows = await run();
        order.push(`${name}-out`);
        return rows;
      });

    await expect(
      runSeconds(
        modelContext("findMany"),
        [part("A"), part("B"), part("C")],
        child
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

  test("keeps the no-context path as the exact child promise", () => {
    const childPromise = Promise.resolve("direct");
    const child = vi.fn(() => childPromise);

    expect(executePreparedQuery(undefined, undefined, child, false)).toBe(
      childPromise
    );
    expect(child).toHaveBeenCalledOnce();
  });

  test("publishes every committed segment the child reports, without a final duplicate", async () => {
    const certainties: string[] = [];
    const listener: WriteOutcomeListener = ({ certainty }) => {
      certainties.push(certainty);
    };

    await executePreparedQuery(
      modelContext("createMany"),
      [
        {
          extension: "segments",
          handler: (_prepared, run, register) => {
            register(listener);
            return run();
          },
        },
      ],
      async (notifications) => {
        await notifications?.committed();
        await notifications?.committed();
        return [{ id: "written" }];
      },
      true
    );

    expect(certainties).toEqual(["committed", "committed"]);
  });

  test("an array member's failure after run is the call's, the one the admission is told", async () => {
    const postWorkFailure = new Error("array post-work failed");
    let rejectChild: ((reason: unknown) => void) | undefined;
    const childPromise = new Promise<Rows>((_resolve, reject) => {
      rejectChild = reject;
    });

    const failure = await captureFailure(
      executePreparedQuery(
        modelContext("create", "array"),
        [
          second("array-post-work", (run) => {
            // biome-ignore lint/complexity/noVoid: the run is deliberately left floating; the discard marks that
            void run();
            throw postWorkFailure;
          }),
        ],
        () => childPromise,
        true,
        undefined,
        {
          reportAdmissionFailure(admissionFailure) {
            if (rejectChild === undefined) {
              throw new Error("Child rejection was not initialized");
            }
            rejectChild(admissionFailure);
          },
        }
      )
    );

    expect(failure).toBe(postWorkFailure);
  });
});

describe("the child's outcome is the call's", () => {
  test("a second moment that throws before run fails the call, and the child never starts", async () => {
    const handlerFailure = new Error("handler threw synchronously");
    const child = vi.fn(async () => [{ id: "child" }]);

    const failure = await captureFailure(
      runSeconds(
        modelContext("findMany"),
        [
          second("sync-handler", () => {
            throw handlerFailure;
          }),
        ],
        child
      )
    );

    expect(failure).toBe(handlerFailure);
    expect(child).not.toHaveBeenCalled();
  });

  test("a child that throws synchronously fails the call with its error", async () => {
    const childFailure = new Error("child threw synchronously");

    const failure = await captureFailure(
      runSeconds(
        modelContext("findMany"),
        [second("sync-child", (run) => run())],
        () => {
          throw childFailure;
        }
      )
    );

    expect(failure).toBe(childFailure);
  });

  test("a write, and every raw family, refuse a second moment that answers without run, naming its extension", async () => {
    const mutationChild = vi.fn(async (): Promise<Count> => ({ count: 1 }));
    const mutationError = await captureFailure(
      runSeconds(
        modelContext("updateMany", "transaction"),
        [second("mutation-no-run", () => ({ count: 99 }))],
        mutationChild
      )
    );
    expect(requireQueryError(mutationError).message).toContain(
      'Extension "mutation-no-run"'
    );
    expect(mutationChild).not.toHaveBeenCalled();

    for (const kind of [
      "queryRaw",
      "executeRaw",
      "queryRawUnsafe",
      "executeRawUnsafe",
    ] as const) {
      const rawChild = vi.fn(async () => [{ id: "raw" }]);
      const rawError = await captureFailure(
        runSeconds(
          rawContext(kind, "transaction"),
          [second(kind, () => [{ id: "fabricated" }])],
          rawChild
        )
      );
      expect(requireQueryError(rawError).message).toContain(
        `Extension "${kind}"`
      );
      expect(rawChild).not.toHaveBeenCalled();
    }
  });

  test("an array member's read may not answer without run", async () => {
    const child = vi.fn(async () => [{ id: "child" }]);
    const error = await captureFailure(
      runSeconds(
        modelContext("findMany", "array"),
        [second("array-read", () => [{ id: "short-circuit" }])],
        child
      )
    );

    expect(requireQueryError(error).message).toContain(
      'Extension "array-read"'
    );
    expect(child).not.toHaveBeenCalled();
  });

  test("a second run, even caught, fails the call, and the child runs once", async () => {
    const child = vi.fn(async () => [{ id: "child" }]);
    let caught: unknown;

    const error = await captureFailure(
      runSeconds(
        modelContext("findMany"),
        [
          second("double-run", async (run) => {
            const childResult = run();
            try {
              await run();
            } catch (failure) {
              caught = failure;
            }
            await childResult;
            return [{ id: "fabricated" }];
          }),
        ],
        child
      )
    );

    expect(caught).toBeInstanceOf(QueryError);
    expect(error).toBe(caught);
    expect(requireQueryError(error).message).toContain(
      'Extension "double-run"'
    );
    expect(child).toHaveBeenCalledOnce();
  });

  test("an uncaught second run fails the call with that refusal", async () => {
    const child = vi.fn(async () => [{ id: "child" }]);

    const failure = await captureFailure(
      runSeconds(
        modelContext("findMany"),
        [
          second("uncaught-double-run", (run) => {
            // biome-ignore lint/complexity/noVoid: the first run is deliberately left floating; the discard marks that
            void run();
            return run();
          }),
        ],
        child
      )
    );

    expect(requireQueryError(failure).message).toContain(
      "called run() more than once"
    );
    expect(child).toHaveBeenCalledOnce();
  });

  test("a caught refusal is the call's failure, not what the second moment throws later", async () => {
    const postFailure = new Error("post-work also failed");
    let refusal: unknown;
    const error = await captureFailure(
      runSeconds(
        modelContext("findMany"),
        [
          second("refusal-and-post", async (run) => {
            const childResult = run();
            try {
              await run();
            } catch (failure) {
              refusal = failure;
            }
            await childResult;
            throw postFailure;
          }),
        ],
        async () => [{ id: "child" }]
      )
    );

    expect(error).toBe(refusal);
  });

  test("the child's failure wins over a refusal and over what the second moment throws", async () => {
    const childFailure = new Error("child failed");
    const postFailure = new Error("post-work also failed");
    let refusal: unknown;
    const error = await captureFailure(
      runSeconds(
        modelContext("findMany"),
        [
          second("triple-failure", async (run) => {
            const childResult = run();
            try {
              await run();
            } catch (failure) {
              refusal = failure;
            }
            try {
              await childResult;
            } catch {
              // Replaced below by a failure of the second moment's own.
            }
            throw postFailure;
          }),
        ],
        async () => {
          throw childFailure;
        }
      )
    );

    expect(error).toBe(childFailure);
    expect(refusal).toBeInstanceOf(QueryError);
  });

  test("a write's run kept past its refusal never starts the child", async () => {
    let kept: Run | undefined;
    const child = vi.fn(async (): Promise<Count> => ({ count: 1 }));

    await expect(
      runSeconds(
        modelContext("deleteMany"),
        [
          second("kept-run", (run) => {
            kept = run;
            return { count: 99 };
          }),
        ],
        child
      )
    ).rejects.toBeInstanceOf(QueryError);

    if (kept === undefined) throw new Error("The second moment kept no run");
    expect(kept).toThrowError(QueryError);
    expect(child).not.toHaveBeenCalled();
  });

  test("the value a second moment returns after run is the call's", async () => {
    const result = await runSeconds(
      modelContext("findMany"),
      [
        second("fabrication", async (run) => {
          await run();
          return [{ id: "fabricated" }];
        }),
      ],
      async () => [{ id: "child" }]
    );

    expect(result).toEqual([{ id: "fabricated" }]);
  });

  test("the call waits for the second moment's work after the child fulfilled", async () => {
    let finishPostWork: (() => void) | undefined;
    const postWork = new Promise<void>((resolve) => {
      finishPostWork = resolve;
    });
    let done = false;
    const running = runSeconds(
      modelContext("findMany"),
      [
        second("post-work-wait", async (run) => {
          const rows = await run();
          await postWork;
          return rows;
        }),
      ],
      async () => [{ id: "child" }]
    ).then(() => {
      done = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    if (finishPostWork === undefined) {
      throw new Error("Post-work release was not initialized");
    }
    finishPostWork();
    await running;
    expect(done).toBe(true);
  });

  test("a child failure the second moment swallows is still the call's, by identity", async () => {
    const childFailure = new Error("child failed");
    const error = await captureFailure(
      runSeconds(
        modelContext("findMany"),
        [
          second("swallow-attempt", async (run) => {
            try {
              await run();
            } catch {
              // The runner, not this second moment, owns the child outcome.
            }
            return [{ id: "fabricated" }];
          }),
        ],
        async () => {
          throw childFailure;
        }
      )
    );

    expect(error).toBe(childFailure);
  });

  test("after a child that succeeded, what the second moment throws is the call's failure", async () => {
    const postFailure = new Error("post-work failed");
    const error = await captureFailure(
      runSeconds(
        modelContext("findMany"),
        [
          second("post-work", async (run) => {
            await run();
            throw postFailure;
          }),
        ],
        async () => [{ id: "child" }]
      )
    );

    expect(error).toBe(postFailure);
  });

  test("when both fail, the call fails with the child's failure alone", async () => {
    const childFailure = new Error("child failed");
    const error = await captureFailure(
      runSeconds(
        modelContext("findMany"),
        [
          second("dual-failure", async (run) => {
            try {
              await run();
            } catch {
              // Deliberately replaced by a failure of the second moment's own.
            }
            throw new Error("post-work failed");
          }),
        ],
        async () => {
          throw childFailure;
        }
      )
    );

    expect(error).toBe(childFailure);
  });

  test("the child's failure wins over a later failure that hides its Error identity", async () => {
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
      runSeconds(
        modelContext("findMany"),
        [
          second("hostile-query-error", async (run) => {
            try {
              await run();
            } catch {
              // Deliberately replaced by a hostile failure.
            }
            throw hostilePostFailure;
          }),
        ],
        async () => {
          throw childFailure;
        }
      )
    );

    expect(error).toBe(childFailure);
  });

  test("through nested second moments, the original child's failure is the call's", async () => {
    const childFailure = new Error("child failed");
    const replacing = (name: string) =>
      second(name, async (run) => {
        try {
          await run();
        } catch {
          // Replaced by a failure of this second moment's own.
        }
        throw new Error(`${name} post-work failed`);
      });
    const error = await captureFailure(
      runSeconds(
        modelContext("findMany"),
        [replacing("outer"), replacing("inner")],
        async () => {
          throw childFailure;
        }
      )
    );

    expect(error).toBe(childFailure);
  });

  test("every refusal after the first one throws that first refusal", async () => {
    const child = vi.fn(async (): Promise<Rows> => [{ id: "child" }]);
    const thrown: unknown[] = [];

    const failure = await captureFailure(
      runSeconds(
        modelContext("findMany"),
        [
          second("repeatedly-illegal", (run) => {
            const first = run();
            for (const _attempt of [1, 2]) {
              try {
                // biome-ignore lint/complexity/noVoid: each refused run throws before it returns a promise
                void run();
              } catch (error) {
                thrown.push(error);
              }
            }
            return first;
          }),
        ],
        child
      )
    );

    expect(thrown).toHaveLength(2);
    expect(thrown[0]).toBe(thrown[1]);
    expect(requireQueryError(thrown[0]).message).toContain(
      "called run() more than once"
    );
    expect(failure).toBe(thrown[0]);
  });
});

describe("settled, as the runner tells it", () => {
  test("is told in the order the extensions registered, after the write", async () => {
    const told: string[] = [];
    const registering = (name: string, labels: readonly string[]) =>
      extension(
        name,
        around((c) => {
          for (const label of labels)
            settled(c, ({ certainty }) => {
              told.push(`${label}:${certainty}`);
            });
          return (run) => run();
        }, target(writes))
      );
    const db = (await seededClient())
      .$extends(registering("A", ["A"]))
      .$extends(registering("B", ["B1", "B2"]));

    await db.post.update({ where: { id: "p1" }, data: { title: "two" } });

    expect(told).toEqual(["A:committed", "B1:committed", "B2:committed"]);
  });

  test("a raw statement's first moment hears an execute's outcome, never a read's", async () => {
    const told: string[] = [];
    const db = (await seededClient()).$extends(
      extension(
        "raw-outcomes",
        around((c) => {
          if (c.kind === "raw")
            settled(c, ({ certainty }) => {
              told.push(`${c.operation}:${certainty}`);
            });
          return (run) => run();
        })
      )
    );

    await db.$queryRaw`SELECT id FROM post`;
    expect(told).toEqual([]);
    await db.$executeRaw(sql`UPDATE post SET title = ${"three"}`);
    expect(told).toEqual(["$executeRaw:committed"]);
  });
});

describe("an array a part hears without wrapping it", () => {
  test("a read member runs bare, a write under its registration, told after the commit; a failed array tells nothing", async () => {
    const told: string[] = [];
    const db = (await seededClient()).$extends(
      extension(
        "hears",
        call((c) => {
          settled(c, ({ certainty }) => {
            told.push(`${c.operation}:${certainty}`);
          });
        }, target(writes))
      )
    );

    await expect(
      db.$transaction([
        db.post.findMany({ select: { id: true } }),
        db.post.update({ where: { id: "p1" }, data: { title: "two" } }),
      ])
    ).resolves.toEqual([[{ id: "p1" }], { id: "p1", title: "two" }]);
    expect(told).toEqual(["update:committed"]);

    told.length = 0;
    // The first member fails: the second is never read, and the rollback
    // tells neither.
    await expect(
      db.$transaction([
        db.post.create({ data: { id: "p1", title: "duplicate" } }),
        db.post.update({ where: { id: "p1" }, data: { title: "three" } }),
      ])
    ).rejects.toThrow();
    expect(told).toEqual([]);
    await expect(db.post.findMany()).resolves.toEqual([
      { id: "p1", title: "two" },
    ]);
  });
});

describe("settled in a transaction whose chain hears no writes", () => {
  // What settled registers waits in the transaction's scope, whose
  // collector the word installs: told after the commit, never before it,
  // never after a rollback, whatever else the chain holds.
  const told: string[] = [];
  const raw = extension(
    "raw-outcomes",
    around((c) => {
      if (c.kind === "raw")
        settled(c, ({ certainty }) => {
          told.push(`raw:${certainty}`);
        });
      return (run) => run();
    })
  );
  const scoped = extension(
    "scoped",
    methods((scope) => ({
      $after: () =>
        settled(scope, ({ certainty }) => {
          told.push(`method:${certainty}`);
        }),
    }))
  );

  test("a raw statement's settled is told after the commit, and never after a rollback", async () => {
    told.length = 0;
    const db = (await seededClient()).$extends(raw);
    await db.$transaction(async (tx) => {
      await tx.$executeRaw(sql`DELETE FROM post`);
      told.push("body-end");
    });
    expect(told).toEqual(["body-end", "raw:committed"]);
    told.length = 0;
    await db.$transaction([db.$executeRaw(sql`DELETE FROM post`)]);
    expect(told).toEqual(["raw:committed"]);
    told.length = 0;
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw(sql`DELETE FROM post`);
        throw new Error("rolled back");
      })
    ).rejects.toThrow("rolled back");
    expect(told).toEqual([]);
    await expect(db.$executeRaw(sql`DELETE FROM post`)).resolves.toBe(0);
    expect(told).toEqual(["raw:committed"]);
  });

  test("a method's settled is told after the outermost commit; a savepoint rolled back tells nothing", async () => {
    told.length = 0;
    const db = (await seededClient()).$extends(scoped);
    await db.$transaction(async (tx) => {
      await tx.$transaction(async (inner) => {
        await inner.$after();
      });
      await tx
        .$transaction(async (inner) => {
          await inner.$after();
          throw new Error("savepoint rolled back");
        })
        .catch(() => undefined);
      told.push("body-end");
    });
    expect(told).toEqual(["body-end", "method:committed"]);
  });
});

describe("write-outcome publication", () => {
  test("stages each identity once and promotes only confirmed registrations", async () => {
    const published: string[] = [];
    const confirmed: WriteOutcomeRegistration = Object.freeze({
      extension: "confirmed",
      listener: ({ certainty }) => {
        published.push(`confirmed:${certainty}`);
      },
    });
    const discarded: WriteOutcomeRegistration = Object.freeze({
      extension: "discarded",
      listener: ({ certainty }) => {
        published.push(`discarded:${certainty}`);
      },
    });
    const child = new TransactionWriteOutcomes();
    const parent = new TransactionWriteOutcomes();

    child.stage(confirmed);
    child.stage(confirmed);
    child.stage(discarded);
    child.confirm([confirmed]);
    child.discard([discarded]);
    child.promoteTo(parent);

    await child.publish("committed");
    expect(published).toEqual([]);
    await parent.publish("may-have-committed");
    expect(published).toEqual(["confirmed:may-have-committed"]);
    await parent.publish("committed");
    expect(published).toEqual(["confirmed:may-have-committed"]);
  });

  test("attempts every listener; the first fault rejects and later ones are lost", async () => {
    const boundaryFailure = new Error("official boundary failed");
    const calls: string[] = [];
    const failure = await captureFailure(
      publishWriteOutcomes(
        [
          {
            extension: "ordinary",
            listener() {
              calls.push("ordinary");
              // biome-ignore lint/style/useThrowOnlyError: hostile JavaScript can reject with any value.
              throw "ordinary failure";
            },
          },
          {
            extension: "official",
            failurePolicy: "boundary-owned",
            listener() {
              calls.push("official");
              throw boundaryFailure;
            },
          },
        ],
        { certainty: "committed" }
      )
    );

    expect(calls).toEqual(["ordinary", "official"]);
    expect(requireQueryError(failure).meta).toMatchObject({
      method: "settled",
      commitCertainty: "committed",
    });
  });

  test("keeps one boundary-owned listener failure authoritative by identity", async () => {
    const boundaryFailure = new Error("official boundary failed");

    await expect(
      publishWriteOutcomes(
        [
          {
            extension: "official",
            failurePolicy: "boundary-owned",
            listener() {
              throw boundaryFailure;
            },
          },
        ],
        { certainty: "committed" }
      )
    ).rejects.toBe(boundaryFailure);
  });

  test("retains one or many listener failures behind the execution failure", () => {
    const primary = new Error("execution failed");
    const first = new Error("first listener failed");
    const second = new Error("second listener failed");
    const one = retainWriteOutcomeFailure(primary, first);
    const many = retainWriteOutcomeFailure(
      primary,
      new AggregateError([first, second], "listeners failed")
    );

    expect(one.cause).toBe(primary);
    expect(one.errors).toEqual([primary, first]);
    expect(many.cause).toBe(primary);
    expect(many.errors).toEqual([primary, first, second]);
  });

  test("publishes a pre-registered direct outcome without a query chain", async () => {
    const listener = vi.fn();
    const registration = Object.freeze({
      extension: "pre-registered",
      listener,
    });
    const child = vi.fn(
      async (notifications: WriteOutcomeNotifications | undefined) => {
        await notifications?.mayHaveCommitted();
        return "written";
      }
    );

    await expect(
      executePreparedQuery(
        undefined,
        undefined,
        child,
        true,
        undefined,
        undefined,
        registration
      )
    ).resolves.toBe("written");
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      certainty: "may-have-committed",
    });
  });
});

describe("hostile thenables", () => {
  test("a non-Error rejection after a committed child carries the commit certainty and the extension", async () => {
    const failure = await captureFailure(
      executePreparedQuery(
        modelContext("create"),
        [
          second("committed-post-work", async (run) => {
            await run();
            return Promise.reject("private post-work failure");
          }),
        ],
        async () => ({ count: 1 }),
        true,
        undefined,
        { readCommitCertainty: () => "committed" }
      )
    );
    expect(requireQueryError(failure).meta).toMatchObject({
      commitCertainty: "committed",
    });
    expect(requireQueryError(failure).originalCause).toBeInstanceOf(Error);
    expect(requireQueryError(failure).message).toContain("committed-post-work");
  });

  test("an undefined rejection is a failure of the second moment's own, not an absent refusal", async () => {
    const failure = await captureFailure(
      runSeconds(
        modelContext("findMany"),
        [
          second("undefined-rejection", (run) => {
            // biome-ignore lint/complexity/noVoid: the run is deliberately left floating; the discard marks that
            void run();
            return Promise.reject(undefined);
          }),
        ],
        async () => [{ id: "child" }]
      )
    );

    expect(requireQueryError(failure).message).toContain(
      'Extension "undefined-rejection"'
    );
  });

  test("a thenable whose then getter throws fails the call with that error", async () => {
    const thenFailure = new Error("handler then getter failed");
    const hostileThenable = Object.defineProperty({}, "then", {
      get() {
        throw thenFailure;
      },
    });

    const error = await captureFailure(
      runSeconds(
        modelContext("findMany"),
        [second("hostile-handler", () => hostileThenable)],
        async () => [{ id: "child" }]
      )
    );

    expect(error).toBe(thenFailure);
  });

  test("a child thenable whose then getter throws keeps that failure the call's", async () => {
    const childFailure = new Error("child then getter failed");
    const hostileThenable = Object.defineProperty({}, "then", {
      get() {
        throw childFailure;
      },
    });

    const error = await captureFailure(
      runSeconds(
        modelContext("findMany"),
        [
          second("child-thenable", async (run) => {
            try {
              await run();
            } catch {
              // The runner still publishes the child rejection.
            }
            return [{ id: "fabricated" }];
          }),
        ],
        // @ts-expect-error - runtime falsifier for hostile JavaScript
        () => hostileThenable
      )
    );

    expect(error).toBe(childFailure);
  });
});

describe("coverage low value", () => {
  test("publishes an empty registration set", async () => {
    await expect(
      publishWriteOutcomes([], { certainty: "committed" })
    ).resolves.toBeUndefined();
  });
});
