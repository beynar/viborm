/**
 * workerd compiles SQLite with an expression depth of 100. A policy shaped
 * like a real page tree's (`depth-fixture.ts`) moves a page and asks `can`
 * for its four levels: with the driver's default adapter
 * (`deepExpressions: false`) every statement fits. With deep expressions,
 * the move of the per-kind policy is past the limit ("Expression tree is too
 * large"); `can` for four levels fits either way on this workerd
 * (1.20261104, the test pool's, as on 1.20260310 where it was first measured;
 * viborm-evidence/flarion-2026-11).
 */
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { SQLiteAdapter } from "@src/adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@src/drivers/durable-object";
import { createMigrationClient } from "@src/migrations/client";
import { describe, expect, test } from "vitest";
import {
  compactPolicy,
  LEVELS,
  owner,
  sketchPolicy,
  workspaceSchema,
} from "./depth-fixture";
import { inObject } from "./objects";

/** The storage, with every message the platform's SQLite refused with. */
function recording(storage: DurableObjectStorage, refusals: string[]) {
  return {
    sql: {
      exec: (...args: Parameters<DurableObjectStorage["sql"]["exec"]>) => {
        try {
          return storage.sql.exec(...args);
        } catch (error) {
          refusals.push(error instanceof Error ? error.message : `${error}`);
          throw error;
        }
      },
    },
    transaction: storage.transaction.bind(storage),
    sync: storage.sync.bind(storage),
  } as DurableObjectStorage;
}

async function workspace(
  storage: DurableObjectStorage,
  adapter: SQLiteAdapter | undefined
) {
  const client = createClient({ storage, schema: workspaceSchema, adapter });
  const migrations = createMigrationClient(client);
  await migrations.push({
    consent: (await migrations.push({ dryRun: true })).consent,
  });
  await client.teamspace.create({ data: { id: "ts0", name: "ts0" } });
  await client.teamspaceMember.create({
    data: { teamspaceId: "ts0", userId: "bob", role: "owner" },
  });
  for (const [id, parentId] of [
    ["R", null],
    ["P1", "R"],
    ["P2", "P1"],
  ] as const) {
    await client.page.create({
      data: { id, parentId, teamspaceId: "ts0", createdById: "bob" },
    });
  }
  await client.grant.create({
    data: {
      id: "G1",
      pageId: "P1",
      subjectKind: "user",
      subjectId: "g",
      subjectKey: "user:g",
      level: "update",
    },
  });
  return client;
}

type Policy = typeof sketchPolicy;

function governed(
  policy: Policy,
  client: Awaited<ReturnType<typeof workspace>>
) {
  return policy(client).$as(owner);
}

describe("Durable Object driver: expression depth", () => {
  test.each([
    ["per-kind", sketchPolicy],
    ["compact", compactPolicy],
  ] as const)("the default adapter moves a page and asks can for four levels (%s policy)", async (_name, policy) => {
    await inObject(async (state) => {
      const bob = governed(policy, await workspace(state.storage, undefined));
      await expect(
        bob.page.can([...LEVELS], { id: "P2" })
      ).resolves.toBeTruthy();
      await bob.page.update({ where: { id: "P2" }, data: { parentId: "R" } });
      expect(
        state.storage.sql
          .exec("SELECT parent_id FROM page WHERE id = 'P2'")
          .one()
      ).toEqual({ parent_id: "R" });
    });
  });

  test("with deep expressions the per-kind move is past workerd's depth", async () => {
    await inObject(async (state) => {
      const refusals: string[] = [];
      const deep = new SQLiteAdapter({ temporaryObjects: false });
      const bob = governed(
        sketchPolicy,
        await workspace(recording(state.storage, refusals), deep)
      );
      await expect(
        bob.page.can([...LEVELS], { id: "P2" })
      ).resolves.toBeTruthy();
      await expect(
        bob.page.update({ where: { id: "P2" }, data: { parentId: "R" } })
      ).rejects.toThrow();
      expect(refusals).toEqual([
        expect.stringContaining("Expression tree is too large"),
      ]);
    });
  });
});
