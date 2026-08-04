import { hydrateSchemaNames, s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * U-E6.1 — **the junction upsert arm's probe id.**
 *
 * Measured live before the wire, on both substrates, through the public client:
 *
 *   UnsupportedOperationError: query-engine-v2 nested 'upsert' on many-to-many
 *   relation 'tags' carries nested relation writes; it must locate the target by its
 *   primary key 'id'.
 *
 *   UnsupportedOperationError: query-engine-v2 create does not support nested 'upsert'
 *   on the many-to-many relation 'tags' whose update arm carries a relation write that
 *   needs the whole-target update; the adopted target would be located a second time by
 *   its selector instead of by the key this arm's probe captured.
 *
 * and, for the third shape, no refusal at all — a measured wrong address instead. The
 * whole-target arm's planning read the SELECTOR A THIRD TIME, after two probes had
 * already spent it:
 *
 *   tag.member  SELECT "id" FROM "e61_tags"
 *                 WHERE "id" IN (SELECT "tagId" FROM "tag_user" WHERE "userId" = ?)
 *                   AND "slug" = ?                          ← the membership probe
 *   tag.find    SELECT "id" FROM "e61_tags" WHERE "slug" = ?  ← the global probe
 *   tag.locate  SELECT "id" FROM "e61_tags" WHERE "slug" = ?  ← the DELEGATED locate
 *
 * while the join row and the arm's own guard address the key `tag.member` captured. Two
 * addresses for one row is the split-witness a concurrent selector move opens — and on
 * the create arm it was not even latent. Measured, per arm, at the update root:
 *
 *   FOUND arm  -> OK
 *   CREATE arm -> NestedWriteError: Cannot update relation 'tags': target record was
 *                 not found for this parent.
 *
 * The untaken arm's second locate found nothing and aborted the operation.
 *
 * ONE cause behind all three. The `update` kind pre-allocates its target probe ids so a
 * target named by some OTHER unique can hand its deeper edges a `planned` read of the
 * row the slot located (N4-U1). The upsert fold passed `undefined` instead, and the
 * refusal that filled the gap was justified by the created-earlier dedup branch —
 * which N7-U-C DELETED. What was left was a wire, not a wall.
 *
 * The unit wires it: the builder allocates the slot's two probe ids, hands the arm the
 * one `compile` will spend on it (the membership probe under a correlated parent, the
 * global probe under a fresh one), and the delegated whole-target update locates by
 * that captured key instead of by the selector.
 *
 * Every witness below runs against a DECOY that shares the arm's NON-UNIQUE half — same
 * weight, same shape, different unique name, not a member — so a write that re-derived
 * its address from the selector, or took any row but the located one, lands somewhere
 * observable.
 */
export const junctionUpsertArmSchema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      tags: s.manyToMany(() => tag),
    })
    .map("e61_users");

  const tag = s
    .model({
      id: s.int().id().increment(),
      slug: s.string().unique(),
      weight: s.int().default(0),
      ownerId: s.string().nullable(),
      // A PARENT-HELD to-one on the target: `targetNeedsFullUpdate`, so an update arm
      // carrying it delegates the WHOLE target write to `UpdateOperation`.
      owner: s
        .manyToOne(() => owner)
        .fields("ownerId")
        .references("id")
        .optional(),
      // A CHILD-HELD to-many: the deeper edge folds IN PLACE against the target's own
      // primary key, which is the `planned` source the arm's probe now supplies.
      notes: s.oneToMany(() => note),
      users: s.manyToMany(() => user),
    })
    .map("e61_tags");

  const owner = s
    .model({
      id: s.string().id(),
      label: s.string(),
      tags: s.oneToMany(() => tag),
    })
    .map("e61_owners");

  const note = s
    .model({
      id: s.string().id(),
      body: s.string(),
      tagId: s.int(),
      tag: s
        .manyToOne(() => tag)
        .fields("tagId")
        .references("id"),
    })
    .map("e61_notes");

  return { user, tag, owner, note };
})();

hydrateSchemaNames(junctionUpsertArmSchema);

async function reset(client: any): Promise<void> {
  await client.note.deleteMany({});
  await client.user.deleteMany({});
  await client.tag.deleteMany({});
  await client.owner.deleteMany({});
}

/**
 * The decoy world: a tag that shares the target's non-unique half (`weight: 4`), owns
 * its own note, and belongs to its own user. Nothing this suite asks for names it.
 */
async function seedDecoy(client: any): Promise<{
  decoyTagId: number;
  decoyUserId: string;
}> {
  const decoyTag = await client.tag.create({
    data: { slug: "decoy", weight: 4 },
  });
  await client.note.create({
    data: { id: "n-decoy", body: "decoy", tagId: decoyTag.id },
  });
  await client.user.create({
    data: {
      id: "u-decoy",
      name: "decoy",
      tags: { connect: { id: decoyTag.id } },
    },
  });
  await client.owner.create({ data: { id: "o-decoy", label: "decoy" } });
  return { decoyTagId: decoyTag.id, decoyUserId: "u-decoy" };
}

const tagsOf = async (client: any, userId: string): Promise<number[]> =>
  (
    await client.tag.findMany({
      where: { users: { some: { id: userId } } },
      orderBy: { id: "asc" },
    })
  ).map((row: any) => row.id);

export function registerJunctionUpsertArmProbeBehavior(
  name: string,
  connect: () => Promise<any>,
  register: (label: string, body: () => void) => void = describe
): void {
  register(`U-E6.1 the junction upsert arm's probe id (${name})`, () => {
    test("UPDATE root: a relation-carrying arm by a NON-PK unique folds against the member probe's key", async () => {
      const client = await connect();
      await reset(client);
      const decoy = await seedDecoy(client);
      const target = await client.tag.create({
        data: { slug: "target", weight: 4 },
      });
      await client.user.create({
        data: { id: "u1", name: "u", tags: { connect: { id: target.id } } },
      });

      await client.user.update({
        where: { id: "u1" },
        data: {
          tags: {
            upsert: {
              where: { slug: "target" },
              create: { slug: "target" },
              update: {
                weight: 9,
                notes: { create: { id: "n-1", body: "b" } },
              },
            },
          },
        },
      });

      expect(
        await client.note.findUnique({ where: { id: "n-1" } })
      ).toMatchObject({ tagId: target.id });
      expect(
        (await client.tag.findUnique({ where: { id: target.id } })).weight
      ).toBe(9);
      // The look-alike kept its own weight and its own note.
      expect(
        (await client.tag.findUnique({ where: { id: decoy.decoyTagId } }))
          .weight
      ).toBe(4);
      expect(
        (
          await client.note.findMany({ where: { tagId: decoy.decoyTagId } })
        ).map((row: any) => row.id)
      ).toEqual(["n-decoy"]);
    }, 120_000);

    test("UPDATE root: the WHOLE-TARGET arm delegates against the captured key, both arms", async () => {
      const client = await connect();
      await reset(client);
      const decoy = await seedDecoy(client);
      await client.owner.create({ data: { id: "o1", label: "o" } });
      const target = await client.tag.create({
        data: { slug: "target", weight: 4 },
      });
      await client.user.create({
        data: { id: "u1", name: "u", tags: { connect: { id: target.id } } },
      });

      // FOUND arm — the delegated `UpdateOperation` locates by the membership probe's
      // captured primary key, not by `slug` a second time.
      await client.user.update({
        where: { id: "u1" },
        data: {
          tags: {
            upsert: {
              where: { slug: "target" },
              create: { slug: "target" },
              update: { owner: { connect: { id: "o1" } } },
            },
          },
        },
      });
      expect(
        (await client.tag.findUnique({ where: { id: target.id } })).ownerId
      ).toBe("o1");
      expect(
        (await client.tag.findUnique({ where: { id: decoy.decoyTagId } }))
          .ownerId
      ).toBeNull();

      // CREATE arm — the delegated locate finds nothing and must NOT raise the
      // target's own not-found: an empty probe here is the create decision. This is
      // the leg that used to abort the whole operation.
      await client.user.update({
        where: { id: "u1" },
        data: {
          tags: {
            upsert: {
              where: { slug: "fresh" },
              create: { slug: "fresh", weight: 7 },
              update: { owner: { connect: { id: "o1" } } },
            },
          },
        },
      });
      const fresh = await client.tag.findUnique({ where: { slug: "fresh" } });
      expect(fresh.weight).toBe(7);
      // The update arm's payload is NOT applied to the row the create arm made.
      expect(fresh.ownerId).toBeNull();
      expect(await tagsOf(client, "u1")).toEqual(
        [target.id, fresh.id].sort((a, b) => a - b)
      );
      expect(await tagsOf(client, decoy.decoyUserId)).toEqual([
        decoy.decoyTagId,
      ]);
    }, 120_000);

    test("UPDATE root: a target that exists but is NOT a member still refuses", async () => {
      // The correlated upsert's own V7001 is untouched by the wiring: the membership
      // probe is empty, the global probe is not, and adopting a foreign row is still
      // refused. The absorption widened WHICH key the arm addresses, never WHOSE row.
      const client = await connect();
      await reset(client);
      await seedDecoy(client);
      await client.tag.create({ data: { slug: "outsider", weight: 4 } });
      await client.user.create({ data: { id: "u1", name: "u" } });

      await expect(
        client.user.update({
          where: { id: "u1" },
          data: {
            tags: {
              upsert: {
                where: { slug: "outsider" },
                create: { slug: "outsider" },
                update: { notes: { create: { id: "n-no", body: "x" } } },
              },
            },
          },
        })
      ).rejects.toThrow(
        "Cannot upsert relation 'tags': target record was not found for this parent."
      );
      expect(await client.note.count({ where: { id: "n-no" } })).toBe(0);
    }, 120_000);

    test("CREATE root: the fresh-parent arm folds against the GLOBAL probe's key", async () => {
      const client = await connect();
      await reset(client);
      const decoy = await seedDecoy(client);
      const target = await client.tag.create({
        data: { slug: "target", weight: 4 },
      });

      const made = await client.user.create({
        data: {
          id: "u2",
          name: "u",
          tags: {
            upsert: {
              where: { slug: "target" },
              create: { slug: "target" },
              update: { notes: { create: { id: "n-2", body: "b" } } },
            },
          },
        },
      });

      expect(
        await client.note.findUnique({ where: { id: "n-2" } })
      ).toMatchObject({ tagId: target.id });
      expect(await tagsOf(client, made.id)).toEqual([target.id]);
      expect(
        (
          await client.note.findMany({ where: { tagId: decoy.decoyTagId } })
        ).map((row: any) => row.id)
      ).toEqual(["n-decoy"]);
    }, 120_000);

    test("CREATE root: the fresh-parent WHOLE-TARGET arm delegates against the captured key", async () => {
      const client = await connect();
      await reset(client);
      const decoy = await seedDecoy(client);
      await client.owner.create({ data: { id: "o1", label: "o" } });
      const target = await client.tag.create({
        data: { slug: "target", weight: 4 },
      });

      const made = await client.user.create({
        data: {
          id: "u3",
          name: "u",
          tags: {
            upsert: {
              where: { slug: "target" },
              create: { slug: "target" },
              update: { owner: { connect: { id: "o1" } } },
            },
          },
        },
      });

      expect(
        (await client.tag.findUnique({ where: { id: target.id } })).ownerId
      ).toBe("o1");
      expect(await tagsOf(client, made.id)).toEqual([target.id]);
      expect(
        (await client.tag.findUnique({ where: { id: decoy.decoyTagId } }))
          .ownerId
      ).toBeNull();
    }, 120_000);
  });
}
