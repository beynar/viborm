import { s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * E6.5 — a VACATE followed by a SUPPLY on one to-one slot at the UPDATE root, as
 * behavior every driver leg runs.
 *
 * Measured at 8c2908d over ALL 21 unordered pairs the update-root to-one parse factory
 * delivers (`toOneUpdateFactory`: `create`, `connect`, `connectOrCreate`, `update`,
 * `upsert`, plus `disconnect` / `delete` on an optional relation), on BOTH directions,
 * plus the empty `{}` payload. The enumeration is what corrected the old argument:
 *
 *  · 15 of the 21 pairs on this direction died at the dispatch guard with
 *    "query-engine-v2 update supports one mutation kind on the to-one relation
 *    'badge'; it has <a>, <b>." — construction-time, 0 statements;
 *  · 6 died EARLIER, in the own-write legality walk ("Nested operation 'x' … depends
 *    on an earlier 'y' … Split these operations into separate queries."), which is a
 *    different guard with a different reason and is not this unit's to lift;
 *  · `{}` executed as a no-op — the payload the old argument never classified at all.
 *
 * The "two intents for one slot" contradiction is real for two SUPPLIERS (two
 * identities, one slot, no canonical winner). A vacate and a supplier carry ONE
 * identity between them and a fixed order, so the pair has a state and the sequence
 * IS that state. Prisma refuses it; the maintainer's rule says parity is not a reason.
 *
 * `b-alt` is the decoy: it is a live, unconnected row of the same model, so a pair
 * that vacated the wrong row, or supplied the wrong one, moves it.
 */
export const vacateThenSupplySchema = (() => {
  const station = s
    .model({
      id: s.string().id(),
      label: s.string(),
      badge: s.oneToOne(() => badge).optional(),
    })
    .map("e65_stations");

  const badge = s
    .model({
      id: s.string().id(),
      tag: s.string(),
      stationId: s.string().nullable().unique(),
      station: s
        .oneToOne(() => station)
        .fields("stationId")
        .references("id")
        .optional(),
    })
    .map("e65_badges");

  return { station, badge };
})();

export async function resetVacateThenSupply(client: any): Promise<void> {
  await client.badge.deleteMany({});
  await client.station.deleteMany({});
  await client.station.create({ data: { id: "s1", label: "L" } });
  await client.badge.create({
    data: { id: "b1", tag: "incumbent", stationId: "s1" },
  });
  // The decoy: live, unconnected, and named by the `connect` / `connectOrCreate` arms.
  await client.badge.create({ data: { id: "b-alt", tag: "alt" } });
}

/** `[id, tag, stationId]` for every badge, id-ordered. */
async function badges(client: any): Promise<unknown[][]> {
  const rows = await client.badge.findMany({ orderBy: { id: "asc" } });
  return rows.map((row: any) => [row.id, row.tag, row.stationId]);
}

export function registerVacateThenSupplyBehavior(
  name: string,
  connect: () => Promise<any>,
  register: (label: string, body: () => void) => void = describe
): void {
  register(`E6.5 vacate-then-supply on a to-one slot (${name})`, () => {
    test("disconnect + connect retargets, and ORPHANS the incumbent", async () => {
      const client = await connect();
      await resetVacateThenSupply(client);

      await client.station.update({
        where: { id: "s1" },
        data: { badge: { disconnect: true, connect: { id: "b-alt" } } },
      });

      // The old target's fate under `disconnect` is ORPHANED, not deleted.
      expect(await badges(client)).toEqual([
        ["b-alt", "alt", "s1"],
        ["b1", "incumbent", null],
      ]);
    });

    test("disconnect + connectOrCreate adopts the found row, and ORPHANS the incumbent", async () => {
      const client = await connect();
      await resetVacateThenSupply(client);

      await client.station.update({
        where: { id: "s1" },
        data: {
          badge: {
            disconnect: true,
            connectOrCreate: {
              where: { id: "b-alt" },
              create: { id: "b-alt", tag: "never-minted" },
            },
          },
        },
      });

      expect(await badges(client)).toEqual([
        ["b-alt", "alt", "s1"],
        ["b1", "incumbent", null],
      ]);
    });

    test("disconnect + create mints the newcomer, ORPHANS the incumbent, and leaves the decoy alone", async () => {
      const client = await connect();
      await resetVacateThenSupply(client);

      await client.station.update({
        where: { id: "s1" },
        data: {
          badge: {
            disconnect: true,
            create: { id: "b-new", tag: "fresh" },
          },
        },
      });

      expect(await badges(client)).toEqual([
        ["b-alt", "alt", null],
        ["b-new", "fresh", "s1"],
        ["b1", "incumbent", null],
      ]);
    });

    test("delete + connect retargets, and REMOVES the incumbent", async () => {
      const client = await connect();
      await resetVacateThenSupply(client);

      await client.station.update({
        where: { id: "s1" },
        data: { badge: { delete: true, connect: { id: "b-alt" } } },
      });

      // The old target's fate under `delete` is GONE.
      expect(await badges(client)).toEqual([["b-alt", "alt", "s1"]]);
    });

    test("delete + create replaces: the incumbent is REMOVED and the newcomer holds the slot", async () => {
      const client = await connect();
      await resetVacateThenSupply(client);

      await client.station.update({
        where: { id: "s1" },
        data: {
          badge: { delete: true, create: { id: "b-new", tag: "fresh" } },
        },
      });

      expect(await badges(client)).toEqual([
        ["b-alt", "alt", null],
        ["b-new", "fresh", "s1"],
      ]);
    });

    test("delete + connectOrCreate keeps the own-write legality walk's refusal", async () => {
      const client = await connect();
      await resetVacateThenSupply(client);

      // NOT the dispatch guard: a DIFFERENT guard, one layer up, with its own reason.
      // Lifting the dispatch guard for this pair changed which message a caller sees
      // for the other five and none for this one.
      await expect(
        client.station.update({
          where: { id: "s1" },
          data: {
            badge: {
              delete: true,
              connectOrCreate: {
                where: { id: "b-alt" },
                create: { id: "b-alt", tag: "n" },
              },
            },
          },
        })
      ).rejects.toThrow(
        "Nested operation 'connectOrCreate' on relation 'badge' depends on an earlier 'delete' target write in the same nested write."
      );
      expect(await badges(client)).toEqual([
        ["b-alt", "alt", null],
        ["b1", "incumbent", "s1"],
      ]);
    });

    test("two SUPPLIERS stay refused — two identities, one slot", async () => {
      const client = await connect();
      await resetVacateThenSupply(client);

      await expect(
        client.station.update({
          where: { id: "s1" },
          data: {
            badge: {
              connect: { id: "b-alt" },
              create: { id: "b-new", tag: "fresh" },
            },
          },
        })
      ).rejects.toThrow(
        "query-engine-v2 update supports one mutation kind on the to-one relation 'badge'; it has connect, create."
      );
      expect(await badges(client)).toEqual([
        ["b-alt", "alt", null],
        ["b1", "incumbent", "s1"],
      ]);
    });

    test("two VACATES stay refused — and a vacate beside a MUTATOR too", async () => {
      const client = await connect();
      await resetVacateThenSupply(client);

      await expect(
        client.station.update({
          where: { id: "s1" },
          data: { badge: { disconnect: true, delete: true } },
        })
      ).rejects.toThrow(
        "query-engine-v2 update supports one mutation kind on the to-one relation 'badge'; it has disconnect, delete."
      );
      await expect(
        client.station.update({
          where: { id: "s1" },
          data: { badge: { update: { tag: "u" }, connect: { id: "b-alt" } } },
        })
      ).rejects.toThrow(
        "query-engine-v2 update supports one mutation kind on the to-one relation 'badge'; it has update, connect."
      );
      expect(await badges(client)).toEqual([
        ["b-alt", "alt", null],
        ["b1", "incumbent", "s1"],
      ]);
    });

    test("a THIRD kind reopens the question the pair answers, and stays refused", async () => {
      const client = await connect();
      await resetVacateThenSupply(client);

      await expect(
        client.station.update({
          where: { id: "s1" },
          data: {
            badge: {
              disconnect: true,
              connect: { id: "b-alt" },
              create: { id: "b-new", tag: "fresh" },
            },
          },
        })
      ).rejects.toThrow(
        "query-engine-v2 update supports one mutation kind on the to-one relation 'badge'; it has disconnect, connect, create."
      );
      expect(await badges(client)).toEqual([
        ["b-alt", "alt", null],
        ["b1", "incumbent", "s1"],
      ]);
    });

    test("`delete: false` beside a supplier is still a SINGLE-kind payload (N7-U-B)", async () => {
      const client = await connect();

      // `getRelationMutationKinds` drops a literal `false` arm, so this payload asks
      // for exactly ONE kind and never reaches the pair rule. The pin is that both
      // spellings do the SAME thing — and what a lone `connect` does into an occupied
      // 1:1 slot is raise the child's unique violation, because nothing vacated the
      // incumbent. A regression that read `false` as a vacate would take the absorbed
      // pair's branch instead, DELETE `b1`, and succeed: a difference impossible to
      // miss.
      await resetVacateThenSupply(client);
      const withFalse = await client.station
        .update({
          where: { id: "s1" },
          data: { badge: { delete: false, connect: { id: "b-alt" } } },
        })
        .then(() => "resolved")
        .catch((error: Error) => error.constructor.name);
      const stateWithFalse = await badges(client);

      await resetVacateThenSupply(client);
      const withoutFalse = await client.station
        .update({
          where: { id: "s1" },
          data: { badge: { connect: { id: "b-alt" } } },
        })
        .then(() => "resolved")
        .catch((error: Error) => error.constructor.name);
      const stateWithoutFalse = await badges(client);

      expect(withFalse).toBe("UniqueConstraintError");
      expect(withFalse).toBe(withoutFalse);
      expect(stateWithFalse).toEqual(stateWithoutFalse);
      // The incumbent is untouched by both — `false` vacated nothing.
      expect(stateWithFalse).toEqual([
        ["b-alt", "alt", null],
        ["b1", "incumbent", "s1"],
      ]);
    });

    test("the empty `{}` relation payload is a no-op", async () => {
      const client = await connect();
      await resetVacateThenSupply(client);

      // Unclassified by the old argument (no kinds at all, so neither one nor two).
      await client.station.update({
        where: { id: "s1" },
        data: { badge: {} },
      });

      expect(await badges(client)).toEqual([
        ["b-alt", "alt", null],
        ["b1", "incumbent", "s1"],
      ]);
    });
  });
}
