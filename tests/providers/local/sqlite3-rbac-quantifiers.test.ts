import { createClient } from "@drivers/sqlite3";
import { s } from "@schema";
import { rbac } from "@src/rbac";
import { v } from "@src/validation";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";

test.each([
  { every: { OR: [] }, none: { id: "blocked" } },
  { none: { id: "blocked" }, every: { OR: [] } },
])("every false and none require an empty relation: %j", async (children) => {
  const parent = s.model({
    id: s.string().id(),
    children: s.toMany(() => child),
  });
  const child = s.model({
    id: s.string().id(),
    parentId: s.string(),
    parent: s
      .toOne(() => parent)
      .fields("parentId")
      .references("id"),
  });
  const base = createClient({ schema: { parent, child }, dataDir: ":memory:" });
  try {
    await syncLiveSchema(base);
    await base.parent.createMany({
      data: [{ id: "empty" }, { id: "populated" }],
    });
    await base.child.create({ data: { id: "allowed", parentId: "populated" } });
    const db = rbac({
      actor: v.object({ id: v.string() }),
      levels: ["view"],
      models: { parent: { view: { children } }, child: { view: {} } },
    })(base).$as({ id: "actor" });
    expect(await db.parent.findMany()).toEqual([{ id: "empty" }]);
    expect(await db.parent.can("view", { id: "populated" })).toBe(false);
  } finally {
    await base.$disconnect();
  }
});
