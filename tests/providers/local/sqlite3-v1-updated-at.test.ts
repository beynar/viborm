import { createClient } from "@drivers/sqlite3";
import { s } from "@schema";
import { sql } from "@sql";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";

test("FK updates refresh timestamps from either direction, and empty upsert arms do not write", async () => {
  const parent = s.model({ id: s.int().id(), children: s.toMany(() => child) });
  const child = s.model({
    id: s.int().id(),
    parentId: s.int(),
    parent: s
      .toOne(() => parent)
      .fields("parentId")
      .references("id"),
    updatedAt: s.dateTime().updatedAt().map("updated_at"),
  });
  const db = createClient({ schema: { parent, child } });
  const old = new Date("2000-01-01T00:00:00.000Z");
  const reset = () =>
    db.$executeRaw(
      sql`UPDATE "child" SET "updated_at" = ${old.toISOString()} WHERE "id" = ${1}`
    );
  const read = () => db.child.findUniqueOrThrow({ where: { id: 1 } });
  try {
    await syncLiveSchema(db);
    await db.parent.createMany({ data: [{ id: 1 }, { id: 2 }] });
    await db.child.create({ data: { id: 1, parentId: 1, updatedAt: old } });
    await db.parent.update({
      where: { id: 2 },
      data: { children: { connect: { id: 1 } } },
    });
    expect((await read()).parentId).toBe(2);
    expect((await read()).updatedAt.getTime()).toBeGreaterThan(old.getTime());
    await reset();
    await db.child.update({
      where: { id: 1 },
      data: { parent: { connect: { id: 1 } } },
    });
    expect((await read()).parentId).toBe(1);
    expect((await read()).updatedAt.getTime()).toBeGreaterThan(old.getTime());
    await reset();
    await db.child.upsert({
      where: { id: 1 },
      create: { id: 1, parentId: 2 },
      update: {},
    });
    expect((await read()).updatedAt).toEqual(old);
    expect((await read()).parentId).toBe(1);
    await db.parent.update({
      where: { id: 1 },
      data: {
        children: {
          upsert: { where: { id: 1 }, create: { id: 1 }, update: {} },
        },
      },
    });
    expect((await read()).updatedAt).toEqual(old);
    expect(await db.child.count()).toBe(1);
    await reset();
    await db.parent.update({
      where: { id: 2 },
      data: { children: { set: [{ id: 1 }] } },
    });
    expect((await read()).parentId).toBe(2);
    expect((await read()).updatedAt.getTime()).toBeGreaterThan(old.getTime());
  } finally {
    await db.$disconnect();
  }
});
