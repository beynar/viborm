/**
 * D1 Driver Tests — `$transaction([...])` under extensions, on the binding.
 *
 * D1 has no interactive transaction: an array is one native `batch`. The one
 * array executor (the plain and the intercepted paths made one) is held at
 * the layer by `query-interceptors-array.core.test.ts` against a scripted
 * batch driver; these cells hold it against D1 itself:
 *
 * - an array that an `around` wraps, with `watch` and `settled`, is still one
 *   D1 batch; `watch` is told each member's rows, and `settled` runs after
 *   that batch committed, member by member, before the array resolves;
 * - a batch D1 refuses commits nothing and runs no `settled` as committed;
 * - a write in an array invalidates the cache once the batch committed (a
 *   read of the cached view is no array member: its types say it is not
 *   batchable);
 * - units: one `batch` unit around the array, one `operation` unit per member,
 *   one `statement` unit for the one native send, its members listed.
 */

import { env } from "cloudflare:test";
import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import type { D1Database } from "@cloudflare/workers-types";
import { s } from "@schema";
import { D1Driver } from "@src/drivers/d1";
import {
  around,
  extension,
  settled,
  statements,
  target,
  unit,
  watch,
  writes,
} from "@src/index";
import { createMigrationClient } from "@src/migrations/client";
import { failure } from "@tests/fixtures/failure";
import { afterEach, describe, expect, test } from "vitest";
import { RecordingD1 } from "./d1-statements";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
    }
  }
}

const record = s.model({
  id: s.string().id(),
  name: s.string(),
});
const schema = { record };

const opened: { $disconnect(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

/** A client on a recorded binding, its table made by `push`'s statements. */
const open = async () => {
  const recording = new RecordingD1(env.DB);
  const base = createClient({
    schema,
    driver: new D1Driver({ database: recording.database }),
  });
  opened.push(base);
  const preview = await createMigrationClient(base).push({ dryRun: true });
  for (const statement of preview.statements)
    await env.DB.prepare(statement.sql).run();
  return { base, recording };
};

/** The batch ordinals of the statements recorded from `from` on. */
const batchesFrom = (recording: RecordingD1, from: number) =>
  recording.statements.slice(from).map((statement) => statement.batch);

const names = async (base: { record: { findMany(args: object): unknown } }) =>
  await base.record.findMany({ orderBy: { id: "asc" }, select: { id: true } });

describe("D1: an array an around wraps, with watch and settled", () => {
  const watched = (
    timeline: string[],
    base: Awaited<ReturnType<typeof open>>["base"]
  ) =>
    base.$extends(
      extension(
        "array-watch",
        around(
          (c) => {
            watch(c, {
              wants: () => true,
              rows: (model, kind, rows) => {
                for (const row of rows)
                  timeline.push(`rows:${model}:${kind}:${String(row.id)}`);
              },
            });
            settled(c, async ({ certainty }) => {
              // Read through the bare client: what `settled` is told is
              // durable must be visible outside the batch that wrote it.
              const seen = await base.record.findMany({
                select: { id: true },
                orderBy: { id: "asc" },
              });
              timeline.push(
                `settled:${c.operation}:${certainty}:${seen
                  .map((row) => row.id)
                  .join(",")}`
              );
            });
            return async (run) => {
              const result = await run();
              timeline.push(`after-run:${c.operation}`);
              return result;
            };
          },
          target("record", writes)
        )
      )
    );

  test("is one batch, tells each member's rows, and settles each member after the commit", async () => {
    const { base, recording } = await open();
    const timeline: string[] = [];
    const db = watched(timeline, base);
    const from = recording.statements.length;

    const results = await db.$transaction([
      db.record.create({ data: { id: "a", name: "first" } }),
      db.record.update({ where: { id: "a" }, data: { name: "renamed" } }),
      db.record.create({ data: { id: "b", name: "second" } }),
    ]);

    expect(results).toEqual([
      { id: "a", name: "first" },
      { id: "a", name: "renamed" },
      { id: "b", name: "second" },
    ]);
    // One native send for the whole array (the reads `settled` makes come
    // after it, each alone).
    const sent = batchesFrom(recording, from);
    const arrayBatch = sent[0];
    expect(arrayBatch).toBeDefined();
    const inBatch = sent.filter((ordinal) => ordinal === arrayBatch).length;
    expect(inBatch).toBeGreaterThanOrEqual(3);
    expect(
      sent.slice(0, inBatch).every((ordinal) => ordinal === arrayBatch)
    ).toBe(true);
    expect(sent.slice(inBatch).every((ordinal) => ordinal === undefined)).toBe(
      true
    );
    // Every member's rows, then each member's `settled` after the commit,
    // each reading both rows already durable.
    expect(timeline.filter((entry) => entry.startsWith("rows:"))).toEqual([
      "rows:record:create:a",
      "rows:record:update:a",
      "rows:record:create:b",
    ]);
    expect(timeline.filter((entry) => entry.startsWith("settled:"))).toEqual([
      "settled:create:committed:a,b",
      "settled:update:committed:a,b",
      "settled:create:committed:a,b",
    ]);
    expect(await names(base)).toEqual([{ id: "a" }, { id: "b" }]);
  });

  test("a batch D1 refuses commits nothing, and settles each member as one that may have committed", async () => {
    const { base } = await open();
    await base.record.create({ data: { id: "a", name: "kept" } });
    const timeline: string[] = [];
    const db = watched(timeline, base);

    const refused = await failure(
      db.$transaction([
        db.record.create({ data: { id: "b", name: "new" } }),
        // The same key twice: D1 refuses the batch, all of it.
        db.record.create({ data: { id: "a", name: "duplicate" } }),
      ])
    );

    expect(refused).toMatchObject({
      name: "UniqueConstraintError",
      meta: { commitCertainty: "may-have-committed" },
    });
    expect(await names(base)).toEqual([{ id: "a" }]);
    // A native batch that fails once sent may have committed for all the
    // executor can tell (spec 14.3): every member's `settled` is told so,
    // and reads that nothing of the batch stayed.
    expect(timeline.filter((entry) => entry.startsWith("settled:"))).toEqual([
      "settled:create:may-have-committed:a",
      "settled:create:may-have-committed:a",
    ]);
    expect(timeline.filter((entry) => entry.startsWith("after-run:"))).toEqual(
      []
    );
  });

  test("a plain chain sends the same array as one batch", async () => {
    const { base, recording } = await open();
    const from = recording.statements.length;
    await base.$transaction([
      base.record.create({ data: { id: "a", name: "first" } }),
      base.record.create({ data: { id: "b", name: "second" } }),
    ]);
    const sent = batchesFrom(recording, from);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sent).size).toBe(1);
    expect(sent[0]).toBeDefined();
  });
});

describe("D1: the cache in an array", () => {
  test("a write in an array invalidates the cache once the batch committed", async () => {
    const { base } = await open();
    await base.record.create({ data: { id: "a", name: "first" } });
    const db = base.$extends(cache({ driver: new MemoryCache() }));
    const read = () =>
      db.$withCache().record.findUnique({ where: { id: "a" } });
    expect(await read()).toEqual({ id: "a", name: "first" });

    await db.$transaction([
      db.record.update({ where: { id: "a" }, data: { name: "second" } }),
    ]);
    expect(await read()).toEqual({ id: "a", name: "second" });
  });
});

describe("D1: units of an array", () => {
  test("one batch unit, one operation unit per member, one statement unit for the native send", async () => {
    const { base, recording } = await open();
    const units: { kind: string; operation?: string; members?: number }[] = [];
    const db = base.$extends(
      extension(
        "array-units",
        unit(async (u, next) => {
          const members = u.kind === "statement" ? statements(u) : undefined;
          units.push({
            kind: u.kind,
            ...(u.operation === undefined ? {} : { operation: u.operation }),
            ...(members === undefined ? {} : { members: members.length }),
          });
          return await next();
        })
      )
    );
    const from = recording.statements.length;

    await db.$transaction([
      db.record.create({ data: { id: "a", name: "first" } }),
      db.record.create({ data: { id: "b", name: "second" } }),
    ]);

    const sent = recording.statements.slice(from);
    expect(new Set(sent.map((statement) => statement.batch)).size).toBe(1);
    expect(units.filter((u) => u.kind === "batch")).toHaveLength(1);
    expect(
      units.filter((u) => u.kind === "operation").map((u) => u.operation)
    ).toEqual(["create", "create"]);
    const sends = units.filter((u) => u.kind === "statement");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.members).toBe(sent.length);
    expect(units.filter((u) => u.kind === "transaction")).toEqual([]);
  });
});
