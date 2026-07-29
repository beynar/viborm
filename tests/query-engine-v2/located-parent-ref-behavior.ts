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
 * N1 — the located-parent Ref, across the whole driver matrix.
 *
 * Before N1 a child-held nested `create`/`createMany` under `update` demanded that the
 * parent column its foreign key references be a COMPILE-TIME LITERAL: pinned by the
 * unique `where`, or rewritten by the root SET. `update({ where: { email }, data: {
 * posts: { create } } })` therefore refused while `update({ where: { id }, … })` worked
 * — the same operation, spelled by a different unique.
 *
 * The value was never unknowable: the update ALREADY locates the row. N1 threads it
 * through the mechanism the engine already owns — the locate read selects the referenced
 * column, and the create leaf resolves its foreign key from THE ROW THE LOCATE ACTED ON
 * (never by re-consulting the `where`; W4's wrong-row lesson is doctrine here). U2 adds no
 * mechanism: a compound foreign key is per-field (ATOM §1), so every member resolves by
 * name from that SAME row.
 *
 * These are fixed-expectation behaviors run on every driver class and both substrates.
 * The plan-shape evidence — that the two spellings compile to the SAME statements, not
 * merely to the same final state — lives in `located-parent-ref.test.ts`, which can see
 * the driver traffic.
 */
export const locatedParentRefSchema = (() => {
  const account = s
    .model({
      // An explicit primary key so the witnesses can choose ids that DISTINGUISH the
      // located row from its decoy (a generated key would make "wrong row" unprovable).
      id: s.int().id(),
      email: s.string().unique(),
      // A second unique that is NEITHER the primary key NOR the usual discriminator:
      // `ticket.accountCode` references it, so a nested ticket create needs a value
      // that no `where: { email }` and no primary key carries.
      code: s.string().unique(),
      label: s.string(),
      notes: s.oneToMany(() => note),
      tickets: s.oneToMany(() => ticket),
    })
    .map("n1_ref_accounts");
  const note = s
    .model({
      id: s.int().id(),
      body: s.string(),
      accountId: s.int(),
      account: s
        .manyToOne(() => account)
        .fields("accountId")
        .references("id"),
      attachments: s.oneToMany(() => attachment),
    })
    .map("n1_ref_notes");
  const attachment = s
    .model({
      id: s.int().id(),
      name: s.string(),
      noteId: s.int(),
      note: s
        .manyToOne(() => note)
        .fields("noteId")
        .references("id"),
    })
    .map("n1_ref_attachments");
  const ticket = s
    .model({
      id: s.int().id(),
      subject: s.string(),
      accountCode: s.string(),
      account: s
        .manyToOne(() => account)
        .fields("accountCode")
        .references("code"),
    })
    .map("n1_ref_tickets");
  // N1-U2 — a COMPOUND primary key, plus a `handle` unique that names NEITHER member.
  // Two owners sharing `tenantId` and differing only in `slot` are the correctness pin:
  // a per-field resolution that dropped a member would attach the memo to the wrong one.
  const owner = s
    .model({
      tenantId: s.string(),
      slot: s.string(),
      handle: s.string().unique(),
      memos: s.oneToMany(() => memo),
    })
    .id(["tenantId", "slot"])
    .map("n1_ref_owners");
  const memo = s
    .model({
      id: s.int().id(),
      text: s.string(),
      ownerTenant: s.string(),
      ownerSlot: s.string(),
      owner: s
        .manyToOne(() => owner)
        .fields("ownerTenant", "ownerSlot")
        .references("tenantId", "slot"),
    })
    .map("n1_ref_memos");
  // N1-U2 — a COMPOUND NON-PK referenced unique (the D4 shape at compound arity): the
  // contract's foreign key names `[region, code]`, which is neither the vendor's primary
  // key nor any `where` discriminator the witnesses use.
  const vendor = s
    .model({
      id: s.int().id(),
      region: s.string(),
      code: s.string(),
      name: s.string(),
      contracts: s.oneToMany(() => contract),
    })
    .unique(["region", "code"])
    .map("n1_ref_vendors");
  const contract = s
    .model({
      id: s.int().id(),
      title: s.string(),
      vendorRegion: s.string(),
      vendorCode: s.string(),
      vendor: s
        .manyToOne(() => vendor)
        .fields("vendorRegion", "vendorCode")
        .references("region", "code"),
    })
    .map("n1_ref_contracts");
  return { account, note, attachment, ticket, owner, memo, vendor, contract };
})();

hydrateSchemaNames(locatedParentRefSchema);

/** The executor's typed refusal for a savepoint skip inside a single atomic batch. */
const NO_BATCH_SKIP_LOWERING = /no atomic-batch lowering/;

/**
 * The operations run through the OPERATION, not the routed client. A batch-only,
 * non-returning driver (MySQL forced into atomic-batch mode) refuses every single-row
 * mutation at the client seam — "public result parsing cannot be rolled back" — which
 * would make the whole batch leg vacuous. The same seam every other update-family
 * behavior suite uses, for the same reason.
 */
function makeRefRunner(driver: AnyDriver) {
  const schemas = createSchemaRegistry(locatedParentRefSchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(locatedParentRefSchema, schemas)
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

function makeRefClient(driver: AnyDriver) {
  return createClient({ schema: locatedParentRefSchema, driver });
}
type RefClient = ReturnType<typeof makeRefClient>;

/**
 * Two accounts whose ONLY distinguishing scalar is the discriminator each witness
 * locates by. `decoy` is seeded FIRST and holds the LOWER primary key, so any
 * implementation that re-consults the `where`, takes "the first row", or falls back to
 * a scan lands on it — and the assertions name the id, not just the row count.
 */
async function seedAccounts(client: RefClient): Promise<void> {
  await client.account.create({
    data: { id: 1, email: "decoy@x", code: "DECOY", label: "same" },
  });
  await client.account.create({
    data: { id: 2, email: "target@x", code: "TARGET", label: "same" },
  });
}

/**
 * Two owners sharing `tenantId` and differing only in `slot`: the compound pin. A
 * per-field resolution that dropped `slot` — or read it from a different row —
 * would attach the memo to `t1/a`, which the witnesses assert stays empty.
 */
async function seedOwners(client: RefClient): Promise<void> {
  await client.owner.create({
    data: { tenantId: "t1", slot: "a", handle: "h-t1-a" },
  });
  await client.owner.create({
    data: { tenantId: "t1", slot: "b", handle: "h-t1-b" },
  });
}

/** Two vendors sharing `region`, so only the full `[region, code]` tuple names one. */
async function seedVendors(client: RefClient): Promise<void> {
  await client.vendor.create({
    data: { id: 1, region: "eu", code: "DECOY", name: "decoy" },
  });
  await client.vendor.create({
    data: { id: 2, region: "eu", code: "TARGET", name: "target" },
  });
}

export function runLocatedParentRefBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  readonly createStateDriver?: () => AnyDriver;
  /**
   * Declared by the caller, never sniffed: on a dialect whose `skipDuplicates` is NOT a
   * SQL leaf (`recoverableUniqueError` — MySQL), the skip is a savepoint-wrapped executor
   * effect, and a savepoint has no lowering into a single atomic batch. Such a leg must
   * see the typed refusal with NOTHING written, not a silent success. Requiring the leg
   * to say so keeps the assertion falsifiable in both directions: a dialect that CAN
   * express it may not quietly start refusing, and one that cannot may not quietly start
   * succeeding.
   */
  readonly skipDuplicatesInBatchIsInexpressible?: boolean;
}): void {
  describe(`${options.name} located-parent Ref (N1)`, () => {
    const setup = async () => {
      const driver = options.createDriver();
      const stateDriver = options.createStateDriver?.() ?? driver;
      const client = makeRefClient(stateDriver);
      const update = makeRefRunner(driver);
      await push(client, { force: true });
      const dispose = async () => {
        await client.$disconnect();
        if (driver !== stateDriver) await driver.disconnect();
      };
      return { client, update, dispose };
    };

    test(
      "the non-PK-unique spelling persists what the primary-key spelling persists",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedAccounts(client);
          // The pinned spelling (the referenced column IS the discriminator) and the
          // Ref spelling (it is not) on two disjoint accounts. Same shape in, same
          // shape out: a note whose accountId is its own account's id.
          await update("account", locatedParentRefSchema.account, {
            where: { id: 1 },
            data: { notes: { create: { id: 11, body: "pinned" } } },
          });
          await update("account", locatedParentRefSchema.account, {
            where: { email: "target@x" },
            data: { notes: { create: { id: 12, body: "reffed" } } },
          });
          await expect(
            client.note.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 11, body: "pinned", accountId: 1 },
            { id: 12, body: "reffed", accountId: 2 },
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
          await update("account", locatedParentRefSchema.account, {
            where: { email: "target@x" },
            data: { notes: { create: { id: 20, body: "wrong-row witness" } } },
          });
          const note = await client.note.findUnique({ where: { id: 20 } });
          expect(note).toEqual({
            id: 20,
            body: "wrong-row witness",
            accountId: 2,
          });
          // The decoy — seeded first, lower primary key, identical `label` — adopted
          // nothing.
          await expect(
            client.note.findMany({ where: { accountId: 1 } })
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
          // `ticket.accountCode -> account.code`: the `where` pins `email`, the primary
          // key is `id`, and the foreign key needs `code`. Only the located row has it.
          await update("account", locatedParentRefSchema.account, {
            where: { email: "target@x" },
            data: { tickets: { create: { id: 30, subject: "d4" } } },
          });
          await expect(
            client.ticket.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 30, subject: "d4", accountCode: "TARGET" },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "nested createMany rides the same located-parent Ref",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedAccounts(client);
          await update("account", locatedParentRefSchema.account, {
            where: { email: "target@x" },
            data: {
              notes: {
                createMany: {
                  data: [
                    { id: 41, body: "one" },
                    { id: 42, body: "two" },
                    { id: 43, body: "three" },
                  ],
                },
              },
            },
          });
          await expect(
            client.note.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 41, body: "one", accountId: 2 },
            { id: 42, body: "two", accountId: 2 },
            { id: 43, body: "three", accountId: 2 },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "a relation-carrying nested create subtree resolves its root foreign key from the located row",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedAccounts(client);
          // X1b: the fresh note is a create SUBTREE (it carries its own `attachments`),
          // delegated to the create root whose `rootFkInject` is the compile-resolved
          // located-parent value.
          await update("account", locatedParentRefSchema.account, {
            where: { email: "target@x" },
            data: {
              notes: {
                create: {
                  id: 50,
                  body: "subtree",
                  attachments: { create: { id: 60, name: "a.txt" } },
                },
              },
            },
          });
          await expect(
            client.note.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([{ id: 50, body: "subtree", accountId: 2 }]);
          await expect(
            client.attachment.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([{ id: 60, name: "a.txt", noteId: 50 }]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "a scalar SET and a Ref-parented create compose in one update",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedAccounts(client);
          await update("account", locatedParentRefSchema.account, {
            where: { email: "target@x" },
            data: {
              label: "renamed",
              notes: { create: { id: 70, body: "with set" } },
            },
          });
          await expect(
            client.account.findUnique({ where: { id: 2 } })
          ).resolves.toMatchObject({ label: "renamed" });
          await expect(
            client.note.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([{ id: 70, body: "with set", accountId: 2 }]);
          // The decoy's label is untouched — the SET addressed the located row.
          await expect(
            client.account.findUnique({ where: { id: 1 } })
          ).resolves.toMatchObject({ label: "same" });
        } finally {
          await dispose();
        }
      }
    );

    // ------------------------------------------------------------------
    // N1-U2 — COMPOUND referenced keys. A compound foreign key is per-field
    // (ATOM §1's multi-field produces): each column resolves from the SAME
    // located row by name. Nothing new is needed for compound arity — the leaf
    // already loops the foreign-key columns index-aligned with the referenced
    // ones — so what these witness is that every member travels TOGETHER, from
    // one row, and that a sibling sharing one member cannot capture the child.
    // ------------------------------------------------------------------

    test(
      "compound primary-key reference: both members come from the located row",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedOwners(client);
          await update("owner", locatedParentRefSchema.owner, {
            where: { tenantId_slot: { tenantId: "t1", slot: "b" } },
            data: { memos: { create: { id: 10, text: "by compound pk" } } },
          });
          await expect(
            client.memo.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            {
              id: 10,
              text: "by compound pk",
              ownerTenant: "t1",
              ownerSlot: "b",
            },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "compound primary-key reference located by a unique naming NEITHER member",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedOwners(client);
          // `handle` is the discriminator; the foreign key needs `tenantId` AND
          // `slot`, and no literal in the payload holds either. The sibling
          // `t1/a` shares the tenant, so a resolution that carried only the
          // tenant (or dropped the slot) would attach the memo to it.
          await update("owner", locatedParentRefSchema.owner, {
            where: { handle: "h-t1-b" },
            data: {
              memos: {
                createMany: {
                  data: [
                    { id: 20, text: "one" },
                    { id: 21, text: "two" },
                  ],
                },
              },
            },
          });
          await expect(
            client.memo.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 20, text: "one", ownerTenant: "t1", ownerSlot: "b" },
            { id: 21, text: "two", ownerTenant: "t1", ownerSlot: "b" },
          ]);
          await expect(
            client.memo.findMany({ where: { ownerSlot: "a" } })
          ).resolves.toEqual([]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "compound NON-PK referenced unique is threaded per field from the located row",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedVendors(client);
          // `contract.[vendorRegion, vendorCode] -> vendor.[region, code]`: a
          // compound unique that is not the vendor's primary key and not the
          // `where`. The decoy vendor shares `region`.
          await update("vendor", locatedParentRefSchema.vendor, {
            where: { id: 2 },
            data: { contracts: { create: { id: 30, title: "d4 compound" } } },
          });
          await expect(
            client.contract.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            {
              id: 30,
              title: "d4 compound",
              vendorRegion: "eu",
              vendorCode: "TARGET",
            },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "nested createMany skipDuplicates rides the located-parent Ref",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedAccounts(client);
          // The colliding row already belongs to the DECOY, so the skip must drop it
          // (a unique violation on `note.id`) while the survivors attach to the
          // located account — the composed skip leaf, on the planned-parent path.
          await client.note.create({
            data: { id: 91, body: "taken", accountId: 1 },
          });
          const skip = () =>
            update("account", locatedParentRefSchema.account, {
              where: { email: "target@x" },
              data: {
                notes: {
                  createMany: {
                    data: [
                      { id: 90, body: "kept" },
                      { id: 91, body: "dropped" },
                    ],
                    skipDuplicates: true,
                  },
                },
              },
            });
          if (options.skipDuplicatesInBatchIsInexpressible) {
            await expect(skip()).rejects.toThrow(NO_BATCH_SKIP_LOWERING);
            await expect(
              client.note.findMany({ orderBy: { id: "asc" } })
            ).resolves.toEqual([{ id: 91, body: "taken", accountId: 1 }]);
            return;
          }
          await skip();
          await expect(
            client.note.findMany({ orderBy: { id: "asc" } })
          ).resolves.toEqual([
            { id: 90, body: "kept", accountId: 2 },
            { id: 91, body: "taken", accountId: 1 },
          ]);
        } finally {
          await dispose();
        }
      }
    );

    test(
      "a `where` that matches no row aborts before any child insert",
      { timeout: 30_000 },
      async () => {
        const { client, update, dispose } = await setup();
        try {
          await seedAccounts(client);
          await expect(
            update("account", locatedParentRefSchema.account, {
              where: { email: "absent@x" },
              data: { notes: { create: { id: 80, body: "never" } } },
            })
          ).rejects.toThrow();
          await expect(client.note.findMany()).resolves.toEqual([]);
        } finally {
          await dispose();
        }
      }
    );
  });
}
