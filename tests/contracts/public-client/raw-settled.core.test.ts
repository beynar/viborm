/**
 * `settled` on a raw write (`$executeRaw`): an `around` with no target sees
 * raw statements, and what it registers runs once the statement settled. A
 * failure of what it registered rejects the call after the write; a
 * statement that fails still runs it, and the statement's failure is the
 * one the caller receives.
 *
 * Runs on in-memory SQLite.
 */

import { createClient } from "@drivers/sqlite3";
import { ForbiddenError } from "@errors";
import { s } from "@schema";
import { around, extension, settled, sql, type WriteOutcome } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const post = s.model({ id: s.string().id(), title: s.string() });
const schema = { post };

type Row = Record<string, unknown>;
interface Loose {
  post: { findMany(args?: object): Promise<Row[]> };
  $extends(definition: unknown): Loose;
  $executeRaw(query: unknown): Promise<number>;
  $disconnect(): Promise<void>;
}

const opened: Loose[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

async function raw(failure: unknown) {
  const base = createClient({ schema, dataDir: ":memory:" }) as never as Loose;
  opened.push(base);
  await syncLiveSchema(base as never);
  const told: WriteOutcome["certainty"][] = [];
  const db = base.$extends(
    extension(
      "after-raw",
      around((c) => {
        if (c.kind !== "raw") return;
        settled(c, ({ certainty }) => {
          told.push(certainty);
          throw failure;
        });
      })
    )
  );
  return { base, db, told };
}

describe("settled on a raw write", () => {
  test("its failure rejects the call once the write committed", async () => {
    const failure = new ForbiddenError("post", "raw");
    const { base, db, told } = await raw(failure);
    await expect(
      db.$executeRaw(sql`INSERT INTO post (id, title) VALUES (${"1"}, ${"a"})`)
    ).rejects.toBe(failure);
    expect(told).toEqual(["committed"]);
    expect((await base.post.findMany({})).length).toBe(1);
  });

  test("a statement that fails still runs it, and its own failure is the one received", async () => {
    const { db, told } = await raw(new ForbiddenError("post", "raw"));
    const failed = await db
      .$executeRaw(sql`INSERT INTO nowhere (id) VALUES (${"1"})`)
      .catch((error: unknown) => error);
    expect(failed).not.toBeInstanceOf(ForbiddenError);
    expect(failed).toBeInstanceOf(Error);
    expect(told.length).toBe(1);
  });
});
