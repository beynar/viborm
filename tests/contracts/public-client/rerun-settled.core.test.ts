/**
 * `settled` under a driver that runs a callback transaction again after a
 * conflict at commit, as SurrealDB's does with `rerunsOnConflict`: what a
 * rerun registers is judged by that run's commit alone. A first run that
 * reached its commit and failed must not lend its "may have committed" to a
 * rerun that fails before committing anything.
 *
 * Runs on in-memory SQLite.
 */

import { createClient } from "@client/client";
import { getExecutionTransactionPhases } from "@drivers/execution-context";
import type { QueryExecutionContext } from "@drivers/exports";
import type { TransactionOptions } from "@drivers/shared/transaction-options";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { around, extension, settled, sql } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const post = s.model({ id: s.string().id(), title: s.string() });

/**
 * Runs a callback transaction a second time when its first run reached its
 * commit: the first is reported ready to commit, then refused, as a commit
 * conflict is, and rolled back.
 */
class RerunningDriver extends SQLite3Driver {
  override async withTransaction<T>(
    fn: (driver: never) => Promise<T>,
    options?: TransactionOptions,
    context?: QueryExecutionContext
  ): Promise<T> {
    let run = 0;
    const conflict = new Error("conflict at commit");
    try {
      return await super.withTransaction(
        async (driver) => {
          const result = await fn(driver as never);
          run += 1;
          if (run === 1) {
            getExecutionTransactionPhases(context)?.readyToCommit();
            throw conflict;
          }
          return result;
        },
        options,
        context
      );
    } catch (error) {
      if (error !== conflict) throw error;
      return super.withTransaction(fn, options, context);
    }
  }
}

interface Loose {
  post: { findMany(args?: object): Promise<Record<string, unknown>[]> };
  $extends(definition: unknown): Loose;
  $executeRaw(query: unknown): Promise<number>;
  $transaction<T>(fn: (tx: Loose) => Promise<T>): Promise<T>;
  $disconnect(): Promise<void>;
}

const opened: Loose[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

describe("settled under a driver that runs a callback again", () => {
  test("a rerun that fails before its commit tells nothing, and its failure carries no commit certainty", async () => {
    const base = createClient({
      schema: { post },
      driver: new RerunningDriver({ dataDir: ":memory:" }),
    }) as never as Loose;
    opened.push(base);
    await syncLiveSchema(base as never);
    const told: string[] = [];
    const db = base.$extends(
      extension(
        "after-raw",
        around((c) => {
          if (c.kind !== "raw") return;
          settled(c, ({ certainty }) => {
            told.push(certainty);
          });
        })
      )
    );
    let runs = 0;
    const refusal = new TypeError("the second run refuses");
    const failed = await db
      .$transaction(async (tx) => {
        runs += 1;
        await tx.$executeRaw(
          sql`INSERT INTO post (id, title) VALUES (${String(runs)}, ${"a"})`
        );
        if (runs === 2) throw refusal;
      })
      .catch((error: unknown) => error);
    expect(runs).toBe(2);
    expect(failed).toBe(refusal);
    expect(told).toEqual([]);
    expect(await base.post.findMany({})).toEqual([]);
  });

  test("a rerun that commits tells what it registered once, committed", async () => {
    const base = createClient({
      schema: { post },
      driver: new RerunningDriver({ dataDir: ":memory:" }),
    }) as never as Loose;
    opened.push(base);
    await syncLiveSchema(base as never);
    const told: string[] = [];
    const db = base.$extends(
      extension(
        "after-raw",
        around((c) => {
          if (c.kind !== "raw") return;
          settled(c, ({ certainty }) => {
            told.push(certainty);
          });
        })
      )
    );
    let runs = 0;
    await db.$transaction(async (tx) => {
      runs += 1;
      await tx.$executeRaw(
        sql`INSERT INTO post (id, title) VALUES (${String(runs)}, ${"a"})`
      );
    });
    expect(runs).toBe(2);
    expect(told).toEqual(["committed"]);
    expect((await base.post.findMany({})).map((row) => row.id)).toEqual(["2"]);
  });
});
