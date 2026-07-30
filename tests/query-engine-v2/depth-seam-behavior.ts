import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { OperationExecutor } from "../../src/query-engine-v2/OperationExecutor";
import { UpdateOperation } from "../../src/query-engine-v2/UpdateOperation";

/**
 * N4 — the depth seams, across the whole driver matrix.
 *
 * Two boundaries used to sit one level below every absorbed nested write, and both
 * were about the same thing: a value the engine needed had to be a COMPILE-TIME
 * LITERAL, so the payload had to be spelled a particular way to be executable at all.
 *
 *  · **N4-U1 — locate the target by ANY unique.** `RelationWritePart`,
 *    `RelationUpsertPart` and `RelationJunctionPart` each refused a nested
 *    `update`/`upsert` that carried DEEPER relation writes unless its `where` named
 *    the target's PRIMARY KEY: the grandchild foreign keys reference that key, and
 *    only the `where` could supply it. But each of those parts ALREADY locates its
 *    target — a correlated probe, a unique probe, a junction membership read, every
 *    one of them selecting exactly that primary key and spending it on the write it
 *    performs. So the key travels as a `planned` source into that same read, the way
 *    N1 gave the update ROOT's child edges the located-parent Ref, and the value the
 *    grandchildren spend comes from THE ROW THE STEP ACTED ON — never re-derived by
 *    consulting the `where` a second time (the wrong-row doctrine).
 *
 *  · **N4-U3 — `createMany` under a planned parent.** A parent-held to-one `update`
 *    whose target bulk-creates a to-many child refused, while the SINGLE-`create`
 *    spelling of the identical shape ran. N1 had already built the planned-parent
 *    bulk leaf; this site was simply not handed it.
 *
 *  · **N4-U2 — the create arm one level deeper.** A nested `upsert`/`connectOrCreate`
 *    whose probe finds nothing INSERTs a FRESH row, and a fresh row's relations are the
 *    create root's surface — so the whole arm is now a create SUBTREE rather than one
 *    hand-rolled INSERT plus a narrow list of deeper writes. Its identity is produced,
 *    not located: a spelled primary key, or one the database generates and the
 *    grandchildren `Ref`.
 *
 * These are fixed-expectation behaviors run on every driver class and both
 * substrates. Each absorbed shape is paired with a WRONG-ROW probe: a decoy row,
 * seeded FIRST and holding the LOWER primary key, that any "take the first row" or
 * "re-read the where" implementation would land on — and the assertions name the id,
 * not just the count. The wall that remains is asserted too, in the same file
 * and on the same substrates, so it cannot quietly change disposition.
 */
export const depthSeamSchema = (() => {
  // --- N4-U1, child-held to-many (`RelationWritePart` / `RelationUpsertPart`) ---
  const workspace = s
    .model({
      id: s.int().id(),
      slug: s.string().unique(),
      projects: s.oneToMany(() => project),
      slots: s.oneToMany(() => slot).name("slots"),
    })
    .map("n4_seam_workspaces");
  const project = s
    .model({
      // `code` is a unique that is NEITHER the primary key NOR the parent's
      // discriminator: addressing the target by it is exactly the shape that refused.
      id: s.int().id(),
      code: s.string().unique(),
      title: s.string(),
      workspaceId: s.int(),
      workspace: s
        .manyToOne(() => workspace)
        .fields("workspaceId")
        .references("id"),
      tasks: s.oneToMany(() => task),
    })
    .map("n4_seam_projects");
  const task = s
    .model({
      id: s.int().id(),
      label: s.string(),
      projectId: s.int(),
      project: s
        .manyToOne(() => project)
        .fields("projectId")
        .references("id"),
    })
    .map("n4_seam_tasks");

  // A to-many whose key the DATABASE generates, reachable by a non-PK unique. N4-U1
  // could not serve this shape on the upsert CREATE arm (a fresh row's generated key is
  // not knowable before its INSERT runs, and the arm's grandchildren needed a
  // construction-time literal); N4-U2 made the arm a create SUBTREE, whose grandchildren
  // `Ref` the INSERT that produces it — so the pair of arms below now witnesses the
  // produced and spelled identities agreeing, not a wall.
  const slot = s
    .model({
      id: s.int().id().increment(),
      code: s.string().unique(),
      title: s.string(),
      workspaceId: s.int(),
      workspace: s
        .manyToOne(() => workspace)
        .fields("workspaceId")
        .references("id")
        .name("slots"),
      entries: s.oneToMany(() => entry),
    })
    .map("n4_seam_slots");
  const entry = s
    .model({
      id: s.int().id().increment(),
      text: s.string(),
      slotId: s.int(),
      slot: s
        .manyToOne(() => slot)
        .fields("slotId")
        .references("id"),
    })
    .map("n4_seam_entries");

  // --- N4-U3, parent-held to-one target (`nested-target-parts`) ---
  const owner = s
    .model({
      id: s.int().id(),
      name: s.string(),
      notes: s.oneToMany(() => note),
      tickets: s.oneToMany(() => ticket),
    })
    .map("n4_seam_owners");
  const note = s
    .model({
      id: s.int().id(),
      body: s.string(),
      ownerId: s.int(),
      owner: s
        .manyToOne(() => owner)
        .fields("ownerId")
        .references("id"),
    })
    .map("n4_seam_notes");
  const ticket = s
    .model({
      id: s.int().id(),
      subject: s.string(),
      ownerId: s.int(),
      // The ROOT holds this foreign key, so `ticket.update({ data: { owner: { update } } })`
      // is the parent-held to-one whose target is located by a PLANNED probe.
      owner: s
        .manyToOne(() => owner)
        .fields("ownerId")
        .references("id"),
    })
    .map("n4_seam_tickets");

  // --- N4-U1, many-to-many (`RelationJunctionPart`) ---
  const album = s
    .model({
      id: s.int().id(),
      title: s.string(),
      photos: s.manyToMany(() => photo),
    })
    .map("n4_seam_albums");
  const photo = s
    .model({
      id: s.int().id(),
      slug: s.string().unique(),
      caption: s.string(),
      albums: s.manyToMany(() => album),
      marks: s.oneToMany(() => mark),
    })
    .map("n4_seam_photos");
  const mark = s
    .model({
      id: s.int().id(),
      text: s.string(),
      photoId: s.int(),
      photo: s
        .manyToOne(() => photo)
        .fields("photoId")
        .references("id"),
    })
    .map("n4_seam_marks");

  return {
    workspace,
    project,
    task,
    slot,
    entry,
    owner,
    note,
    ticket,
    album,
    photo,
    mark,
  };
})();

hydrateSchemaNames(depthSeamSchema);

/** The executor's typed refusal for a savepoint skip inside a single atomic batch. */
const NO_BATCH_SKIP_LOWERING = /no atomic-batch lowering/;
/** V1's verbatim `Cannot update … for this parent` abort. */
const TARGET_NOT_FOUND = /Cannot update/;
/** The same abort raised by the X1c DELEGATION route — an `UpdateOperation` running in
 *  `nestedTarget` mode, whose locate misses. Spelled in full and named per relation so
 *  the arm cannot pass on some other `Cannot update …` the tree might raise first. */
const TICKET_TARGET_NOT_FOUND =
  /Cannot update relation 'tickets': target record was not found for this parent\./;
/** The DELETE family's spelling of the same abort. Named separately because
 *  {@link TARGET_NOT_FOUND} matches only the update wording, and a nested `delete`
 *  that aborts must be asserted against the message it actually raises. */
const DELETE_TARGET_NOT_FOUND =
  /Cannot delete relation 'projects': target record was not found for this parent\./;
/** The surviving N4-U1 wall's wording. */
const MUST_LOCATE_BY_PK = /must locate the target by its primary key/;

/**
 * The operations run through the OPERATION, not the routed client: a batch-only,
 * non-returning driver refuses every single-row mutation at the client seam ("public
 * result parsing cannot be rolled back"), which would make the whole batch leg
 * vacuous. The same seam `located-parent-ref-behavior.ts` uses, for the same reason.
 */
/** The seam schema's `QueryEngine`, for tests that inspect a COMPILED fragment
 *  rather than execute one (the N6-U1 `racePin` witnesses). */
export function makeSeamEngine(driver: AnyDriver): QueryEngine {
  const schemas = createSchemaRegistry(depthSeamSchema);
  return new QueryEngine(driver, createModelRegistry(depthSeamSchema, schemas));
}

export function makeSeamRunner(driver: AnyDriver) {
  const engine = makeSeamEngine(driver);
  const executor = new OperationExecutor(engine);
  return (
    modelName: string,
    model: Model<any>,
    args: Record<string, unknown>
  ): Promise<unknown> =>
    executor.execute(
      new UpdateOperation(engine, model, args),
      createOperationExecutionContext(
        modelName,
        "update",
        engine.instrumentation
      )
    );
}

export function makeSeamClient(driver: AnyDriver) {
  return createClient({ schema: depthSeamSchema, driver });
}
export type SeamClient = ReturnType<typeof makeSeamClient>;

/**
 * Two projects with the SAME title in two different workspaces. The decoy is seeded
 * FIRST and holds the LOWER primary key, so an implementation that re-consults the
 * `where`, takes "the first row", or falls back to a scan attaches the grandchild to
 * it — and every assertion names the project id, not just a row count.
 */
export async function seedProjects(client: SeamClient): Promise<void> {
  await client.workspace.create({ data: { id: 1, slug: "decoy-ws" } });
  await client.workspace.create({ data: { id: 2, slug: "target-ws" } });
  await client.project.create({
    data: { id: 10, code: "P-DECOY", title: "same", workspaceId: 1 },
  });
  await client.project.create({
    data: { id: 20, code: "P-TARGET", title: "same", workspaceId: 2 },
  });
}

/** The N4-U3 bed: two owners, the decoy first and lower, one ticket pointing at the
 *  second. Any planned read that resolved to the wrong row files the notes on owner 1.
 *
 *  The bed carries a DECOY TICKET too — lower key, identical `subject`, owned by the
 *  decoy owner — because the same models are the only ones in this schema that force
 *  X1c's full-update delegation (a ticket's `owner` is parent-held, so a target whose
 *  data carries it hands its WHOLE update to `UpdateOperation`). The N6-U1 witnesses at
 *  the bottom of this file address ticket 5 from owner 2 and must not be able to pass by
 *  landing on ticket 4. No `ticket` row assertion elsewhere reads more than id 5. */
async function seedOwners(client: SeamClient): Promise<void> {
  await client.owner.create({ data: { id: 1, name: "decoy" } });
  await client.owner.create({ data: { id: 2, name: "target" } });
  await client.ticket.create({ data: { id: 4, subject: "s", ownerId: 1 } });
  await client.ticket.create({ data: { id: 5, subject: "s", ownerId: 2 } });
}

/** The junction bed: two photos with identical captions, the decoy first and lower;
 *  only the target is a member of the album. */
async function seedAlbum(client: SeamClient): Promise<void> {
  await client.photo.create({ data: { id: 10, slug: "decoy", caption: "c" } });
  await client.photo.create({ data: { id: 20, slug: "target", caption: "c" } });
  await client.album.create({
    data: { id: 1, title: "a", photos: { connect: [{ id: 20 }] } },
  });
}

export function runDepthSeamBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  readonly createStateDriver?: () => AnyDriver;
  /**
   * Declared by the caller, never sniffed (the `located-parent-ref-behavior`
   * convention): on a dialect whose `skipDuplicates` is NOT a SQL leaf
   * (`recoverableUniqueError` — MySQL) the skip is a savepoint-wrapped executor effect,
   * and a savepoint has no lowering into a single atomic batch. Such a leg must see the
   * typed refusal with NOTHING written, not a silent success — and a leg that CAN
   * express it may not quietly start refusing.
   */
  readonly skipDuplicatesInBatchIsInexpressible?: boolean;
}): void {
  describe(`${options.name} depth-seam boundaries (N4)`, () => {
    const setup = async () => {
      const driver = options.createDriver();
      const stateDriver = options.createStateDriver?.() ?? driver;
      const client = makeSeamClient(stateDriver);
      const update = makeSeamRunner(driver);
      await push(client, { force: true });
      const dispose = async () => {
        await client.$disconnect();
        if (driver !== stateDriver) await driver.disconnect();
      };
      return { client, update, dispose };
    };

    // -----------------------------------------------------------------------
    // N4-U1 — child-held to-many `update` (RelationWritePart)
    // -----------------------------------------------------------------------

    test(
      "a nested update named by a non-PK unique carries its deeper create",
      {
        timeout: 30_000,
      },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedProjects(client);
          await update("workspace", depthSeamSchema.workspace, {
            where: { id: 2 },
            data: {
              projects: {
                update: {
                  where: { code: "P-TARGET" },
                  data: {
                    title: "moved",
                    tasks: { create: { id: 100, label: "deep" } },
                  },
                },
              },
            },
          });
          // The grandchild's foreign key is the LOCATED project's id …
          await expect(
            client.task.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([{ id: 100, label: "deep", projectId: 20 }]);
          // … and the target's own scalar write landed on the same row.
          await expect(
            client.project.findUnique({ where: { id: 20 } })
          ).resolves.toMatchObject({ title: "moved" });
          // The decoy — seeded first, lower key, identical title — is untouched.
          await expect(
            client.project.findUnique({ where: { id: 10 } })
          ).resolves.toMatchObject({ title: "same" });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "the non-PK-unique and primary-key spellings persist the same state",
      {
        timeout: 30_000,
      },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedProjects(client);
          await update("workspace", depthSeamSchema.workspace, {
            where: { id: 1 },
            data: {
              projects: {
                update: {
                  where: { id: 10 },
                  data: {
                    title: "pinned",
                    tasks: { create: { id: 101, label: "x" } },
                  },
                },
              },
            },
          });
          await update("workspace", depthSeamSchema.workspace, {
            where: { id: 2 },
            data: {
              projects: {
                update: {
                  where: { code: "P-TARGET" },
                  data: {
                    title: "pinned",
                    tasks: { create: { id: 102, label: "x" } },
                  },
                },
              },
            },
          });
          await expect(
            client.task.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 101, label: "x", projectId: 10 },
            { id: 102, label: "x", projectId: 20 },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "a non-PK unique naming a target of ANOTHER parent aborts with nothing written",
      {
        timeout: 30_000,
      },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedProjects(client);
          // `P-DECOY` is a real, unique row — but it belongs to workspace 1. The
          // correlated probe finds no row, so the operation aborts BEFORE any write.
          await expect(
            update("workspace", depthSeamSchema.workspace, {
              where: { id: 2 },
              data: {
                projects: {
                  update: {
                    where: { code: "P-DECOY" },
                    data: {
                      title: "stolen",
                      tasks: { create: { id: 103, label: "x" } },
                    },
                  },
                },
              },
            })
          ).rejects.toThrow(TARGET_NOT_FOUND);
          await expect(client.task.findMany({})).resolves.toEqual([]);
          await expect(
            client.project.findUnique({ where: { id: 10 } })
          ).resolves.toMatchObject({ title: "same" });
        } finally {
          await dispose();
        }
      }
    );

    // -----------------------------------------------------------------------
    // N4-U1 — child-held to-many `upsert` (RelationUpsertPart)
    // -----------------------------------------------------------------------

    test(
      "an upsert named by a non-PK unique folds its UPDATE arm's deeper create onto the found row",
      {
        timeout: 30_000,
      },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedProjects(client);
          await update("workspace", depthSeamSchema.workspace, {
            where: { id: 2 },
            data: {
              projects: {
                upsert: {
                  where: { code: "P-TARGET" },
                  create: {
                    id: 30,
                    code: "P-TARGET",
                    title: "fresh",
                  },
                  update: {
                    title: "adopted",
                    tasks: { create: { id: 110, label: "deep-upsert" } },
                  },
                },
              },
            },
          });
          await expect(
            client.task.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 110, label: "deep-upsert", projectId: 20 },
          ]);
          await expect(
            client.project.findUnique({ where: { id: 20 } })
          ).resolves.toMatchObject({ title: "adopted" });
          await expect(
            client.project.findUnique({ where: { id: 30 } })
          ).resolves.toBeNull();
        } finally {
          await dispose();
        }
      }
    );

    test(
      "the same upsert takes its CREATE arm when the unique names no row, and its grandchildren follow the fresh key",
      {
        timeout: 30_000,
      },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedProjects(client);
          await update("workspace", depthSeamSchema.workspace, {
            where: { id: 2 },
            data: {
              projects: {
                upsert: {
                  where: { code: "P-ABSENT" },
                  create: {
                    id: 40,
                    code: "P-ABSENT",
                    title: "fresh",
                    tasks: { create: { id: 120, label: "under-create-arm" } },
                  },
                  update: { title: "not-taken" },
                },
              },
            },
          });
          await expect(
            client.project.findUnique({ where: { id: 40 } })
          ).resolves.toMatchObject({ title: "fresh", workspaceId: 2 });
          await expect(
            client.task.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 120, label: "under-create-arm", projectId: 40 },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "an upsert create arm carrying grandchildren under a DATABASE-GENERATED key follows the key its own INSERT produced",
      {
        timeout: 30_000,
      },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedProjects(client);
          // RETARGETED BY N4-U2 (authorized test change). N4-U1 refused this shape
          // because neither the `where` (which names `code`) nor the create data could
          // spell the fresh row's primary key, and the grandchild foreign key had to be
          // a value known at construction. That premise held only while the arm was one
          // hand-rolled INSERT plus a list of deeper writes correlated to a LITERAL. The
          // arm is now a create SUBTREE, and a create root has always handed its
          // grandchildren a database-generated key as a backward `Ref` to its own INSERT
          // — so nothing needs to be known before the statement runs, and the shape
          // executes. The assertion is the identity: the entry's foreign key is the slot
          // id the database generated, not a decoy's and not a guess.
          await update("workspace", depthSeamSchema.workspace, {
            where: { id: 2 },
            data: {
              slots: {
                upsert: {
                  where: { code: "S-NOKEY" },
                  create: {
                    code: "S-NOKEY",
                    title: "fresh",
                    entries: { create: { text: "under-generated-key" } },
                  },
                  update: { title: "not-taken" },
                },
              },
            },
          });
          const slots = await client.slot.findMany({ orderBy: { id: "asc" } });
          expect(slots).toHaveLength(1);
          expect(slots[0]).toMatchObject({
            code: "S-NOKEY",
            title: "fresh",
            workspaceId: 2,
          });
          await expect(
            client.entry.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            {
              id: expect.anything(),
              text: "under-generated-key",
              slotId: slots[0]?.id,
            },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "the SAME upsert runs identically when the create arm SPELLS the key",
      {
        timeout: 30_000,
      },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedProjects(client);
          // The only difference from the arm above: the create data names the key. Both
          // spellings now execute (N4-U2), so the pair pins that the produced-identity
          // path and the spelled-identity path agree on state rather than that one of
          // them is a wall.
          await update("workspace", depthSeamSchema.workspace, {
            where: { id: 2 },
            data: {
              slots: {
                upsert: {
                  where: { code: "S-KEYED" },
                  create: {
                    id: 900,
                    code: "S-KEYED",
                    title: "fresh",
                    entries: { create: { id: 901, text: "kept" } },
                  },
                  update: { title: "not-taken" },
                },
              },
            },
          });
          await expect(
            client.slot.findUnique({ where: { id: 900 } })
          ).resolves.toMatchObject({ title: "fresh", workspaceId: 2 });
          await expect(client.entry.findMany({})).resolves.toEqual([
            { id: 901, text: "kept", slotId: 900 },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    // -----------------------------------------------------------------------
    // N4-U1 — many-to-many (RelationJunctionPart)
    // -----------------------------------------------------------------------

    test(
      "a junction update named by a non-PK unique carries its deeper create",
      {
        timeout: 30_000,
      },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedAlbum(client);
          await update("album", depthSeamSchema.album, {
            where: { id: 1 },
            data: {
              photos: {
                update: {
                  where: { slug: "target" },
                  data: {
                    caption: "edited",
                    marks: { create: { id: 200, text: "deep-m2m" } },
                  },
                },
              },
            },
          });
          await expect(
            client.mark.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([{ id: 200, text: "deep-m2m", photoId: 20 }]);
          await expect(
            client.photo.findUnique({ where: { id: 20 } })
          ).resolves.toMatchObject({ caption: "edited" });
          await expect(
            client.photo.findUnique({ where: { id: 10 } })
          ).resolves.toMatchObject({ caption: "c" });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "a junction update whose non-PK unique names a NON-member aborts with nothing written",
      {
        timeout: 30_000,
      },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedAlbum(client);
          await expect(
            update("album", depthSeamSchema.album, {
              where: { id: 1 },
              data: {
                photos: {
                  update: {
                    where: { slug: "decoy" },
                    data: {
                      caption: "stolen",
                      marks: { create: { id: 201, text: "x" } },
                    },
                  },
                },
              },
            })
          ).rejects.toThrow(TARGET_NOT_FOUND);
          await expect(client.mark.findMany({})).resolves.toEqual([]);
          await expect(
            client.photo.findUnique({ where: { id: 10 } })
          ).resolves.toMatchObject({ caption: "c" });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "a junction UPSERT arm named by a non-PK unique is still a typed refusal, before any write",
      {
        timeout: 30_000,
      },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedAlbum(client);
          // The surviving wall, kept honest: an upsert's update arm can also be reached
          // by the created-earlier branch, whose global probe ran BEFORE this operation's
          // own INSERT and therefore located nothing. There is no row for a `planned`
          // source to read, so the refusal names the missing primary key — and it fires
          // at CONSTRUCTION, so nothing executes at all.
          expect(() =>
            update("album", depthSeamSchema.album, {
              where: { id: 1 },
              data: {
                photos: {
                  upsert: {
                    where: { slug: "target" },
                    create: { id: 20, slug: "target", caption: "c" },
                    update: {
                      caption: "edited",
                      marks: { create: { id: 202, text: "x" } },
                    },
                  },
                },
              },
            })
          ).toThrow(MUST_LOCATE_BY_PK);
          await expect(client.mark.findMany({})).resolves.toEqual([]);
          await expect(
            client.photo.findUnique({ where: { id: 20 } })
          ).resolves.toMatchObject({ caption: "c" });
        } finally {
          await dispose();
        }
      }
    );

    // -----------------------------------------------------------------------
    // N4-U3 — createMany under a planned parent-held target
    // -----------------------------------------------------------------------

    test(
      "a createMany under a parent-held target files its rows against the LOCATED owner",
      {
        timeout: 30_000,
      },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedOwners(client);
          await update("ticket", depthSeamSchema.ticket, {
            where: { id: 5 },
            data: {
              owner: {
                update: {
                  name: "renamed",
                  notes: {
                    createMany: {
                      data: [
                        { id: 71, body: "a" },
                        { id: 72, body: "b" },
                      ],
                    },
                  },
                },
              },
            },
          });
          await expect(
            client.note.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 71, body: "a", ownerId: 2 },
            { id: 72, body: "b", ownerId: 2 },
          ]);
          // The decoy owner — seeded first, lower key — adopted nothing.
          await expect(
            client.note.findMany({ where: { ownerId: 1 } })
          ).resolves.toEqual([]);
          await expect(
            client.owner.findUnique({ where: { id: 2 } })
          ).resolves.toMatchObject({ name: "renamed" });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "the same createMany with an empty data array writes nothing and does not fail",
      {
        timeout: 30_000,
      },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedOwners(client);
          await update("ticket", depthSeamSchema.ticket, {
            where: { id: 5 },
            data: {
              owner: {
                update: {
                  name: "renamed",
                  notes: { createMany: { data: [] } },
                },
              },
            },
          });
          await expect(client.note.findMany({})).resolves.toEqual([]);
          await expect(
            client.owner.findUnique({ where: { id: 2 } })
          ).resolves.toMatchObject({ name: "renamed" });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "the same createMany WITHOUT skipDuplicates fails closed on a duplicate",
      {
        timeout: 30_000,
      },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedOwners(client);
          await client.note.create({
            data: { id: 71, body: "existing", ownerId: 1 },
          });
          await expect(
            update("ticket", depthSeamSchema.ticket, {
              where: { id: 5 },
              data: {
                owner: {
                  update: {
                    name: "renamed",
                    notes: {
                      createMany: {
                        data: [
                          { id: 71, body: "a" },
                          { id: 72, body: "b" },
                        ],
                      },
                    },
                  },
                },
              },
            })
          ).rejects.toThrow();
          // Fail closed: the pre-existing row keeps its owner, and neither new row landed.
          await expect(
            client.note.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([{ id: 71, body: "existing", ownerId: 1 }]);
          await expect(
            client.owner.findUnique({ where: { id: 2 } })
          ).resolves.toMatchObject({ name: "target" });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "the same createMany with skipDuplicates leaves the existing row untouched",
      {
        timeout: 30_000,
      },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedOwners(client);
          await client.note.create({
            data: { id: 71, body: "existing", ownerId: 1 },
          });
          const run = () =>
            update("ticket", depthSeamSchema.ticket, {
              where: { id: 5 },
              data: {
                owner: {
                  update: {
                    name: "renamed",
                    notes: {
                      createMany: {
                        skipDuplicates: true,
                        data: [
                          { id: 71, body: "a" },
                          { id: 72, body: "b" },
                        ],
                      },
                    },
                  },
                },
              },
            });
          if (options.skipDuplicatesInBatchIsInexpressible) {
            // The savepoint the skip needs has no lowering into one atomic batch: a
            // typed refusal with NOTHING written, never a silent success.
            await expect(run()).rejects.toThrow(NO_BATCH_SKIP_LOWERING);
            await expect(
              client.note.findMany({ orderBy: { id: "asc" } })
            ).resolves.toEqual([{ id: 71, body: "existing", ownerId: 1 }]);
            return;
          }
          await run();
          await expect(
            client.note.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 71, body: "existing", ownerId: 1 },
            { id: 72, body: "b", ownerId: 2 },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    // -----------------------------------------------------------------------
    // N6-U1 (D-N1) — the EXTENDED nested target selector, past Prisma.
    //
    // A nested `update` / `upsert` / `delete` target may now be named by
    // `{ <unique>, ...ordinary filters }`, the shape W4 gave the ROOT and
    // deliberately withheld here. Prisma's nested selectors are unique-only in
    // these three positions, so this is the superset row of the capability matrix.
    //
    // The two halves keep the roles `where-unique-builder` assigns them: the
    // DISCRIMINATOR is the only half anything compile-time reads (the located PK
    // every deeper write spends, `racePin` attribution), and the FILTER half can
    // only NARROW which row is addressed. Each shape below is therefore witnessed
    // TWICE — once with a filter that KEEPS the row the bare unique names, once
    // with one that EXCLUDES it — because only the pair separates "the filter was
    // honoured" from "the filter was dropped". That distinction is not academic:
    // when the selectors were first widened, `RelationWritePart` compiled its
    // locate from the discriminator alone, and the excluding case renamed and
    // deleted the very rows it had excluded. A dropped predicate is the WRONG ROW,
    // not a refusal, so the exclusion arm asserts BOTH the family's typed abort
    // and the untouched state.
    //
    // The decoy bed is the one N4-U1 seeded: the decoy holds the LOWER primary key
    // and the SAME filtered value as its target, so a filter that "matches" cannot
    // be passing by accidentally selecting the decoy instead.
    // -----------------------------------------------------------------------

    test(
      "N6-U1 to-many update: a MATCHING filter is transparent, deeper create included",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedProjects(client);
          // `title: "same"` is true of the target AND of the decoy, so the filter
          // narrows nothing on its own — the discriminator still names the row.
          await update("workspace", depthSeamSchema.workspace, {
            where: { id: 2 },
            data: {
              projects: {
                update: {
                  where: { code: "P-TARGET", title: "same" },
                  data: {
                    title: "moved",
                    tasks: { create: { id: 110, label: "deep" } },
                  },
                },
              },
            },
          });
          // Identical to the bare-unique spelling: the deeper FK is the LOCATED id.
          await expect(
            client.task.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([{ id: 110, label: "deep", projectId: 20 }]);
          await expect(
            client.project.findUnique({ where: { id: 20 } })
          ).resolves.toMatchObject({ title: "moved" });
          await expect(
            client.project.findUnique({ where: { id: 10 } })
          ).resolves.toMatchObject({ title: "same" });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "N6-U1 to-many update: an EXCLUDING filter aborts with nothing written",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedProjects(client);
          // The discriminator names project 20; the filter demands a title it does
          // not carry. The two halves intersect nothing, so the locate misses and
          // the family's not-found aborts the whole tree.
          await expect(
            update("workspace", depthSeamSchema.workspace, {
              where: { id: 2 },
              data: {
                projects: {
                  update: {
                    where: { code: "P-TARGET", title: "not-the-title" },
                    data: {
                      title: "must-not-land",
                      tasks: { create: { id: 111, label: "x" } },
                    },
                  },
                },
              },
            })
          ).rejects.toThrow(TARGET_NOT_FOUND);
          // The row the DISCRIMINATOR alone would have named kept its title, and no
          // grandchild was filed. This is the assertion the first cut of the
          // absorption failed: it renamed project 20 to "must-not-land".
          await expect(
            client.project.findUnique({ where: { id: 20 } })
          ).resolves.toMatchObject({ title: "same" });
          await expect(client.task.findMany({})).resolves.toEqual([]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "N6-U1 to-many delete: the filter decides whether the row dies",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedProjects(client);
          // EXCLUDING first, on the same seeded state: the row survives.
          await expect(
            update("workspace", depthSeamSchema.workspace, {
              where: { id: 2 },
              data: {
                projects: {
                  delete: { code: "P-TARGET", title: "not-the-title" },
                },
              },
            })
          ).rejects.toThrow(DELETE_TARGET_NOT_FOUND);
          await expect(
            client.project.findUnique({ where: { id: 20 } })
          ).resolves.toMatchObject({ title: "same" });
          // MATCHING: the same selector with a true filter deletes it, so the
          // survival above is the filter's doing and not an inert `delete`.
          await update("workspace", depthSeamSchema.workspace, {
            where: { id: 2 },
            data: {
              projects: { delete: { code: "P-TARGET", title: "same" } },
            },
          });
          await expect(
            client.project.findUnique({ where: { id: 20 } })
          ).resolves.toBeNull();
          // The decoy — same title, lower key, another parent — is still there.
          await expect(
            client.project.findUnique({ where: { id: 10 } })
          ).resolves.toMatchObject({ title: "same" });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "N6-U1 to-many upsert: an EXCLUDING filter takes the CREATE arm",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedProjects(client);
          // The discriminator matches a LIVE row that the filter excludes, so the
          // probe finds nothing and the create arm runs — the nested analogue of
          // the root behaviour W4 pinned. The created row is a different one, and
          // the excluded row must be left exactly as it was.
          await update("workspace", depthSeamSchema.workspace, {
            where: { id: 2 },
            data: {
              projects: {
                upsert: {
                  where: { code: "P-TARGET", title: "not-the-title" },
                  create: { id: 30, code: "P-FRESH", title: "fresh" },
                  update: { title: "must-not-land" },
                },
              },
            },
          });
          await expect(
            client.project.findUnique({ where: { id: 30 } })
          ).resolves.toMatchObject({ code: "P-FRESH", title: "fresh" });
          await expect(
            client.project.findUnique({ where: { id: 20 } })
          ).resolves.toMatchObject({ title: "same" });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "N6-U1 to-many upsert: a MATCHING filter takes the UPDATE arm",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedProjects(client);
          // The falsification of the create-arm witness above: addressing by an
          // extended selector must not turn every nested upsert into a create.
          await update("workspace", depthSeamSchema.workspace, {
            where: { id: 2 },
            data: {
              projects: {
                upsert: {
                  where: { code: "P-TARGET", title: "same" },
                  create: { id: 30, code: "P-FRESH", title: "fresh" },
                  update: { title: "updated" },
                },
              },
            },
          });
          await expect(
            client.project.findUnique({ where: { id: 20 } })
          ).resolves.toMatchObject({ title: "updated" });
          await expect(
            client.project.findUnique({ where: { id: 30 } })
          ).resolves.toBeNull();
        } finally {
          await dispose();
        }
      }
    );

    test(
      "N6-U1 junction update: the filter reaches the membership read",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedAlbum(client);
          // EXCLUDING: photo 20 IS a member and the slug names it, but the caption
          // filter does not hold, so the membership read returns nothing.
          await expect(
            update("album", depthSeamSchema.album, {
              where: { id: 1 },
              data: {
                photos: {
                  update: {
                    where: { slug: "target", caption: "not-the-caption" },
                    data: {
                      caption: "must-not-land",
                      marks: { create: { id: 210, text: "x" } },
                    },
                  },
                },
              },
            })
          ).rejects.toThrow(TARGET_NOT_FOUND);
          await expect(
            client.photo.findUnique({ where: { id: 20 } })
          ).resolves.toMatchObject({ caption: "c" });
          await expect(client.mark.findMany({})).resolves.toEqual([]);
          // MATCHING: the deeper create lands on the located member.
          await update("album", depthSeamSchema.album, {
            where: { id: 1 },
            data: {
              photos: {
                update: {
                  where: { slug: "target", caption: "c" },
                  data: {
                    caption: "edited",
                    marks: { create: { id: 211, text: "deep-m2m" } },
                  },
                },
              },
            },
          });
          await expect(
            client.mark.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([{ id: 211, text: "deep-m2m", photoId: 20 }]);
          // The decoy shares the caption the filter names and is NOT a member — it
          // must not have been adopted by the filter half.
          await expect(
            client.photo.findUnique({ where: { id: 10 } })
          ).resolves.toMatchObject({ caption: "c" });
        } finally {
          await dispose();
        }
      }
    );

    // The FOURTH seam. The three above each live in a Part; this one does not.
    //
    // When a nested target's data carries a PARENT-HELD to-one edge, the target holds
    // the foreign key its deeper write produces, so the edge folds into the target's OWN
    // update SET — something no child-Part can express. `targetNeedsFullUpdate`
    // (`nested-target-parts.ts`) therefore hands the WHOLE target update to
    // `UpdateOperation` in its X1c `nestedTarget` mode, and that op assembles its own
    // locate conjuncts (`nestedTargetWhereFilters`) for BOTH its locate and its batch
    // presence guard. It is a seam for exactly the same reason the other three are, and
    // it was widened by N6-U1 for exactly the same reason — but every arm above routes
    // through a Part (scalar data, or a CHILD-held to-many create), so none of them can
    // enter this branch at all. Measured: reverting this one function to the
    // discriminator-only assembly left the entire V2 suite green.
    //
    // `ticket.owner` is the only parent-held to-one in this schema, so the pair below is
    // `owner.tickets.update` whose data updates that owner — and the grandchild `notes`
    // create makes the damage visible on a third table: with the filter half dropped, an
    // EXCLUDED ticket is renamed, its owner is renamed, and a note is filed under it.
    test(
      "N6-U1 delegated target: an EXCLUDING filter aborts the parent-held deeper write",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedOwners(client);
          await expect(
            update("owner", depthSeamSchema.owner, {
              where: { id: 2 },
              data: {
                tickets: {
                  update: {
                    where: { id: 5, subject: "not-the-subject" },
                    data: {
                      subject: "must-not-land",
                      owner: {
                        update: {
                          name: "renamed",
                          notes: { create: { id: 81, body: "deep" } },
                        },
                      },
                    },
                  },
                },
              },
            })
          ).rejects.toThrow(TICKET_TARGET_NOT_FOUND);
          // Three independent state witnesses, one per write the dropped predicate
          // would have let through: the target's own scalar, the parent-held to-one's
          // SET-folded update, and the grandchild under it.
          await expect(
            client.ticket.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 4, subject: "s", ownerId: 1 },
            { id: 5, subject: "s", ownerId: 2 },
          ]);
          await expect(
            client.owner.findUnique({ where: { id: 2 } })
          ).resolves.toMatchObject({ name: "target" });
          await expect(client.note.findMany({})).resolves.toEqual([]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "N6-U1 delegated target: a MATCHING filter carries the parent-held deeper write",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedOwners(client);
          // The falsification of the arm above: the abort there is the FILTER's doing
          // and not an inert delegation. `subject: "s"` is true of the target AND of the
          // decoy ticket, so the filter narrows nothing on its own.
          await update("owner", depthSeamSchema.owner, {
            where: { id: 2 },
            data: {
              tickets: {
                update: {
                  where: { id: 5, subject: "s" },
                  data: {
                    subject: "edited",
                    owner: {
                      update: {
                        name: "renamed",
                        notes: { create: { id: 81, body: "deep" } },
                      },
                    },
                  },
                },
              },
            },
          });
          await expect(
            client.ticket.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 4, subject: "s", ownerId: 1 },
            { id: 5, subject: "edited", ownerId: 2 },
          ]);
          // The note's foreign key is the LOCATED owner, never the decoy.
          await expect(
            client.note.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([{ id: 81, body: "deep", ownerId: 2 }]);
          await expect(
            client.owner.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 1, name: "decoy" },
            { id: 2, name: "renamed" },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "N6-U1: the filter half NEVER names the row — an OR decoy pins nothing",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedProjects(client);
          // The discriminating shape, ported from W4's root witness. An `OR` whose
          // branches disagree is the one filter that can hold while naming ANOTHER
          // live row's key: `code = 'P-TARGET' AND (id = 10 OR id = 20)` locates
          // project 20 in both orderings, with the decoy's id sitting in the filter
          // half. An implementation that read a pin out of that half would file the
          // grandchild under project 10 — a live, insertable foreign key, so the
          // wrong parent would be SILENT rather than an error. Both branch
          // orderings run: no positional filter-as-pin survives one of them.
          await update("workspace", depthSeamSchema.workspace, {
            where: { id: 2 },
            data: {
              projects: {
                update: {
                  where: { code: "P-TARGET", OR: [{ id: 10 }, { id: 20 }] },
                  data: {
                    tasks: { create: { id: 120, label: "decoy first" } },
                  },
                },
              },
            },
          });
          await update("workspace", depthSeamSchema.workspace, {
            where: { id: 2 },
            data: {
              projects: {
                update: {
                  where: { code: "P-TARGET", OR: [{ id: 20 }, { id: 10 }] },
                  data: { tasks: { create: { id: 121, label: "decoy last" } } },
                },
              },
            },
          });
          await expect(
            client.task.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 120, label: "decoy first", projectId: 20 },
            { id: 121, label: "decoy last", projectId: 20 },
          ]);
        } finally {
          await dispose();
        }
      }
    );
  });
}
