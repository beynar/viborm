/**
 * Closing review of the extension host (2026-11-15), PGlite lane: the one
 * change of timing the review measured. `together` (the barrier that sends a
 * native batch's members together) was rebuilt on `members` between
 * `c41f3aff3` and `dcc705544`. Under some chains the members' `operation`
 * units of a failed native batch now settle a few microtasks earlier,
 * before the caller resumes, where `c41f3aff3` settled them just after (the
 * differential harness read them as the next call's 7 times in 300 seeds;
 * content and order are unchanged). That micro-order depends on the exact
 * chain and is not pinned. What both trees hold, and this pins: each member's
 * unit settles once, as a failure, by the next macrotask.
 */

import { createClient } from "@client/client";
import { s } from "@schema";
import { extension, unit } from "@src/index";
import { instrumentation } from "@src/instrumentation/exports";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import {
  closeTestPGlite,
  openTestPGlite,
} from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

/** A span that records nothing. */
const span = {
  setAttribute: () => undefined,
  setStatus: () => undefined,
  recordException: () => undefined,
  end: () => undefined,
};

const post = s.model({ id: s.int().id(), title: s.string().unique() });

const opened: ReturnType<typeof openTestPGlite>[] = [];
afterEach(async () => {
  for (const database of opened.splice(0)) await closeTestPGlite(database);
});

async function batched(refuse: boolean) {
  const database = openTestPGlite();
  opened.push(database);
  const base = createClient({
    schema: { post },
    driver: new BatchOnlyPGliteDriver({ client: database }),
  });
  await syncLiveSchema(base as never);
  await base.post.create({ data: { id: 1, title: "taken" } });
  const settled: string[] = [];
  const db = base
    .$extends(
      extension(
        "watcher",
        unit(
          async (u, next) => {
            const end = await next();
            settled.push(`${u.operation} ${end.status}`);
          },
          ["operation"]
        )
      )
    )
    .$extends(
      extension(
        "rewriter",
        unit(
          (u, next) => {
            if (refuse && u.operation === "update")
              throw new Error("member refused");
            return next();
          },
          ["statement"],
          { rewrites: true }
        )
      )
    )
    .$extends(
      instrumentation({
        tracing: {
          tracer: { startActiveSpan: (_name, fn) => fn(span) },
        },
        logging: { error: () => undefined },
      })
    );
  return { db, settled };
}

describe("a native batch that fails: each member's unit settles once, as a failure", () => {
  test("a member a rewriting unit refuses", async () => {
    const { db, settled } = await batched(true);
    try {
      await db.$transaction([
        db.post.create({ data: { id: 2, title: "two" } }),
        db.post.update({ where: { id: 1 }, data: { title: "one" } }),
      ]);
    } catch {
      // The batch fails as a whole; its members are read below.
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    const seen = [...settled];
    expect(seen).toEqual(["create failure", "update failure"]);
  });

  test("a member the database refuses", async () => {
    const { db, settled } = await batched(false);
    try {
      await db.$transaction([
        db.post.create({ data: { id: 2, title: "two" } }),
        db.post.create({ data: { id: 3, title: "taken" } }),
      ]);
    } catch {
      // The batch fails as a whole; its members are read below.
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    const seen = [...settled];
    expect(seen).toEqual(["create failure", "create failure"]);
  });
});
