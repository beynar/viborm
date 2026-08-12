import { NestedWriteError, UnsupportedOperationError } from "@errors";
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
      card: s.oneToOne(() => card).optional(),
      stub: s.oneToOne(() => stub).optional(),
    })
    .map("e1u_accounts");
  /** The shared primary key: `accountId` is this row's identity AND its foreign key. */
  const card = s
    .model({
      accountId: s.string().id(),
      label: s.string(),
      account: s
        .oneToOne(() => account)
        .fields("accountId")
        .references("id"),
      notes: s.oneToMany(() => note),
      chits: s.oneToMany(() => chit),
    })
    .map("e1u_cards");
  /** A CHILD-HELD edge on the shared key: what the fold's transition has to reach. */
  const note = s
    .model({
      id: s.string().id(),
      cardId: s.string(),
      body: s.string(),
      card: s
        .manyToOne(() => card)
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
        .manyToOne(() => card)
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
        .oneToOne(() => account)
        .fields("accountId")
        .references("id")
        .optional(),
    })
    .map("e1u_stubs");
  const desk = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
      ticket: s.oneToOne(() => ticket).optional(),
    })
    .map("e1u_desks");
  /** A shared key whose final value the TARGET's own INSERT produces (Package F). */
  const ticket = s
    .model({
      deskId: s.int().id(),
      memo: s.string(),
      desk: s
        .oneToOne(() => desk)
        .fields("deskId")
        .references("id"),
    })
    .map("e1u_tickets");
  return { account, card, chit, desk, note, stub, ticket };
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
  register: (label: string, body: () => void) => void = describe
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
        "connect",
        { connect: { email: "a2@x" } },
        "shared-primary-key connect on relation 'account'",
      ],
      [
        "connectOrCreate whose arms disagree",
        {
          connectOrCreate: {
            where: { id: "a2" },
            create: { id: "a3", email: "a3@x", name: "three" },
          },
        },
        "shared-primary-key connectOrCreate on relation 'account'",
      ],
      [
        "upsert whose arms disagree",
        {
          upsert: {
            create: { id: "a2", email: "a2@x", name: "two" },
            update: { name: "unused" },
          },
        },
        "shared-primary-key upsert on relation 'account'",
      ],
    ])("a %s names no one final value: typed refusal, nothing written", async (_label, payload, fragment) => {
      const client = await connect();
      await seed(client);

      const rejection = await client.card
        .update({ where: { accountId: "a1" }, data: { account: payload } })
        .then(
          () => undefined,
          (error: unknown) => error
        );

      expect(rejection).toBeInstanceOf(UnsupportedOperationError);
      expect((rejection as Error).message).toContain(fragment);
      expect((rejection as Error).message).toContain(
        "does not resolve to one final value"
      );
      expect(await cards(client)).toEqual([
        { accountId: "a1", label: "under test" },
        { accountId: "decoy", label: "decoy" },
      ]);
      expect(await client.account.count()).toBe(4);
    });

    /**
     * RESIDUE, MEASURED AND KEPT (Package E gate) — a fold that moves NOTHING is still
     * counted as a move, so it takes the occupied guard and is REFUSED where the scalar
     * spelling of the identical final state is ACCEPTED.
     *
     * `resolveSharedKeyMembers` is topological: it runs before the relation loop, so it
     * knows the arm's KIND but not its VALUE, and it must answer before any arm has. The
     * scalar half reaches `sameScalarValue` and returns regime "none"; this half cannot,
     * because there is no `after` to compare yet. Closing the gap means deriving each
     * arm's value a second time in the pre-pass — a second enumeration of "what does this
     * arm fold", whose disagreement with the first is the silent orphan D2 closed. This
     * asymmetry is the price, and it is pinned here so it is a decision and not a drift:
     * the day the two spellings agree, this test goes red and says so.
     *
     * At 33368eb6 BOTH relation spellings refused unconditionally (the shape refusal, and
     * for `connect` the compile-time "unsupported operation" one), so this is a narrowing,
     * never a regression.
     */
    test("a fold that moves nothing still takes the occupied guard, where its scalar twin does not", async () => {
      const client = await connect();
      await seed(client);
      await client.note.create({
        data: { id: "old", cardId: "a1", body: "incumbent" },
      });

      // (A) the RELATION spelling: `connect` names the key the record already holds.
      const rejection = await client.card
        .update({
          where: { accountId: "a1" },
          data: {
            account: { connect: { id: "a1" } },
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
      expect(
        await client.note.findMany({
          orderBy: { id: "asc" },
          select: { id: true, cardId: true },
        })
      ).toEqual([{ id: "old", cardId: "a1" }]);

      // (B) the SCALAR spelling of the SAME final state: accepted, on the same tree.
      expect(
        await client.card.update({
          where: { accountId: "a1" },
          data: {
            accountId: "a1",
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
    ])("an upsert whose update arm moves the row key returns the post-move key: %s", async (_label, update, expected) => {
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
    });

    test("an OPTIONAL shared edge still cannot be disconnected: a row key is never nullable", async () => {
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

      expect(rejection).toBeInstanceOf(NestedWriteError);
      expect((rejection as Error).message).toBe(
        "Cannot disconnect relation 'account' because foreign key field(s) accountId are required."
      );
      expect(
        await client.stub.findMany({ select: { accountId: true } })
      ).toEqual([{ accountId: "a1" }]);
    });
  });
}
