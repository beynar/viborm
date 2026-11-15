/**
 * D1 Driver Tests — `viborm/on` over `$transaction([...])`, on the binding.
 * An array is one native D1 batch: each member's hook runs after it, in
 * member order, with the rows its write left, and reads them durable; a
 * batch D1 refuses commits nothing and calls no hook: no member's write
 * showed rows, where `settled` is still told the batch may have committed
 * (`d1-array-extensions.test.ts`).
 */

import { env } from "cloudflare:test";
import { createClient } from "@client/client";
import type { D1Database } from "@cloudflare/workers-types";
import { s } from "@schema";
import { D1Driver } from "@src/drivers/d1";
import { createMigrationClient } from "@src/migrations/client";
import { on } from "@src/on";
import { failure } from "@tests/fixtures/failure";
import { afterEach, describe, expect, test } from "vitest";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
    }
  }
}

const record = s.model({ id: s.string().id(), name: s.string() });
const schema = { record };

const opened: { $disconnect(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

const open = async () => {
  const base = createClient({
    schema,
    driver: new D1Driver({ database: env.DB }),
  });
  opened.push(base);
  const preview = await createMigrationClient(base).push({ dryRun: true });
  for (const statement of preview.statements)
    await env.DB.prepare(statement.sql).run();
  return base;
};

describe("D1: on() over an array", () => {
  test("each member's hook after the batch, in order, with its rows and the batch durable", async () => {
    const base = await open();
    const told: string[] = [];
    const seen = async () =>
      (await base.record.findMany({ orderBy: { id: "asc" } }))
        .map((row) => row.name)
        .join(",");
    const db = base.$extends(
      on({
        record: {
          create: async (rows, { certainty }) => {
            told.push(`create ${rows[0]?.name} ${certainty} ${await seen()}`);
          },
          update: async (rows, { certainty }) => {
            told.push(`update ${rows[0]?.name} ${certainty} ${await seen()}`);
          },
        },
      })
    );
    await db.$transaction([
      db.record.create({ data: { id: "a", name: "first" } }),
      db.record.update({ where: { id: "a" }, data: { name: "renamed" } }),
      db.record.create({ data: { id: "b", name: "second" } }),
    ]);
    expect(told).toEqual([
      "create first committed renamed,second",
      "update renamed committed renamed,second",
      "create second committed renamed,second",
    ]);
  });

  test("a batch D1 refuses leaves the rows as they were and calls no hook", async () => {
    const base = await open();
    await base.record.create({ data: { id: "a", name: "kept" } });
    const told: string[] = [];
    const db = base.$extends(
      on({
        record: {
          create: (rows, { certainty }) => {
            told.push(`create ${rows[0]?.id} ${certainty}`);
          },
        },
      })
    );
    const refused = await failure(
      db.$transaction([
        db.record.create({ data: { id: "b", name: "new" } }),
        db.record.create({ data: { id: "a", name: "duplicate" } }),
      ])
    );
    expect(refused).toMatchObject({ name: "UniqueConstraintError" });
    expect(
      (await base.record.findMany({ orderBy: { id: "asc" } })).map(
        (row) => row.name
      )
    ).toEqual(["kept"]);
    expect(told).toEqual([]);
  });
});
