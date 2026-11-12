import { createClient } from "@client/client";
import { s } from "@schema";
import { permissions } from "@src/permissions";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { afterEach, expect, test } from "vitest";

const account = s.model({
  id: s.string().id(),
  project: s.toOne(() => project),
});
const project = s.model({
  id: s.string().id(),
  ownerId: s.string(),
  secret: s.string(),
  label: s.string(),
  accountId: s.string().unique(),
  account: s
    .toOne(() => account)
    .fields("accountId")
    .references("id"),
});
const schema = { account, project };

const clients: { $disconnect(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

// A field that needs more than `update` to write needs it however the row is
// reached: by its own delegate, or as the one row a relation reaches.
test("a protected field is judged the same through a to-one update as through its own delegate", async () => {
  const base = createClient({ schema, driver: createInMemorySQLite3Driver() });
  clients.push(base);
  await syncLiveSchema(base);
  await base.account.create({ data: { id: "a1" } });
  await base.project.create({
    data: {
      id: "p1",
      ownerId: "someone else",
      secret: "kept",
      label: "old",
      accountId: "a1",
    },
  });
  const db = base
    .$extends(
      permissions({
        actor: v.object({ userId: v.string() }),
        models: {
          account: { read: true, update: true },
          project: {
            read: true,
            update: true,
            delete: { ownerId: { actor: "userId" } },
            fields: { secret: { write: "delete" } },
          },
        },
      })
    )
    .$as({ userId: "me" });

  // A field that is not protected is written both ways.
  await db.account.update({
    where: { id: "a1" },
    data: { project: { update: { label: "new" } } },
  });
  const refusedDirectly = await db.project
    .update({ where: { id: "p1" }, data: { secret: "taken" } })
    .then(
      () => "written",
      (error: unknown) => (error as Error).constructor.name
    );
  const refusedThroughTheRelation = await db.account
    .update({
      where: { id: "a1" },
      data: { project: { update: { secret: "taken" } } },
    })
    .then(
      () => "written",
      (error: unknown) => (error as Error).constructor.name
    );
  expect(refusedDirectly).not.toBe("written");
  expect(refusedThroughTheRelation).not.toBe("written");
  expect(await base.project.findUnique({ where: { id: "p1" } })).toMatchObject({
    secret: "kept",
    label: "new",
  });
});
