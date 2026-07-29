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
import { UnsupportedOperationError } from "../../src/query-engine-v2/shared";
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
 * These are fixed-expectation behaviors run on every driver class and both
 * substrates. Each absorbed shape is paired with a WRONG-ROW probe: a decoy row,
 * seeded FIRST and holding the LOWER primary key, that any "take the first row" or
 * "re-read the where" implementation would land on — and the assertions name the id,
 * not just the count. The two walls that remain are asserted too, in the same file
 * and on the same substrates, so neither can quietly change disposition.
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

  // A to-many whose key the DATABASE generates, reachable by a non-PK unique: the
  // one shape N4-U1's upsert CREATE arm cannot serve, because a fresh row's generated
  // key is not knowable before its INSERT runs.
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
/** The surviving N4-U1 wall's wording. */
const MUST_LOCATE_BY_PK = /must locate the target by its primary key/;

/**
 * The operations run through the OPERATION, not the routed client: a batch-only,
 * non-returning driver refuses every single-row mutation at the client seam ("public
 * result parsing cannot be rolled back"), which would make the whole batch leg
 * vacuous. The same seam `located-parent-ref-behavior.ts` uses, for the same reason.
 */
function makeSeamRunner(driver: AnyDriver) {
  const schemas = createSchemaRegistry(depthSeamSchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(depthSeamSchema, schemas)
  );
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

function makeSeamClient(driver: AnyDriver) {
  return createClient({ schema: depthSeamSchema, driver });
}
type SeamClient = ReturnType<typeof makeSeamClient>;

/**
 * Two projects with the SAME title in two different workspaces. The decoy is seeded
 * FIRST and holds the LOWER primary key, so an implementation that re-consults the
 * `where`, takes "the first row", or falls back to a scan attaches the grandchild to
 * it — and every assertion names the project id, not just a row count.
 */
async function seedProjects(client: SeamClient): Promise<void> {
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
 *  second. Any planned read that resolved to the wrong row files the notes on owner 1. */
async function seedOwners(client: SeamClient): Promise<void> {
  await client.owner.create({ data: { id: 1, name: "decoy" } });
  await client.owner.create({ data: { id: 2, name: "target" } });
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

    test("a nested update named by a non-PK unique carries its deeper create", {
      timeout: 30_000,
    }, async () => {
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
    });

    test("the non-PK-unique and primary-key spellings persist the same state", {
      timeout: 30_000,
    }, async () => {
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
    });

    test("a non-PK unique naming a target of ANOTHER parent aborts with nothing written", {
      timeout: 30_000,
    }, async () => {
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
    });

    // -----------------------------------------------------------------------
    // N4-U1 — child-held to-many `upsert` (RelationUpsertPart)
    // -----------------------------------------------------------------------

    test("an upsert named by a non-PK unique folds its UPDATE arm's deeper create onto the found row", {
      timeout: 30_000,
    }, async () => {
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
        ).resolves.toEqual([{ id: 110, label: "deep-upsert", projectId: 20 }]);
        await expect(
          client.project.findUnique({ where: { id: 20 } })
        ).resolves.toMatchObject({ title: "adopted" });
        await expect(
          client.project.findUnique({ where: { id: 30 } })
        ).resolves.toBeNull();
      } finally {
        await dispose();
      }
    });

    test("the same upsert takes its CREATE arm when the unique names no row, and its grandchildren follow the fresh key", {
      timeout: 30_000,
    }, async () => {
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
    });

    test("an upsert create arm carrying grandchildren under a DATABASE-GENERATED key is a typed refusal, before any write", {
      timeout: 30_000,
    }, async () => {
      const { client, update, dispose } = await setup();
      try {
        await seedProjects(client);
        // `slot.id` is generated and the `where` names `code`, so NEITHER source can
        // supply the fresh row's primary key before its INSERT runs. The grandchild's
        // foreign key therefore has no value — a construction-time refusal, not a
        // guess: it throws before the operation is even built, so nothing executes.
        expect(() =>
          update("workspace", depthSeamSchema.workspace, {
            where: { id: 2 },
            data: {
              slots: {
                upsert: {
                  where: { code: "S-NOKEY" },
                  create: {
                    code: "S-NOKEY",
                    title: "fresh",
                    entries: { create: { text: "orphan" } },
                  },
                  update: { title: "not-taken" },
                },
              },
            },
          })
        ).toThrow(UnsupportedOperationError);
        await expect(client.slot.findMany({})).resolves.toEqual([]);
        await expect(client.entry.findMany({})).resolves.toEqual([]);
      } finally {
        await dispose();
      }
    });

    test("the SAME generated-key upsert runs once the create arm spells the key", {
      timeout: 30_000,
    }, async () => {
      const { client, update, dispose } = await setup();
      try {
        await seedProjects(client);
        // The only difference from the refusal above: the create data names the key.
        // That is the whole content of the wall — an absent value, not a shape V2
        // declines to execute.
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
    });

    // -----------------------------------------------------------------------
    // N4-U1 — many-to-many (RelationJunctionPart)
    // -----------------------------------------------------------------------

    test("a junction update named by a non-PK unique carries its deeper create", {
      timeout: 30_000,
    }, async () => {
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
    });

    test("a junction update whose non-PK unique names a NON-member aborts with nothing written", {
      timeout: 30_000,
    }, async () => {
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
    });

    test("a junction UPSERT arm named by a non-PK unique is still a typed refusal, before any write", {
      timeout: 30_000,
    }, async () => {
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
    });

    // -----------------------------------------------------------------------
    // N4-U3 — createMany under a planned parent-held target
    // -----------------------------------------------------------------------

    test("a createMany under a parent-held target files its rows against the LOCATED owner", {
      timeout: 30_000,
    }, async () => {
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
    });

    test("the same createMany with an empty data array writes nothing and does not fail", {
      timeout: 30_000,
    }, async () => {
      const { client, update, dispose } = await setup();
      try {
        await seedOwners(client);
        await update("ticket", depthSeamSchema.ticket, {
          where: { id: 5 },
          data: {
            owner: {
              update: { name: "renamed", notes: { createMany: { data: [] } } },
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
    });

    test("the same createMany WITHOUT skipDuplicates fails closed on a duplicate", {
      timeout: 30_000,
    }, async () => {
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
    });

    test("the same createMany with skipDuplicates leaves the existing row untouched", {
      timeout: 30_000,
    }, async () => {
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
    });
  });
}
