import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { ValidationError } from "@errors";
import { hydrateSchemaNames, s } from "@schema";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

/**
 * M12 — **the relation-owned foreign key spelled in nested UPDATE data.**
 *
 * A nested write correlates its child to the parent the enclosing step acted on: the
 * child's foreign key is DERIVED (`fk = <parent>`), never taken from the payload. Four
 * positions used to let the payload spell that same column anyway, and the spelled value
 * WON — it rides the target's own SET, which lands after the correlation has already
 * chosen the row. Every one of them was measured live (PGlite, public client) returning
 * success and leaving the child under a DIFFERENT parent.
 *
 *   1. the inverse-side to-one `update` arm — `profile: { update: { userId: … } }`
 *   2. the inverse-side to-one `upsert` UPDATE arm
 *   3. the to-many `update` arm — `posts: { update: { where, data: { userId: … } } }`
 *   4. the to-many `updateMany` arm — `posts: { updateMany: { where, data: { userId: … } } }`
 *
 * PR #20 answered 1–3 in the ENGINE. Position 4 was never reached by that guard
 * (`buildToManyUpdateManyParts` called it from nowhere) and stayed live until Package N1;
 * measured at e52c93de it returned success and moved `po1` to the thief. The Package N
 * GATE then wired position 4 to the same guard as the other three, because at that HEAD
 * the parse closed the family only where the two inverse scanners AGREED, and the
 * degenerate schema at the bottom of this file measured it still reparenting the row.
 * Phase 2 of the distinct-truth compression made the scanners agree everywhere and the
 * guard went with its last route (see below).
 *
 * **Package N1 moved the whole family to the parse boundary.** Nested update data is now
 * built from the same omitted-FK owner nested create data has always been built from
 * (`v.omit(core.update, fkFields)`, `UpdateWithOmittedFk` in
 * `src/validation/relations/create.ts`), so all four positions — plus the to-many
 * `upsert` UPDATE arm under an update root — answer `ValidationError: Unknown key` before
 * an operation is constructed, and the column is not a key the TYPES offer either. The
 * refusals below assert that boundary. What each one still pins:
 *
 *  · **Both spellings.** `{ userId: "u2" }` and `{ userId: { set: "u2" } }` were ONE shape
 *    to the engine (the parse coerced the bare literal into the `set` envelope) and
 *    compiled to byte-identical SQL. They are now refused one step EARLIER, by key rather
 *    than by value, so both are asserted: a boundary that inspected the value would pass
 *    one and fail the other.
 *  · **Both forks.** Positions 1 and 3 compile two ways: the leaf `RelationWritePart`, and
 *    the X1c whole-target delegation taken when the same data also carries a parent-held
 *    to-one write. Neither is reached any more, and both spellings stay here so that a
 *    regression re-opening either fork lands on a red test rather than on the engine.
 *  · **Nothing reached the database.** Refusal is a parse-time decision now, so a
 *    recording driver must see zero statements — not "the transaction rolled back".
 *  · **The control still works.** Drop the foreign key from the very same payload and the
 *    write executes and lands on the right row, so the boundary is not refusing the family.
 *  · **The provenance.** A decoy parent holds the id the payload tried to spell; after the
 *    refusal the child is still its own parent's.
 *
 * The ENGINE guard (`RelationWritePart.assertOwnedFkAbsentFromUpdateData`) is now DELETED.
 * It was retained by N1 for one reason — the two inverse scanners read `.fields()`
 * differently, so a publicly constructible schema still got a spelled owned FK past the
 * omission — and Phase 2 of the distinct-truth compression closed exactly that: both
 * readers now length-test `.fields()`, so the parse omits the owned FK on EVERY schema and
 * the guard's only route stopped existing. The last two sections of this file are the
 * witnesses: the same two degenerate schemas, the same payloads, now refused at the same
 * boundary as every position above.
 *
 * TWO deliberate consequences of moving the boundary, both measured and both making the
 * update context agree with the create context, which has behaved this way since it was
 * written:
 *
 *  · `{ userId: undefined }` is now refused too. `strict` object parsing keys on the
 *    PRESENCE of a key, and Prisma's absence rule is applied downstream of it. Nested
 *    CREATE data has always answered `Unknown key: userId` for the same spelling.
 *  · the message degrades from the engine's `Relation 'x' owns 'y'; omit it …` to
 *    `Unknown key: y`. That trade was already made on the create side (E5-U2's WALL 1).
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

/** The two spellings the parse boundary used to collapse into one — asserted separately
 *  so a value-inspecting boundary cannot pass this file. Both are legal client input for
 *  the column, which is the point: nothing above the schema tells them apart. */
type FkSpelling = string | { set: string };

const SPELLINGS: readonly { label: string; value: FkSpelling }[] = [
  { label: "bare literal", value: "thief" },
  { label: "{ set } envelope", value: { set: "thief" } },
];

type Client = Awaited<ReturnType<typeof setup>>["client"];

/**
 * Every refusal case: the payload and the key the parse boundary must not offer. The
 * `(X1c-delegated)` entries are the same position with `deepBadge` folded into the same
 * data — a parent-held to-one write, which is what routed the target through the whole-
 * target delegation instead of the leaf part.
 *
 * Each `data` is deliberately un-typed at the call: N1 removes these keys from the TYPES
 * as well, and the type-level half of the same claim is pinned through the public client
 * in `tests/types/client/contextual-typing-gate.core.types.ts`.
 */
function refusalCases(fk: FkSpelling) {
  const deepBadge = { badge: { update: { label: "after" } } };
  return [
    {
      name: "inverse to-one update",
      key: "userId",
      data: { profile: { update: { bio: "x", userId: fk } } },
    },
    {
      name: "inverse to-one update (X1c-delegated)",
      key: "userId",
      data: { profile: { update: { bio: "x", userId: fk, ...deepBadge } } },
    },
    {
      name: "inverse to-one upsert update arm",
      key: "userId",
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
      key: "userId",
      data: {
        posts: {
          update: { where: { id: "po1" }, data: { title: "x", userId: fk } },
        },
      },
    },
    {
      name: "to-many update (X1c-delegated)",
      key: "userId",
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
      // N1 — position 4. `buildToManyUpdateManyParts` never called the engine guard, so
      // before this package the payload below compiled to a correlated bulk
      // `UPDATE … SET user_id = $1 WHERE user_id = <parent> …` and SUCCEEDED.
      name: "to-many updateMany",
      key: "userId",
      data: {
        posts: {
          updateMany: {
            where: { id: "po1" },
            data: { title: "x", userId: fk },
          },
        },
      },
    },
    {
      name: "to-many upsert update arm",
      key: "userId",
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
          driver.recording = true;
          const call = () =>
            client.user.update({
              where: { id: "owner" },
              data: scenario.data as never,
            });
          await expect(call()).rejects.toThrow(ValidationError);
          await expect(call()).rejects.toThrow(`Unknown key: ${scenario.key}`);
          driver.recording = false;
          // The decision is made while the payload is PARSED, so neither attempt
          // reached the database — not "was rolled back", never sent.
          expect(driver.statements).toEqual([]);
          // The provenance: `thief` exists and would have accepted the row. The child
          // is still the parent's, and the parent-held `badge` the delegated spellings
          // asked to rewrite was not written either.
          await expect(readState(client)).resolves.toEqual(UNTOUCHED);
          await expect(
            client.badge.findUnique({ where: { id: "b1" } })
          ).resolves.toEqual({ id: "b1", label: "before" });
        }
      );
    }
  }

  test(
    "the same positions execute end to end with the foreign key omitted",
    { timeout: 30_000 },
    async () => {
      const { client } = await setup();
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
      // Position 4 — the to-many updateMany.
      await client.user.update({
        where: { id: "owner" },
        data: {
          posts: {
            updateMany: { where: { id: "po1" }, data: { title: "four" } },
          },
        },
      });
      await expect(readState(client)).resolves.toEqual({
        profile: { id: "p1", bio: "two", userId: "owner", badgeId: "b1" },
        post: { id: "po1", title: "four", userId: "owner", badgeId: "b1" },
      });
    }
  );

  test(
    "an undefined foreign key is refused too, exactly as nested CREATE data refuses it",
    { timeout: 30_000 },
    async () => {
      const { client } = await setup();
      // Prisma treats `undefined` as "the key is not in the payload", and the engine's
      // guard keyed on what SURVIVED that classification — so this spelling used to
      // execute. `strict` object parsing keys on the key's PRESENCE instead, which is
      // why nested CREATE data has always refused the identical spelling. The two
      // contexts now agree; the pair below is the whole claim.
      await expect(
        client.user.update({
          where: { id: "owner" },
          data: {
            profile: { update: { bio: "kept", userId: undefined } },
          } as never,
        })
      ).rejects.toThrow("Unknown key: userId");
      await expect(
        client.user.update({
          where: { id: "owner" },
          data: {
            posts: { create: { id: "po-u", title: "t", userId: undefined } },
          } as never,
        })
      ).rejects.toThrow("Unknown key: userId");
      await expect(readState(client)).resolves.toEqual(UNTOUCHED);
    }
  );
});

/**
 * **The schema that used to escape the omission — now a witness that nothing does.**
 *
 * This schema is why `assertOwnedFkAbsentFromUpdateData` was RETAINED by Package N1 and
 * why it is DELETED now. The two runtime readers of "which column does this relation own"
 * disagreed about a relation spelled `.fields()` with ZERO arguments:
 *
 *  · `getInverseRelationMap` (validation, `src/schema/relation/types.ts`) tested
 *    `state.fields` for TRUTHINESS. `[]` is truthy, so the scan short-circuited on its
 *    owner-side arm and answered `[]` — the omission removed nothing and `userId` stayed
 *    a legal key, which the engine guard then had to catch.
 *  · `bindRelation` (engine) tested `fields && fields.length > 0`, so the same relation
 *    was CHILD-HELD and the engine resolved the target's real back-reference.
 *
 * PHASE 2 OF THE DISTINCT-TRUTH COMPRESSION ALIGNED THEM: the omission view length-tests
 * `.fields()` too (`src/schema/relation/types.ts`, both the owner-side short-circuit and
 * the candidate filter), and one resolver — `src/schema/relation/inverse.ts` — now owns
 * candidate discovery for every consumer. A zero-argument `.fields()` is fields-LESS
 * everywhere, so on THIS schema the parse omits `userId` exactly as it does on the
 * ordinary one at the top of the file, and the guard's only route is gone.
 *
 * The schema is KEPT, unchanged, because it is the falsifier for that claim: if either
 * reader ever goes back to reading truthiness, these two tests stop refusing. The
 * before-truth — the engine's `UnsupportedOperationError: Relation 'profile' owns
 * 'userId'; …`, with the same payloads — is at commit 40e50057 and in this file's history.
 */
const splitScannerSchema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      profile: s
        .oneToOne(() => profile)
        .fields()
        .optional(),
    })
    .map("m12_split_users");
  const profile = s
    .model({
      id: s.string().id(),
      bio: s.string(),
      userId: s.string().unique().nullable(),
      user: s
        .oneToOne(() => user)
        .fields("userId")
        .references("id")
        .optional(),
    })
    .map("m12_split_profiles");
  return { user, profile };
})();

hydrateSchemaNames(splitScannerSchema);
const getSplitFamily = usePGliteSchemaFamily(splitScannerSchema);

/** The aligned parse's own sentence on this schema — `v.omit(core.update, ["userId"])`
 *  makes the column an unknown key, exactly as on the ordinary schema above. */
const SPLIT_UNKNOWN_FK = "Validation failed for update: Unknown key: userId";

describe("M12 the parse boundary owns the degenerate to-one schema too", () => {
  async function splitSetup() {
    const family = getSplitFamily();
    await family.reset();
    const driver = new RecordingPGliteDriver({ client: family.database });
    const client = createClient({ schema: splitScannerSchema, driver });
    await client.user.create({ data: { id: "owner", name: "owner" } });
    await client.user.create({ data: { id: "thief", name: "thief" } });
    await client.profile.create({
      data: { id: "p1", bio: "bio", userId: "owner" },
    });
    return { client, driver };
  }

  test(
    "the to-one update arm refuses at the parse, not at the engine",
    { timeout: 30_000 },
    async () => {
      const { client, driver } = await splitSetup();
      driver.recording = true;
      // Was `UnsupportedOperationError: Relation 'profile' owns 'userId'; …`, raised by
      // the engine guard after the omission had admitted the key. The payload is
      // un-typed at the call for the same reason as every refusal above: the alignment
      // removes the key from the TYPES on this schema too.
      const call = () =>
        client.user.update({
          where: { id: "owner" },
          data: { profile: { update: { bio: "x", userId: "thief" } } } as never,
        });
      await expect(call()).rejects.toThrow(ValidationError);
      await expect(call()).rejects.toThrow(SPLIT_UNKNOWN_FK);
      driver.recording = false;
      expect(driver.statements).toEqual([]);
      await expect(
        client.profile.findUnique({ where: { id: "p1" } })
      ).resolves.toEqual({ id: "p1", bio: "bio", userId: "owner" });
    }
  );

  test(
    "the to-one upsert UPDATE arm refuses at the parse, not at the engine",
    { timeout: 30_000 },
    async () => {
      const { client, driver } = await splitSetup();
      driver.recording = true;
      const call = () =>
        client.user.update({
          where: { id: "owner" },
          data: {
            profile: {
              upsert: {
                create: { id: "p2", bio: "created" },
                update: { bio: "x", userId: "thief" },
              },
            },
          } as never,
        });
      await expect(call()).rejects.toThrow(ValidationError);
      await expect(call()).rejects.toThrow(SPLIT_UNKNOWN_FK);
      driver.recording = false;
      expect(driver.statements).toEqual([]);
      await expect(
        client.profile.findUnique({ where: { id: "p1" } })
      ).resolves.toEqual({ id: "p1", bio: "bio", userId: "owner" });
    }
  );

  test(
    "RATIFIED WIDENING — disconnect is now AVAILABLE on this schema, like its ordinary twin",
    { timeout: 30_000 },
    async () => {
      // Before the alignment the degenerate map answered `[]`, so
      // `inverseMembershipCanBeCleared` was false and `disconnect` was an
      // `Unknown key` here — a refusal the ordinary spelling of the SAME
      // physical schema never had (profile.userId is nullable). The aligned
      // scan resolves the real back-reference, so the degenerate spelling now
      // behaves exactly like the ordinary one: disconnect nulls the FK.
      // Reviewed and ratified with the Phase 2 alignment (ledger addendum).
      const { client } = await splitSetup();
      await client.user.update({
        where: { id: "owner" },
        data: { profile: { disconnect: true } } as never,
      });
      await expect(
        client.profile.findUnique({ where: { id: "p1" } })
      ).resolves.toEqual({ id: "p1", bio: "bio", userId: null });
    }
  );

  test(
    "the same schema writes when the foreign key is omitted",
    { timeout: 30_000 },
    async () => {
      const { client } = await splitSetup();
      await client.user.update({
        where: { id: "owner" },
        data: { profile: { update: { bio: "written" } } },
      });
      await expect(
        client.profile.findUnique({ where: { id: "p1" } })
      ).resolves.toEqual({ id: "p1", bio: "written", userId: "owner" });
    }
  );
});

/**
 * **The to-many half of the same schema class — and position 4's owner.**
 *
 * The split needs the target to carry the zero-argument `.fields()` relation for a
 * to-many edge, so `post` holds TWO back-references to `user`: `ghost`, spelled
 * `.fields()` with no arguments and DECLARED FIRST, and the real `author`.
 *
 * BEFORE THE ALIGNMENT: `getInverseRelationMap` kept `ghost` as a candidate (its filter
 * was `!state.fields`, and `[]` is truthy), met two candidates, took the first whose
 * `.name()` did not disagree — `ghost` — and answered `[]`, so the omission removed
 * nothing; `bindRelation` DROPPED `ghost` (`fields && fields.length > 0`), leaving one
 * potential inverse, so `posts` bound child-held on the real `userId`. Measured at the
 * Package N implementer's HEAD, through the public client, `posts.updateMany.data.userId`
 * returned SUCCESS and left `po1` under `thief` — the silent reparent the Package N gate
 * then wired to the engine guard.
 *
 * AFTER IT: one candidate scan (`src/schema/relation/inverse.ts`) drops `ghost` for both
 * readers, so the omission view answers the real `["userId"]`, the parse omits it, and
 * BOTH to-many arms refuse before an operation is constructed. The bulk refusal below is
 * the alignment's falsifier: restore the truthiness reading in either place and — with no
 * engine guard behind it any more — that payload reparents `po1` onto `thief` again.
 *
 * The second test is the one that changed shape as well as class. The targeted `update`
 * arm used to die EARLIER than any guard, in the engine's own scanner
 * (`Cannot determine FK fields for relation 'ghost'`), because a targeted to-many update
 * binds the target's own relations and the zero-argument side cannot be bound — the
 * asymmetry with `updateMany`, which binds nothing, is precisely why position 4 stood
 * open. That route is now UNREACHABLE FROM THIS PAYLOAD: the parse refuses the spelled
 * key before the engine binds anything. `ghost` itself is still unbindable, and that fact
 * keeps its own pin at the resolver level in
 * `tests/unit/relations/inverse-resolution-parity.core.test.ts` (case 10).
 */
const splitToManySchema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.oneToMany(() => post),
    })
    .map("m12_split_many_users");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      userId: s.string(),
      // Zero-argument `.fields()`, declared FIRST so it is `candidates[0]`.
      ghost: s.manyToOne(() => user).fields(),
      author: s
        .manyToOne(() => user)
        .fields("userId")
        .references("id"),
    })
    .map("m12_split_many_posts");
  return { user, post };
})();

hydrateSchemaNames(splitToManySchema);
const getSplitToManyFamily = usePGliteSchemaFamily(splitToManySchema);

/** Both to-many arms are `v.singleOrArray(...)`, so the unknown key surfaces through the
 *  union's own sentence: member 1 is the `{ where, data }` object, member 2 the array. */
const SPLIT_MANY_UNKNOWN_FK =
  "Validation failed for update: Value did not match any union member: Unknown key: userId, Expected array";

describe("M12 the parse boundary owns the degenerate to-many schema's arms", () => {
  async function splitManySetup() {
    const family = getSplitToManyFamily();
    await family.reset();
    const driver = new RecordingPGliteDriver({ client: family.database });
    const client = createClient({ schema: splitToManySchema, driver });
    await client.user.create({ data: { id: "owner", name: "owner" } });
    await client.user.create({ data: { id: "thief", name: "thief" } });
    await client.post.create({
      data: { id: "po1", title: "title", userId: "owner" },
    });
    return { client, driver };
  }

  test(
    "the bulk arm — the one that was silently reparenting — refuses at the parse",
    { timeout: 30_000 },
    async () => {
      const { client, driver } = await splitManySetup();
      driver.recording = true;
      const call = () =>
        client.user.update({
          where: { id: "owner" },
          data: {
            posts: {
              updateMany: {
                where: { id: "po1" },
                data: { title: "x", userId: "thief" },
              },
            },
          } as never,
        });
      // Was a SUCCESS before the Package N gate, then the engine guard's
      // `UnsupportedOperationError: Relation 'posts' owns 'userId'; …`.
      await expect(call()).rejects.toThrow(ValidationError);
      await expect(call()).rejects.toThrow(SPLIT_MANY_UNKNOWN_FK);
      driver.recording = false;
      // Refused while the payload is PARSED, so nothing was sent.
      expect(driver.statements).toEqual([]);
      // `thief` exists and would have accepted the row — this is the provenance that
      // makes the refusal load-bearing rather than incidental.
      await expect(
        client.post.findUnique({ where: { id: "po1" } })
      ).resolves.toEqual({ id: "po1", title: "title", userId: "owner" });
    }
  );

  test(
    "the targeted update arm refuses at the parse, before the engine scanner",
    { timeout: 30_000 },
    async () => {
      const { client, driver } = await splitManySetup();
      driver.recording = true;
      const call = () =>
        client.user.update({
          where: { id: "owner" },
          data: {
            posts: {
              update: {
                where: { id: "po1" },
                data: { title: "y", userId: "thief" },
              },
            },
          } as never,
        });
      // Was `Cannot determine FK fields for relation 'ghost'` — the engine's own scanner,
      // reached because a targeted to-many update binds the target's relations. The parse
      // now answers first, so that route is unreachable from this payload.
      await expect(call()).rejects.toThrow(ValidationError);
      await expect(call()).rejects.toThrow("Unknown key: userId");
      driver.recording = false;
      expect(driver.statements).toEqual([]);
      await expect(
        client.post.findUnique({ where: { id: "po1" } })
      ).resolves.toEqual({ id: "po1", title: "title", userId: "owner" });
    }
  );

  test(
    "the same bulk arm writes when the foreign key is omitted",
    { timeout: 30_000 },
    async () => {
      const { client } = await splitManySetup();
      await client.user.update({
        where: { id: "owner" },
        data: {
          posts: {
            updateMany: { where: { id: "po1" }, data: { title: "ok" } },
          },
        },
      });
      await expect(
        client.post.findUnique({ where: { id: "po1" } })
      ).resolves.toEqual({ id: "po1", title: "ok", userId: "owner" });
    }
  );
});
