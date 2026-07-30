import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { hydrateSchemaNames, s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * N7-U-B — **the arms that ask for nothing.**
 *
 * Two shapes the engine used to refuse (and, worse, two it silently mis-executed),
 * both measured against Prisma 7.9.1 live (`@prisma/adapter-pg` on Postgres) before a
 * line was changed:
 *
 * 1. **The boolean no-op arm.** A to-one `disconnect` / `delete` is typed
 *    `v.boolean()` at viborm's parse boundary, so the ONLY value other than `true`
 *    that can reach the engine is the literal `false`. Prisma treats `false` as DO
 *    NOTHING — `user.update({ data: { profile: { disconnect: false } } })` returns the
 *    parent unchanged with the child row and its foreign key untouched, on the
 *    inverse side and the parent-held side alike, while the same payload spelled
 *    `true` nulls the key. viborm did three different things instead:
 *
 *      · inverse-side `disconnect: false` / `delete: false` at the root → REFUSED
 *        (`UnsupportedOperationError`), and the same `delete: false` one level deeper;
 *      · parent-held `delete: false` → REFUSED;
 *      · parent-held `disconnect: false`, and inverse-side `disconnect: false` ONE
 *        LEVEL DEEPER → **silently disconnected**. The depth path coerced the arm to
 *        `true` outright (`nested-target-parts.ts`), so `false` did the opposite of
 *        what it asked.
 *
 *    Four census sites and two silent wrong-behavior paths, one cause: the boolean was
 *    re-read at each arm instead of being resolved once. It is now resolved once, in
 *    `getRelationMutationKinds` — a kind that asks for nothing is not a kind.
 *
 * 2. **The empty nested update.** `posts: { update: { where, data: {} } }` and the
 *    `updateMany` spelling are accepted by Prisma and write nothing; a `where` that
 *    matches NO row raises nothing either (unlike a non-empty nested update, which
 *    raises P2025) — the arm is skipped whole, never located. viborm's ROOT already
 *    accepted `update({ where, data: {} })`; only the NESTED spelling refused, with no
 *    reason recorded anywhere. It now agrees with both.
 *
 * Every case below asserts STATE, not just the absence of a throw: the point of a
 * no-op is that nothing moved. The `true` controls sit beside them so a plan that
 * no-ops everything cannot pass.
 */
export const booleanNoOpSchema = (() => {
  const holder = s
    .model({
      id: s.int().id(),
      name: s.string(),
      // PARENT-held to-one: the holder row carries the FK.
      cardId: s.int().nullable().unique(),
      card: s
        .oneToOne(() => card)
        .fields("cardId")
        .references("id")
        .optional(),
      // INVERSE-side to-one: the target carries the FK.
      tag: s.oneToOne(() => tag).optional(),
      // Depth: a to-many whose target carries its own inverse-side to-one.
      items: s.oneToMany(() => item),
    })
    .map("ubn_holders");

  const card = s
    .model({
      id: s.int().id(),
      face: s.string(),
      holder: s.oneToOne(() => holder).optional(),
    })
    .map("ubn_cards");

  const tag = s
    .model({
      id: s.int().id(),
      label: s.string(),
      holderId: s.int().nullable().unique(),
      holder: s
        .oneToOne(() => holder)
        .fields("holderId")
        .references("id")
        .optional(),
    })
    .map("ubn_tags");

  const item = s
    .model({
      id: s.int().id(),
      title: s.string(),
      holderId: s.int().nullable(),
      holder: s
        .manyToOne(() => holder)
        .fields("holderId")
        .references("id")
        .optional(),
      label: s.oneToOne(() => label).optional(),
    })
    .map("ubn_items");

  const label = s
    .model({
      id: s.int().id(),
      text: s.string(),
      itemId: s.int().nullable().unique(),
      item: s
        .oneToOne(() => item)
        .fields("itemId")
        .references("id")
        .optional(),
    })
    .map("ubn_labels");

  return { holder, card, tag, item, label };
})();

hydrateSchemaNames(booleanNoOpSchema);

/** The P2025-equivalent a NON-empty nested update still raises for a missing target. */
const TARGET_NOT_FOUND = /not found/i;

export function runBooleanNoOpArmBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
}): void {
  describe(`${options.name} boolean no-op arm + empty nested update`, () => {
    const setup = async () => {
      const client: any = createClient({
        schema: booleanNoOpSchema,
        driver: options.createDriver(),
      });
      await push(client, { force: true });
      await client.card.create({ data: { id: 10, face: "face-a" } });
      await client.holder.create({
        data: { id: 1, name: "holder-a", cardId: 10 },
      });
      await client.tag.create({
        data: { id: 20, label: "tag-a", holderId: 1 },
      });
      await client.item.create({
        data: { id: 30, title: "item-a", holderId: 1 },
      });
      await client.label.create({
        data: { id: 40, text: "label-a", itemId: 30 },
      });
      return client;
    };

    // ---------------------------------------------------------------------
    // 1 — the boolean no-op arm, all four positions.
    // ---------------------------------------------------------------------

    test("inverse-side to-one `disconnect: false` moves nothing", async () => {
      const client = await setup();
      await client.holder.update({
        where: { id: 1 },
        data: { tag: { disconnect: false } },
      });
      expect(await client.tag.findUnique({ where: { id: 20 } })).toMatchObject({
        holderId: 1,
      });
    });

    test("inverse-side to-one `delete: false` moves nothing", async () => {
      const client = await setup();
      await client.holder.update({
        where: { id: 1 },
        data: { tag: { delete: false } },
      });
      expect(await client.tag.findUnique({ where: { id: 20 } })).toMatchObject({
        holderId: 1,
      });
    });

    test("parent-held to-one `disconnect: false` moves nothing", async () => {
      const client = await setup();
      await client.holder.update({
        where: { id: 1 },
        data: { card: { disconnect: false } },
      });
      expect(
        await client.holder.findUnique({ where: { id: 1 } })
      ).toMatchObject({ cardId: 10 });
    });

    test("parent-held to-one `delete: false` moves nothing", async () => {
      const client = await setup();
      await client.holder.update({
        where: { id: 1 },
        data: { card: { delete: false } },
      });
      expect(
        await client.holder.findUnique({ where: { id: 1 } })
      ).toMatchObject({ cardId: 10 });
      expect(
        await client.card.findUnique({ where: { id: 10 } })
      ).not.toBeNull();
    });

    test("`disconnect: false` ONE LEVEL DEEPER moves nothing (was a silent disconnect)", async () => {
      const client = await setup();
      await client.holder.update({
        where: { id: 1 },
        data: {
          items: {
            update: {
              where: { id: 30 },
              data: { label: { disconnect: false } },
            },
          },
        },
      });
      expect(
        await client.label.findUnique({ where: { id: 40 } })
      ).toMatchObject({ itemId: 30 });
    });

    test("`delete: false` ONE LEVEL DEEPER moves nothing", async () => {
      const client = await setup();
      await client.holder.update({
        where: { id: 1 },
        data: {
          items: {
            update: { where: { id: 30 }, data: { label: { delete: false } } },
          },
        },
      });
      expect(
        await client.label.findUnique({ where: { id: 40 } })
      ).not.toBeNull();
    });

    // The controls: `true` still acts, in every one of those positions. Without
    // these, a plan that dropped every to-one arm would pass the six above.

    test("`disconnect: true` still disconnects (inverse side, parent-held, and at depth)", async () => {
      const client = await setup();
      await client.holder.update({
        where: { id: 1 },
        data: { tag: { disconnect: true } },
      });
      expect(await client.tag.findUnique({ where: { id: 20 } })).toMatchObject({
        holderId: null,
      });
      await client.holder.update({
        where: { id: 1 },
        data: { card: { disconnect: true } },
      });
      expect(
        await client.holder.findUnique({ where: { id: 1 } })
      ).toMatchObject({ cardId: null });
      await client.holder.update({
        where: { id: 1 },
        data: {
          items: {
            update: {
              where: { id: 30 },
              data: { label: { disconnect: true } },
            },
          },
        },
      });
      expect(
        await client.label.findUnique({ where: { id: 40 } })
      ).toMatchObject({ itemId: null });
    });

    test("`delete: true` still deletes (inverse side and parent-held)", async () => {
      const client = await setup();
      await client.holder.update({
        where: { id: 1 },
        data: { tag: { delete: true } },
      });
      expect(await client.tag.findUnique({ where: { id: 20 } })).toBeNull();
      await client.holder.update({
        where: { id: 1 },
        data: { card: { delete: true } },
      });
      expect(await client.card.findUnique({ where: { id: 10 } })).toBeNull();
      expect(
        await client.holder.findUnique({ where: { id: 1 } })
      ).toMatchObject({ cardId: null });
    });

    test("a relation payload with only no-op arms leaves its siblings alone", async () => {
      const client = await setup();
      await client.holder.update({
        where: { id: 1 },
        data: {
          name: "renamed",
          card: { disconnect: false },
          tag: { delete: false },
        },
      });
      const holder = await client.holder.findUnique({ where: { id: 1 } });
      expect(holder).toMatchObject({ name: "renamed", cardId: 10 });
      expect(await client.tag.findUnique({ where: { id: 20 } })).toMatchObject({
        holderId: 1,
      });
    });

    // ---------------------------------------------------------------------
    // 2 — the empty nested update.
    // ---------------------------------------------------------------------

    test("nested `update` with empty data writes nothing", async () => {
      const client = await setup();
      await client.holder.update({
        where: { id: 1 },
        data: { items: { update: { where: { id: 30 }, data: {} } } },
      });
      expect(await client.item.findUnique({ where: { id: 30 } })).toMatchObject(
        {
          title: "item-a",
          holderId: 1,
        }
      );
    });

    test("nested `updateMany` with empty data writes nothing", async () => {
      const client = await setup();
      await client.holder.update({
        where: { id: 1 },
        data: { items: { updateMany: { where: { id: 30 }, data: {} } } },
      });
      expect(await client.item.findUnique({ where: { id: 30 } })).toMatchObject(
        {
          title: "item-a",
        }
      );
    });

    test("an empty nested `update` does NOT require the target to exist", async () => {
      const client = await setup();
      // Prisma, measured: with `data: {}` a `where` matching no row raises nothing —
      // the arm is skipped, never located. With NON-empty data the same `where`
      // raises P2025, which is the control immediately below.
      await client.holder.update({
        where: { id: 1 },
        data: { items: { update: { where: { id: 999 }, data: {} } } },
      });
      expect(await client.item.findUnique({ where: { id: 30 } })).toMatchObject(
        {
          title: "item-a",
        }
      );
    });

    test("a NON-empty nested `update` still requires the target to exist", async () => {
      const client = await setup();
      await expect(
        client.holder.update({
          where: { id: 1 },
          data: {
            items: { update: { where: { id: 999 }, data: { title: "x" } } },
          },
        })
      ).rejects.toThrow(TARGET_NOT_FOUND);
    });

    test("an empty to-one nested `update` writes nothing, on both directions", async () => {
      const client = await setup();
      await client.holder.update({
        where: { id: 1 },
        data: { tag: { update: {} }, card: { update: {} } },
      });
      expect(await client.tag.findUnique({ where: { id: 20 } })).toMatchObject({
        label: "tag-a",
        holderId: 1,
      });
      expect(await client.card.findUnique({ where: { id: 10 } })).toMatchObject(
        {
          face: "face-a",
        }
      );
    });

    test("an empty nested update alongside a non-empty sibling leaves the sibling working", async () => {
      const client = await setup();
      await client.holder.update({
        where: { id: 1 },
        data: {
          items: { update: { where: { id: 30 }, data: {} } },
          tag: { update: { label: "tag-b" } },
        },
      });
      expect(await client.item.findUnique({ where: { id: 30 } })).toMatchObject(
        {
          title: "item-a",
        }
      );
      expect(await client.tag.findUnique({ where: { id: 20 } })).toMatchObject({
        label: "tag-b",
      });
    });
  });
}
