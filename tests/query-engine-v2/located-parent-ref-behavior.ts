import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { hydrateSchemaNames, s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * N1-U1 — the located-parent Ref, across the whole driver matrix.
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
 * (never by re-consulting the `where`; W4's wrong-row lesson is doctrine here).
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
  return { account, note, attachment, ticket };
})();

hydrateSchemaNames(locatedParentRefSchema);

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

export function runLocatedParentRefBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  readonly createStateDriver?: () => AnyDriver;
}): void {
  describe(`${options.name} located-parent Ref (N1-U1)`, () => {
    const setup = async () => {
      const driver = options.createDriver();
      const stateDriver = options.createStateDriver?.() ?? driver;
      const client = makeRefClient(stateDriver);
      const opClient = driver === stateDriver ? client : makeRefClient(driver);
      await push(client, { force: true });
      const dispose = async () => {
        await client.$disconnect();
        if (driver !== stateDriver) await driver.disconnect();
      };
      return { client, opClient, dispose };
    };

    test(
      "the non-PK-unique spelling persists what the primary-key spelling persists",
      { timeout: 30_000 },
      async () => {
        const { client, opClient, dispose } = await setup();
        try {
          await seedAccounts(client);
          // The pinned spelling (the referenced column IS the discriminator) and the
          // Ref spelling (it is not) on two disjoint accounts. Same shape in, same
          // shape out: a note whose accountId is its own account's id.
          await opClient.account.update({
            where: { id: 1 },
            data: { notes: { create: { id: 11, body: "pinned" } } },
          });
          await opClient.account.update({
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
        const { client, opClient, dispose } = await setup();
        try {
          await seedAccounts(client);
          await opClient.account.update({
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
        const { client, opClient, dispose } = await setup();
        try {
          await seedAccounts(client);
          // `ticket.accountCode -> account.code`: the `where` pins `email`, the primary
          // key is `id`, and the foreign key needs `code`. Only the located row has it.
          await opClient.account.update({
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
        const { client, opClient, dispose } = await setup();
        try {
          await seedAccounts(client);
          await opClient.account.update({
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
        const { client, opClient, dispose } = await setup();
        try {
          await seedAccounts(client);
          // X1b: the fresh note is a create SUBTREE (it carries its own `attachments`),
          // delegated to the create root whose `rootFkInject` is the compile-resolved
          // located-parent value.
          await opClient.account.update({
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
        const { client, opClient, dispose } = await setup();
        try {
          await seedAccounts(client);
          await opClient.account.update({
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

    test(
      "a `where` that matches no row aborts before any child insert",
      { timeout: 30_000 },
      async () => {
        const { client, opClient, dispose } = await setup();
        try {
          await seedAccounts(client);
          await expect(
            opClient.account.update({
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
