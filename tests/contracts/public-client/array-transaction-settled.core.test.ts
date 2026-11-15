/**
 * After `$transaction([...])` commits: each member's `settled` functions run,
 * member by member, one failing not keeping the next from running, and the
 * first failure rejects the array.
 *
 * Runs on in-memory SQLite.
 */

import { createClient } from "@drivers/sqlite3";
import { ForbiddenError } from "@errors";
import { s } from "@schema";
import { call, extension, settled, target, writes } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const post = s.model({ id: s.string().id(), title: s.string() });
const schema = { post };

type Row = Record<string, unknown>;
interface Delegate {
  create(args: object): Promise<Row>;
  findMany(args?: object): Promise<Row[]>;
}
interface Loose {
  post: Delegate;
  $extends(definition: unknown): Loose;
  $transaction(operations: readonly unknown[]): Promise<unknown[]>;
  $disconnect(): Promise<void>;
}

const opened: Loose[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

/** A client whose writes run a settled function that fails for `failing` titles. */
async function settling(failing: readonly string[]) {
  const base = createClient({ schema, dataDir: ":memory:" }) as never as Loose;
  opened.push(base);
  await syncLiveSchema(base as never);
  const ran: string[] = [];
  const db = base.$extends(
    extension(
      "after",
      call((c) => {
        const title = String((c.args.data as Row | undefined)?.title);
        settled(c, () => {
          ran.push(title);
          if (failing.includes(title)) throw new ForbiddenError("post", title);
        });
      }, target(writes))
    )
  );
  return { base, db, ran };
}

describe("settled functions after an array commits", () => {
  test("one member's failure is the array's; the next member's function still runs", async () => {
    const { base, db, ran } = await settling(["a"]);
    const failure = await db
      .$transaction([
        db.post.create({ data: { id: "1", title: "a" } }),
        db.post.create({ data: { id: "2", title: "b" } }),
      ])
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ForbiddenError);
    expect(ran).toEqual(["a", "b"]);
    // The writes committed: the failure comes after.
    expect((await base.post.findMany({})).length).toBe(2);
  });

  test("several members failing: every function runs, the first failure rejects", async () => {
    const { db, ran } = await settling(["a", "b"]);
    const failure = await db
      .$transaction([
        db.post.create({ data: { id: "1", title: "a" } }),
        db.post.create({ data: { id: "2", title: "b" } }),
      ])
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ForbiddenError);
    expect((failure as ForbiddenError).message).toContain("The a on post");
    expect(ran).toEqual(["a", "b"]);
  });
});
