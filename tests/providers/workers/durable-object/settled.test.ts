/**
 * `watch`, `settled` and `viborm/on` on a Durable Object, where a transaction
 * at any depth is a `storage.transaction()` and an array has no native batch:
 * each is told after the outermost commit, once per committed write; a
 * savepoint that fails and is caught drops what it registered; a rollback
 * tells nothing; a nested transaction that fails unawaited fails the outer
 * one, and leaves no unhandled rejection in workerd. workerd reports a
 * rejection no handler holds by the end of its microtask, where Node waits
 * for the queue to drain: a rolled back transaction, under no extension or a
 * `unit` part, is held here, where a layer test in Node cannot see it.
 */
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { createClient } from "@src/drivers/durable-object";
import {
  call,
  extension,
  settled,
  target,
  unit,
  watch,
  writes,
} from "@src/index";
import { createMigrationClient } from "@src/migrations/client";
import { on } from "@src/on";
import { s } from "@src/schema";
import { describe, expect, test } from "vitest";
import { inObject } from "./objects";

const user = s.model({ id: s.string().id(), name: s.string() });
const schema = { user };

function clientOf(storage: DurableObjectStorage) {
  return createClient({ storage, schema });
}

/** A fresh object with two users, under a chain that logs what it is told. */
function withLogged<T>(
  fn: (
    db: ReturnType<typeof extend>,
    log: string[],
    names: () => Promise<string[]>
  ) => Promise<T>
): Promise<T> {
  return inObject(async (state) => {
    const base = clientOf(state.storage);
    const migrations = createMigrationClient(base);
    const preview = await migrations.push({ dryRun: true });
    await migrations.push({ consent: preview.consent });
    await base.user.createMany({
      data: [
        { id: "u1", name: "Ada" },
        { id: "u2", name: "Bob" },
      ],
    });
    const log: string[] = [];
    const names = async () =>
      (await base.user.findMany({ orderBy: { id: "asc" } })).map(
        (row) => row.name
      );
    return fn(extend(base, log), log, names);
  });
}

function extend(base: ReturnType<typeof clientOf>, log: string[]) {
  return base
    .$extends(
      extension(
        "told",
        call((c) => {
          watch(c, {
            wants: () => true,
            rows: (_model, kind, rows) => {
              log.push(
                `watch ${kind} ${rows.map((row) => row.name).join(",")}`
              );
            },
          });
          settled(c, ({ certainty }) => {
            log.push(`settled ${certainty}`);
          });
        }, target(writes))
      )
    )
    .$extends(
      on({
        user: {
          update: (rows) => {
            log.push(`on ${rows.map((row) => row.name).join(",")}`);
          },
        },
      })
    );
}

const rename = (id: string, name: string) => ({
  where: { id },
  data: { name },
});

describe("Durable Object: settled and on() in transactions", () => {
  test("a callback: told after the commit, a caught savepoint's writes dropped, a committed one's kept", async () => {
    await withLogged(async (db, log, names) => {
      await db.$transaction(async (tx) => {
        await tx.user.update(rename("u1", "Outer"));
        await tx
          .$transaction(async (nested) => {
            await nested.user.update(rename("u2", "Dropped"));
            throw new TypeError("nested refuses");
          })
          .catch(() => undefined);
        await tx.$transaction(async (nested) => {
          await nested.user.update(rename("u2", "Kept"));
        });
        log.push("body done");
      });
      expect(await names()).toEqual(["Outer", "Kept"]);
      // Rows as each write is made; after the commit, what each extension
      // registered, interleaved write by write.
      expect(log.slice(0, 4)).toEqual([
        "watch update Outer",
        "watch update Dropped",
        "watch update Kept",
        "body done",
      ]);
      expect(log.slice(4).sort()).toEqual([
        "on Kept",
        "on Outer",
        "settled committed",
        "settled committed",
      ]);
    });
  });

  test("an array: each member told after the commit, in order", async () => {
    await withLogged(async (db, log, names) => {
      await db.$transaction([
        db.user.update(rename("u1", "One")),
        db.user.update(rename("u2", "Two")),
      ]);
      expect(await names()).toEqual(["One", "Two"]);
      expect(log.filter((line) => !line.startsWith("watch"))).toEqual([
        "settled committed",
        "on One",
        "settled committed",
        "on Two",
      ]);
    });
  });

  test("a rollback, of a callback or of an array, tells nothing after it", async () => {
    await withLogged(async (db, log, names) => {
      await db
        .$transaction(async (tx) => {
          await tx.user.update(rename("u1", "Gone"));
          throw new TypeError("undo");
        })
        .catch(() => undefined);
      await db
        .$transaction([
          db.user.update(rename("u1", "Gone too")),
          db.user.update(rename("nobody", "Missing")),
        ])
        .catch(() => undefined);
      expect(await names()).toEqual(["Ada", "Bob"]);
      expect(log.filter((line) => !line.startsWith("watch"))).toEqual([]);
    });
  });

  test("a nested transaction that fails unawaited fails the outer one: nothing commits, nothing is told", async () => {
    await withLogged(async (db, log, names) => {
      const failed = await db
        .$transaction(async (tx) => {
          await tx.user.update(rename("u1", "Outer"));
          tx.$transaction(async (nested) => {
            await nested.user.update(rename("u2", "Nested"));
            throw new TypeError("unobserved nested failure");
          });
        })
        .catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(Error);
      expect(await names()).toEqual(["Ada", "Bob"]);
      expect(log.filter((line) => !line.startsWith("watch"))).toEqual([]);
    });
  });
});

/** The rejections workerd reports unhandled while `run` ran. */
async function unhandledDuring(run: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const listener = (event: PromiseRejectionEvent) => {
    unhandled.push(event.reason);
  };
  addEventListener("unhandledrejection", listener);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    removeEventListener("unhandledrejection", listener);
  }
  return unhandled;
}

const bare = {
  plain: (base: ReturnType<typeof clientOf>) => base,
  unit: (base: ReturnType<typeof clientOf>) =>
    base.$extends(
      extension(
        "unit",
        unit((_u, next) => next())
      )
    ),
};

for (const [name, extendBare] of Object.entries(bare))
  describe(`Durable Object, ${name}: a rollback leaves no unhandled rejection`, () => {
    test("a callback that throws, and an array whose member fails", async () => {
      await inObject(async (state) => {
        const base = clientOf(state.storage);
        const migrations = createMigrationClient(base);
        const preview = await migrations.push({ dryRun: true });
        await migrations.push({ consent: preview.consent });
        await base.user.create({ data: { id: "u1", name: "Ada" } });
        const db = extendBare(base);
        const failures: unknown[] = [];
        const unhandled = await unhandledDuring(async () => {
          failures.push(
            await db
              .$transaction(async (tx) => {
                await tx.user.update(rename("u1", "Gone"));
                throw new TypeError("undo");
              })
              .catch((error: unknown) => error),
            await db
              .$transaction([
                db.user.update(rename("u1", "Gone too")),
                db.user.update(rename("nobody", "Missing")),
              ])
              .catch((error: unknown) => error)
          );
        });
        expect(failures).toHaveLength(2);
        expect(unhandled).toEqual([]);
        expect((await base.user.findMany()).map((row) => row.name)).toEqual([
          "Ada",
        ]);
      });
    });
  });
