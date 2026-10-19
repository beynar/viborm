/**
 * An upsert under a policy that grants `create` and no update: its update arm
 * finds no row, so an existing row reaches the create arm and the database
 * refuses its key. That refusal is reported as the update's `ForbiddenError`,
 * with the unique violation as its cause, where the violated constraint is the
 * key `where` names; a missing row is still created.
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import {
  ForbiddenError,
  UniqueConstraintError,
  VibORMErrorCode,
} from "@errors";
import { s } from "@schema";
import { permissions } from "@src/permissions";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { expect, test } from "vitest";

export function runPermissionsUpsertBehavior(substrate: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
}): void {
  test(`${substrate.name}: an upsert onto an existing row without the update action is a ForbiddenError; a missing row is created`, async () => {
    const tag = s.model({
      id: s.string().id(),
      slug: s.string().unique(),
      body: s.string(),
    });
    const base = createClient({
      schema: { tag },
      driver: substrate.createDriver(),
    });
    try {
      await syncLiveSchema(base);
      await base.tag.create({ data: { id: "t1", slug: "one", body: "x" } });
      const db = base
        .$extends(
          permissions({
            actor: v.object({ userId: v.string() }),
            models: { tag: { read: true, create: true } },
          })
        )
        .$as({ userId: "u1" });
      // By the primary key and by a unique field, each create colliding on
      // that key alone (a provider reports one violated constraint).
      for (const [where, id, slug] of [
        [{ id: "t1" }, "t1", "uno"],
        [{ slug: "one" }, "t9", "one"],
      ] as const) {
        const refused = await db.tag
          .upsert({
            where,
            update: { body: "y" },
            create: { id, slug, body: "z" },
          })
          .catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(ForbiddenError);
        expect((refused as Error).message).toBe(
          "The update on tag is not permitted: the row this upsert locates exists"
        );
        // The cause is the unique violation, as every cause is kept: a
        // sanitized copy carrying its code.
        expect(
          (refused as Error & { cause: { code?: unknown } }).cause.code
        ).toBe(VibORMErrorCode.UNIQUE_CONSTRAINT);
      }
      // A missing row is created, whether or not the update arm writes.
      expect(
        await db.tag.upsert({
          where: { id: "t2" },
          update: { body: "y" },
          create: { id: "t2", slug: "two", body: "z" },
        })
      ).toEqual({ id: "t2", slug: "two", body: "z" });
      expect(
        await db.tag.upsert({
          where: { id: "t1" },
          update: {},
          create: { id: "t1", slug: "one", body: "z" },
        })
      ).toEqual({ id: "t1", slug: "one", body: "x" });
      // Another key the create collides on is the create's own violation.
      await expect(
        db.tag.upsert({
          where: { id: "t3" },
          update: { body: "y" },
          create: { id: "t3", slug: "one", body: "z" },
        })
      ).rejects.toBeInstanceOf(UniqueConstraintError);
      expect(
        await base.tag.findMany({
          orderBy: { id: "asc" },
          select: { id: true, body: true },
        })
      ).toEqual([
        { id: "t1", body: "x" },
        { id: "t2", body: "z" },
      ]);
    } finally {
      await base.$disconnect();
    }
  });
}
