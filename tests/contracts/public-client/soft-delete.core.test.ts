/**
 * `viborm/soft-delete` (extension-capabilities plan v3.1 §1.1) on in-memory
 * SQLite: the plan's use block end to end (`soft-delete-behavior.ts`, which
 * PGlite also runs), plus the configuration branches the use block does not
 * take: no actor field, and an actor field with no actor.
 */

import { softDelete } from "@src/soft-delete";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import {
  openSoftDeleteFixture,
  runSoftDeleteBehavior,
  type SoftDeleteBase,
} from "./soft-delete-behavior";

runSoftDeleteBehavior({
  name: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
});

describe("SQLite3: viborm/soft-delete configuration branches", () => {
  const opened: SoftDeleteBase[] = [];
  afterEach(async () => {
    for (const base of opened.splice(0)) await base.$disconnect();
  });
  async function fixture() {
    const base = await openSoftDeleteFixture(createInMemorySQLite3Driver());
    opened.push(base);
    await base.post.update({
      where: { id: "p1" },
      data: { deletedById: "stale" },
    });
    return base;
  }
  const marks = (base: SoftDeleteBase) =>
    base.post.findUniqueOrThrow({
      where: { id: "p1" },
      select: { deletedAt: true, deletedById: true },
    });

  test("without `deletedBy`, a delete writes the marker only and restore clears the marker only", async () => {
    const base = await fixture();
    const db = softDelete({ models: { post: { deletedAt: "deletedAt" } } })(
      base
    );
    await db.post.delete({ where: { id: "p1" } });
    const deleted = await marks(base);
    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect(deleted.deletedById).toBe("stale");
    expect(await db.post.restoreMany({ where: { id: "p1" } })).toEqual({
      count: 1,
    });
    expect(await marks(base)).toEqual({
      deletedAt: null,
      deletedById: "stale",
    });
  });

  test("with `deletedBy` and no actor, a delete writes the actor field null", async () => {
    const base = await fixture();
    const db = softDelete({
      models: { post: { deletedAt: "deletedAt", deletedBy: "deletedById" } },
    })(base);
    await db.post.delete({ where: { id: "p1" } });
    const deleted = await marks(base);
    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect(deleted.deletedById).toBeNull();
  });
});
