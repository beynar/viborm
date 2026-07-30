import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { CreateOperation } from "../../src/query-engine-v2/CreateOperation";
import { OperationExecutor } from "../../src/query-engine-v2/OperationExecutor";
import { UpdateOperation } from "../../src/query-engine-v2/UpdateOperation";

/**
 * N4-U2 + N4-U4 — the PRODUCED identity, across the whole driver matrix.
 *
 * Both units answer one question the earlier waves never had to: what does a nested
 * write spend for an identity when there is no row to locate, because the row it is
 * about to write does not exist yet? N1/N4-U1 answered "the row the locate step ACTED
 * ON". Here there is no locate step, and the answer is the other half of the same
 * doctrine — **the row the step PRODUCED**, read from the INSERT that produced it.
 *
 *  · **N4-U2 — the adopt family's create arm one level deeper.** A nested
 *    `upsert`/`connectOrCreate` whose probe finds nothing INSERTs a fresh row. That is
 *    what a `create` ROOT builds, so the whole arm is a create SUBTREE: it owns the
 *    arm's INSERT, its own identity (a spelled primary key, or one the database
 *    generates and its grandchildren `Ref`), and every relation below it at any depth —
 *    m2m through the junction, a before-parent to-one `create`, `createMany`, the
 *    globally-adopting family. Before this it owned one statement and refused all but a
 *    single deeper `connect`.
 *
 *  · **N4-U4 — the shared-primary-key edge under a create root.** A record whose
 *    primary key IS its foreign key gets that key from the edge. When the edge is a
 *    parent-held `create` whose target key the DATABASE generates, the key exists only
 *    once that before-parent INSERT runs — so the record's identity, and the terminal
 *    read that addresses the created row, ride the same backward `Ref` its own foreign
 *    key already did.
 *
 *  · **N4-U4 — the wider fresh-record identity.** A child edge referencing a
 *    NON-primary-key unique of a fresh record (the D4 shape on a create root) reads the
 *    value that unique is about to hold, from the same create data the primary key came
 *    from.
 *
 * Every shape runs end-to-end on every driver class and both substrates, and every
 * assertion names the ROW, not just a count: the beds seed a decoy first, holding the
 * LOWER primary key, so an implementation that took "the first row" or re-consulted the
 * payload's selector lands on it visibly.
 */
export const producedIdentitySchema = (() => {
  // --- N4-U2: an adopt arm whose fresh row carries every deeper kind ---
  const org = s
    .model({
      id: s.int().id(),
      slug: s.string().unique(),
      teams: s.oneToMany(() => team),
      // A to-many whose key the DATABASE generates: the arm's identity is produced,
      // never spelled, and its grandchildren must follow it.
      squads: s.oneToMany(() => squad).name("squads"),
    })
    .map("n4pi_orgs");
  const team = s
    .model({
      // Explicit key: the arm's identity is spelled, so the spelled and produced
      // spellings can be compared on state.
      id: s.int().id(),
      // A unique that is NEITHER the primary key NOR the parent discriminator.
      code: s.string().unique(),
      title: s.string(),
      orgId: s.int(),
      org: s
        .manyToOne(() => org)
        .fields("orgId")
        .references("id"),
      // Child-held to-many one level deeper (create / createMany / connect / adopt).
      tasks: s.oneToMany(() => task),
      // Many-to-many one level deeper — the junction under a FRESH parent.
      labels: s.manyToMany(() => label),
      // Parent-held to-one one level deeper — a BEFORE-parent write folded into the
      // arm's own INSERT, which is the fold no child Part can perform.
      leadId: s.int().nullable(),
      lead: s
        .manyToOne(() => lead)
        .fields("leadId")
        .references("id")
        .optional(),
    })
    .map("n4pi_teams");
  const task = s
    .model({
      id: s.int().id(),
      label: s.string(),
      teamId: s.int(),
      team: s
        .manyToOne(() => team)
        .fields("teamId")
        .references("id"),
    })
    .map("n4pi_tasks");
  const label = s
    .model({
      id: s.int().id(),
      name: s.string().unique(),
      teams: s.manyToMany(() => team),
    })
    .map("n4pi_labels");
  const lead = s
    .model({
      id: s.int().id(),
      name: s.string(),
      teams: s.oneToMany(() => team),
    })
    .map("n4pi_leads");
  const squad = s
    .model({
      id: s.int().id().increment(),
      code: s.string().unique(),
      title: s.string(),
      orgId: s.int(),
      org: s
        .manyToOne(() => org)
        .fields("orgId")
        .references("id")
        .name("squads"),
      drills: s.oneToMany(() => drill),
    })
    .map("n4pi_squads");
  const drill = s
    .model({
      id: s.int().id().increment(),
      text: s.string(),
      squadId: s.int(),
      squad: s
        .manyToOne(() => squad)
        .fields("squadId")
        .references("id"),
    })
    .map("n4pi_drills");

  // --- N4-U4: the shared-primary-key edge (the child's PK IS its FK) ---
  const account = s
    .model({
      id: s.int().id().increment(),
      email: s.string().unique(),
      // A NON-primary-key unique a child edge can reference (the D4 shape).
      handle: s.string().unique(),
      name: s.string(),
      profile: s.oneToOne(() => profile).optional(),
      badges: s.oneToMany(() => badge),
    })
    .map("n4pi_accounts");
  const profile = s
    .model({
      // Shared primary key: `accountId` is this row's identity AND its foreign key.
      accountId: s.int().id(),
      bio: s.string(),
      account: s
        .oneToOne(() => account)
        .fields("accountId")
        .references("id"),
    })
    .map("n4pi_profiles");
  const badge = s
    .model({
      id: s.int().id(),
      kind: s.string(),
      // References `account.handle` — a unique that is not the account's primary key.
      accountHandle: s.string(),
      account: s
        .manyToOne(() => account)
        .fields("accountHandle")
        .references("handle")
        .name("badges"),
    })
    .map("n4pi_badges");

  return {
    org,
    team,
    task,
    label,
    lead,
    squad,
    drill,
    account,
    profile,
    badge,
  };
})();

hydrateSchemaNames(producedIdentitySchema);

/** The surviving update-arm boundary's wording (an m2m edge correlated to a LOCATED
 *  row, which needs a builder `RelationUpsertPart` cannot import without a cycle). */
const M2M_ONE_LEVEL_DEEPER = /many-to-many create one level deeper/;

/**
 * The operations run through the OPERATION, not the routed client: a batch-only,
 * non-returning driver refuses every single-row mutation at the client seam ("public
 * result parsing cannot be rolled back"), which would make the whole batch leg vacuous.
 * The seam `depth-seam-behavior.ts` and `located-parent-ref-behavior.ts` use, for the
 * same reason.
 */
function makeRunner(driver: AnyDriver) {
  const schemas = createSchemaRegistry(producedIdentitySchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(producedIdentitySchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  return {
    update: (
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
      ),
    create: (
      modelName: string,
      model: Model<any>,
      args: Record<string, unknown>
    ): Promise<unknown> =>
      executor.execute(
        new CreateOperation(engine, model, args),
        createOperationExecutionContext(
          modelName,
          "create",
          engine.instrumentation
        )
      ),
  };
}

function makeStateClient(driver: AnyDriver) {
  return createClient({ schema: producedIdentitySchema, driver });
}
type StateClient = ReturnType<typeof makeStateClient>;

/**
 * The N4-U2 bed. Two orgs and a DECOY team seeded first, holding the LOWER primary key
 * and sharing the target's title, so any write that lands on "the first row" is visible
 * in the assertions by id. `lead` 7 and `label` 1 pre-exist so the deeper adopt family
 * has something global to adopt.
 */
async function seedOrgs(client: StateClient): Promise<void> {
  await client.org.create({ data: { id: 1, slug: "decoy-org" } });
  await client.org.create({ data: { id: 2, slug: "target-org" } });
  await client.team.create({
    data: { id: 10, code: "T-DECOY", title: "same", orgId: 1 },
  });
  await client.lead.create({ data: { id: 7, name: "existing-lead" } });
  await client.label.create({ data: { id: 1, name: "existing-label" } });
}

export function runProducedIdentityBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  readonly createStateDriver?: () => AnyDriver;
}): void {
  describe(`${options.name} produced identity at depth (N4-U2 / N4-U4)`, () => {
    const setup = async () => {
      const driver = options.createDriver();
      const stateDriver = options.createStateDriver?.() ?? driver;
      const client = makeStateClient(stateDriver);
      const run = makeRunner(driver);
      await push(client, { force: true });
      const dispose = async () => {
        await client.$disconnect();
        if (driver !== stateDriver) await driver.disconnect();
      };
      return { client, ...run, dispose };
    };

    // -------------------------------------------------------------------------
    // N4-U2 — the create arm one level deeper
    // -------------------------------------------------------------------------

    test(
      "an upsert CREATE arm folds every deeper kind onto the row it produced",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedOrgs(client);
          await client.task.create({
            data: { id: 500, label: "adoptable", teamId: 10 },
          });
          await update("org", producedIdentitySchema.org, {
            where: { id: 2 },
            data: {
              teams: {
                upsert: {
                  // No such code, so the CREATE arm is taken.
                  where: { code: "T-FRESH" },
                  create: {
                    id: 20,
                    code: "T-FRESH",
                    title: "same",
                    // child-held single create
                    tasks: { create: { id: 100, label: "deep-create" } },
                    // many-to-many through the junction, under a FRESH parent
                    labels: { connect: [{ id: 1 }] },
                    // parent-held to-one: a BEFORE-parent INSERT whose id folds into
                    // this arm's own INSERT — the fold no child Part can do
                    lead: { create: { id: 8, name: "fresh-lead" } },
                  },
                  update: { title: "not-taken" },
                },
              },
            },
          });
          await expect(
            client.team.findUnique({ where: { id: 20 } })
          ).resolves.toMatchObject({
            code: "T-FRESH",
            orgId: 2,
            leadId: 8,
          });
          await expect(
            client.task.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 100, label: "deep-create", teamId: 20 },
            { id: 500, label: "adoptable", teamId: 10 },
          ]);
          // The junction row exists and names the produced team, not the decoy.
          await expect(
            client.label.findUnique({
              where: { id: 1 },
              include: { teams: true },
            })
          ).resolves.toMatchObject({
            teams: [{ id: 20 }],
          });
          // The decoy is untouched.
          await expect(
            client.team.findUnique({ where: { id: 10 } })
          ).resolves.toMatchObject({ title: "same", leadId: null });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "a connectOrCreate CREATE arm folds the same depth, and its FOUND arm runs none of it",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedOrgs(client);
          // Absent → CREATE arm: the deeper writes run.
          await update("org", producedIdentitySchema.org, {
            where: { id: 2 },
            data: {
              teams: {
                connectOrCreate: {
                  where: { code: "T-COC" },
                  create: {
                    id: 30,
                    code: "T-COC",
                    title: "coc",
                    tasks: {
                      createMany: { data: [{ id: 110, label: "bulk" }] },
                    },
                  },
                },
              },
            },
          });
          await expect(
            client.task.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([{ id: 110, label: "bulk", teamId: 30 }]);

          // Present → FOUND arm: a pure reparent. The create arm's grandchildren must
          // NOT run — nested writes in a create payload describe a row this call did
          // not create. Asserted, not assumed: the same payload against the EXISTING
          // decoy team leaves the grandchild table exactly as it was.
          await update("org", producedIdentitySchema.org, {
            where: { id: 2 },
            data: {
              teams: {
                connectOrCreate: {
                  where: { code: "T-DECOY" },
                  create: {
                    id: 10,
                    code: "T-DECOY",
                    title: "same",
                    tasks: { create: { id: 999, label: "must-not-exist" } },
                    lead: { create: { id: 9, name: "must-not-exist" } },
                  },
                },
              },
            },
          });
          await expect(
            client.task.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([{ id: 110, label: "bulk", teamId: 30 }]);
          await expect(
            client.lead.findMany({ where: { id: 9 } })
          ).resolves.toEqual([]);
          // The found arm did what it is for: the decoy was reparented.
          await expect(
            client.team.findUnique({ where: { id: 10 } })
          ).resolves.toMatchObject({ orgId: 2 });
        } finally {
          await dispose();
        }
      }
    );

    test(
      "the create arm's grandchildren follow a DATABASE-GENERATED key, and the decoy keeps its own",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedOrgs(client);
          // A decoy squad, seeded FIRST so it holds the lower generated key. A
          // grandchild written against "the first row" or against a re-read of the
          // selector would attach here.
          await client.squad.create({
            data: { code: "S-DECOY", title: "decoy", orgId: 1 },
          });
          await update("org", producedIdentitySchema.org, {
            where: { id: 2 },
            data: {
              squads: {
                upsert: {
                  where: { code: "S-FRESH" },
                  create: {
                    code: "S-FRESH",
                    title: "fresh",
                    drills: { create: { text: "under-generated-key" } },
                  },
                  update: { title: "not-taken" },
                },
              },
            },
          });
          const squads = await client.squad.findMany({
            orderBy: { id: "asc" },
          });
          expect(squads.map((row) => row.code)).toEqual(["S-DECOY", "S-FRESH"]);
          const fresh = squads[1];
          const drills = await client.drill.findMany({
            orderBy: { id: "asc" },
          });
          expect(drills).toHaveLength(1);
          expect(drills[0]).toMatchObject({
            text: "under-generated-key",
            squadId: fresh?.id,
          });
          // The identity really is the produced one, not the decoy's.
          expect(drills[0]?.squadId).not.toBe(squads[0]?.id);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "an upsert CREATE arm whose create data names a DIFFERENT key than the where writes that key, and its grandchildren follow it",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedOrgs(client);
          // The `where` names `code: 'T-A'`; the create data names `code: 'T-B'` and
          // `id: 40`. Nothing below correlates through the selector any more, so the
          // row the arm INSERTs is the row its own data describes.
          await update("org", producedIdentitySchema.org, {
            where: { id: 2 },
            data: {
              teams: {
                upsert: {
                  where: { code: "T-A" },
                  create: {
                    id: 40,
                    code: "T-B",
                    title: "divergent",
                    tasks: {
                      create: { id: 130, label: "follows-create-data" },
                    },
                  },
                  update: { title: "not-taken" },
                },
              },
            },
          });
          await expect(
            client.team.findUnique({ where: { id: 40 } })
          ).resolves.toMatchObject({ code: "T-B", orgId: 2 });
          await expect(
            client.task.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 130, label: "follows-create-data", teamId: 40 },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "the UPDATE arm one level deeper still refuses an m2m edge, with nothing written",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedOrgs(client);
          // The surviving boundary, on the same relation as the absorbed create arm:
          // the update arm's target is LOCATED, and a junction correlated to a located
          // row needs a builder `RelationUpsertPart` cannot import without a cycle.
          // A CONSTRUCTION-time decline: it throws before the operation exists, so
          // nothing was planned, let alone written.
          expect(() =>
            update("org", producedIdentitySchema.org, {
              where: { id: 1 },
              data: {
                teams: {
                  upsert: {
                    where: { code: "T-DECOY" },
                    create: { id: 50, code: "T-DECOY", title: "x" },
                    update: { labels: { create: { id: 2, name: "nope" } } },
                  },
                },
              },
            })
          ).toThrow(M2M_ONE_LEVEL_DEEPER);
          await expect(
            client.label.findMany({ where: { id: 2 } })
          ).resolves.toEqual([]);
        } finally {
          await dispose();
        }
      }
    );

    // -------------------------------------------------------------------------
    // N4-U4 — the shared-primary-key edge, and the wider fresh identity
    // -------------------------------------------------------------------------

    test(
      "a shared-primary-key child create takes the id its parent's INSERT generated",
      { timeout: 30_000 },
      async () => {
        const { client, create, dispose } = await setup();
        try {
          // A decoy account seeded FIRST, so it holds the LOWER generated id: a profile
          // keyed off "the first row" would attach to it.
          await client.account.create({
            data: { email: "decoy@x", handle: "decoy", name: "decoy" },
          });
          const result = await create(
            "profile",
            producedIdentitySchema.profile,
            {
              data: {
                bio: "produced",
                account: {
                  create: {
                    email: "target@x",
                    handle: "target",
                    name: "target",
                  },
                },
              },
            }
          );
          const accounts = await client.account.findMany({
            orderBy: { id: "asc" },
          });
          expect(accounts.map((row) => row.handle)).toEqual([
            "decoy",
            "target",
          ]);
          const target = accounts[1];
          // The terminal read addressed the created row through the same produced value
          // its own foreign key rode — so the operation could RETURN it at all.
          expect(result).toMatchObject({
            accountId: target?.id,
            bio: "produced",
          });
          await expect(
            client.profile.findMany({ orderBy: { accountId: "asc" } })
          ).resolves.toEqual([{ accountId: target?.id, bio: "produced" }]);
          expect(target?.id).not.toBe(accounts[0]?.id);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "the same shared-primary-key shape with an EXPLICIT parent key persists the same row",
      { timeout: 30_000 },
      async () => {
        const { client, create, dispose } = await setup();
        try {
          // The parent key is spelled, so the identity is a construction literal — the
          // pre-N4-U4 path, byte-identical. The pair pins that the two provenances
          // agree on state rather than that one of them is a wall.
          const result = await create(
            "profile",
            producedIdentitySchema.profile,
            {
              data: {
                bio: "spelled",
                account: {
                  create: {
                    id: 900,
                    email: "spelled@x",
                    handle: "spelled",
                    name: "spelled",
                  },
                },
              },
            }
          );
          expect(result).toMatchObject({ accountId: 900, bio: "spelled" });
          await expect(client.profile.findMany({})).resolves.toEqual([
            { accountId: 900, bio: "spelled" },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "a child edge referencing a NON-primary-key unique of the fresh parent reads the value that row is about to hold",
      { timeout: 30_000 },
      async () => {
        const { client, create, dispose } = await setup();
        try {
          // A decoy account whose handle differs: the badge's foreign key is a HANDLE,
          // so a resolver that fell back to the parent's primary key (or to the decoy)
          // would either fail the constraint or point at the wrong row.
          await client.account.create({
            data: { email: "d@x", handle: "d-handle", name: "d" },
          });
          const result = await create(
            "account",
            producedIdentitySchema.account,
            {
              data: {
                email: "wide@x",
                handle: "wide-handle",
                name: "wide",
                badges: { create: { id: 1, kind: "gold" } },
              },
            }
          );
          expect(result).toMatchObject({ handle: "wide-handle" });
          await expect(
            client.badge.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 1, kind: "gold", accountHandle: "wide-handle" },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "an after-parent adopt whose referenced field is a NON-primary-key unique reparents onto that value",
      { timeout: 30_000 },
      async () => {
        const { client, create, dispose } = await setup();
        try {
          await client.account.create({
            data: { email: "old@x", handle: "old-handle", name: "old" },
          });
          await client.badge.create({
            data: { id: 5, kind: "silver", accountHandle: "old-handle" },
          });
          await create("account", producedIdentitySchema.account, {
            data: {
              email: "new@x",
              handle: "new-handle",
              name: "new",
              badges: { connect: { id: 5 } },
            },
          });
          await expect(
            client.badge.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 5, kind: "silver", accountHandle: "new-handle" },
          ]);
        } finally {
          await dispose();
        }
      }
    );
  });
}
