import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { NestedWriteError } from "@errors";
import { push } from "@migrations";
import { hydrateSchemaNames, s } from "@schema";
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
  return { author, award, badge, book, holder, node, owner, profile };
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
}

/**
 * E1 U1/U2 — the to-one lookup fold, on every driver class and both substrates.
 *
 * The claim each test makes is the same one from a different side: a parent-held
 * to-one arm can now address its target by a unique the foreign key does NOT
 * reference, and the value written is the target's referenced column read through
 * a correlated lookup — never the selector, never the first row, never NULL.
 */
export function runParentHeldLookupBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
}): void {
  describe(`${options.name} parent-held to-one lookup (E1 U1/U2)`, () => {
    const run = (
      body: (client: LookupClient) => Promise<void>
    ): (() => Promise<void>) => {
      return async () => {
        const driver = options.createDriver();
        const client = makeLookupClient(driver);
        await push(client, { force: true });
        await seedLookupBed(client);
        try {
          await body(client);
        } finally {
          await client.$disconnect();
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
