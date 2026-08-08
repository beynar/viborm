import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { NestedWriteError, ValidationError, VibORMErrorCode } from "@errors";
import { hydrateSchemaNames, JsonNull, s } from "@schema";
import {
  type BehaviorDatabaseSource,
  useBehaviorDatabase,
} from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

/**
 * W4-U3 — the to-one nested `update: { where, data }` form (Prisma 5).
 *
 * A to-one relation's nested `update` accepts BOTH spellings:
 *
 *   bare      `profile: { update: { bio: "x" } }`
 *   wrapped   `profile: { update: { where: { active: true }, data: { bio: "x" } } }`
 *
 * The wrapper's `where` is a **non-unique** `WhereInput`. It does not select among
 * candidates — a to-one has exactly one connected record — it FILTERS that record.
 * A connected row that fails the filter is a P2025-equivalent `NestedWriteError`
 * (`Cannot update relation '…': target record was not found for this parent.`) and
 * the WHOLE operation aborts: the root scalar SET and every sibling nested write
 * roll back with it, identically in transaction and atomic-batch mode.
 *
 * The four engine paths a to-one `update` can take, all four exercised here:
 *
 *   1. parent-held, in place        — the parent row holds the FK; the referenced row
 *                                     is located by `child.id = parent.fk` and updated
 *                                     (`UpdateOperation.interpretParentHeldUpdate`).
 *   2. parent-held, DELEGATED       — the same, but the target's own data carries a
 *                                     parent-held to-one of its own, so the whole
 *                                     target update is delegated to the update root
 *                                     (X1c `NestedTargetLocate`).
 *   3. inverse-side, in place       — the child holds the FK; the correlated probe
 *                                     (`child.fk = parent.id`) is the whole locator
 *                                     (`RelationWritePart` targeted update).
 *   4. inverse-side, DELEGATED      — the same, with a parent-held to-one in the
 *                                     target's data (X1c again).
 *
 * plus the DEPTH path (a to-one `update` folded one level under another nested
 * update target, `nested-target-parts.ts`).
 *
 * The filter is compiled into the LOCATE (and, in batch mode, into the presence
 * guard) — never into the write, which addresses the primary key the locate
 * captured. That is why a RELATION filter inside the wrapper `where` is portable
 * here, unlike inside a top-level extended unique `where` (W4-U1's documented
 * refusal), and it is pinned below.
 */
export const toOneUpdateWhereSchema = (() => {
  const owner = s
    .model({
      id: s.int().id(),
      name: s.string(),
      profileId: s.int().nullable().unique(),
      // 1 + 2: the PARENT holds this FK.
      profile: s
        .oneToOne(() => profile)
        .fields("profileId")
        .references("id")
        .optional(),
      // 3 + 4: the CHILD holds the FK (inverse side).
      badge: s.oneToOne(() => badge).optional(),
      // The collision witness: a model whose scalar is literally named `data`.
      box: s.oneToOne(() => box).optional(),
      // The collision witness that can actually WRITE somewhere else: a JSON
      // document column named `data`, on a model that also owns an ordinary
      // column and a relation the document's keys can name. See section 8b.
      blob: s.oneToOne(() => blob).optional(),
      // Depth: a to-many whose target carries its own inverse-side to-one.
      notes: s.oneToMany(() => note),
    })
    .map("tou_owners");

  const profile = s
    .model({
      id: s.int().id(),
      bio: s.string(),
      active: s.boolean(),
      avatarId: s.int().nullable().unique(),
      // A parent-held to-one INSIDE the target's data forces path 2 (delegation).
      avatar: s
        .oneToOne(() => avatar)
        .fields("avatarId")
        .references("id")
        .optional(),
      owner: s.oneToOne(() => owner).optional(),
      // The relation the DEEP wrapper filter reaches through.
      marks: s.oneToMany(() => mark),
    })
    .map("tou_profiles");

  const avatar = s
    .model({
      id: s.int().id(),
      url: s.string(),
      profile: s.oneToOne(() => profile).optional(),
    })
    .map("tou_avatars");

  const mark = s
    .model({
      id: s.int().id(),
      flag: s.boolean(),
      profileId: s.int(),
      profile: s
        .manyToOne(() => profile)
        .fields("profileId")
        .references("id"),
    })
    .map("tou_marks");

  const badge = s
    .model({
      id: s.int().id(),
      label: s.string(),
      active: s.boolean(),
      ownerId: s.int().nullable().unique(),
      owner: s
        .oneToOne(() => owner)
        .fields("ownerId")
        .references("id")
        .optional(),
      themeId: s.int().nullable().unique(),
      // A parent-held to-one INSIDE the target's data forces path 4 (delegation).
      theme: s
        .oneToOne(() => theme)
        .fields("themeId")
        .references("id")
        .optional(),
    })
    .map("tou_badges");

  const theme = s
    .model({
      id: s.int().id(),
      tint: s.string(),
      badge: s.oneToOne(() => badge).optional(),
    })
    .map("tou_themes");

  const note = s
    .model({
      id: s.int().id(),
      title: s.string(),
      ownerId: s.int().nullable(),
      owner: s
        .manyToOne(() => owner)
        .fields("ownerId")
        .references("id")
        .optional(),
      detail: s.oneToOne(() => detail).optional(),
    })
    .map("tou_notes");

  const detail = s
    .model({
      id: s.int().id(),
      body: s.string(),
      visible: s.boolean(),
      // The DEPTH collision witness: a `data`-named scalar on a model that is only
      // reachable one level under another nested update target (`box` is the same
      // witness at the root). See section 8.
      data: s.int(),
      noteId: s.int().nullable().unique(),
      note: s
        .oneToOne(() => note)
        .fields("noteId")
        .references("id")
        .optional(),
    })
    .map("tou_details");

  const box = s
    .model({
      id: s.int().id(),
      // Deliberately named `data`: the documented collision with the wrapper's
      // discriminator key (see `src/validation/relations/to-one-update-form.ts`).
      data: s.int(),
      ownerId: s.int().nullable().unique(),
      owner: s
        .oneToOne(() => owner)
        .fields("ownerId")
        .references("id")
        .optional(),
    })
    .map("tou_boxes");

  const blob = s
    .model({
      id: s.int().id(),
      // A JSON document column named `data`. Unlike `box.data` (an int, where an
      // object payload cannot be a valid field update and so errors by accident),
      // EVERY object is a legal value here — which is what made the collision able
      // to write the wrong column instead of complaining.
      data: s.json().nullable(),
      // A column a stored document's keys can collide with…
      label: s.string(),
      ownerId: s.int().nullable().unique(),
      // …and a relation whose nested-write keys they can collide with.
      owner: s
        .oneToOne(() => owner)
        .fields("ownerId")
        .references("id")
        .optional(),
    })
    .map("tou_blobs");

  return {
    owner,
    profile,
    avatar,
    mark,
    badge,
    theme,
    note,
    detail,
    box,
    blob,
  };
})();

hydrateSchemaNames(toOneUpdateWhereSchema);

type ToOneUpdateWhereClient = ReturnType<typeof makeClient>;

function makeClient(driver: AnyDriver) {
  return createClient({ schema: toOneUpdateWhereSchema, driver });
}

const TARGET_NOT_FOUND =
  "target record was not found for this parent." as const;

async function rejection(act: PromiseLike<unknown>): Promise<unknown> {
  return await act.then(
    () => undefined,
    (error: unknown) => error
  );
}

export function runToOneUpdateWhereBehavior(
  options: { readonly name: string } & BehaviorDatabaseSource
): void {
  describe(`${options.name} to-one nested update { where, data }`, () => {
    const openDatabase = useBehaviorDatabase(toOneUpdateWhereSchema, options);
    const setup = async () => {
      const database = await openDatabase();
      const { client } = database;
      await client.avatar.create({ data: { id: 10, url: "avatar-a" } });
      await client.avatar.create({ data: { id: 11, url: "avatar-b" } });
      await client.theme.create({ data: { id: 20, tint: "tint-a" } });
      await client.theme.create({ data: { id: 21, tint: "tint-b" } });
      await client.profile.create({
        data: { id: 1, bio: "bio-0", active: true, avatarId: 10 },
      });
      await client.owner.create({
        data: { id: 1, name: "name-0", profileId: 1 },
      });
      await client.mark.create({ data: { id: 100, flag: true, profileId: 1 } });
      await client.mark.create({
        data: { id: 101, flag: false, profileId: 1 },
      });
      await client.badge.create({
        data: {
          id: 2,
          label: "label-0",
          active: true,
          ownerId: 1,
          themeId: 20,
        },
      });
      await client.box.create({ data: { id: 3, data: 5, ownerId: 1 } });
      await client.blob.create({
        data: { id: 6, data: { seed: true }, label: "label-0", ownerId: 1 },
      });
      await client.note.create({
        data: { id: 4, title: "title-0", ownerId: 1 },
      });
      await client.detail.create({
        data: { id: 5, body: "body-0", visible: true, data: 5, noteId: 4 },
      });
      return database;
    };

    const run = (
      body: (client: ToOneUpdateWhereClient) => Promise<void>
    ): (() => Promise<void>) => {
      return async () => {
        const { client, dispose } = await setup();
        try {
          await body(client);
        } finally {
          await dispose();
        }
      };
    };

    /** Every column any scenario can move, in one comparable snapshot. Compared
     *  against {@link SEED} inside the test, so a rolled-back operation has to
     *  leave the WHOLE tree where it found it, not just the row under test. */
    const snapshot = async (client: ToOneUpdateWhereClient) => ({
      owner: await client.owner.findUnique({
        where: { id: 1 },
        select: { name: true, profileId: true },
      }),
      profile: await client.profile.findUnique({
        where: { id: 1 },
        select: { bio: true, avatarId: true },
      }),
      badge: await client.badge.findUnique({
        where: { id: 2 },
        select: { label: true, themeId: true },
      }),
      box: await client.box.findUnique({
        where: { id: 3 },
        select: { data: true },
      }),
      blob: await client.blob.findUnique({
        where: { id: 6 },
        select: { data: true, label: true, ownerId: true },
      }),
      note: await client.note.findUnique({
        where: { id: 4 },
        select: { title: true },
      }),
      detail: await client.detail.findUnique({
        where: { id: 5 },
        select: { body: true, data: true },
      }),
    });

    const SEED = {
      owner: { name: "name-0", profileId: 1 },
      profile: { bio: "bio-0", avatarId: 10 },
      badge: { label: "label-0", themeId: 20 },
      box: { data: 5 },
      blob: { data: { seed: true }, label: "label-0", ownerId: 1 },
      note: { title: "title-0" },
      detail: { body: "body-0", data: 5 },
    };

    // -- 1. parent-held to-one, in place ------------------------------------

    test(
      "parent-held: a matching filter updates the connected record",
      { timeout: 30_000 },
      run(async (client) => {
        await client.owner.update({
          where: { id: 1 },
          data: {
            name: "name-1",
            profile: {
              update: { where: { active: true }, data: { bio: "bio-1" } },
            },
          },
        });
        expect(
          await client.profile.findUnique({ where: { id: 1 } })
        ).toMatchObject({ bio: "bio-1" });
        expect(
          await client.owner.findUnique({ where: { id: 1 } })
        ).toMatchObject({ name: "name-1" });
      })
    );

    test(
      "parent-held: an excluding filter aborts the whole operation",
      { timeout: 30_000 },
      run(async (client) => {
        const error = await rejection(
          client.owner.update({
            where: { id: 1 },
            data: {
              name: "name-1",
              profile: {
                update: { where: { active: false }, data: { bio: "bio-1" } },
              },
              // A sibling write that must roll back with it.
              badge: { update: { label: "label-1" } },
            },
          })
        );
        expect(error).toBeInstanceOf(NestedWriteError);
        expect((error as NestedWriteError).code).toBe(
          VibORMErrorCode.NESTED_WRITE_FAILED
        );
        expect((error as NestedWriteError).message).toContain(TARGET_NOT_FOUND);
        expect(await snapshot(client)).toEqual(SEED);
      })
    );

    // -- 2. parent-held to-one, delegated (X1c) -----------------------------

    test(
      "parent-held (delegated): filter hit and miss on a target that carries its own to-one",
      { timeout: 30_000 },
      run(async (client) => {
        await client.owner.update({
          where: { id: 1 },
          data: {
            profile: {
              update: {
                where: { active: true },
                data: { bio: "bio-1", avatar: { connect: { id: 11 } } },
              },
            },
          },
        });
        expect(
          await client.profile.findUnique({ where: { id: 1 } })
        ).toMatchObject({ bio: "bio-1", avatarId: 11 });

        const error = await rejection(
          client.owner.update({
            where: { id: 1 },
            data: {
              name: "name-2",
              profile: {
                update: {
                  where: { bio: "bio-0" },
                  data: { bio: "bio-2", avatar: { connect: { id: 10 } } },
                },
              },
            },
          })
        );
        expect(error).toBeInstanceOf(NestedWriteError);
        expect((error as NestedWriteError).message).toContain(TARGET_NOT_FOUND);
        // The hit above is the only change; the miss rolled its whole tree back.
        expect(
          await client.profile.findUnique({ where: { id: 1 } })
        ).toMatchObject({ bio: "bio-1", avatarId: 11 });
        expect(
          await client.owner.findUnique({ where: { id: 1 } })
        ).toMatchObject({ name: "name-0" });
      })
    );

    // -- 3. inverse-side to-one, in place -----------------------------------

    test(
      "inverse-side: a matching filter updates the correlated child",
      { timeout: 30_000 },
      run(async (client) => {
        await client.owner.update({
          where: { id: 1 },
          data: {
            name: "name-1",
            badge: {
              update: { where: { active: true }, data: { label: "label-1" } },
            },
          },
        });
        expect(
          await client.badge.findUnique({ where: { id: 2 } })
        ).toMatchObject({ label: "label-1" });
        expect(
          await client.owner.findUnique({ where: { id: 1 } })
        ).toMatchObject({ name: "name-1" });
      })
    );

    test(
      "inverse-side: an excluding filter aborts the whole operation",
      { timeout: 30_000 },
      run(async (client) => {
        const error = await rejection(
          client.owner.update({
            where: { id: 1 },
            data: {
              name: "name-1",
              profile: { update: { bio: "bio-1" } },
              badge: {
                update: {
                  where: { active: false },
                  data: { label: "label-1" },
                },
              },
            },
          })
        );
        expect(error).toBeInstanceOf(NestedWriteError);
        expect((error as NestedWriteError).message).toContain(TARGET_NOT_FOUND);
        expect(await snapshot(client)).toEqual(SEED);
      })
    );

    // -- 4. inverse-side to-one, delegated (X1c) ----------------------------

    test(
      "inverse-side (delegated): filter hit and miss on a target that carries its own to-one",
      { timeout: 30_000 },
      run(async (client) => {
        await client.owner.update({
          where: { id: 1 },
          data: {
            badge: {
              update: {
                where: { active: true },
                data: { label: "label-1", theme: { connect: { id: 21 } } },
              },
            },
          },
        });
        expect(
          await client.badge.findUnique({ where: { id: 2 } })
        ).toMatchObject({ label: "label-1", themeId: 21 });

        const error = await rejection(
          client.owner.update({
            where: { id: 1 },
            data: {
              name: "name-2",
              badge: {
                update: {
                  where: { label: "label-0" },
                  data: { label: "label-2", theme: { connect: { id: 20 } } },
                },
              },
            },
          })
        );
        expect(error).toBeInstanceOf(NestedWriteError);
        expect((error as NestedWriteError).message).toContain(TARGET_NOT_FOUND);
        expect(
          await client.badge.findUnique({ where: { id: 2 } })
        ).toMatchObject({ label: "label-1", themeId: 21 });
        expect(
          await client.owner.findUnique({ where: { id: 1 } })
        ).toMatchObject({ name: "name-0" });
      })
    );

    // -- 5. a DEEP filter: a relation filter inside the wrapper `where` ------

    test(
      "a relation filter inside the wrapper where decides hit and miss",
      { timeout: 30_000 },
      run(async (client) => {
        await client.owner.update({
          where: { id: 1 },
          data: {
            profile: {
              update: {
                where: { marks: { some: { flag: true } } },
                data: { bio: "bio-1" },
              },
            },
          },
        });
        expect(
          await client.profile.findUnique({ where: { id: 1 } })
        ).toMatchObject({ bio: "bio-1" });

        const error = await rejection(
          client.owner.update({
            where: { id: 1 },
            data: {
              name: "name-2",
              profile: {
                update: {
                  where: { marks: { every: { flag: true } } },
                  data: { bio: "bio-2" },
                },
              },
            },
          })
        );
        expect(error).toBeInstanceOf(NestedWriteError);
        expect((error as NestedWriteError).message).toContain(TARGET_NOT_FOUND);
        expect(
          await client.profile.findUnique({ where: { id: 1 } })
        ).toMatchObject({ bio: "bio-1" });
        expect(
          await client.owner.findUnique({ where: { id: 1 } })
        ).toMatchObject({ name: "name-0" });
      })
    );

    test(
      "AND / OR / NOT compile into the wrapper filter",
      { timeout: 30_000 },
      run(async (client) => {
        await client.owner.update({
          where: { id: 1 },
          data: {
            badge: {
              update: {
                where: {
                  AND: [{ active: true }],
                  OR: [{ label: "label-0" }, { label: "nobody" }],
                  NOT: { label: "nobody" },
                },
                data: { label: "label-1" },
              },
            },
          },
        });
        expect(
          await client.badge.findUnique({ where: { id: 2 } })
        ).toMatchObject({ label: "label-1" });

        const error = await rejection(
          client.owner.update({
            where: { id: 1 },
            data: {
              badge: {
                update: {
                  where: { NOT: { active: true } },
                  data: { label: "label-2" },
                },
              },
            },
          })
        );
        expect(error).toBeInstanceOf(NestedWriteError);
        expect(
          await client.badge.findUnique({ where: { id: 2 } })
        ).toMatchObject({ label: "label-1" });
      })
    );

    // -- 6. depth: the wrapper one level under another nested update --------

    test(
      "depth: the wrapper works on a to-one folded under another update target",
      { timeout: 30_000 },
      run(async (client) => {
        await client.owner.update({
          where: { id: 1 },
          data: {
            notes: {
              update: {
                where: { id: 4 },
                data: {
                  title: "title-1",
                  detail: {
                    update: {
                      where: { visible: true },
                      data: { body: "body-1" },
                    },
                  },
                },
              },
            },
          },
        });
        expect(
          await client.detail.findUnique({ where: { id: 5 } })
        ).toMatchObject({ body: "body-1" });

        const error = await rejection(
          client.owner.update({
            where: { id: 1 },
            data: {
              name: "name-2",
              notes: {
                update: {
                  where: { id: 4 },
                  data: {
                    title: "title-2",
                    detail: {
                      update: {
                        where: { visible: false },
                        data: { body: "body-2" },
                      },
                    },
                  },
                },
              },
            },
          })
        );
        expect(error).toBeInstanceOf(NestedWriteError);
        expect((error as NestedWriteError).message).toContain(TARGET_NOT_FOUND);
        expect(
          await client.detail.findUnique({ where: { id: 5 } })
        ).toMatchObject({ body: "body-1" });
        expect(
          await client.note.findUnique({ where: { id: 4 } })
        ).toMatchObject({ title: "title-1" });
        expect(
          await client.owner.findUnique({ where: { id: 1 } })
        ).toMatchObject({ name: "name-0" });
      })
    );

    // -- 7. the bare form's regression witnesses ----------------------------

    test(
      "bare data stays bare on both directions and at depth",
      { timeout: 30_000 },
      run(async (client) => {
        await client.owner.update({
          where: { id: 1 },
          data: {
            name: "name-1",
            profile: { update: { bio: "bio-1" } },
            badge: { update: { label: "label-1" } },
            notes: {
              update: {
                where: { id: 4 },
                data: { detail: { update: { body: "body-1" } } },
              },
            },
          },
        });
        expect(
          await client.profile.findUnique({ where: { id: 1 } })
        ).toMatchObject({ bio: "bio-1", active: true });
        expect(
          await client.badge.findUnique({ where: { id: 2 } })
        ).toMatchObject({ label: "label-1", active: true });
        expect(
          await client.detail.findUnique({ where: { id: 5 } })
        ).toMatchObject({ body: "body-1" });
        expect(
          await client.owner.findUnique({ where: { id: 1 } })
        ).toMatchObject({ name: "name-1" });
      })
    );

    test(
      "an empty wrapper where constrains nothing",
      { timeout: 30_000 },
      run(async (client) => {
        await client.owner.update({
          where: { id: 1 },
          data: { profile: { update: { where: {}, data: { bio: "bio-1" } } } },
        });
        expect(
          await client.profile.findUnique({ where: { id: 1 } })
        ).toMatchObject({ bio: "bio-1" });
      })
    );

    // -- 8. the `data`-named-field collision, REFUSED ------------------------
    //
    // AUTHORIZED RETARGET (fix round). These three tests previously asserted that
    // an object payload for a `data`-named field "reads as the wrapper", with
    // `update: { data: { data: … } }` as the escape. That reading is what let a
    // to-one nested update write the WRONG COLUMNS on a model whose `data` field
    // accepts objects (section 8b is the witness that could not be built with
    // `box`, whose `data` is an int). The rule now REFUSES the ambiguous spelling
    // and the escape carries an explicit `where`. Everything else here — the
    // scalar shorthand staying bare, the filter working on such a model, the
    // reading being identical at the root, at depth and under a delegated target
    // — is unchanged and still asserted.

    const AMBIGUOUS = "Ambiguous to-one nested `update`";

    test(
      "a target field named `data`: the object payload is refused, not guessed",
      { timeout: 30_000 },
      run(async (client) => {
        // A NON-object payload is unambiguous — still bare data (shorthand set).
        await client.owner.update({
          where: { id: 1 },
          data: { box: { update: { data: 7 } } },
        });
        expect(await client.box.findUnique({ where: { id: 3 } })).toMatchObject(
          {
            data: 7,
          }
        );

        // An OBJECT payload has the envelope's shape AND is how bare data spells
        // this model's own `data` field. Refused, by name.
        const error = await rejection(
          client.owner.update({
            where: { id: 1 },
            data: { box: { update: { data: { set: 9 } } } },
          })
        );
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).message).toContain(AMBIGUOUS);
        expect(await client.box.findUnique({ where: { id: 3 } })).toMatchObject(
          {
            data: 7,
          }
        );

        // The escape: spell the envelope out. An empty `where` constrains nothing.
        await client.owner.update({
          where: { id: 1 },
          data: { box: { update: { where: {}, data: { data: { set: 9 } } } } },
        });
        expect(await client.box.findUnique({ where: { id: 3 } })).toMatchObject(
          {
            data: 9,
          }
        );

        // …and the wrapper's filter works on that model too.
        const filtered = await rejection(
          client.owner.update({
            where: { id: 1 },
            data: {
              box: { update: { where: { data: 5 }, data: { data: 11 } } },
            },
          })
        );
        expect(filtered).toBeInstanceOf(NestedWriteError);
        expect(await client.box.findUnique({ where: { id: 3 } })).toMatchObject(
          {
            data: 9,
          }
        );
      })
    );

    // -- 8b. the collision that could WRITE THE WRONG COLUMN -----------------
    //
    // `box.data` is an int, so the old "object payload reads as the wrapper" rule
    // errored there by accident: `{ set: 9 }` is not a valid `box` update. On a
    // JSON column every object is a legal value AND a plausible update payload,
    // so the same rule silently wrote somewhere else — the document
    // `{ label: "x" }` set the `label` COLUMN and left `data` alone, and
    // `{ owner: { disconnect: true } }` executed a real FK disconnect. Each case
    // below is that write, now refused with the whole tree untouched.
    test(
      "a JSON field named `data`: no document is ever read as an update",
      { timeout: 30_000 },
      run(async (client) => {
        const refuse = async (payload: unknown) => {
          const error = await rejection(
            client.owner.update({
              where: { id: 1 },
              data: { blob: { update: payload } },
            } as never)
          );
          expect(error).toBeInstanceOf(ValidationError);
          expect((error as ValidationError).message).toContain(AMBIGUOUS);
          // Not one column of the tree moved — the refusal precedes every write.
          expect(await snapshot(client)).toEqual(SEED);
        };

        // 1. keys that name the target's own columns: the wrong-column write.
        await refuse({ data: { label: "from-json" } });
        // 2. keys that name one of its relations: the unintended FK mutation.
        await refuse({ data: { owner: { disconnect: true } } });
        // 3. keys that name NOTHING on the target. Refused identically — the FORM
        //    a payload takes may not depend on the VALUES inside it, or the same
        //    spelling would store one document and rewrite columns for the next.
        await refuse({ data: { seed: 1 } });

        // The escape writes the document, and only the document.
        await client.owner.update({
          where: { id: 1 },
          data: {
            blob: { update: { where: {}, data: { data: { seed: false } } } },
          },
        });
        expect(await snapshot(client)).toEqual({
          ...SEED,
          blob: { ...SEED.blob, data: { seed: false } },
        });

        // Bare data that does not mention `data` never had the collision.
        await client.owner.update({
          where: { id: 1 },
          data: { blob: { update: { label: "label-1" } } },
        });
        expect(await snapshot(client)).toEqual({
          ...SEED,
          blob: { ...SEED.blob, data: { seed: false }, label: "label-1" },
        });

        // A class instance never had the envelope's shape: a `JsonNull` sentinel
        // written against the `data` field is a VALUE, and stays bare data.
        await client.owner.update({
          where: { id: 1 },
          data: { blob: { update: { data: JsonNull } } },
        });
        expect(await snapshot(client)).toEqual({
          ...SEED,
          blob: { ...SEED.blob, data: null, label: "label-1" },
        });
      })
    );

    // The SAME model-owns-`data` collision one level deeper, where the engine sees
    // only the enclosing parse's OUTPUT. The form must read identically at every
    // depth: the scalar shorthand is bare, the object payload is the wrapper, and
    // the explicit wrapper is the escape. Before the canonical envelope the depth
    // reading disagreed with the root's — the bare `{ data: 7 }` arrived as the
    // rewritten `{ data: { set: 7 } }` and was misread as the wrapper.
    test(
      "a target field named `data` reads the same way at depth",
      { timeout: 30_000 },
      run(async (client) => {
        const deep = (detailUpdate: unknown) => ({
          where: { id: 1 },
          data: {
            notes: {
              update: {
                where: { id: 4 },
                data: { detail: { update: detailUpdate } },
              },
            },
          },
        });

        // BARE, scalar shorthand — unambiguous, and it must still be bare here.
        await client.owner.update(deep({ data: 7 }) as never);
        expect(
          await client.detail.findUnique({ where: { id: 5 } })
        ).toMatchObject({ data: 7 });

        // OBJECT payload — the refused collision, identical to the root reading.
        const error = await rejection(
          client.owner.update(deep({ data: { set: 9 } }) as never)
        );
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).message).toContain(AMBIGUOUS);
        expect(
          await client.detail.findUnique({ where: { id: 5 } })
        ).toMatchObject({ data: 7 });

        // The escape, at depth.
        await client.owner.update(
          deep({ where: {}, data: { data: { set: 9 } } }) as never
        );
        expect(
          await client.detail.findUnique({ where: { id: 5 } })
        ).toMatchObject({ data: 9 });

        // …and the wrapper's filter still filters on that model, at depth.
        const filtered = await rejection(
          client.owner.update(
            deep({ where: { data: 5 }, data: { data: 11 } }) as never
          )
        );
        expect(filtered).toBeInstanceOf(NestedWriteError);
        expect(
          await client.detail.findUnique({ where: { id: 5 } })
        ).toMatchObject({ data: 9 });
      })
    );

    // The X1c DELEGATED depth path (the second site the parsed-output reading
    // collapsed on): the note target holds a parent-held to-one write, so its WHOLE
    // update delegates to an `UpdateOperation` in nested-target mode — which
    // re-parses the ALREADY-parsed relation payload. Only a form that survives
    // re-parse unchanged reads correctly here.
    //
    // This is also the idempotence witness for the refusal: `{ data: 7 }` is bare,
    // and the canonical envelope the schema emits for it — `{ where: {}, data: … }`
    // on a target that owns a `data` field — is EXACTLY what stops the re-parse
    // from re-reading its own output as the ambiguous spelling. Drop that marker
    // and this test fails with the ambiguity refusal.
    test(
      "a target field named `data` reads the same way under a delegated target",
      { timeout: 30_000 },
      run(async (client) => {
        const delegated = (detailUpdate: unknown) => ({
          where: { id: 1 },
          data: {
            notes: {
              update: {
                where: { id: 4 },
                data: {
                  // Re-binds note 4 to the owner it already has: harmless, and it
                  // forces the X1c whole-target delegation.
                  owner: { connect: { id: 1 } },
                  title: "title-1",
                  detail: { update: detailUpdate },
                },
              },
            },
          },
        });

        await client.owner.update(delegated({ data: 7 }) as never);
        expect(
          await client.detail.findUnique({ where: { id: 5 } })
        ).toMatchObject({ data: 7, body: "body-0" });
        expect(
          await client.note.findUnique({ where: { id: 4 } })
        ).toMatchObject({ title: "title-1", ownerId: 1 });

        // The escape survives the re-parse too, filter and all.
        await client.owner.update(
          delegated({ where: {}, data: { data: { set: 9 } } }) as never
        );
        expect(
          await client.detail.findUnique({ where: { id: 5 } })
        ).toMatchObject({ data: 9, body: "body-0" });

        // …and the refusal is the same one at this depth.
        const error = await rejection(
          client.owner.update(delegated({ data: { set: 11 } }) as never)
        );
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).message).toContain(AMBIGUOUS);
        expect(
          await client.detail.findUnique({ where: { id: 5 } })
        ).toMatchObject({ data: 9 });
      })
    );

    // -- 9. the schema still fails closed ------------------------------------

    test(
      "an unknown key in the wrapper data or filter is a ValidationError",
      { timeout: 30_000 },
      run(async (client) => {
        const badData = await rejection(
          client.owner.update({
            where: { id: 1 },
            data: {
              profile: {
                update: {
                  where: { active: true },
                  // @ts-expect-error the wrapper's `data` half is typed as the
                  // target's update input — an unknown key fails to compile too.
                  data: { nope: 1 },
                },
              },
            },
          })
        );
        expect(badData).toBeInstanceOf(ValidationError);

        const badFilter = await rejection(
          client.owner.update({
            where: { id: 1 },
            data: {
              profile: {
                update: {
                  // @ts-expect-error the wrapper's `where` half is typed as the
                  // target's (non-unique) where input.
                  where: { nope: 1 },
                  data: { bio: "bio-1" },
                },
              },
            },
          })
        );
        expect(badFilter).toBeInstanceOf(ValidationError);
        expect(await snapshot(client)).toEqual(SEED);
      })
    );
  });
}
