import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { UniqueConstraintError } from "@errors";
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
 * N2-U1 — nested `create` on the INVERSE-SIDE to-one, across the whole driver matrix.
 *
 * `user.update({ where, data: { profile: { create: { bio } } } })` is the mainstream
 * Prisma shape, and until this wave it raised
 * `does not support nested 'create' on the inverse-side to-one relation`. Nothing about
 * it was inexpressible: it is the ARITY-1 case of the child-held create the update root
 * already builds — one INSERT whose foreign key is the located parent's referenced
 * column. So it now enters `interpretChildHeldCreate` unchanged, and inherits both
 * provenances N1 gave that leaf: a construction literal when the unique `where` pins the
 * referenced column, the LOCATED-PARENT REF when it does not.
 *
 * THE OCCUPIED SLOT is the one rule the to-many case does not have. Prisma errors when
 * the to-one already holds a related row; viborm produces the same OBSERVABLE — a
 * `UniqueConstraintError` with nothing written — because the 1:1 foreign key ALWAYS
 * carries a UNIQUE constraint. That is not an assumption this fixture makes, it is
 * structural: a 1:1 whose foreign key is not unique cannot be DEFINED (`FK008`, "1:1
 * '<rel>' in '<model>': FK [<col>] must be unique", `schema/validation`), and the DDL
 * serializer adds the constraint if a schema ever reaches it without one. So there is no
 * pre-check SELECT here — it would be a second guard on the one invariant, AND a racy
 * one: two concurrent creates would both read an empty slot and leave the constraint to
 * decide anyway.
 *
 * These are fixed-expectation behaviors run on every driver class and both substrates.
 * The traffic-level evidence — that the occupied-slot conflict is NOT re-run as a race,
 * and that the two spellings compile to the same plan — lives in
 * `inverse-to-one-create.test.ts`, which can see the statements.
 */
export const inverseToOneCreateSchema = (() => {
  const account = s
    .model({
      // Explicit primary keys so a witness can name the row it expects, and so the
      // decoy can hold the LOWER key (any "first row" fallback lands on it).
      id: s.int().id(),
      email: s.string().unique(),
      // A second unique that is NEITHER the primary key NOR the discriminator the
      // witnesses locate by: `badge.accountCode` references it, so the D4 shape needs a
      // value only the located row carries.
      code: s.string().unique(),
      label: s.string(),
      profile: s.oneToOne(() => profile).optional(),
      badge: s.oneToOne(() => badge).optional(),
    })
    .map("n2_ito_accounts");
  const profile = s
    .model({
      id: s.int().id(),
      bio: s.string(),
      // `.unique()` is not decoration and not optional: `FK008` refuses to DEFINE a 1:1
      // whose foreign key is not unique. It is the occupied-slot guard.
      accountId: s.int().unique().nullable(),
      account: s
        .oneToOne(() => account)
        .fields("accountId")
        .references("id")
        .optional(),
      // The depth witness: a created inverse-to-one child carrying its own nested writes.
      tags: s.oneToMany(() => profileTag),
    })
    .map("n2_ito_profiles");
  const profileTag = s
    .model({
      id: s.int().id(),
      name: s.string(),
      profileId: s.int(),
      profile: s
        .manyToOne(() => profile)
        .fields("profileId")
        .references("id"),
    })
    .map("n2_ito_profile_tags");
  // The D4 shape at to-one arity: the foreign key references `account.code`, which no
  // `where: { email }` and no primary key carries.
  const badge = s
    .model({
      id: s.int().id(),
      kind: s.string(),
      accountCode: s.string().unique().nullable(),
      account: s
        .oneToOne(() => account)
        .fields("accountCode")
        .references("code")
        .optional(),
    })
    .map("n2_ito_badges");
  return { account, profile, profileTag, badge };
})();

hydrateSchemaNames(inverseToOneCreateSchema);

/**
 * The operations run through the OPERATION, not the routed client — the same seam every
 * other update-family behavior suite uses. A batch-only, non-returning driver (MySQL
 * forced into atomic-batch mode) refuses every single-row mutation at the client seam
 * ("public result parsing cannot be rolled back"), which would make the whole batch leg
 * vacuous while looking green.
 */
function makeRunner(driver: AnyDriver) {
  const schemas = createSchemaRegistry(inverseToOneCreateSchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(inverseToOneCreateSchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  return (args: Record<string, unknown>): Promise<unknown> =>
    executor.execute(
      new UpdateOperation(
        engine,
        inverseToOneCreateSchema.account as unknown as Model<any>,
        args
      ),
      createOperationExecutionContext(
        "account",
        "update",
        engine.instrumentation
      )
    );
}

function makeStateClient(driver: AnyDriver) {
  return createClient({ schema: inverseToOneCreateSchema, driver });
}
type StateClient = ReturnType<typeof makeStateClient>;

/**
 * Two accounts whose only distinguishing scalars are the two discriminators. The decoy
 * is seeded FIRST and holds the LOWER primary key, so a re-consulted `where`, a "first
 * row" fallback, or a scan lands on it — and every assertion names the id.
 */
async function seedAccounts(client: StateClient): Promise<void> {
  await client.account.create({
    data: { id: 1, email: "decoy@x", code: "DECOY", label: "same" },
  });
  await client.account.create({
    data: { id: 2, email: "target@x", code: "TARGET", label: "same" },
  });
}

export function runInverseToOneCreateBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  readonly createStateDriver?: () => AnyDriver;
}): void {
  describe(`${options.name} inverse to-one create (N2)`, () => {
    const setup = async () => {
      const driver = options.createDriver();
      const stateDriver = options.createStateDriver?.() ?? driver;
      const client = makeStateClient(stateDriver);
      const update = makeRunner(driver);
      await push(client, { force: true });
      const dispose = async () => {
        await client.$disconnect();
        if (driver !== stateDriver) await driver.disconnect();
      };
      return { client, update, dispose };
    };

    test(
      "the mainstream shape executes: a nested create on the inverse-side to-one",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedAccounts(client);
          // The pinned spelling (`where` names the referenced column) and the Ref
          // spelling (it does not) on two disjoint accounts. Same shape in, same shape
          // out: a profile whose accountId is its own account's id.
          await update({
            where: { id: 1 },
            data: { profile: { create: { id: 11, bio: "pinned" } } },
          });
          await update({
            where: { email: "target@x" },
            data: { profile: { create: { id: 12, bio: "reffed" } } },
          });
          await expect(
            client.profile.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 11, bio: "pinned", accountId: 1 },
            { id: 12, bio: "reffed", accountId: 2 },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "the created child carries the LOCATED row's key, not the decoy's",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedAccounts(client);
          await update({
            where: { email: "target@x" },
            data: { profile: { create: { id: 20, bio: "wrong-row witness" } } },
          });
          await expect(
            client.profile.findUnique({ where: { id: 20 } })
          ).resolves.toEqual({
            id: 20,
            bio: "wrong-row witness",
            accountId: 2,
          });
          // The decoy — seeded first, lower primary key, identical `label` — adopted
          // nothing.
          await expect(
            client.profile.findMany({ where: { accountId: 1 } })
          ).resolves.toEqual([]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "a referenced column that is neither the primary key nor the discriminator is threaded from the located row",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedAccounts(client);
          // `badge.accountCode -> account.code`: the `where` pins `email`, the primary
          // key is `id`, and the foreign key needs `code`.
          await update({
            where: { email: "target@x" },
            data: { badge: { create: { id: 30, kind: "d4" } } },
          });
          await expect(
            client.badge.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([{ id: 30, kind: "d4", accountCode: "TARGET" }]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "the created child carries its own nested writes one level deeper",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedAccounts(client);
          await update({
            where: { email: "target@x" },
            data: {
              profile: {
                create: {
                  id: 40,
                  bio: "deep",
                  tags: {
                    create: [
                      { id: 401, name: "alpha" },
                      { id: 402, name: "beta" },
                    ],
                  },
                },
              },
            },
          });
          await expect(
            client.profile.findUnique({ where: { id: 40 } })
          ).resolves.toEqual({ id: 40, bio: "deep", accountId: 2 });
          await expect(
            client.profileTag.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 401, name: "alpha", profileId: 40 },
            { id: 402, name: "beta", profileId: 40 },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    // ---- the occupied slot -------------------------------------------------
    // Prisma's documented behavior when the to-one already holds a related row is an
    // error. Both provenances are asserted, because the failure must come from the
    // CONSTRAINT (identical either way) and not from anything the pinned path happens
    // to know that the Ref path does not.

    for (const spelling of [
      { name: "pinned", where: { id: 2 } as Record<string, unknown> },
      {
        name: "Ref",
        where: { email: "target@x" } as Record<string, unknown>,
      },
    ]) {
      test(
        `an occupied slot makes the create fail with UniqueConstraintError and changes nothing (${spelling.name} parent)`,
        { timeout: 30_000 },
        async () => {
          const { client, update, dispose } = await setup();
          try {
            await seedAccounts(client);
            await update({
              where: { id: 2 },
              data: { profile: { create: { id: 50, bio: "first" } } },
            });
            await expect(
              update({
                where: spelling.where,
                // The root also writes a scalar, so "nothing written" is provable for
                // the WHOLE atomic unit, not merely for the child INSERT.
                data: {
                  label: "changed",
                  profile: { create: { id: 51, bio: "second" } },
                },
              })
            ).rejects.toBeInstanceOf(UniqueConstraintError);
            // Exactly one profile, the first one, untouched.
            await expect(
              client.profile.findMany({ orderBy: { id: "asc" } })
            ).resolves.toEqual([{ id: 50, bio: "first", accountId: 2 }]);
            // And the root's own scalar write rolled back with it.
            await expect(
              client.account.findUnique({ where: { id: 2 } })
            ).resolves.toEqual({
              id: 2,
              email: "target@x",
              code: "TARGET",
              label: "same",
            });
          } finally {
            await dispose();
          }
        }
      );
    }

    test(
      "a create under a where that matches no row aborts before writing the child",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedAccounts(client);
          await expect(
            update({
              where: { email: "absent@x" },
              data: { profile: { create: { id: 60, bio: "orphan" } } },
            })
          ).rejects.toThrow();
          await expect(client.profile.findMany({})).resolves.toEqual([]);
        } finally {
          await dispose();
        }
      }
    );
  });
}
