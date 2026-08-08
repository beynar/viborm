import { hydrateSchemaNames, s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * E6.2 — **the upsert create arm whose read-back identity is PRODUCED: the member
 * the INSERT captured ⊎ the members the create data spelled.**
 *
 * Measured at 8c2908d, through the public client, on both substrates. The payload is
 * M9's (i): a compound primary key `(a, b)` whose `a` is an `increment`, and a create
 * arm that spells `b` and omits `a`.
 *
 *   UnsupportedOperationError: query-engine-v2 upsert cannot read back the row its
 *   create arm inserts for 'ticket': the create data carries neither a complete
 *   primary key ('a, b') nor any complete unique constraint of the model, and the
 *   primary key is not a single database-generated identity.
 *
 * SQL at the refusal — the locate planning read, and nothing after it:
 *
 *   transaction: SELECT "t0"."a", "t0"."b" FROM "…tickets" AS "t0"
 *                WHERE ("t0"."a" = $1 AND "t0"."b" = $2) LIMIT 1 FOR UPDATE
 *   atomic batch: the same SELECT without FOR UPDATE
 *
 * The refusal's third rung asked for a SINGLE database-generated primary key, and the
 * shape has two members. But one of them IS produced by the INSERT and the other is
 * written BY the same INSERT, so between them they name exactly one row — the row this
 * statement made. The rung now takes that union: one absent member, generated, plus the
 * literals the create data spells.
 *
 * **The batch capture wall is respected, not crossed.** The terminal read is a LATER
 * statement, so on the atomic batch the create arm publishes its identity as `insertId`
 * (the executor's scratch-store threading — the certified path) and never as the
 * `firstRowField` of a write, which a batch cannot thread. That is the shape
 * `createArmInsert` has always compiled; this unit widens WHICH members the read-back
 * joins, not HOW the produced one travels. The `firstRowField` capture stays on the
 * transaction + returning-driver leg alone.
 *
 * **What the decoys measure.** `b` is not unique on its own, so a read-back that
 * re-derived the identity by the spelled members could answer with a DIFFERENT row that
 * also holds them; a read-back that consulted the `where` would answer with the row the
 * caller asked about rather than the row the create arm wrote. The fixture seeds both
 * traps before every create-arm case: `decoy-same-b` holds the very `b` the create
 * writes, and `decoy-where-b` holds the `b` the `where` names. Only the union of the
 * capture and the spelled literal walks past both.
 */
export const producedCompoundSchema = (() => {
  /**
   * The increment member is FIRST in the compound key on purpose: MySQL requires an
   * AUTO_INCREMENT column to lead an index, and this fixture has to run on every
   * driver leg. (SQLite cannot generate a compound-PK member at all — it has no
   * AUTOINCREMENT outside a single INTEGER PRIMARY KEY — so the SQLite legs are out
   * of this fixture's reach by DDL, not by engine behavior.)
   */
  const ticket = s
    .model({
      a: s.int().increment(),
      b: s.string(),
      label: s.string(),
    })
    .id(["a", "b"])
    .map("e62_tickets");
  return { ticket };
})();

hydrateSchemaNames(producedCompoundSchema);

/** Rows the create arm must not answer with: one holding the `b` the create writes,
 *  one holding the `b` the `where` names. Returns their generated keys. */
async function seedDecoys(
  client: any
): Promise<{ sameB: number; whereB: number }> {
  await client.ticket.deleteMany({});
  // `create` cannot reach this model (mutation-identity refuses to propagate a
  // generated compound primary key), so seed through `createMany`.
  await client.ticket.createMany({
    data: [
      { b: "written", label: "decoy-same-b" },
      { b: "asked", label: "decoy-where-b" },
    ],
  });
  const rows = await client.ticket.findMany({
    select: { a: true, b: true, label: true },
  });
  const sameB = rows.find((row: any) => row.label === "decoy-same-b");
  const whereB = rows.find((row: any) => row.label === "decoy-where-b");
  if (!(sameB && whereB)) throw new Error("decoys were not seeded");
  return { sameB: sameB.a as number, whereB: whereB.a as number };
}

export function registerProducedCompoundBehavior(
  name: string,
  connect: () => Promise<any>,
  register: (label: string, body: () => void) => void = describe
): void {
  register(`E6.2 produced compound identity (${name})`, () => {
    test("the create arm reads back the row its INSERT made, not either decoy", async () => {
      const client = await connect();
      const decoys = await seedDecoys(client);

      // The `where` names a key no row holds (`a` is free), so the create arm is
      // taken — and it names a DIFFERENT `b` than the create writes, which is the
      // wrong-row trap: `decoy-where-b` already holds that `b`.
      const created = await client.ticket.upsert({
        where: { a_b: { a: 9999, b: "asked" } },
        create: { b: "written", label: "made" },
        update: { label: "must not run" },
        select: { a: true, b: true, label: true },
      });

      expect(created.b).toBe("written");
      expect(created.label).toBe("made");
      // The captured member is the one the INSERT produced — never a decoy's, never
      // the `where`'s.
      expect(created.a).not.toBe(decoys.sameB);
      expect(created.a).not.toBe(decoys.whereB);
      expect(created.a).not.toBe(9999);

      // The row really exists under the key the read-back answered with.
      expect(
        await client.ticket.findUnique({
          where: { a_b: { a: created.a, b: "written" } },
          select: { label: true },
        })
      ).toEqual({ label: "made" });
      // Neither decoy was read back, and neither was touched.
      expect(
        await client.ticket.findMany({
          orderBy: { a: "asc" },
          select: { label: true },
        })
      ).toEqual([
        { label: "decoy-same-b" },
        { label: "decoy-where-b" },
        { label: "made" },
      ]);
    });

    test("the update arm is untouched — a located row still updates", async () => {
      const client = await connect();
      const decoys = await seedDecoys(client);

      // The same model, the same create payload, a `where` that DOES locate: the
      // create-arm identity is never consulted (it is decided at compile, on the
      // taken arm only), so this arm behaves exactly as it did before the widening.
      expect(
        await client.ticket.upsert({
          where: { a_b: { a: decoys.sameB, b: "written" } },
          create: { b: "written", label: "must not run" },
          update: { label: "updated" },
          select: { a: true, b: true, label: true },
        })
      ).toEqual({ a: decoys.sameB, b: "written", label: "updated" });
      // No row was inserted: the arm choice is the locate's, not the identity's.
      expect(await client.ticket.count()).toBe(2);
    });

    test("a second create arm on the same b makes a second row, each read back by its own key", async () => {
      const client = await connect();
      await seedDecoys(client);

      const first = await client.ticket.upsert({
        where: { a_b: { a: 9998, b: "written" } },
        create: { b: "written", label: "first" },
        update: { label: "must not run" },
        select: { a: true, label: true },
      });
      const second = await client.ticket.upsert({
        where: { a_b: { a: 9999, b: "written" } },
        create: { b: "written", label: "second" },
        update: { label: "must not run" },
        select: { a: true, label: true },
      });

      // Two INSERTs, two produced keys, two read-backs — and each answered with its
      // OWN row. A read-back that re-derived the identity from the spelled `b` could
      // not tell these apart.
      expect(first.label).toBe("first");
      expect(second.label).toBe("second");
      expect(first.a).not.toBe(second.a);
      expect(await client.ticket.count()).toBe(4);
    });
  });
}
