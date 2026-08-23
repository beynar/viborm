import { NestedWriteError, ValidationError } from "@errors";
import { hydrateSchemaNames, s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * PACKAGE E (§6 E) — **the shared-primary-key edge at an UPDATE root, executed.**
 *
 * `parity-e-shared-pk.test.ts` pins the plans byte for byte; this file runs them and
 * asserts the ROWS. The two questions a structural pin cannot answer are the ones that
 * made this shape refuse for so long:
 *
 *   · does the record end up addressable at the key the fold gave it — i.e. does the
 *     terminal read return the row rather than the create root's recorded defect (a
 *     terminal addressing a key no row holds: the transaction aborts on the read's
 *     postcondition, and the ATOMIC BATCH commits the write and then reports an internal
 *     `QueryEngineError`; see `shared-pk-connect-or-create-behavior.ts`'s header); and
 *   · does a child-held edge on the moved column follow the record, on a real foreign
 *     key, in the order the plan claims — the fresh child INSERT after the root UPDATE,
 *     carrying the POST-transition value.
 *
 * Both are asserted as STATE, on every leg, so a plan that is byte-perfect and wrong
 * still fails here. The refusals are asserted as state too ("nothing was written"),
 * because a refusal that fires after a write is not a refusal.
 */
export const sharedPkUpdateRootSchema = (() => {
  const account = s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      name: s.string(),
      card: s.toOne(() => card),
      stub: s.toOne(() => stub),
    })
    .map("e1u_accounts");
  /** The shared primary key: `accountId` is this row's identity AND its foreign key. */
  const card = s
    .model({
      accountId: s.string().id(),
      label: s.string(),
      account: s
        .toOne(() => account)
        .fields("accountId")
        .references("id")
        .onUpdate("cascade"),
      notes: s.toMany(() => note),
      chits: s.toMany(() => chit),
    })
    .map("e1u_cards");
  /** A CHILD-HELD edge on the shared key: what the fold's transition has to reach. */
  const note = s
    .model({
      id: s.string().id(),
      cardId: s.string(),
      body: s.string(),
      card: s
        .toOne(() => card)
        .fields("cardId")
        .references("accountId"),
    })
    .map("e1u_notes");
  /** The same child-held edge under ON UPDATE CASCADE — the enclosing-record leg below. */
  const chit = s
    .model({
      id: s.string().id(),
      cardId: s.string(),
      body: s.string(),
      card: s
        .toOne(() => card)
        .fields("cardId")
        .references("accountId")
        .onUpdate("cascade"),
    })
    .map("e1u_chits");
  /** The same shared key on an OPTIONAL edge — the only spelling `disconnect` reaches. */
  const stub = s
    .model({
      accountId: s.string().id(),
      memo: s.string(),
      account: s
        .toOne(() => account)
        .fields("accountId")
        .references("id"),
    })
    .map("e1u_stubs");
  const desk = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
      ticket: s.toOne(() => ticket),
    })
    .map("e1u_desks");
  /** A shared key whose final value the TARGET's own INSERT produces (Package F). */
  const ticket = s
    .model({
      deskId: s.int().id(),
      memo: s.string(),
      desk: s
        .toOne(() => desk)
        .fields("deskId")
        .references("id"),
    })
    .map("e1u_tickets");
  const compoundAccount = s
    .model({
      region: s.string(),
      code: s.string(),
      email: s.string().unique(),
      card: s.toOne(() => compoundCard),
    })
    .id(["region", "code"])
    .map("e1u_compound_accounts");
  const compoundCard = s
    .model({
      regionId: s.string(),
      accountCode: s.string(),
      label: s.string(),
      account: s
        .toOne(() => compoundAccount)
        .fields("regionId", "accountCode")
        .references("region", "code"),
    })
    .id(["regionId", "accountCode"])
    .map("e1u_compound_cards");
  const provider = s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      // A to-ONE: `providerAccount.providerId` is unique, and a unique foreign key
      // contradicting a remote collection is FK009. The badge edge below references
      // that same unique, so the uniqueness is the fact that must stay.
      account: s.toOne(() => providerAccount).name("provider"),
    })
    .map("e1u_providers");
  const providerAccount = s
    .model({
      id: s.string().id(),
      providerId: s.string().unique(),
      provider: s
        .toOne(() => provider)
        .fields("providerId")
        .references("id")
        .name("provider"),
      badge: s.toOne(() => providerBadge).name("badge"),
    })
    .map("e1u_provider_accounts");
  const providerBadge = s
    .model({
      accountProviderId: s.string().id(),
      label: s.string(),
      account: s
        .toOne(() => providerAccount)
        .fields("accountProviderId")
        .references("providerId")
        .name("badge")
        .onUpdate("cascade"),
    })
    .map("e1u_provider_badges");
  const partialAccount = s
    .model({
      id: s.string().id(),
      code: s.string(),
      card: s.toOne(() => partialCard),
    })
    .unique(["id", "code"])
    .map("e1u_partial_accounts");
  const partialCard = s
    .model({
      accountId: s.string().id(),
      accountCode: s.string().unique(),
      account: s
        .toOne(() => partialAccount)
        .fields("accountId", "accountCode")
        .references("id", "code")
        .onUpdate("cascade"),
      tokens: s.toMany(() => partialToken),
    })
    .unique(["accountId", "accountCode"])
    .map("e1u_partial_cards");
  const partialToken = s
    .model({
      id: s.string().id(),
      cardCode: s.string(),
      card: s
        .toOne(() => partialCard)
        .fields("cardCode")
        .references("accountCode"),
    })
    .map("e1u_partial_tokens");
  return {
    account,
    card,
    chit,
    compoundAccount,
    compoundCard,
    desk,
    note,
    partialAccount,
    partialCard,
    partialToken,
    provider,
    providerAccount,
    providerBadge,
    stub,
    ticket,
  };
})();

hydrateSchemaNames(sharedPkUpdateRootSchema);

/**
 * `a1` holds the card under test. `decoy` holds a card too, so a write that addressed
 * "some card" answers wrong; `a2` is a free destination and `a3` a second one, so a key
 * re-derived from "some account" answers wrong as well.
 */
async function seed(client: any): Promise<void> {
  await client.chit.deleteMany({});
  await client.note.deleteMany({});
  await client.card.deleteMany({});
  await client.stub.deleteMany({});
  await client.ticket.deleteMany({});
  await client.desk.deleteMany({});
  await client.account.deleteMany({});
  await client.account.createMany({
    data: [
      { id: "a1", email: "a1@x", name: "one" },
      { id: "a2", email: "a2@x", name: "two" },
      { id: "a3", email: "a3@x", name: "three" },
      { id: "decoy", email: "decoy@x", name: "decoy" },
    ],
  });
  await client.card.createMany({
    data: [
      { accountId: "a1", label: "under test" },
      { accountId: "decoy", label: "decoy" },
    ],
  });
}

const cards = async (client: any): Promise<unknown> =>
  await client.card.findMany({
    orderBy: { accountId: "asc" },
    select: { accountId: true, label: true },
  });

export function registerSharedPkUpdateRootBehavior(
  name: string,
  connect: () => Promise<any>,
  register: (label: string, body: () => void) => void = describe,
  options: { readonly includeProducedKey?: boolean } = {}
): void {
  register(`Package E shared-PK update root (${name})`, () => {
    test("create: the record's own key moves to the created target, and the read returns it", async () => {
      const client = await connect();
      await seed(client);

      expect(
        await client.card.update({
          where: { accountId: "a1" },
          data: {
            account: { create: { id: "fresh", email: "f@x", name: "f" } },
          },
          select: { accountId: true, label: true },
        })
      ).toEqual({ accountId: "fresh", label: "under test" });

      expect(await cards(client)).toEqual([
        { accountId: "decoy", label: "decoy" },
        { accountId: "fresh", label: "under test" },
      ]);
      // The vacated account survives the move; only the card's key changed.
      expect(await client.account.count()).toBe(5);
    });

    test("connect: the record's key moves to an existing target", async () => {
      const client = await connect();
      await seed(client);

      expect(
        await client.card.update({
          where: { accountId: "a1" },
          data: { account: { connect: { id: "a2" } } },
          select: { accountId: true },
        })
      ).toEqual({ accountId: "a2" });

      expect(await cards(client)).toEqual([
        { accountId: "a2", label: "under test" },
        { accountId: "decoy", label: "decoy" },
      ]);
      expect(await client.account.count()).toBe(4);
    });

    test("compound shared keys use every member captured by an alternate unique", async () => {
      const client = await connect();
      await client.compoundCard.deleteMany({});
      await client.compoundAccount.deleteMany({});
      await client.compoundAccount.createMany({
        data: [
          { region: "eu", code: "one", email: "one@compound" },
          { region: "us", code: "two", email: "two@compound" },
        ],
      });

      expect(
        await client.compoundCard.create({
          data: {
            label: "created",
            account: { connect: { email: "one@compound" } },
          },
          select: { regionId: true, accountCode: true },
        })
      ).toEqual({ regionId: "eu", accountCode: "one" });

      expect(
        await client.compoundCard.update({
          where: {
            regionId_accountCode: { regionId: "eu", accountCode: "one" },
          },
          data: { account: { connect: { email: "two@compound" } } },
          select: { regionId: true, accountCode: true },
        })
      ).toEqual({ regionId: "us", accountCode: "two" });
    });

    test("connectOrCreate FOUND: the target exists, so only the record's key is written", async () => {
      const client = await connect();
      await seed(client);

      expect(
        await client.card.update({
          where: { accountId: "a1" },
          data: {
            account: {
              connectOrCreate: {
                where: { id: "a3" },
                create: { id: "a3", email: "unused@x", name: "unused" },
              },
            },
          },
          select: { accountId: true },
        })
      ).toEqual({ accountId: "a3" });

      expect(await client.account.count()).toBe(4);
      // The found arm wrote no target: `a3` keeps the name the seed gave it.
      expect(
        await client.account.findUnique({
          where: { id: "a3" },
          select: { name: true },
        })
      ).toEqual({ name: "three" });
    });

    test("connectOrCreate MISSING: the target is created and the record's key follows it", async () => {
      const client = await connect();
      await seed(client);

      expect(
        await client.card.update({
          where: { accountId: "a1" },
          data: {
            account: {
              connectOrCreate: {
                where: { id: "made" },
                create: { id: "made", email: "made@x", name: "made" },
              },
            },
          },
          select: { accountId: true },
        })
      ).toEqual({ accountId: "made" });

      expect(await client.account.count()).toBe(5);
      expect(await cards(client)).toEqual([
        { accountId: "decoy", label: "decoy" },
        { accountId: "made", label: "under test" },
      ]);
    });

    test("upsert FOUND: the arms agree on the key the record holds, so the target is updated in place", async () => {
      const client = await connect();
      await seed(client);

      expect(
        await client.card.update({
          where: { accountId: "a1" },
          data: {
            account: {
              upsert: {
                create: { id: "a1", email: "a1@x", name: "unused" },
                update: { name: "renamed" },
              },
            },
          },
          select: { accountId: true },
        })
      ).toEqual({ accountId: "a1" });

      expect(
        await client.account.findUnique({
          where: { id: "a1" },
          select: { name: true },
        })
      ).toEqual({ name: "renamed" });
      expect(await client.account.count()).toBe(4);
    });

    test("upsert FOUND publishes the target's post-update referenced key", async () => {
      const client = await connect();
      await seed(client);

      expect(
        await client.card.update({
          where: { accountId: "a1" },
          data: {
            account: {
              upsert: {
                create: { id: "unused", email: "unused@x", name: "unused" },
                update: { id: "cascade", name: "moved target" },
              },
            },
            notes: { create: { id: "after", body: "post key" } },
          },
          select: { accountId: true },
        })
      ).toEqual({ accountId: "cascade" });
      expect(
        await client.note.findUnique({
          where: { id: "after" },
          select: { cardId: true },
        })
      ).toEqual({ cardId: "cascade" });
      expect(
        await client.account.findUnique({
          where: { id: "cascade" },
          select: { name: true },
        })
      ).toEqual({ name: "moved target" });
    });

    test("update publishes the target's post-update key before descendant writes", async () => {
      const client = await connect();
      await seed(client);
      await client.chit.create({
        data: { id: "before-update", cardId: "a1", body: "before" },
      });

      expect(
        await client.card.update({
          where: { accountId: "a1" },
          data: {
            account: { update: { id: "cascade" } },
            chits: {
              update: {
                where: { id: "before-update" },
                data: { body: "updated before transition" },
              },
              create: { id: "after-update", body: "after" },
            },
          },
          select: { accountId: true },
        })
      ).toEqual({ accountId: "cascade" });
      expect(
        await client.chit.findUnique({
          where: { id: "after-update" },
          select: { cardId: true },
        })
      ).toEqual({ cardId: "cascade" });
      expect(
        await client.chit.findUnique({
          where: { id: "before-update" },
          select: { cardId: true, body: true },
        })
      ).toEqual({
        cardId: "cascade",
        body: "updated before transition",
      });
    });

    test("an empty target update keeps the captured shared key for descendants", async () => {
      const client = await connect();
      await seed(client);

      expect(
        await client.card.update({
          where: { accountId: "a1" },
          data: {
            account: { update: {} },
            notes: { create: { id: "empty-update", body: "same key" } },
          },
          select: { accountId: true },
        })
      ).toEqual({ accountId: "a1" });
      expect(
        await client.note.findUnique({
          where: { id: "empty-update" },
          select: { cardId: true },
        })
      ).toEqual({ cardId: "a1" });
    });

    test("a partial compound shared edge publishes every transitioned member", async () => {
      const client = await connect();
      await client.partialToken.deleteMany({});
      await client.partialCard.deleteMany({});
      await client.partialAccount.deleteMany({});
      await client.partialAccount.create({ data: { id: "i1", code: "c1" } });
      await client.partialCard.create({
        data: { accountId: "i1", accountCode: "c1" },
      });

      expect(
        await client.partialCard.update({
          where: { accountId: "i1" },
          data: {
            account: { update: { id: "i2", code: "c2" } },
            tokens: { create: { id: "token" } },
          },
          select: { accountId: true, accountCode: true },
        })
      ).toEqual({ accountId: "i2", accountCode: "c2" });
      expect(
        await client.partialToken.findUnique({
          where: { id: "token" },
          select: { cardCode: true },
        })
      ).toEqual({ cardCode: "c2" });
    });

    test("fresh create publishes the complete selected compound tuple", async () => {
      const client = await connect();
      await client.partialToken.deleteMany({});
      await client.partialCard.deleteMany({});
      await client.partialAccount.deleteMany({});
      await client.partialAccount.create({ data: { id: "i1", code: "c1" } });

      expect(
        await client.partialCard.create({
          data: {
            account: {
              connect: { id_code: { id: "i1", code: "c1" } },
            },
            tokens: { create: { id: "fresh-token" } },
          },
          select: { accountId: true, accountCode: true },
        })
      ).toEqual({ accountId: "i1", accountCode: "c1" });
      expect(
        await client.partialToken.findUnique({
          where: { id: "fresh-token" },
          select: { cardCode: true },
        })
      ).toEqual({ cardCode: "c1" });
    });

    test("upsert FOUND publishes a relation-folded non-primary referenced field", async () => {
      const client = await connect();
      await client.providerBadge.deleteMany({});
      await client.providerAccount.deleteMany({});
      await client.provider.deleteMany({});
      await client.provider.createMany({
        data: [
          { id: "p1", email: "p1@provider" },
          { id: "p2", email: "p2@provider" },
        ],
      });
      await client.providerAccount.create({
        data: { id: "account", providerId: "p1" },
      });
      await client.providerBadge.create({
        data: { accountProviderId: "p1", label: "badge" },
      });

      expect(
        await client.providerBadge.update({
          where: { accountProviderId: "p1" },
          data: {
            account: {
              upsert: {
                create: { id: "unused", providerId: "p1" },
                update: {
                  provider: { connect: { email: "p2@provider" } },
                },
              },
            },
          },
          select: { accountProviderId: true },
        })
      ).toEqual({ accountProviderId: "p2" });
      expect(
        await client.providerAccount.findUnique({
          where: { id: "account" },
          select: { providerId: true },
        })
      ).toEqual({ providerId: "p2" });
    });

    test("update publishes a nested relation-folded non-primary referenced field", async () => {
      const client = await connect();
      await client.providerBadge.deleteMany({});
      await client.providerAccount.deleteMany({});
      await client.provider.deleteMany({});
      await client.provider.createMany({
        data: [
          { id: "p1", email: "p1@provider" },
          { id: "p2", email: "p2@provider" },
        ],
      });
      await client.providerAccount.create({
        data: { id: "account", providerId: "p1" },
      });
      await client.providerBadge.create({
        data: { accountProviderId: "p1", label: "badge" },
      });

      expect(
        await client.providerBadge.update({
          where: { accountProviderId: "p1" },
          data: {
            account: {
              update: {
                provider: { connect: { email: "p2@provider" } },
              },
            },
          },
          select: { accountProviderId: true },
        })
      ).toEqual({ accountProviderId: "p2" });
      expect(
        await client.providerAccount.findUnique({
          where: { id: "account" },
          select: { providerId: true },
        })
      ).toEqual({ providerId: "p2" });
    });

    test("a child-held sibling on the shared key follows the fold, written after the root UPDATE", async () => {
      const client = await connect();
      await seed(client);

      expect(
        await client.card.update({
          where: { accountId: "a1" },
          data: {
            account: { create: { id: "moved", email: "m@x", name: "m" } },
            notes: { create: { id: "n1", body: "fresh" } },
          },
          select: { accountId: true },
        })
      ).toEqual({ accountId: "moved" });

      // The note carries the POST-transition key. A fresh child written BEFORE the root
      // UPDATE would have carried `a1` and violated the foreign key instead.
      expect(
        await client.note.findMany({ select: { id: true, cardId: true } })
      ).toEqual([{ id: "n1", cardId: "moved" }]);
    });

    test("an OCCUPIED old slot refuses the fold, and nothing is written", async () => {
      const client = await connect();
      await seed(client);
      await client.note.create({
        data: { id: "old", cardId: "a1", body: "incumbent" },
      });

      const rejection = await client.card
        .update({
          where: { accountId: "a1" },
          data: {
            account: { create: { id: "moved", email: "m@x", name: "m" } },
            notes: { create: { id: "n1", body: "fresh" } },
          },
        })
        .then(
          () => undefined,
          (error: unknown) => error
        );

      expect(rejection).toBeInstanceOf(NestedWriteError);
      expect((rejection as Error).message).toBe(
        "Cannot update relation 'notes' with onUpdate('restrict') while the current relation is occupied."
      );
      // The record kept its key, the target was never created, and the incumbent stayed.
      expect(await cards(client)).toEqual([
        { accountId: "a1", label: "under test" },
        { accountId: "decoy", label: "decoy" },
      ]);
      expect(await client.account.count()).toBe(4);
      expect(
        await client.note.findMany({ select: { id: true, cardId: true } })
      ).toEqual([{ id: "old", cardId: "a1" }]);
    });

    if (options.includeProducedKey !== false)
      test("a PRODUCED shared key: the record ends at the id the target's INSERT generated", async () => {
        const client = await connect();
        await seed(client);
        const first = await client.desk.create({
          data: { title: "first" },
          select: { id: true },
        });
        await client.ticket.create({
          data: { deskId: first.id, memo: "riding" },
        });

        const result = await client.ticket.update({
          where: { deskId: first.id },
          data: { desk: { create: { title: "second" } } },
          select: { deskId: true, memo: true },
        });
        const second = await client.desk.findFirst({
          where: { title: "second" },
          select: { id: true },
        });
        // Not `first.id + 1`: what is asserted is that the record ends at the id the
        // SECOND insert generated, whatever the sequence chose.
        expect(second.id).not.toBe(first.id);
        expect(result).toEqual({ deskId: second.id, memo: "riding" });
        expect(
          await client.ticket.findMany({ select: { deskId: true } })
        ).toEqual([{ deskId: second.id }]);
      });

    test.each([
      [
        "connect selected by alternate unique",
        { connect: { email: "a2@x" } },
        "a2",
      ],
      [
        "connectOrCreate found arm",
        {
          connectOrCreate: {
            where: { id: "a2" },
            create: { id: "a3", email: "a3@x", name: "three" },
          },
        },
        "a2",
      ],
      [
        "upsert found arm",
        {
          upsert: {
            create: { id: "a2", email: "a2@x", name: "two" },
            update: { name: "selected" },
          },
        },
        "a1",
      ],
    ])(
      "a %s contributes only the taken arm's exact key",
      async (_label, payload, expectedKey) => {
        const client = await connect();
        await seed(client);

        expect(
          await client.card.update({
            where: { accountId: "a1" },
            data: { account: payload },
            select: { accountId: true },
          })
        ).toEqual({ accountId: expectedKey });
        expect(await cards(client)).toContainEqual({
          accountId: expectedKey,
          label: "under test",
        });
        expect(await client.account.count()).toBe(4);
      }
    );

    test("a selected fold that keeps the key suppresses the occupied transition guard", async () => {
      const client = await connect();
      await seed(client);
      await client.note.create({
        data: { id: "old", cardId: "a1", body: "incumbent" },
      });

      expect(
        await client.card.update({
          where: { accountId: "a1" },
          data: {
            account: { connect: { id: "a1" } },
            notes: { create: { id: "n1", body: "fresh" } },
          },
          select: { accountId: true },
        })
      ).toEqual({ accountId: "a1" });
      expect(
        await client.note.findMany({
          orderBy: { id: "asc" },
          select: { id: true, cardId: true },
        })
      ).toEqual([
        { id: "n1", cardId: "a1" },
        { id: "old", cardId: "a1" },
      ]);
    });

    /**
     * SCOPE, MEASURED AND KEPT (Package E gate) — the lift is per SELECTED RECORD, not
     * per update ROOT, and §6 E's "at an update root" describes the motivating case
     * rather than a boundary the code can coherently draw.
     *
     * The refusal it replaced (`assertNotSharedPk`) was scope-blind, so a nested selected
     * record — the target of a parent-held `update` — now folds and moves its own row key
     * too. What decides the outcome there is the ENCLOSING record's foreign key to it,
     * which is the database's to decide and not the engine's, and the proof that this is
     * coherent rather than an oversight is that the relation spelling and the SCALAR
     * spelling of the same nested move agree on both edges:
     *
     *   · ON UPDATE RESTRICT — both raise the database's foreign-key error, both leave the
     *     state untouched;
     *   · ON UPDATE CASCADE — both succeed, and the enclosing row's foreign key follows.
     *
     * Gating the fold to the operation's own root would have made the RELATION spelling
     * refuse where the SCALAR spelling at the same position succeeds, which is the
     * kind-gated incoherence D2 removed. At 33368eb6 the nested position raised a typed
     * construction refusal with zero statements; that is a refusal-to-refusal retarget on
     * the RESTRICT edge and a lift on the CASCADE edge, recorded for O's ledger.
     */
    test("a NESTED selected record folds its own row key, exactly as its scalar twin does", async () => {
      const client = await connect();

      for (const spelling of ["relation", "scalar"] as const) {
        // ON UPDATE RESTRICT: the database refuses, and nothing moves.
        await seed(client);
        await client.note.create({
          data: { id: "n", cardId: "a1", body: "held" },
        });
        const restricted = await client.note
          .update({
            where: { id: "n" },
            data: {
              card: {
                update:
                  spelling === "relation"
                    ? {
                        account: {
                          create: { id: "moved", email: "m@x", name: "m" },
                        },
                      }
                    : { accountId: "a2" },
              },
            },
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        expect((restricted as Error | undefined)?.constructor.name).toBe(
          "ForeignKeyError"
        );
        expect(
          await client.note.findMany({ select: { id: true, cardId: true } })
        ).toEqual([{ id: "n", cardId: "a1" }]);

        // ON UPDATE CASCADE: both succeed, and the enclosing row's key follows.
        await seed(client);
        await client.chit.create({
          data: { id: "c", cardId: "a1", body: "held" },
        });
        await client.chit.update({
          where: { id: "c" },
          data: {
            card: {
              update:
                spelling === "relation"
                  ? {
                      account: {
                        create: { id: "moved", email: "m@x", name: "m" },
                      },
                    }
                  : { accountId: "a2" },
            },
          },
        });
        expect(
          await client.chit.findMany({ select: { id: true, cardId: true } })
        ).toEqual([
          { id: "c", cardId: spelling === "relation" ? "moved" : "a2" },
        ]);
      }
    });

    /**
     * The SECOND root terminal owner, pinned on both of its branches.
     *
     * `UpsertOperation.updatedTerminalWhere` answers "where does the updated row now
     * live" from the record update compiler when the update arm carries relations, and
     * from its own `getUpdatedPrimaryKeyWhere` when it does not — a two-path answer to
     * one question, gated on something unrelated to the row key. They agree by
     * construction (the compiler's SET is the update data plus to-one link assignments,
     * and only a shared-key assignment can touch a row-key column), and this is what
     * makes that agreement a measurement: the same row-key move, spelled once as a FOLD
     * (which only the compiler branch can see — the update data carries no `accountId`
     * at all, so the own branch would answer with the PRE-fold key and the terminal would
     * read a row that has moved) and once as a plain SCALAR with no relation beside it
     * (which only the own branch runs), must land the record in the same place and return
     * it from the same read.
     */
    test.each([
      [
        "a shared-primary-key fold in the update arm — the compiler branch",
        { account: { create: { id: "a9", email: "a9@x", name: "nine" } } },
        "a9",
      ],
      [
        "a plain scalar move with no relation — the operation's own branch",
        { accountId: "a2" },
        "a2",
      ],
    ])(
      "an upsert whose update arm moves the row key returns the post-move key: %s",
      async (_label, update, expected) => {
        const client = await connect();
        await seed(client);

        expect(
          await client.card.upsert({
            where: { accountId: "a1" },
            update,
            create: { accountId: "a3", label: "unused" },
            select: { accountId: true, label: true },
          })
        ).toEqual({ accountId: expected, label: "under test" });

        expect(await cards(client)).toEqual(
          [
            { accountId: expected, label: "under test" },
            { accountId: "decoy", label: "decoy" },
          ].sort((left, right) => left.accountId.localeCompare(right.accountId))
        );
      }
    );

    test("a shared edge still cannot be disconnected: a row key is never nullable", async () => {
      const client = await connect();
      await seed(client);
      await client.stub.create({ data: { accountId: "a1", memo: "held" } });

      const rejection = await client.stub
        .update({
          where: { accountId: "a1" },
          data: { account: { disconnect: true } },
        })
        .then(
          () => undefined,
          (error: unknown) => error
        );

      // Same verdict, one owner earlier: the removal verb is not PUBLISHED on an
      // edge whose stored tuple cannot be emptied, so the parse answers instead of
      // the engine's deleted `assertRelationCanDisconnect`.
      expect(rejection).toBeInstanceOf(ValidationError);
      expect((rejection as Error).message).toBe(
        "Validation failed for update: Unknown key: disconnect"
      );
      expect(
        await client.stub.findMany({ select: { accountId: true } })
      ).toEqual([{ accountId: "a1" }]);
    });
  });
}
