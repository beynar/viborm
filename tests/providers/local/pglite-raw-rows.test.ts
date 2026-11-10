/**
 * PGlite Driver Tests — governed raw reads on PostgreSQL: the derived table
 * `<model>.$rows(alias)` renders is valid there, its alias read unquoted, its
 * domain's own relation subquery included. Oracle: pages a (alice), b
 * (alice), c (bob).
 */

import { s } from "@schema";
import { permissions } from "@src/permissions";
import { softDelete } from "@src/soft-delete/index";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { v } from "@validation";
import { beforeEach, expect, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  pages: s.toMany(() => page),
});
const page = s.model({
  id: s.string().id(),
  owner: s.string(),
  author: s
    .toOne(() => user)
    .fields("owner")
    .references("id"),
  title: s.string(),
  deletedAt: s.dateTime().nullable(),
});

const family = usePGliteSchemaFamily({ user, page });

beforeEach(async () => {
  const { client } = family();
  await client.user.createMany({
    data: [
      { id: "alice", name: "Alice" },
      { id: "bob", name: "Bob" },
    ],
  });
  await client.page.createMany({
    data: [
      { id: "a", owner: "alice", title: "one" },
      { id: "b", owner: "alice", title: "two" },
      { id: "c", owner: "bob", title: "three" },
    ],
  });
});

test("a policy's domain, through a relation, composed with a JOIN and a bound value", async () => {
  const tombstoned = family().client.$extends(
    softDelete({ models: { page: { deletedAt: "deletedAt" } } })
  );
  await tombstoned.page.delete({ where: { id: "b" } });
  const db = tombstoned.$extends(
    permissions({
      actor: v.object({ name: v.string() }),
      models: {
        user: { read: true },
        page: { read: { author: { name: { actor: "name" } } } },
      },
    })
  );
  const alice = db.$as({ name: "Alice" });
  const rows = await alice.$queryRaw`
    SELECT p.id, p.title, u.name FROM ${alice.page.$rows("p")}
    JOIN ${alice.user.$rows("u")} ON u.id = p.owner
    WHERE p.title <> ${"none"} ORDER BY p.id`;
  expect(rows).toEqual([{ id: "a", title: "one", name: "Alice" }]);
  const all = await family().client.$queryRaw`
    SELECT p.id FROM ${family().client.page.$rows("p")} ORDER BY p.id`;
  expect(all).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
});
