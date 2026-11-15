/**
 * Closing review of the extension host (2026-11-15), D1 lane: failing
 * tracers, loggers, handlers, hooks and cache backends on the binding,
 * under workerd. See `closing-review-cases.ts`. Each answer is the one
 * `c41f3aff3` gives; the lane fails on any unhandled rejection.
 */

import { env } from "cloudflare:test";
import { createClient } from "@client/client";
import type { D1Database } from "@cloudflare/workers-types";
import { D1Driver } from "@src/drivers/d1";
import { createMigrationClient } from "@src/migrations/client";
import { afterEach, describe, expect, test } from "vitest";
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
} from "./closing-review-cases";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
    }
  }
}

const opened: { $disconnect(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

const open = async () => {
  const base = createClient({
    schema: closingSchema,
    driver: new D1Driver({ database: env.DB }),
  });
  opened.push(base);
  const preview = await createMigrationClient(base).push({ dryRun: true });
  for (const statement of preview.statements)
    await env.DB.prepare(statement.sql).run();
  return base;
};

describe("D1: a tracer that fails never fails the call", () => {
  for (const [name, tracer] of Object.entries(FAILING_TRACERS))
    test(name, async () => {
      const base = await open();
      expect(await exercise(withTracer(base, tracer))).toEqual(EXERCISED);
    });
});

describe("D1: a logger that fails never fails the call", () => {
  for (const rejects of [false, true])
    test(rejects ? "it rejects" : "it throws", async () => {
      const base = await open();
      expect(await exercise(withFailingLogger(base, rejects))).toEqual(
        EXERCISED
      );
    });
});

describe("D1: a handler that fails fails the call as it failed", () => {
  for (const [name, { chain, name: message }] of Object.entries(
    FAILING_HANDLERS
  ))
    test(name, async () => {
      const db = chain(await open());
      await expect(
        db.record.create({ data: { id: "a", name: "Ada" } })
      ).rejects.toThrow(message);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
});

test("D1: an on() hook that fails is reported, and its report's failure is swallowed", async () => {
  const reported: string[] = [];
  const db = withFailingHook(await open(), reported);
  await expect(
    db.record.create({ data: { id: "a", name: "Ada" } })
  ).resolves.toMatchObject({ id: "a" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(reported).toEqual([
    'Extension "viborm.on" hook record.create failed after the write committed; the write is not undone.',
  ]);
});

describe("D1: a cache backend that fails", () => {
  test("a read whose background set fails is answered by the database", async () => {
    const backend = new FailingBackend();
    const db = withFailingCache(await open(), backend);
    backend.failing = new Set(["set"]);
    await expect(
      db.$withCache({ ttl: "1h" }).record.findMany()
    ).resolves.toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  test("a read whose get fails is rejected with the backend's failure (c41f3aff3 too)", async () => {
    const backend = new FailingBackend();
    const db = withFailingCache(await open(), backend);
    backend.failing = new Set(["get", "set"]);
    await expect(
      db.$withCache({ ttl: "1h" }).record.findMany()
    ).rejects.toThrow("backend get failed");
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  test("a write whose invalidation fails is refused after it committed", async () => {
    const backend = new FailingBackend();
    const base = await open();
    const db = withFailingCache(base, backend);
    backend.failing = new Set(["get", "set", "delete", "clear"]);
    await expect(
      db.record.create({ data: { id: "a", name: "Ada" } })
    ).rejects.toThrow("Cache invalidation failed after mutation 'create'");
    expect(await base.record.count()).toBe(1);
  });

  test("$invalidate with a key and a prefix rejects with the backend's failure", async () => {
    const backend = new FailingBackend();
    const db = withFailingCache(await open(), backend);
    backend.failing = new Set(["get", "set", "delete", "clear"]);
    await expect(db.$invalidate("one", "many*")).rejects.toThrow(
      "Cache invalidation failed."
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
