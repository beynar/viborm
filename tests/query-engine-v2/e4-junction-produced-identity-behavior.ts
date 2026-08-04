import { hydrateSchemaNames, s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * E4-U3 — **the relation-carrying junction create arm whose target key is produced by
 * its own INSERT.**
 *
 * Measured at 2e4e297, at construction, for all three arms that make a junction target:
 *
 *   UnsupportedOperationError: query-engine-v2 create-through-junction for relation
 *   'stamps' requires the target primary key 'id' in the create data (create).
 *   … (connectOrCreate).
 *
 * The reason was real and narrow: the arm's deeper edges folded against a COMPILE-TIME
 * literal (`literalParentId`), and a database-generated key is a backward `Ref` — there
 * is no literal to fold against. A scalar-only arm was fine, because it asked for no
 * literal at all.
 *
 * The absorption does not teach the fold to carry a `Ref`. It stops folding: the arm
 * becomes a whole create SUBTREE through `buildNestedTargetFreshCreatePart`, and the
 * create root has threaded produced identities to its own children since N4-U4. What the
 * junction still owns is the JOIN ROW, and it now takes the same produced identity the
 * subtree's grandchildren take — from the subtree, by asking it
 * (`rootReferenced`), never re-derived.
 *
 * Two obligations came with it, both witnessed here:
 *
 *  · **the racePin.** The subtree REPLACES the arm's `childInsert`, and with it the
 *    unique-constraint pin the arm's missing premise is enforced by (the Pin Rule).
 *    E2 refused the delegation rather than make that trade silently. The pin now rides
 *    the subtree's ROOT insert (`nestedFresh.rootRacePin`) — for the create arm this
 *    unit opened AND for the whole-create delegation X1c already shipped.
 *  · **the dedup ledger (the E2×E4 composition).** `connectOrCreate` deduplicates
 *    sibling items that name one target; with a produced key there is no compile-time
 *    value to key on, so the ledger keys by the `where` and stores the EARLIER item's
 *    produced `Ref`. The duplicate item's join row then addresses the row the first item
 *    made.
 */
export const producedIdentitySchema = (() => {
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      stamps: s.manyToMany(() => stamp),
    })
    .map("e4u3_posts");

  const stamp = s
    .model({
      id: s.int().id().increment(),
      name: s.string().unique(),
      posts: s.manyToMany(() => post),
      notes: s.oneToMany(() => note),
    })
    .map("e4u3_stamps");

  const note = s
    .model({
      id: s.string().id(),
      body: s.string(),
      stampId: s.int(),
      stamp: s
        .manyToOne(() => stamp)
        .fields("stampId")
        .references("id"),
    })
    .map("e4u3_notes");

  return { post, stamp, note };
})();

hydrateSchemaNames(producedIdentitySchema);

async function reset(client: any): Promise<void> {
  await client.note.deleteMany({});
  await client.post.deleteMany({});
  await client.stamp.deleteMany({});
}

/**
 * The DECOY is seeded first and owns a note of its own, so the sequence has already
 * moved: a join row (or a grandchild) carrying a stale, borrowed, or previous-insert
 * identity lands on the decoy instead of on the row this statement made. That is the
 * wrong-row witness, not a value comparison.
 */
async function seedDecoy(client: any): Promise<number> {
  const decoy = await client.stamp.create({ data: { name: "decoy" } });
  await client.note.create({
    data: { id: "n-decoy", body: "decoy", stampId: decoy.id },
  });
  return decoy.id as number;
}

export function registerProducedIdentityBehavior(
  name: string,
  connect: () => Promise<any>,
  register: (label: string, body: () => void) => void = describe
): void {
  register(`E4-U3 junction produced identity (${name})`, () => {
    test("the create arm's produced id reaches BOTH the join row and the grandchildren", async () => {
      const client = await connect();
      await reset(client);
      const decoyId = await seedDecoy(client);

      await client.post.create({
        data: {
          id: "p1",
          title: "t",
          stamps: {
            create: {
              name: "fresh",
              notes: { create: { id: "n-fresh", body: "b" } },
            },
          },
        },
      });

      const fresh = await client.stamp.findUnique({
        where: { name: "fresh" },
      });
      expect(fresh.id).not.toBe(decoyId);
      // The JOIN row carries THIS insert's id — asked for through the m2m filter, so
      // the assertion reads the junction table rather than the child's own columns.
      expect(
        (
          await client.stamp.findMany({
            where: { posts: { some: { id: "p1" } } },
          })
        ).map((row: any) => row.id)
      ).toEqual([fresh.id]);
      // …and so does the GRANDCHILD, which the subtree wrote.
      expect(
        await client.note.findUnique({ where: { id: "n-fresh" } })
      ).toMatchObject({ stampId: fresh.id });
      // The decoy is untouched: it owns exactly its own note, and no join row.
      expect(
        await client.note.findMany({ where: { stampId: decoyId } })
      ).toMatchObject([{ id: "n-decoy" }]);
      expect(
        await client.stamp.findMany({
          where: { id: decoyId, posts: { some: { id: "p1" } } },
        })
      ).toEqual([]);
    }, 120_000);

    test("a multi-entry array gives each item its OWN produced id", async () => {
      const client = await connect();
      await reset(client);
      await seedDecoy(client);

      await client.post.create({
        data: {
          id: "p2",
          title: "t",
          stamps: {
            create: [
              { name: "a", notes: { create: { id: "n-a", body: "a" } } },
              { name: "b", notes: { create: { id: "n-b", body: "b" } } },
            ],
          },
        },
      });

      const a = await client.stamp.findUnique({ where: { name: "a" } });
      const b = await client.stamp.findUnique({ where: { name: "b" } });
      expect(a.id).not.toBe(b.id);
      expect(
        await client.note.findUnique({ where: { id: "n-a" } })
      ).toMatchObject({ stampId: a.id });
      expect(
        await client.note.findUnique({ where: { id: "n-b" } })
      ).toMatchObject({ stampId: b.id });
      expect(
        (
          await client.stamp.findMany({
            where: { posts: { some: { id: "p2" } } },
            orderBy: { id: "asc" },
          })
        ).map((row: any) => row.id)
      ).toEqual([a.id, b.id].sort((x, y) => x - y));
    }, 120_000);

    test("connectOrCreate: the second item adopts the FIRST item's produced row", async () => {
      // THE E2×E4 COMPOSITION. With a produced key the dedup ledger has no
      // compile-time value to key on, so it keys by the `where` and stores the first
      // item's produced `Ref`. First create wins WHOLE: the second item's create
      // payload — its grandchild included — is not applied to the row that is already
      // there.
      const client = await connect();
      await reset(client);
      await seedDecoy(client);
      await client.post.create({ data: { id: "p3", title: "t" } });

      await client.post.update({
        where: { id: "p3" },
        data: {
          stamps: {
            connectOrCreate: [
              {
                where: { name: "dup" },
                create: {
                  name: "dup",
                  notes: { create: { id: "n-first", body: "first" } },
                },
              },
              {
                where: { name: "dup" },
                create: {
                  name: "dup",
                  notes: { create: { id: "n-second", body: "second" } },
                },
              },
            ],
          },
        },
      });

      const dup = await client.stamp.findMany({ where: { name: "dup" } });
      expect(dup).toHaveLength(1);
      expect(
        (
          await client.stamp.findMany({
            where: { posts: { some: { id: "p3" } } },
          })
        ).map((row: any) => row.id)
      ).toEqual([dup[0].id]);
      expect(
        await client.note.findUnique({ where: { id: "n-first" } })
      ).toMatchObject({ stampId: dup[0].id });
      expect(
        await client.note.findUnique({ where: { id: "n-second" } })
      ).toBeNull();
    }, 120_000);

    test("connectOrCreate: the FOUND arm still adopts without describing", async () => {
      const client = await connect();
      await reset(client);
      await seedDecoy(client);
      await client.post.create({ data: { id: "p4", title: "t" } });
      const existing = await client.stamp.create({ data: { name: "here" } });

      await client.post.update({
        where: { id: "p4" },
        data: {
          stamps: {
            connectOrCreate: {
              where: { name: "here" },
              create: {
                name: "here",
                notes: { create: { id: "n-never", body: "never" } },
              },
            },
          },
        },
      });

      expect(
        (
          await client.stamp.findMany({
            where: { posts: { some: { id: "p4" } } },
          })
        ).map((row: any) => row.id)
      ).toEqual([existing.id]);
      // The create payload describes nothing about a row that was already there.
      expect(
        await client.note.findUnique({ where: { id: "n-never" } })
      ).toBeNull();
    }, 120_000);

    test("the upsert create arm rides the same produced identity", async () => {
      const client = await connect();
      await reset(client);
      await seedDecoy(client);
      await client.post.create({ data: { id: "p5", title: "t" } });

      await client.post.update({
        where: { id: "p5" },
        data: {
          stamps: {
            upsert: {
              where: { name: "made-by-upsert" },
              create: {
                name: "made-by-upsert",
                notes: { create: { id: "n-upsert", body: "b" } },
              },
              update: { name: "unused" },
            },
          },
        },
      });

      const made = await client.stamp.findUnique({
        where: { name: "made-by-upsert" },
      });
      expect(
        (
          await client.stamp.findMany({
            where: { posts: { some: { id: "p5" } } },
          })
        ).map((row: any) => row.id)
      ).toEqual([made.id]);
      expect(
        await client.note.findUnique({ where: { id: "n-upsert" } })
      ).toMatchObject({ stampId: made.id });
    }, 120_000);

    test("skipDuplicates with a produced key ADOPTS instead of refusing (E4-U3 × E6.8)", async () => {
      const client = await connect();
      await reset(client);
      // RETARGETED by U-E6.8 (maintainer-authorized). This test used to pin the sibling
      // refusal E4-U3 deliberately left standing. E6.8 absorbed it for this exact shape:
      // `stamp` spells one nameable unique (`name`), so the row becomes a
      // `connectOrCreate` adopt — which has an identity where the skip leaf had none.
      // What the composition owes E4-U3 is that BOTH branches still produce a join row
      // addressed to the right stamp: the adopted one by the probe's captured key, the
      // fresh one by the `Ref` its own INSERT produced.
      const existing = await client.stamp.create({ data: { name: "sitting" } });
      await client.post.create({
        data: {
          id: "p6",
          title: "t",
          stamps: {
            createMany: {
              data: [{ name: "sitting" }, { name: "arriving" }],
              skipDuplicates: true,
            },
          },
        },
      });
      const fresh = await client.stamp.findUnique({
        where: { name: "arriving" },
      });
      expect(fresh.id).not.toBe(existing.id);
      expect(
        (
          await client.stamp.findMany({
            where: { posts: { some: { id: "p6" } } },
            orderBy: { name: "asc" },
          })
        ).map((row: any) => row.id)
      ).toEqual([fresh.id, existing.id]);
    }, 120_000);
  });
}
