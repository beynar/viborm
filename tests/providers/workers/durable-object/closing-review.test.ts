/**
 * Closing review of the extension host (2026-11-15), Durable Object lane:
 * failing tracers, loggers, handlers, hooks and cache backends, where a
 * transaction is a `storage.transaction()`. See `../closing-review-cases.ts`.
 * Each answer is the one `c41f3aff3` gives; the lane fails on any unhandled
 * rejection.
 */
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { createClient } from "@src/drivers/durable-object";
import { extension, unit } from "@src/index";
import { createMigrationClient } from "@src/migrations/client";
import { describe, expect, test } from "vitest";
import {
  closingSchema,
  EXERCISED,
  exercise,
  FAILING_HANDLERS,
  FAILING_TRACERS,
  FailingBackend,
  withFailingCache,
  withFailingHook,
  withFailingLogger,
  withTracer,
} from "../closing-review-cases";
import { inObject } from "./objects";

/** A fresh object holding the schema's table. */
function withBase<T>(
  fn: (base: ReturnType<typeof clientOf>) => Promise<T>
): Promise<T> {
  return inObject(async (state) => {
    const base = clientOf(state.storage);
    const migrations = createMigrationClient(base);
    const preview = await migrations.push({ dryRun: true });
    await migrations.push({ consent: preview.consent });
    return fn(base);
  });
}

function clientOf(storage: DurableObjectStorage) {
  return createClient({ storage, schema: closingSchema });
}

/** A transaction whose second write fails, and one the callback abandons. */
async function transactions(db: ReturnType<typeof clientOf>) {
  const seen: string[] = [];
  try {
    await db.$transaction(async (tx) => {
      await tx.record.create({ data: { id: "t1", name: "Tia" } });
      await tx.record.create({ data: { id: "t2", name: "Tia" } });
    });
    seen.push("failing: ok");
  } catch (error) {
    seen.push(`failing: ${(error as Error).name}`);
  }
  try {
    await db.$transaction(async (tx) => {
      await tx.record.create({ data: { id: "t3", name: "Tom" } });
      throw new Error("abandoned");
    });
    seen.push("abandoned: ok");
  } catch (error) {
    seen.push(`abandoned: ${(error as Error).message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  return seen;
}

describe("Durable Object: a tracer that fails never fails the call", () => {
  for (const [name, tracer] of Object.entries(FAILING_TRACERS))
    test(name, () =>
      withBase(async (base) => {
        const db = withTracer(base, tracer);
        expect(await exercise(db)).toEqual(EXERCISED);
        expect(await transactions(db)).toEqual([
          "failing: UniqueConstraintError",
          "abandoned: abandoned",
        ]);
        expect(await base.record.count()).toBe(1);
      })
    );
});

describe("Durable Object: a logger that fails never fails the call", () => {
  for (const rejects of [false, true])
    test(rejects ? "it rejects" : "it throws", () =>
      withBase(async (base) => {
        const db = withFailingLogger(base, rejects);
        expect(await exercise(db)).toEqual(EXERCISED);
        expect(await transactions(db)).toEqual([
          "failing: UniqueConstraintError",
          "abandoned: abandoned",
        ]);
      })
    );
});

describe("Durable Object: a handler that fails fails the call as it failed", () => {
  for (const [name, { chain, name: message }] of Object.entries(
    FAILING_HANDLERS
  ))
    test(name, () =>
      withBase(async (base) => {
        const db = chain(base);
        await expect(
          db.record.create({ data: { id: "a", name: "Ada" } })
        ).rejects.toThrow(message);
        await expect(
          db.$transaction(async (tx: typeof db) =>
            tx.record.create({ data: { id: "b", name: "Bea" } })
          )
        ).rejects.toThrow(message);
        await new Promise((resolve) => setTimeout(resolve, 20));
      })
    );

  test("a transaction unit that fails before its body rolls back what run() opened", () =>
    withBase(async (base) => {
      const db = base.$extends(
        extension(
          "tx",
          unit(async () => {
            await Promise.resolve();
            throw new Error("before the body");
          }, ["transaction"])
        )
      );
      await expect(
        db.$transaction(async (tx) =>
          tx.record.create({ data: { id: "a", name: "Ada" } })
        )
      ).rejects.toThrow("before the body");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await base.record.count()).toBe(0);
    }));
});

test("Durable Object: an on() hook that fails is reported, and its report's failure is swallowed", () =>
  withBase(async (base) => {
    const reported: string[] = [];
    const db = withFailingHook(base, reported);
    await db.$transaction(async (tx: typeof db) => {
      await tx.record.create({ data: { id: "a", name: "Ada" } });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reported).toEqual([
      'Extension "viborm.on" hook record.create failed after the write committed; the write is not undone.',
    ]);
  }));

describe("Durable Object: a cache backend that fails", () => {
  test("a read whose background set fails is answered by the database", () =>
    withBase(async (base) => {
      const backend = new FailingBackend();
      const db = withFailingCache(base, backend);
      backend.failing = new Set(["set"]);
      await expect(
        db.$withCache({ ttl: "1h" }).record.findMany()
      ).resolves.toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }));

  test("a write in a transaction whose invalidation fails rejects after the commit", () =>
    withBase(async (base) => {
      const backend = new FailingBackend();
      const db = withFailingCache(base, backend);
      backend.failing = new Set(["get", "set", "delete", "clear"]);
      await expect(
        db.$transaction(async (tx: typeof db) =>
          tx.record.create({ data: { id: "a", name: "Ada" } })
        )
      ).rejects.toThrow("Cache invalidation failed after mutation 'create'");
      expect(await base.record.count()).toBe(1);
    }));

  test("$invalidate with a key and a prefix rejects with the backend's failure", () =>
    withBase(async (base) => {
      const backend = new FailingBackend();
      const db = withFailingCache(base, backend);
      backend.failing = new Set(["delete", "clear"]);
      await expect(db.$invalidate("one", "many*")).rejects.toThrow(
        "Cache invalidation failed."
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }));
});
