import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { push } from "@migrations";
import { sharedPkUpdateRootSchema } from "@tests/contracts/engine/write/shared-pk-update-root-behavior";
import { describe, expect, test } from "vitest";

/**
 * PACKAGE H, the PACKAGE E PRECONDITION — **a supplier beside a modify, on the edge
 * whose foreign key is the record's own primary key.**
 *
 * `resolveSharedKeyMembers` decides, from topology alone and before the relation loop
 * runs, which members of the selected record's row key a parent-held arm will rewrite.
 * Until H it skipped any relation carrying more than one entry, and that skip was
 * correct only because a multi-entry parent-held payload was refused before a plan
 * existed. H's lattice admits `connect` beside `update` (and a vacate beside a
 * supplier), which is exactly the payload that would have walked through the skip: the
 * `connect` fills `sharedKeyFinal` with the new key while the members map stays empty,
 * so the record moves WITHOUT the transition regime, without the descendant reorder,
 * and without the occupied guard — and the child-held `notes` edge, whose foreign key
 * references the moved column, is left addressing a key no row holds.
 *
 * `card.accountId` is the card's identity AND its foreign key to `account`, and `notes`
 * hangs off that same column, so this one payload reaches every reader that has to
 * learn about the fold.
 *
 * THE WITNESS WAS STAGED, and all three steps have now been taken:
 *   1. before H2 — the LATTICE refused it, in `to-one-mutation-schema.ts`:
 *      "Validation failed for update: Unsupported to-one operation combination:
 *      connect, update";
 *   2. after H2 — validation accepted and the ENGINE's parent-held arity guard refused;
 *   3. after H3 (HERE) — it EXECUTES. The card's key becomes `a2` and `account.name`
 *      becomes `moved`, in one operation, and the fold is what carried the key.
 * The state assertions are what made each step a real step rather than a change of
 * wording: a refusal that fires after a write is not a refusal.
 *
 * WHAT STEP 3 MEASURED AND THE STAGING DID NOT PREDICT: a `note` that references the
 * moved column blocks the move — `Foreign key constraint violation`, nothing written.
 * That is NOT the composition's doing and not H's. A LONE `connect` on the same seed was
 * measured to fail identically, so the composed payload behaves exactly as its supplier
 * alone does; `notes.cardId` is a non-cascade reference to `cards.accountId` and the
 * shared-key fold does not rewrite dependents. Both halves are pinned below, because the
 * agreement between them is the claim: the modify rides along without changing what the
 * supplier means.
 */
describe("Package H — shared-primary-key supplier + modify", () => {
  const client = () =>
    createClient({
      schema: sharedPkUpdateRootSchema,
      driver: new PGliteDriver({ client: new PGlite() }),
    }) as any;

  async function seeded({
    note = true,
  }: {
    note?: boolean;
  } = {}): Promise<any> {
    const db = client();
    await push(db, { force: true });
    await db.account.createMany({
      data: [
        { id: "a1", email: "a1@x", name: "one" },
        { id: "a2", email: "a2@x", name: "two" },
      ],
    });
    await db.card.create({ data: { accountId: "a1", label: "under test" } });
    if (note) {
      await db.note.create({
        data: { id: "n1", cardId: "a1", body: "follows the key" },
      });
    }
    return db;
  }

  /** The card's key, the note that references it, and the supplied target's name. */
  async function state(db: any): Promise<unknown> {
    return {
      cards: await db.card.findMany({
        orderBy: { accountId: "asc" },
        select: { accountId: true, label: true },
      }),
      notes: await db.note.findMany({
        orderBy: { id: "asc" },
        select: { id: true, cardId: true },
      }),
      names: (
        await db.account.findMany({
          orderBy: { id: "asc" },
          select: { name: true },
        })
      ).map((row: any) => row.name),
    };
  }

  const UNTOUCHED = {
    cards: [{ accountId: "a1", label: "under test" }],
    notes: [{ id: "n1", cardId: "a1" }],
    names: ["one", "two"],
  };

  test("connect + update on the shared key EXECUTES: the key moves and the target is modified", async () => {
    const db = await seeded({ note: false });

    const message = await db.card
      .update({
        where: { accountId: "a1" },
        data: {
          account: { connect: { id: "a2" }, update: { name: "moved" } },
        },
      })
      .then(
        () => "EXECUTED",
        (thrown: unknown) => (thrown as Error).message
      );

    expect({ message, state: await state(db) }).toEqual({
      message: "EXECUTED",
      state: {
        cards: [{ accountId: "a2", label: "under test" }],
        notes: [],
        // `a2` is the row the SUPPLIER named, and the row the modify hit. `a1` keeps its
        // name: a modify correlated on the parent's foreign key would have rewritten it,
        // because at probe time `card.accountId` still holds `a1`.
        names: ["one", "moved"],
      },
    });
    await db.$disconnect();
  }, 60_000);

  test("a dependent row blocks the shared-key move — exactly as a lone `connect` does", async () => {
    // MEASURED both ways on this seed: `{ connect }` alone and `{ connect, update }`
    // produce the same `Foreign key constraint violation` with nothing written, because
    // `notes.cardId` references the moved column and the fold does not rewrite
    // dependents. Pinned so that a future change to either half cannot silently make the
    // composed spelling behave differently from the supplier alone.
    const composed = await (await seeded({ note: true })).card
      .update({
        where: { accountId: "a1" },
        data: {
          account: { connect: { id: "a2" }, update: { name: "moved" } },
        },
      })
      .then(
        () => "EXECUTED",
        (thrown: unknown) => (thrown as Error).message
      );
    const db = await seeded({ note: true });
    const supplierAlone = await db.card
      .update({
        where: { accountId: "a1" },
        data: { account: { connect: { id: "a2" } } },
      })
      .then(
        () => "EXECUTED",
        (thrown: unknown) => (thrown as Error).message
      );

    expect({ composed, supplierAlone, state: await state(db) }).toEqual({
      composed: "Foreign key constraint violation",
      supplierAlone: "Foreign key constraint violation",
      state: UNTOUCHED,
    });
    await db.$disconnect();
  }, 60_000);

  test("disconnect + connect on the shared key is not a spellable pair", async () => {
    // The "optional" spelling of the same fold, RE-FOUNDED. It used to reach the
    // engine because `stub.account` carried an `.optional()` flag beside a
    // NON-NULLABLE row-key column, so the schema published a vacate the column
    // could never accept. Emptiness follows the stored tuple now (§9.4), the verb
    // is not published at all, and the pair the fold had to arbitrate cannot be
    // written. R2's per-column precedence keeps its witness on the payload that IS
    // spellable — `connect` beside `update`, above.
    const db = await seeded();
    await db.stub.create({ data: { accountId: "a1", memo: "m" } });

    const message = await db.stub
      .update({
        where: { accountId: "a1" },
        data: { account: { disconnect: true, connect: { id: "a2" } } },
      })
      .then(
        () => "EXECUTED",
        (thrown: unknown) => (thrown as Error).message
      );

    expect({
      message,
      stubs: await db.stub.findMany({
        orderBy: { accountId: "asc" },
        select: { accountId: true, memo: true },
      }),
    }).toEqual({
      message: "Validation failed for update: Unknown key: disconnect",
      // A refusal that fires after a write is not a refusal: the row never moved.
      stubs: [{ accountId: "a1", memo: "m" }],
    });
    await db.$disconnect();
  }, 60_000);
});
