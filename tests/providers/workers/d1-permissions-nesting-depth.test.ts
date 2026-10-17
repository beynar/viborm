/**
 * D1 Driver Tests — a governed relation filter nested as deep as admission
 * takes it (15 relation levels) runs on D1 (ENG-6, review 2). D1 compiles
 * with an expression depth of 100, and SQLite adds a nested filter's
 * `WHERE` heights level by level, so a target's row domain lowered at every
 * level paid its own height at every level: a three-arm read policy cost
 * about 10 per level and failed at 9 levels ("Expression tree is too
 * large"), while the base client ran to 15. The domain of a level whose
 * filter goes on below is isolated (`subqueries.isolated`): its height is
 * paid once, at the end of its own branch, so each level costs about 5
 * whatever the policy (measured: 94 at 15 levels for the three-arm policy).
 */

import { env } from "cloudflare:test";
import { createClient } from "@client/client";
import type { D1Database } from "@cloudflare/workers-types";
import { D1Driver } from "@src/drivers/d1";
import { createMigrationClient } from "@src/migrations/client";
import { permissions } from "@src/permissions";
import { s } from "@src/schema";
import { v } from "@src/validation";
import { expect, test } from "vitest";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

const org = s.model({
  id: s.string().id(),
  members: s.toMany(() => member),
  docs: s.toMany(() => doc),
});
const member = s.model({
  id: s.string().id(),
  userId: s.string(),
  orgId: s.string(),
  org: s
    .toOne(() => org)
    .fields("orgId")
    .references("id"),
});
const doc = s.model({
  id: s.string().id(),
  status: s.string(),
  orgId: s.string(),
  org: s
    .toOne(() => org)
    .fields("orgId")
    .references("id"),
  ownerId: s.string().nullable(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => doc)
    .fields("parentId")
    .references("id"),
  children: s.toMany(() => doc),
  grants: s.toMany(() => grant),
});
const grant = s.model({
  id: s.string().id(),
  docId: s.string(),
  doc: s
    .toOne(() => doc)
    .fields("docId")
    .references("id"),
  userId: s.string().nullable(),
  level: s.string(),
});
const schema = { org, member, doc, grant };

const me = { actor: "userId" } as const;
const inOrg = { org: { members: { some: { userId: me } } } };
const Actor = v.object({ userId: v.string() });
/** The reviewers' policies (review 2, ENG-6): three arms, each in the org. */
const policies = {
  "three arms": permissions({
    actor: Actor,
    models: {
      org: { read: { members: { some: { userId: me } } } },
      member: { read: { org: "read" } },
      doc: {
        read: {
          OR: [
            { AND: [inOrg, { status: "public" }] },
            { AND: [inOrg, { ownerId: me }] },
            { AND: [inOrg, { status: "shared" }, { ownerId: { not: null } }] },
          ],
        },
      },
    },
  }),
  "three arms through grants and a NOT": permissions({
    actor: Actor,
    models: {
      org: { read: { members: { some: { userId: me } } } },
      member: { read: { org: "read" } },
      doc: {
        read: {
          OR: [
            { AND: [inOrg, { status: "public" }] },
            { AND: [inOrg, { grants: { some: { userId: me } } }] },
            {
              AND: [
                inOrg,
                { NOT: { grants: { some: { userId: me, level: "deny" } } } },
                { ownerId: me },
              ],
            },
          ],
        },
      },
      grant: { read: { doc: "read" } },
    },
  }),
};

/** Admission's ceiling: a filter 16 levels deep is refused before SQL. */
const DEEPEST = 15;

test(
  "a governed relation filter nested to admission's depth reads its row on D1",
  {
    timeout: 600_000,
  },
  async () => {
    const base = createClient({
      schema,
      driver: new D1Driver({ database: env.DB }),
    });
    const preview = await createMigrationClient(base).push({ dryRun: true });
    for (const statement of preview.statements)
      await env.DB.prepare(statement.sql).run();
    await base.org.create({ data: { id: "o1" } });
    await base.member.create({ data: { id: "m1", userId: "u1", orgId: "o1" } });
    // d0 <- d1 <- … <- d15, each the parent of the next.
    for (let i = 0; i <= DEEPEST; i++)
      await base.doc.create({
        data: {
          id: `d${i}`,
          status: "public",
          orgId: "o1",
          ownerId: "u1",
          parentId: i === 0 ? null : `d${i - 1}`,
        },
      });
    type Reader = {
      doc: { findMany(args: object): Promise<{ id: string }[]> };
    };
    // Each policy is its own type: the loop reads them as one shape.
    const extensible = base as unknown as {
      $extends(policy: unknown): { $as(actor: object): Reader };
    };
    const clients: Record<string, Reader> = {
      base: base as unknown as Reader,
      ...Object.fromEntries(
        Object.entries(policies).map(([name, policy]) => [
          name,
          extensible.$extends(policy).$as({ userId: "u1" }),
        ])
      ),
    };
    const answers: Record<string, string[]> = {};
    for (const [name, client] of Object.entries(clients))
      for (let depth = 1; depth <= DEEPEST; depth++) {
        let where: object = { id: "d0" };
        for (let level = 0; level < depth; level++) where = { parent: where };
        try {
          const rows = await client.doc.findMany({
            where,
            select: { id: true },
          });
          (answers[name] ??= []).push(rows.map((row) => row.id).join());
        } catch (error) {
          (answers[name] ??= []).push(`${depth}: ${(error as Error).message}`);
        }
      }
    const expected = Array.from({ length: DEEPEST }, (_, at) => `d${at + 1}`);
    expect(answers).toEqual(
      Object.fromEntries(Object.keys(clients).map((name) => [name, expected]))
    );
    await base.$disconnect();
  }
);
