/**
 * Differential review of the extension rewrite against `main` (29d3e4181):
 * what an application's end user sees through the official extensions.
 * Each test is a call the scenario generator found answering differently on
 * the branch (its seed is named), reduced to the smallest schema that shows
 * it. On `main` every test here passes.
 *
 * Runs on in-memory SQLite.
 */

import { createClient } from "@drivers/sqlite3";
import { s } from "@schema";
import { permissions } from "@src/permissions";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { afterEach, describe, expect, test } from "vitest";

const doc = s.model({
  id: s.int().id(),
  title: s.string(),
  ownerId: s.int(),
});
const schema = { doc };

interface Delegate {
  findMany(args?: object): Promise<Record<string, unknown>[]>;
  upsert(args: object): Promise<Record<string, unknown>>;
}
interface Governed {
  $as(actor: { userId: number }): { doc: Delegate };
}

const open: { $disconnect(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.$disconnect()));
});

async function governed(policy: object): Promise<Governed> {
  const base = createClient({ schema, dataDir: ":memory:" });
  open.push(base);
  await syncLiveSchema(base);
  await base.doc.create({ data: { id: 1, title: "mine", ownerId: 7 } });
  return base.$extends(policy as never) as unknown as Governed;
}

describe("permissions: upsert, judged per arm", () => {
  // Seed 64 (call 38) of the differential: an upsert whose row exists, on a
  // model whose policy grants `update` but declares no `create` rule. The
  // documentation: "`upsert`: `update` for its update branch; `create` for
  // its insert branch". `main` runs the update arm.
  test("an upsert onto an existing row needs the update action only", async () => {
    const db = await governed(
      permissions({
        actor: v.object({ userId: v.number() }),
        models: {
          doc: { read: true, update: { ownerId: { actor: "userId" } } },
        },
      })
    );
    const call = db.$as({ userId: 7 });
    await expect(
      call.doc.upsert({
        where: { id: 1 },
        create: { id: 1, title: "never", ownerId: 7 },
        update: { title: "renamed" },
      })
    ).resolves.toEqual({ id: 1, title: "renamed", ownerId: 7 });
    expect(await call.doc.findMany()).toEqual([
      { id: 1, title: "renamed", ownerId: 7 },
    ]);
  });
});
