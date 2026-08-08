import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { NestedWriteError } from "@errors";
import { hydrateSchemaNames, s } from "@schema";
import {
  type BehaviorDatabaseSource,
  useBehaviorDatabase,
} from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

/**
 * E1 — the parent-held to-one LOOKUP bed.
 *
 * Every shape wave E1 absorbs resolves a parent-held foreign key from something
 * the payload does not spell: a target row addressed by a unique the FK does not
 * reference, a target the same tree is about to INSERT, a target whose referenced
 * column is not its primary key. The models below exist to give each of those a
 * row it must land on and a DECOY it must not.
 *
 *  · `author` / `book` — the FK references the target's PRIMARY key and the
 *    payload addresses the target by `email`. The connect value is therefore a
 *    lookup, not a literal (E1 U1/U2).
 *  · `award` — a relation hanging off `author`, so a target `create` or an
 *    `upsert` arm can carry one (E1 U3/U4).
 *  · `badge` / `holder` — the FK references `code`, a NULLABLE non-primary-key
 *    unique, and the payload addresses the badge by `slug`. This is the single
 *    field NON-PK half of the correlation site (E1 U6) and the bed for the
 *    carve-out that stays refused: a found badge whose `code` is NULL cannot be
 *    connected to, because writing the lookup's NULL would silently DISCONNECT.
 *  · `node` — a SELF relation, so the connect lookup reads the very table the
 *    UPDATE mutates. MySQL rejects that (ERROR 1093) unless the subquery hides
 *    behind a derived table, which is why the MySQL leg of U1 runs here.
 */
export const parentHeldLookupSchema = (() => {
  const author = s
    .model({
      id: s.int().id(),
      email: s.string().unique(),
      name: s.string(),
      books: s.oneToMany(() => book),
      awards: s.oneToMany(() => award),
    })
    .map("e1_authors");
  const award = s
    .model({
      id: s.int().id(),
      title: s.string(),
      authorId: s.int(),
      author: s
        .manyToOne(() => author)
        .fields("authorId")
        .references("id"),
    })
    .map("e1_awards");
  const book = s
    .model({
      id: s.int().id(),
      title: s.string(),
      authorId: s.int().nullable(),
      author: s
        .manyToOne(() => author)
        .fields("authorId")
        .references("id")
        .optional(),
    })
    .map("e1_books");
  const badge = s
    .model({
      id: s.int().id(),
      slug: s.string().unique(),
      code: s.string().nullable().unique(),
      tier: s.string(),
      holders: s.oneToMany(() => holder),
    })
    .map("e1_badges");
  const holder = s
    .model({
      id: s.int().id(),
      name: s.string(),
      badgeCode: s.string().nullable(),
      badge: s
        .manyToOne(() => badge)
        .fields("badgeCode")
        .references("code")
        .optional(),
    })
    .map("e1_holders");
  const node = s
    .model({
      id: s.int().id(),
      label: s.string().unique(),
      parentId: s.int().nullable(),
      parent: s
        .manyToOne(() => node)
        .fields("parentId")
        .references("id")
        .optional(),
      children: s.oneToMany(() => node),
    })
    .map("e1_nodes");
  // The SHARED-primary-key edge: the profile's own primary key IS the foreign key
  // this relation resolves. Nothing here is absorbed — the row exists so the
  // refusal that stays (E1 U5) has a live reproduction rather than a citation.
  const owner = s
    .model({
      id: s.int().id(),
      email: s.string().unique(),
      profile: s.oneToOne(() => profile).optional(),
    })
    .map("e1_owners");
  const profile = s
    .model({
      ownerId: s.int().id(),
      bio: s.string(),
      owner: s
        .oneToOne(() => owner)
        .fields("ownerId")
        .references("id"),
    })
    .map("e1_profiles");
  // The REVERSED produced identity (E1 U3): the target's primary key is assigned by
  // the DATABASE, so the enclosing UPDATE's SET can only reference the key the
  // subtree's own INSERT reports. `issue` holds the foreign key, `magazine` produces
  // the value it points at.
  const magazine = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
      issues: s.oneToMany(() => issue),
    })
    .map("e1_magazines");
  const issue = s
    .model({
      id: s.int().id(),
      name: s.string(),
      magazineId: s.int().nullable(),
      magazine: s
        .manyToOne(() => magazine)
        .fields("magazineId")
        .references("id")
        .optional(),
    })
    .map("e1_issues");
  return {
    author,
    award,
    badge,
    book,
    holder,
    issue,
    magazine,
    node,
    owner,
    profile,
  };
})();

hydrateSchemaNames(parentHeldLookupSchema);

export function makeLookupClient(driver: AnyDriver) {
  return createClient({ schema: parentHeldLookupSchema, driver });
}
export type LookupClient = ReturnType<typeof makeLookupClient>;

/**
 * The decoy always holds the LOWER key and the value a wrong lookup would find:
 * `decoy@x` sorts before `target@x`, badge 1 carries a NULL `code`, and node 1 is
 * the root every self-relation connect could collapse onto.
 */
export async function seedLookupBed(client: LookupClient): Promise<void> {
  await client.author.create({
    data: { id: 1, email: "decoy@x", name: "decoy" },
  });
  await client.author.create({
    data: { id: 2, email: "target@x", name: "target" },
  });
  await client.book.create({ data: { id: 1, title: "book-1", authorId: 1 } });
  await client.book.create({
    data: { id: 2, title: "book-2", authorId: null },
  });
  await client.badge.create({
    data: { id: 1, slug: "codeless", code: null, tier: "bronze" },
  });
  await client.badge.create({
    data: { id: 2, slug: "gold-slug", code: "GOLD", tier: "gold" },
  });
  await client.holder.create({
    data: { id: 1, name: "holder-1", badgeCode: null },
  });
  await client.node.create({ data: { id: 1, label: "root", parentId: null } });
  await client.node.create({ data: { id: 2, label: "leaf", parentId: null } });
  await client.owner.create({ data: { id: 1, email: "owner@x" } });
  await client.profile.create({ data: { ownerId: 1, bio: "seed" } });
  // Seeded FIRST so it holds the LOWER generated key: a produced identity that came
  // from anywhere but the subtree's own INSERT lands here.
  await client.magazine.create({ data: { title: "decoy-magazine" } });
  await client.issue.create({
    data: { id: 1, name: "issue-1", magazineId: null },
  });
}

/**
 * E1 U1/U2 — the to-one lookup fold, on every driver class and both substrates.
 *
 * The claim each test makes is the same one from a different side: a parent-held
 * to-one arm can now address its target by a unique the foreign key does NOT
 * reference, and the value written is the target's referenced column read through
 * a correlated lookup — never the selector, never the first row, never NULL.
 */
export function runParentHeldLookupBehavior(
  options: { readonly name: string } & BehaviorDatabaseSource
): void {
  describe(`${options.name} parent-held to-one lookup (E1 U1/U2)`, () => {
    const openDatabase = useBehaviorDatabase(parentHeldLookupSchema, options);
    const run = (
      body: (client: LookupClient) => Promise<void>
    ): (() => Promise<void>) => {
      return async () => {
        const { client, dispose } = await openDatabase();
        await seedLookupBed(client);
        try {
          await body(client);
        } finally {
          await dispose();
        }
      };
    };

    test(
      "connect by a NON-referenced unique binds the named target, not the decoy",
      { timeout: 30_000 },
      run(async (client) => {
        // `target@x` is author 2; author 1 (`decoy@x`) holds the LOWER key, so a
        // fold that took "the first row" — or that mistook the selector's own value
        // for the referenced one — lands on it visibly.
        await expect(
          client.book.update({
            where: { id: 2 },
            data: { author: { connect: { email: "target@x" } } },
          })
        ).resolves.toEqual({ id: 2, title: "book-2", authorId: 2 });
        await expect(
          client.book.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: 1, title: "book-1", authorId: 1 },
          { id: 2, title: "book-2", authorId: 2 },
        ]);
      })
    );

    test(
      "connect by a NON-referenced unique that matches nothing is the not-found premise",
      { timeout: 30_000 },
      run(async (client) => {
        // Zero rows is not the lookup's problem to solve: the arm's probe reads the
        // target by the SAME selector, so a missing target is refused with the
        // relation's own not-found wording before any row is written.
        await expect(
          client.book.update({
            where: { id: 2 },
            data: { author: { connect: { email: "absent@x" } } },
          })
        ).rejects.toThrow(NestedWriteError);
        await expect(
          client.book.findUnique({ where: { id: 2 } })
        ).resolves.toEqual({ id: 2, title: "book-2", authorId: null });
      })
    );

    test(
      "a located target whose referenced NULLABLE unique is NULL refuses, and writes nothing",
      { timeout: 30_000 },
      run(async (client) => {
        // Badge 1 exists and matches `slug: 'codeless'`, but its `code` — the column
        // the foreign key references — is NULL. Writing the lookup's NULL would
        // DISCONNECT the holder while the payload asked to connect it, so the arm
        // refuses by name. The state assertion is the real claim: no partial write,
        // not even the sibling scalar rebind in the same SET.
        await expect(
          client.holder.update({
            where: { id: 1 },
            data: { name: "renamed", badge: { connect: { slug: "codeless" } } },
          })
        ).rejects.toThrow(
          "Cannot connect relation 'badge': the located target's referenced field 'code' is null."
        );
        await expect(
          client.holder.findUnique({ where: { id: 1 } })
        ).resolves.toEqual({ id: 1, name: "holder-1", badgeCode: null });
      })
    );

    test(
      "connectOrCreate FOUND arm adopts through the lookup",
      { timeout: 30_000 },
      run(async (client) => {
        await expect(
          client.book.update({
            where: { id: 2 },
            data: {
              author: {
                connectOrCreate: {
                  where: { email: "target@x" },
                  create: { id: 9, email: "target@x", name: "never-written" },
                },
              },
            },
          })
        ).resolves.toEqual({ id: 2, title: "book-2", authorId: 2 });
        // The create arm was not taken: author 9 must not exist.
        await expect(
          client.author.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: 1, email: "decoy@x", name: "decoy" },
          { id: 2, email: "target@x", name: "target" },
        ]);
      })
    );

    test(
      "connectOrCreate MISSING arm still creates and binds the fresh identity",
      { timeout: 30_000 },
      run(async (client) => {
        await expect(
          client.book.update({
            where: { id: 2 },
            data: {
              author: {
                connectOrCreate: {
                  where: { email: "fresh@x" },
                  create: { id: 9, email: "fresh@x", name: "fresh" },
                },
              },
            },
          })
        ).resolves.toEqual({ id: 2, title: "book-2", authorId: 9 });
        await expect(
          client.author.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: 1, email: "decoy@x", name: "decoy" },
          { id: 2, email: "target@x", name: "target" },
          { id: 9, email: "fresh@x", name: "fresh" },
        ]);
      })
    );

    test(
      "a SELF relation's lookup reads the table the UPDATE mutates",
      { timeout: 30_000 },
      run(async (client) => {
        // The dialect-risk shape: `SET parentId = (SELECT id FROM e1_nodes …)` on the
        // very table being updated. MySQL raises ERROR 1093 unless the lookup hides
        // behind a derived table; PostgreSQL and SQLite never wrap. Node 1 (`root`)
        // is the only match and node 2 is the row being updated, so a wrap that lost
        // its selector would bind node 2 to ITSELF and this fails.
        await expect(
          client.node.update({
            where: { id: 2 },
            data: { parent: { connect: { label: "root" } } },
          })
        ).resolves.toEqual({ id: 2, label: "leaf", parentId: 1 });
        await expect(
          client.node.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: 1, label: "root", parentId: null },
          { id: 2, label: "leaf", parentId: 1 },
        ]);
      })
    );

    test(
      "a NON-primary-key referenced column resolves through the lookup too",
      { timeout: 30_000 },
      run(async (client) => {
        // The foreign key references `badge.code` and the payload names the badge by
        // `slug`: two different non-primary-key uniques on one edge. The written
        // value must be the CODE of the row the slug found.
        await expect(
          client.holder.update({
            where: { id: 1 },
            data: { badge: { connect: { slug: "gold-slug" } } },
          })
        ).resolves.toEqual({ id: 1, name: "holder-1", badgeCode: "GOLD" });
      })
    );
  });
}

/**
 * E1 U3 — the before-root target as a create SUBTREE.
 *
 * The enclosing record holds the foreign key, so the target is written FIRST and
 * the root UPDATE's SET reads its key. Two things are being claimed and each test
 * names one: the target's OWN relations now come along at any depth, and the key
 * the enclosing UPDATE spends is the SUBTREE ROOT's — generated or spelled.
 */
export function runBeforeRootSubtreeBehavior(
  options: { readonly name: string } & BehaviorDatabaseSource
): void {
  describe(`${options.name} before-root target subtree (E1 U3)`, () => {
    const openDatabase = useBehaviorDatabase(parentHeldLookupSchema, options);
    const run = (
      body: (client: LookupClient) => Promise<void>
    ): (() => Promise<void>) => {
      return async () => {
        const { client, dispose } = await openDatabase();
        await seedLookupBed(client);
        try {
          await body(client);
        } finally {
          await dispose();
        }
      };
    };

    test(
      "a parent-held `create` target carries its own relations",
      { timeout: 30_000 },
      run(async (client) => {
        await expect(
          client.book.update({
            where: { id: 2 },
            data: {
              author: {
                create: {
                  id: 9,
                  email: "fresh@x",
                  name: "fresh",
                  awards: { create: { id: 9, title: "gold" } },
                },
              },
            },
          })
        ).resolves.toEqual({ id: 2, title: "book-2", authorId: 9 });
        // The award must hang off the FRESH author, not off the decoy that holds
        // the lower key.
        await expect(
          client.award.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([{ id: 9, title: "gold", authorId: 9 }]);
      })
    );

    test(
      "a NON-primary-key referenced column the subtree's own create data spells resolves",
      { timeout: 30_000 },
      run(async (client) => {
        // The holder's foreign key references `badge.code`, which is neither the
        // badge's primary key nor a value any read produces — it is spelled in the
        // very create data the badge's INSERT writes. That is the third provenance
        // the create root already had and the update root did not.
        await expect(
          client.holder.update({
            where: { id: 1 },
            data: {
              badge: {
                create: {
                  id: 9,
                  slug: "fresh-slug",
                  code: "FRESH",
                  tier: "tin",
                },
              },
            },
          })
        ).resolves.toEqual({ id: 1, name: "holder-1", badgeCode: "FRESH" });
        await expect(
          client.badge.findUnique({ where: { id: 9 } })
        ).resolves.toEqual({
          id: 9,
          slug: "fresh-slug",
          code: "FRESH",
          tier: "tin",
        });
      })
    );

    test(
      "a connectOrCreate FOUND arm writes NO part of its create subtree",
      { timeout: 30_000 },
      run(async (client) => {
        // The arm gate, from the side that can leave an orphan: the create arm's
        // subtree carries a child of its own, and the found arm is the one taken.
        // If the subtree compiled unconditionally, award 9 would exist under an
        // author nobody asked for.
        await expect(
          client.book.update({
            where: { id: 2 },
            data: {
              author: {
                connectOrCreate: {
                  where: { email: "target@x" },
                  create: {
                    id: 9,
                    email: "target@x",
                    name: "never",
                    awards: { create: { id: 9, title: "orphan" } },
                  },
                },
              },
            },
          })
        ).resolves.toEqual({ id: 2, title: "book-2", authorId: 2 });
        await expect(client.award.findMany({})).resolves.toEqual([]);
        await expect(
          client.author.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: 1, email: "decoy@x", name: "decoy" },
          { id: 2, email: "target@x", name: "target" },
        ]);
      })
    );

    test(
      "a connectOrCreate MISSING arm writes the whole subtree",
      { timeout: 30_000 },
      run(async (client) => {
        await expect(
          client.book.update({
            where: { id: 2 },
            data: {
              author: {
                connectOrCreate: {
                  where: { email: "fresh@x" },
                  create: {
                    id: 9,
                    email: "fresh@x",
                    name: "fresh",
                    awards: { create: { id: 9, title: "kept" } },
                  },
                },
              },
            },
          })
        ).resolves.toEqual({ id: 2, title: "book-2", authorId: 9 });
        await expect(
          client.award.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([{ id: 9, title: "kept", authorId: 9 }]);
      })
    );

    test(
      "an upsert FOUND arm writes NO part of its create subtree",
      { timeout: 30_000 },
      run(async (client) => {
        // Book 1 already points at author 1, so the upsert's probe finds it and the
        // update arm is taken. The create arm's award must not appear.
        await expect(
          client.book.update({
            where: { id: 1 },
            data: {
              author: {
                upsert: {
                  update: { name: "renamed" },
                  create: {
                    id: 9,
                    email: "fresh@x",
                    name: "never",
                    awards: { create: { id: 9, title: "orphan" } },
                  },
                },
              },
            },
          })
        ).resolves.toEqual({ id: 1, title: "book-1", authorId: 1 });
        await expect(client.award.findMany({})).resolves.toEqual([]);
        await expect(
          client.author.findUnique({ where: { id: 1 } })
        ).resolves.toEqual({ id: 1, email: "decoy@x", name: "renamed" });
      })
    );

    test(
      "an upsert ABSENT arm writes the whole subtree and rebinds the parent",
      { timeout: 30_000 },
      run(async (client) => {
        // Book 2 points at nothing, so the upsert probe finds nothing.
        await expect(
          client.book.update({
            where: { id: 2 },
            data: {
              author: {
                upsert: {
                  update: { name: "never" },
                  create: {
                    id: 9,
                    email: "fresh@x",
                    name: "fresh",
                    awards: { create: { id: 9, title: "kept" } },
                  },
                },
              },
            },
          })
        ).resolves.toEqual({ id: 2, title: "book-2", authorId: 9 });
        await expect(
          client.award.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([{ id: 9, title: "kept", authorId: 9 }]);
      })
    );

    test(
      "a null referenced field in the target's create data stays refused",
      { timeout: 30_000 },
      run(async (client) => {
        // The carve-out that stays: the badge's own create data sets `code` to NULL,
        // so there is no value for the holder's foreign key to reference. A foreign
        // key equal to NULL names no row, which is a contradiction rather than a
        // shape the engine has not learned.
        await expect(
          client.holder.update({
            where: { id: 1 },
            data: {
              badge: {
                create: { id: 9, slug: "fresh-slug", code: null, tier: "tin" },
              },
            },
          })
        ).rejects.toThrow(
          "query-engine-v2 update cannot resolve referenced field 'code' for the before-root target of relation 'badge': it is neither that record's primary key nor a knowable value in its own create data."
        );
        await expect(
          client.badge.findMany({ where: { id: 9 } })
        ).resolves.toEqual([]);
      })
    );
  });
}

/**
 * E1 U4 — relations in a parent-held to-one UPSERT arm.
 *
 * The arm is the located referenced row's whole update, so it delegates to the same
 * nested-target sub-op the plain `update` arm uses. What these tests separate is the
 * arm GATE: the delegated work must appear in the found arm and nowhere else, and
 * the scalar-only arm must keep the fold it always had — including its no-op.
 */
export function runUpsertArmRelationBehavior(
  options: { readonly name: string } & BehaviorDatabaseSource
): void {
  describe(`${options.name} parent-held upsert arm relations (E1 U4)`, () => {
    const openDatabase = useBehaviorDatabase(parentHeldLookupSchema, options);
    const run = (
      body: (client: LookupClient) => Promise<void>
    ): (() => Promise<void>) => {
      return async () => {
        const { client, dispose } = await openDatabase();
        await seedLookupBed(client);
        try {
          await body(client);
        } finally {
          await dispose();
        }
      };
    };

    test(
      "the FOUND arm writes its scalars and its relations together",
      { timeout: 30_000 },
      run(async (client) => {
        // Book 1 points at author 1, so the probe finds it and the update arm runs.
        await expect(
          client.book.update({
            where: { id: 1 },
            data: {
              author: {
                upsert: {
                  update: {
                    name: "renamed",
                    awards: { create: { id: 5, title: "medal" } },
                  },
                  create: { id: 9, email: "fresh@x", name: "never" },
                },
              },
            },
          })
        ).resolves.toEqual({ id: 1, title: "book-1", authorId: 1 });
        await expect(
          client.author.findUnique({ where: { id: 1 } })
        ).resolves.toEqual({ id: 1, email: "decoy@x", name: "renamed" });
        // The award must hang off the LOCATED author, not off the other one.
        await expect(
          client.award.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([{ id: 5, title: "medal", authorId: 1 }]);
      })
    );

    test(
      "a relation-ONLY found arm writes the relation and no target SET",
      { timeout: 30_000 },
      run(async (client) => {
        await expect(
          client.book.update({
            where: { id: 1 },
            data: {
              author: {
                upsert: {
                  update: { awards: { create: { id: 5, title: "medal" } } },
                  create: { id: 9, email: "fresh@x", name: "never" },
                },
              },
            },
          })
        ).resolves.toEqual({ id: 1, title: "book-1", authorId: 1 });
        await expect(
          client.author.findUnique({ where: { id: 1 } })
        ).resolves.toEqual({ id: 1, email: "decoy@x", name: "decoy" });
        await expect(
          client.award.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([{ id: 5, title: "medal", authorId: 1 }]);
      })
    );

    test(
      "the ABSENT arm writes NOTHING from the relation-carrying update arm",
      { timeout: 30_000 },
      run(async (client) => {
        // Book 2 points at nothing, so the create arm is taken. The update arm's
        // relation was already PLANNED (both arms plan); it must not be written.
        await expect(
          client.book.update({
            where: { id: 2 },
            data: {
              author: {
                upsert: {
                  update: {
                    name: "never",
                    awards: { create: { id: 5, title: "orphan" } },
                  },
                  create: { id: 9, email: "fresh@x", name: "fresh" },
                },
              },
            },
          })
        ).resolves.toEqual({ id: 2, title: "book-2", authorId: 9 });
        await expect(client.award.findMany({})).resolves.toEqual([]);
        await expect(
          client.author.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: 1, email: "decoy@x", name: "decoy" },
          { id: 2, email: "target@x", name: "target" },
          { id: 9, email: "fresh@x", name: "fresh" },
        ]);
      })
    );

    test(
      "a scalar-only found arm that asks for nothing is still the pinned no-op",
      { timeout: 30_000 },
      run(async (client) => {
        // The byte-identical path: no relations, an empty update arm. Nothing is
        // written and nothing is refused.
        await expect(
          client.book.update({
            where: { id: 1 },
            data: {
              author: {
                upsert: {
                  update: {},
                  create: { id: 9, email: "fresh@x", name: "never" },
                },
              },
            },
          })
        ).resolves.toEqual({ id: 1, title: "book-1", authorId: 1 });
        await expect(
          client.author.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: 1, email: "decoy@x", name: "decoy" },
          { id: 2, email: "target@x", name: "target" },
        ]);
      })
    );

    test(
      "a same-update FK rebind makes the arm correlate on the FINAL value",
      { timeout: 30_000 },
      run(async (client) => {
        // The D1 contract, through the delegated arm: the same SET moves book 1 from
        // author 1 to author 2, so the upsert arm must locate — and write — author 2.
        // Correlating on the located (pre-rebind) value would rename the author the
        // book is moving AWAY from, which is the wrong row.
        await expect(
          client.book.update({
            where: { id: 1 },
            data: {
              authorId: 2,
              author: {
                upsert: {
                  update: {
                    name: "renamed",
                    awards: { create: { id: 5, title: "medal" } },
                  },
                  create: { id: 9, email: "fresh@x", name: "never" },
                },
              },
            },
          })
        ).resolves.toEqual({ id: 1, title: "book-1", authorId: 2 });
        await expect(
          client.author.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: 1, email: "decoy@x", name: "decoy" },
          { id: 2, email: "target@x", name: "renamed" },
        ]);
        await expect(
          client.award.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([{ id: 5, title: "medal", authorId: 2 }]);
      })
    );
  });
}

/**
 * E1 U6 — a parent-held to-one edge whose referenced column is NOT the target's
 * primary key.
 *
 * The holder's foreign key references `badge.code`; the badge's own primary key is
 * `id`. The correlation reads `code`, the probe captures `id`, and the arm's write
 * addresses `id` — two jobs the ledger had conflated into one. Every arm of the
 * family runs here, and each asserts the row it landed on.
 */
export function runNonPkReferenceBehavior(
  options: { readonly name: string } & BehaviorDatabaseSource
): void {
  describe(`${options.name} parent-held NON-primary-key reference (E1 U6)`, () => {
    const openDatabase = useBehaviorDatabase(parentHeldLookupSchema, options);
    const run = (
      body: (client: LookupClient) => Promise<void>
    ): (() => Promise<void>) => {
      return async () => {
        const { client, dispose } = await openDatabase();
        await seedLookupBed(client);
        // Holder 1 wears the gold badge; badge 1 (the codeless decoy) holds the
        // LOWER primary key, so an arm that captured "the first row" — or that
        // mistook the correlation column for the primary key — lands on it.
        await client.holder.update({
          where: { id: 1 },
          data: { badge: { connect: { code: "GOLD" } } },
        });
        try {
          await body(client);
        } finally {
          await dispose();
        }
      };
    };

    test(
      "the `update` arm mutates the referenced row and nothing else",
      { timeout: 30_000 },
      run(async (client) => {
        await expect(
          client.holder.update({
            where: { id: 1 },
            data: { badge: { update: { tier: "platinum" } } },
          })
        ).resolves.toEqual({ id: 1, name: "holder-1", badgeCode: "GOLD" });
        await expect(
          client.badge.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: 1, slug: "codeless", code: null, tier: "bronze" },
          { id: 2, slug: "gold-slug", code: "GOLD", tier: "platinum" },
        ]);
      })
    );

    test(
      "the `update` arm carries its own relations one level deeper",
      { timeout: 30_000 },
      run(async (client) => {
        await expect(
          client.holder.update({
            where: { id: 1 },
            data: {
              badge: {
                update: {
                  tier: "platinum",
                  holders: { create: { id: 7, name: "holder-7" } },
                },
              },
            },
          })
        ).resolves.toEqual({ id: 1, name: "holder-1", badgeCode: "GOLD" });
        // The fresh holder's foreign key is the badge's CODE, read from the row the
        // probe captured by its primary key.
        await expect(
          client.holder.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: 1, name: "holder-1", badgeCode: "GOLD" },
          { id: 7, name: "holder-7", badgeCode: "GOLD" },
        ]);
      })
    );

    test(
      "the `upsert` arm takes its FOUND branch on the referenced row",
      { timeout: 30_000 },
      run(async (client) => {
        await expect(
          client.holder.update({
            where: { id: 1 },
            data: {
              badge: {
                upsert: {
                  update: { tier: "platinum" },
                  create: { id: 9, slug: "fresh", code: "FRESH", tier: "tin" },
                },
              },
            },
          })
        ).resolves.toEqual({ id: 1, name: "holder-1", badgeCode: "GOLD" });
        await expect(
          client.badge.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: 1, slug: "codeless", code: null, tier: "bronze" },
          { id: 2, slug: "gold-slug", code: "GOLD", tier: "platinum" },
        ]);
      })
    );

    test(
      "the `delete` arm nulls the key and removes the referenced row only",
      { timeout: 30_000 },
      run(async (client) => {
        await expect(
          client.holder.update({
            where: { id: 1 },
            data: { badge: { delete: true } },
          })
        ).resolves.toEqual({ id: 1, name: "holder-1", badgeCode: null });
        await expect(
          client.badge.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: 1, slug: "codeless", code: null, tier: "bronze" },
        ]);
      })
    );

    test(
      "an unconnected holder's update arm finds nothing and writes nothing",
      { timeout: 30_000 },
      run(async (client) => {
        await client.holder.create({
          data: { id: 8, name: "holder-8", badgeCode: null },
        });
        // The correlation reads NULL, which matches no badge — the not-found premise,
        // not a match on the codeless decoy whose `code` is also NULL.
        await expect(
          client.holder.update({
            where: { id: 8 },
            data: { badge: { update: { tier: "platinum" } } },
          })
        ).rejects.toThrow(NestedWriteError);
        await expect(
          client.badge.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: 1, slug: "codeless", code: null, tier: "bronze" },
          { id: 2, slug: "gold-slug", code: "GOLD", tier: "gold" },
        ]);
      })
    );
  });
}
