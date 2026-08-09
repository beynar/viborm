import { s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * A child-held to-one update may replace its current member in one payload. The
 * relation owner emits the vacate before the supplier. Other multi-operation
 * payloads are rejected by the operation schema.
 *
 * `b-alt` is a live, unconnected decoy, so a pair that vacates or supplies the
 * wrong row is observable.
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

/**
 * `[id, tag, stationId]` for every badge, ordered by CODE UNIT rather than by the
 * database.
 *
 * Not a style choice: `ORDER BY id` disagrees across the legs this suite runs on.
 * PostgreSQL's default locale collation ignores punctuation at the primary weight, so
 * it reads `b-alt` as `balt` and returns `b1` first; PGlite and SQLite compare bytes and
 * return `b-alt` first. The rows and their foreign keys are identical either way, and
 * they are the whole claim here — the ordering is not — so sorting in JS keeps a
 * collation difference from being reported as a write-engine difference.
 */
async function badges(client: any): Promise<unknown[][]> {
  const rows = await client.badge.findMany({});
  return rows
    .map((row: any) => [row.id, row.tag, row.stationId])
    .sort((left: unknown[], right: unknown[]) =>
      String(left[0]) < String(right[0]) ? -1 : 1
    );
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

    test("delete + connectOrCreate is not a supported replacement pair", async () => {
      const client = await connect();
      await resetVacateThenSupply(client);

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
        "Unsupported to-one operation combination: connectOrCreate, delete"
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
        "Unsupported to-one operation combination: create, connect"
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
        "Unsupported to-one operation combination: disconnect, delete"
      );
      await expect(
        client.station.update({
          where: { id: "s1" },
          data: { badge: { update: { tag: "u" }, connect: { id: "b-alt" } } },
        })
      ).rejects.toThrow(
        "Unsupported to-one operation combination: connect, update"
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
        "Unsupported to-one operation combination: create, connect, disconnect"
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
