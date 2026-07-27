import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { NestedWriteError, ValidationError, VibORMErrorCode } from "@errors";
import { push } from "@migrations";
import { hydrateSchemaNames, s } from "@schema";
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

  return { owner, profile, avatar, mark, badge, theme, note, detail, box };
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

export function runToOneUpdateWhereBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
}): void {
  describe(`${options.name} to-one nested update { where, data }`, () => {
    const setup = async () => {
      const driver = options.createDriver();
      const client = makeClient(driver);
      await push(client, { force: true });
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
      await client.note.create({
        data: { id: 4, title: "title-0", ownerId: 1 },
      });
      await client.detail.create({
        data: { id: 5, body: "body-0", visible: true, noteId: 4 },
      });
      return { client, dispose: () => client.$disconnect() };
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
      note: await client.note.findUnique({
        where: { id: 4 },
        select: { title: true },
      }),
      detail: await client.detail.findUnique({
        where: { id: 5 },
        select: { body: true },
      }),
    });

    const SEED = {
      owner: { name: "name-0", profileId: 1 },
      profile: { bio: "bio-0", avatarId: 10 },
      badge: { label: "label-0", themeId: 20 },
      box: { data: 5 },
      note: { title: "title-0" },
      detail: { body: "body-0" },
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

    // -- 8. the documented `data`-named-field collision ----------------------

    test(
      "a target field named `data`: the object payload reads as the wrapper",
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

        // An OBJECT payload reads as the wrapper, so `{ set: 9 }` is parsed as a
        // `box` update — which has no `set` field. This is Prisma's collision.
        const error = await rejection(
          client.owner.update({
            where: { id: 1 },
            data: { box: { update: { data: { set: 9 } } } },
          })
        );
        expect(error).toBeInstanceOf(ValidationError);
        expect(await client.box.findUnique({ where: { id: 3 } })).toMatchObject(
          {
            data: 7,
          }
        );

        // The documented escape: spell the wrapper explicitly.
        await client.owner.update({
          where: { id: 1 },
          data: { box: { update: { data: { data: { set: 9 } } } } },
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
