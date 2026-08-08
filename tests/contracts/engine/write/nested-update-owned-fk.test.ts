import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { hydrateSchemaNames, s } from "@schema";
import { describe, expect, test } from "vitest";
import { UnsupportedOperationError } from "@src/query-engine/write-engine/shared";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";

/**
 * M12 — **the relation-owned foreign key spelled in nested UPDATE data.**
 *
 * A nested write correlates its child to the parent the enclosing step acted on: the
 * child's foreign key is DERIVED (`fk = <parent>`), never taken from the payload. Three
 * positions used to let the payload spell that same column anyway, and the spelled value
 * WON — it rides the target's own SET, which lands after the correlation has already
 * chosen the row. Measured live before the fix (PGlite, public client): every one of the
 * six shapes below returned success and left the child under a DIFFERENT parent. The
 * parent silently lost the child it was updating through.
 *
 *   1. the inverse-side to-one `update` arm — `profile: { update: { userId: … } }`
 *   2. the inverse-side to-one `upsert` UPDATE arm
 *   3. the to-many `update` arm — `posts: { update: { where, data: { userId: … } } }`
 *
 * The adopt family (`upsert` / `connectOrCreate` on a to-many) already refused it, and
 * every nested CREATE position is answered at the parse boundary (`v.omit(core.create,
 * fkFields)`); `core.update` carries no such omission, which is why exactly the update
 * positions were reachable. All four now say the SAME sentence, from one string in
 * `messages.ts` — the last case is included here precisely so a future edit that drifts
 * the wording moves it in both places or fails.
 *
 * What each test pins, beyond "it throws":
 *
 *  · **Both spellings.** `{ userId: "u2" }` and `{ userId: { set: "u2" } }` are ONE shape
 *    by the time the engine sees them (the parse boundary coerces the bare literal into
 *    the `set` envelope), and before the fix they compiled to byte-identical SQL. A guard
 *    that inspected the VALUE would pass one and fail the other, so both are asserted.
 *  · **Both forks.** Positions 1 and 3 compile two ways: the leaf `RelationWritePart`, and
 *    the X1c whole-target delegation taken when the same data also carries a parent-held
 *    to-one write. The refusal is placed before that fork; the delegated spellings are
 *    here to keep it there.
 *  · **Nothing reached the database.** The refusal is a CONSTRUCTION-time decision, so a
 *    recording driver must see zero statements — not "the transaction rolled back".
 *  · **The control still works.** Drop the foreign key from the very same payload and the
 *    write executes and lands on the right row, so the guard is not refusing the family.
 *  · **The provenance.** A decoy parent holds the id the payload tried to spell; after the
 *    refusal the child is still its own parent's. That is the wrong-row doctrine's claim
 *    stated as state, not as an error class.
 */
const ownedFkSchema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      profile: s.oneToOne(() => profile).optional(),
      posts: s.oneToMany(() => post),
    })
    .map("m12_owned_fk_users");
  // The parent-held to-one every X1c-delegated spelling below hangs off: a relation
  // write on it is what makes `targetNeedsFullUpdate` take the delegation fork.
  const badge = s
    .model({
      id: s.string().id(),
      label: s.string(),
      profiles: s.oneToMany(() => profile),
      posts: s.oneToMany(() => post),
    })
    .map("m12_owned_fk_badges");
  const profile = s
    .model({
      id: s.string().id(),
      bio: s.string(),
      // `.unique()` is structural for a 1:1 (FK008 refuses to define one without it).
      userId: s.string().unique().nullable(),
      user: s
        .oneToOne(() => user)
        .fields("userId")
        .references("id")
        .optional(),
      badgeId: s.string().nullable(),
      badge: s
        .manyToOne(() => badge)
        .fields("badgeId")
        .references("id")
        .optional(),
    })
    .map("m12_owned_fk_profiles");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      userId: s.string(),
      user: s
        .manyToOne(() => user)
        .fields("userId")
        .references("id"),
      badgeId: s.string().nullable(),
      badge: s
        .manyToOne(() => badge)
        .fields("badgeId")
        .references("id")
        .optional(),
    })
    .map("m12_owned_fk_posts");
  return { user, badge, profile, post };
})();

hydrateSchemaNames(ownedFkSchema);
const getFamily = usePGliteSchemaFamily(ownedFkSchema);

/** Records every statement, in order — the protected seam, so transaction-bound
 *  statements are seen too. */
class RecordingPGliteDriver extends PGliteDriver {
  readonly statements: string[] = [];
  recording = false;

  protected override execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sql);
    return super.execute<T>(client, sql, params, context);
  }

  protected override executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sql);
    return super.executeRaw<T>(client, sql, params, context);
  }
}

/**
 * `owner` holds both children. `thief` is the id every refused payload tries to spell —
 * it exists, so a write that got through would SUCCEED (no FK violation to mask the bug)
 * and the child would end up genuinely reparented.
 */
async function setup() {
  const family = getFamily();
  await family.reset();
  const driver = new RecordingPGliteDriver({ client: family.database });
  const client = createClient({ schema: ownedFkSchema, driver });
  await client.user.create({ data: { id: "owner", name: "owner" } });
  await client.user.create({ data: { id: "thief", name: "thief" } });
  await client.badge.create({ data: { id: "b1", label: "before" } });
  await client.profile.create({
    data: { id: "p1", bio: "bio", userId: "owner", badgeId: "b1" },
  });
  await client.post.create({
    data: { id: "po1", title: "title", userId: "owner", badgeId: "b1" },
  });
  return { client, driver };
}

const OWNED_PROFILE_FK =
  "Relation 'profile' owns 'userId'; omit it from nested create and update data.";
const OWNED_POSTS_FK =
  "Relation 'posts' owns 'userId'; omit it from nested create and update data.";

/** The two spellings the parse boundary collapses into one — asserted separately so a
 *  value-inspecting guard cannot pass this file. Both are legal client input for the
 *  column, which is the point: nothing upstream of the engine tells them apart. */
type FkSpelling = string | { set: string };

const SPELLINGS: readonly { label: string; value: FkSpelling }[] = [
  { label: "bare literal", value: "thief" },
  { label: "{ set } envelope", value: { set: "thief" } },
];

type Client = Awaited<ReturnType<typeof setup>>["client"];

/**
 * Every refusal case: the payload and the message it must carry. The `(X1c-delegated)`
 * entries are the same position with `deepBadge` folded into the same data — a
 * parent-held to-one write, which is what routes the target through the whole-target
 * delegation instead of the leaf part.
 */

function refusalCases(fk: FkSpelling) {
  const deepBadge = { badge: { update: { label: "after" } } };
  return [
    {
      name: "inverse to-one update",
      message: OWNED_PROFILE_FK,
      data: { profile: { update: { bio: "x", userId: fk } } },
    },
    {
      name: "inverse to-one update (X1c-delegated)",
      message: OWNED_PROFILE_FK,
      data: { profile: { update: { bio: "x", userId: fk, ...deepBadge } } },
    },
    {
      name: "inverse to-one upsert update arm",
      message: OWNED_PROFILE_FK,
      data: {
        profile: {
          upsert: {
            create: { id: "p-new", bio: "created" },
            update: { bio: "x", userId: fk },
          },
        },
      },
    },
    {
      name: "to-many update",
      message: OWNED_POSTS_FK,
      data: {
        posts: {
          update: { where: { id: "po1" }, data: { title: "x", userId: fk } },
        },
      },
    },
    {
      name: "to-many update (X1c-delegated)",
      message: OWNED_POSTS_FK,
      data: {
        posts: {
          update: {
            where: { id: "po1" },
            data: { title: "x", userId: fk, ...deepBadge },
          },
        },
      },
    },
    {
      name: "to-many upsert update arm",
      message: OWNED_POSTS_FK,
      data: {
        posts: {
          upsert: {
            where: { id: "po1" },
            create: { id: "po-new", title: "created" },
            update: { title: "x", userId: fk },
          },
        },
      },
    },
  ];
}

async function readState(client: Client) {
  return {
    profile: await client.profile.findUnique({ where: { id: "p1" } }),
    post: await client.post.findUnique({ where: { id: "po1" } }),
  };
}

const UNTOUCHED = {
  profile: { id: "p1", bio: "bio", userId: "owner", badgeId: "b1" },
  post: { id: "po1", title: "title", userId: "owner", badgeId: "b1" },
};

describe("M12 nested update data may not spell the relation's own foreign key", () => {
  for (const spelling of SPELLINGS) {
    for (const scenario of refusalCases(spelling.value)) {
      test(
        `${scenario.name} refuses the owned FK as a ${spelling.label}`,
        { timeout: 30_000 },
        async () => {
          const { client, driver } = await setup();
          try {
            driver.recording = true;
            await expect(
              client.user.update({
                where: { id: "owner" },
                data: scenario.data,
              })
            ).rejects.toThrow(UnsupportedOperationError);
            await expect(
              client.user.update({
                where: { id: "owner" },
                data: scenario.data,
              })
            ).rejects.toThrow(scenario.message);
            driver.recording = false;
            // The decision is made while the operation is CONSTRUCTED, so neither
            // attempt reached the database — not "was rolled back", never sent.
            expect(driver.statements).toEqual([]);
            // The provenance: `thief` exists and would have accepted the row. The child
            // is still the parent's, and the parent-held `badge` the delegated spellings
            // asked to rewrite was not written either.
            await expect(readState(client)).resolves.toEqual(UNTOUCHED);
            await expect(
              client.badge.findUnique({ where: { id: "b1" } })
            ).resolves.toEqual({ id: "b1", label: "before" });
          } finally {
          }
        }
      );
    }
  }

  test(
    "the same three positions execute end to end with the foreign key omitted",
    { timeout: 30_000 },
    async () => {
      const { client } = await setup();
      try {
        // Position 1 — inverse to-one update, and its X1c-delegated form.
        await client.user.update({
          where: { id: "owner" },
          data: {
            profile: {
              update: { bio: "one", badge: { update: { label: "after" } } },
            },
          },
        });
        // Position 2 — the inverse to-one upsert's UPDATE arm (the profile exists).
        await client.user.update({
          where: { id: "owner" },
          data: {
            profile: {
              upsert: {
                create: { id: "p-new", bio: "created" },
                update: { bio: "two" },
              },
            },
          },
        });
        // Position 3 — the to-many update, and its X1c-delegated form.
        await client.user.update({
          where: { id: "owner" },
          data: {
            posts: {
              update: {
                where: { id: "po1" },
                data: { title: "three", badge: { update: { label: "after" } } },
              },
            },
          },
        });
        await expect(readState(client)).resolves.toEqual({
          profile: { id: "p1", bio: "two", userId: "owner", badgeId: "b1" },
          post: { id: "po1", title: "three", userId: "owner", badgeId: "b1" },
        });
      } finally {
      }
    }
  );

  test(
    "an undefined foreign key is absence, not a spelling",
    { timeout: 30_000 },
    async () => {
      const { client } = await setup();
      try {
        // Prisma treats `undefined` as "the key is not in the payload", and so does
        // `separateData` — the guard keys on what SURVIVES that classification, so this
        // must execute rather than refuse.
        await client.user.update({
          where: { id: "owner" },
          data: { profile: { update: { bio: "kept", userId: undefined } } },
        });
        await expect(readState(client)).resolves.toEqual({
          ...UNTOUCHED,
          profile: { id: "p1", bio: "kept", userId: "owner", badgeId: "b1" },
        });
      } finally {
      }
    }
  );
});
