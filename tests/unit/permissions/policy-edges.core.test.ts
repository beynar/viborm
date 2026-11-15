/**
 * Policies whose rules the other compiler contracts do not write: the same
 * SQL operand function in two clauses, a `$if` over a control that is not
 * the actor, and a rule made of a `$if` and an `$exists` alone. Each runs
 * over a driver that sends nothing (`tests/fixtures/drivers/scripted.ts`):
 * what pins it is the statement a database receives.
 */

import { createClient, s } from "@src/index";
import { permissions } from "@src/permissions";
import { v } from "@src/validation";
import { ScriptedDriver } from "@tests/fixtures/drivers/scripted";
import { expect, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  role: s.string(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
});

/** The statement a read of posts sends under a policy whose `read` is `read`. */
async function readUnder(read: object, role = "r") {
  const driver = new ScriptedDriver("postgresql");
  const db = createClient({ schema: { user, post }, driver }).$extends(
    // The rules below are written as an application writes them; their
    // spellings are what is under test, not the policy's typing.
    permissions({
      actor: v.object({ userId: v.string(), role: v.string() }),
      models: { post: { actions: { read: [] }, read } },
    } as never)
  );
  await db
    .$as({ userId: "u1", role } as never)
    .post.findMany({ select: { id: true } });
  return driver.sent;
}

test("one SQL operand function used in two clauses compiles once per clause", async () => {
  const owner = (ctx: { sql: TemplateStringsArrayFn; fields: Fields }) =>
    ctx.sql`${ctx.fields.authorId}`;
  expect(
    await readUnder({
      OR: [{ title: { equals: owner } }, { title: { not: owner } }],
    })
  ).toEqual([
    {
      sql: 'SELECT "q0"."id" FROM "public"."post" AS "q0" WHERE ("q0"."title" = ("q0"."authorId") OR NOT ("q0"."title" = ("q0"."authorId"))) ORDER BY "q0"."id" ASC',
      params: [],
    },
  ]);
});

test("a $if over the scopes control the actor was given none of holds nowhere", async () => {
  expect(
    await readUnder({ $if: { control: "scopes", path: "x", equals: true } })
  ).toEqual([
    {
      sql: 'SELECT "q0"."id" FROM "public"."post" AS "q0" WHERE FALSE ORDER BY "q0"."id" ASC',
      params: [],
    },
  ]);
});

test("a rule of a $if and an $exists alone holds where both do", async () => {
  const rule = {
    $if: { control: "actor", path: "role", equals: "admin" },
    $exists: { user: { id: "u" } },
  };
  expect(await readUnder(rule)).toEqual([
    {
      sql: 'SELECT "q0"."id" FROM "public"."post" AS "q0" WHERE FALSE ORDER BY "q0"."id" ASC',
      params: [],
    },
  ]);
  expect(await readUnder(rule, "admin")).toEqual([
    {
      sql: 'SELECT "q0"."id" FROM "public"."post" AS "q0" WHERE EXISTS (SELECT 1 FROM "public"."user" AS "q1" WHERE "q1"."id" = $1) ORDER BY "q0"."id" ASC',
      params: ["u"],
    },
  ]);
});

type TemplateStringsArrayFn = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => unknown;
type Fields = { readonly authorId: unknown };
