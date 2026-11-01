/**
 * `viborm/soft-delete` (extension-capabilities plan v3.1 §1.1) on in-memory
 * SQLite: the plan's use block end to end (`soft-delete-behavior.ts`, which
 * PGlite also runs), on the interactive driver and on one without RETURNING
 * (MySQL's shape), plus the configuration branches the use block does not
 * take: no actor field, and an actor field with no actor.
 */

import { ClientInitializationError, createClient, s } from "@src/index";
import { softDelete } from "@src/soft-delete";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { createNonReturningSQLite3Driver } from "@tests/providers/local/sqlite3-fixtures";
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
runSoftDeleteBehavior({
  name: "SQLite3 without RETURNING",
  createDriver: createNonReturningSQLite3Driver,
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

  test("the marker must be a nullable DateTime: anything else is refused when the extension is applied", () => {
    const model = s.model({
      id: s.string().id(),
      required: s.dateTime(),
      text: s.string().nullable(),
      dates: s.dateTime().array(),
      marker: s.dateTime().nullable(),
    });
    const base = createClient({
      schema: { model },
      driver: createInMemorySQLite3Driver(),
    });
    for (const field of ["required", "text", "dates"]) {
      const apply = () =>
        softDelete({ models: { model: { deletedAt: field } } })(base);
      expect(apply).toThrow(ClientInitializationError);
      expect(apply).toThrow(
        `softDelete: model.${field} must be a nullable DateTime field`
      );
      // The two steps of a chain written before 1.8 check it too.
      expect(() =>
        softDelete({ models: { model: { deletedAt: field } } }).rows(base)
      ).toThrow(ClientInitializationError);
    }
    expect(() =>
      softDelete({ models: { model: { deletedAt: "marker" } } })(base)
    ).not.toThrow();
    // A field the model lacks is core's refusal, as before.
    expect(() =>
      softDelete({ models: { model: { deletedAt: "missing" } } })(base)
    ).toThrow(
      'Extension "viborm.softDelete" deletion.model.at names unknown scalar.'
    );
  });
});
