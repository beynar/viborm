import { s } from "@schema";
import { describe, expect, test } from "vitest";

const RELATION_BADGE = /badge/;
const UNIQUE_CONFLICT = /[Uu]nique/;

/**
 * PACKAGE E — a singular supplier continued by an ordinary selected-record update.
 *
 * `{ create, update }` and `{ connectOrCreate, update }` on a child-held to-one slot
 * were the last shapes the public lattice admitted and the engine refused. The refusal
 * named a missing produced-identity channel; the lift does not build one. Membership
 * after supply IS the selector: the supplier writes, and the continuation then selects
 * the singular member through the same exact physical-membership predicate every other
 * arm on the edge uses, publishes its complete row key, and runs the ordinary
 * `RecordUpdateCompiler` against it.
 *
 * The bed keeps `b-alt` as a live, unconnected decoy, so a continuation that landed on
 * the wrong row — or on the row the payload replaced — is observable in state rather
 * than only in SQL.
 *
 * `note` hangs off a badge so the continuation can carry relations of its own; that is
 * the recursion witness, and `notes.updateMany` inside it is the nested-bulk one.
 */
export const supplierContinuationSchema = (() => {
  const station = s
    .model({
      id: s.string().id(),
      label: s.string(),
      badge: s.toOne(() => badge),
    })
    .map("e7_stations");

  const badge = s
    .model({
      id: s.string().id(),
      tag: s.string(),
      rank: s.int().default(0),
      stationId: s.string().nullable().unique(),
      station: s
        .toOne(() => station)
        .fields("stationId")
        .references("id"),
      notes: s.toMany(() => note),
      seal: s.toOne(() => seal),
    })
    .map("e7_badges");

  const note = s
    .model({
      id: s.string().id(),
      body: s.string(),
      badgeId: s.string().nullable(),
      badge: s
        .toOne(() => badge)
        .fields("badgeId")
        .references("id"),
    })
    .map("e7_notes");

  /** One more child-held to-one, so a continuation can itself compose a supplier
   *  with a modify — the recursive case. */
  const seal = s
    .model({
      id: s.string().id(),
      wax: s.string(),
      badgeId: s.string().nullable().unique(),
      badge: s
        .toOne(() => badge)
        .fields("badgeId")
        .references("id"),
    })
    .map("e7_seals");

  return { badge, note, seal, station };
})();

export async function resetSupplierContinuation(client: any): Promise<void> {
  await client.note.deleteMany({});
  await client.seal.deleteMany({});
  await client.badge.deleteMany({});
  await client.station.deleteMany({});
  await client.station.create({ data: { id: "s1", label: "L" } });
  // `s2` holds an EMPTY slot. The child's `stationId` is unique — that is what makes
  // the relation singular — so an un-vacated supplier on an OCCUPIED slot is a genuine
  // unique conflict and says nothing about this composition. The vacate-prefixed forms
  // use `s1`; the bare ones use `s2`.
  await client.station.create({ data: { id: "s2", label: "M" } });
  await client.badge.create({
    data: { id: "b1", tag: "incumbent", rank: 1, stationId: "s1" },
  });
  await client.badge.create({ data: { id: "b-alt", tag: "alt", rank: 5 } });
}

async function badges(client: any): Promise<unknown[][]> {
  const rows = await client.badge.findMany({});
  return rows
    .map((row: any) => [row.id, row.tag, row.rank, row.stationId])
    .sort((left: unknown[], right: unknown[]) =>
      String(left[0]) < String(right[0]) ? -1 : 1
    );
}

async function notes(client: any): Promise<unknown[][]> {
  const rows = await client.note.findMany({});
  return rows
    .map((row: any) => [row.id, row.body, row.badgeId])
    .sort((left: unknown[], right: unknown[]) =>
      String(left[0]) < String(right[0]) ? -1 : 1
    );
}

export function registerSupplierContinuationBehavior(
  name: string,
  connect: () => Promise<any>,
  register: (label: string, body: () => void) => void = describe
): void {
  register(`E — supply then update on a to-one slot (${name})`, () => {
    test("create + update mints the newcomer and then updates THAT row", async () => {
      const client = await connect();
      await resetSupplierContinuation(client);

      await client.station.update({
        where: { id: "s2" },
        data: {
          badge: {
            create: { id: "b-new", tag: "fresh", rank: 2 },
            update: { tag: "continued" },
          },
        },
      });

      // `s1`'s incumbent and the unconnected decoy are BOTH untouched. A continuation
      // located by "the first badge", or by the enclosing record's old membership,
      // would have retagged one of them; the capture reads `s2`'s membership, which
      // only the fresh row satisfies.
      expect(await badges(client)).toEqual([
        ["b-alt", "alt", 5, null],
        ["b-new", "continued", 2, "s2"],
        ["b1", "incumbent", 1, "s1"],
      ]);
    });

    test("the continuation observes the supplied row, so a relative update counts from it", async () => {
      const client = await connect();
      await resetSupplierContinuation(client);

      // THE ORDERING CLAIM. `rank` starts at 2 on the row the supplier just inserted;
      // an implementation that merged the update into the create data would write 2,
      // and one that applied it to the incumbent would leave the newcomer at 2 and the
      // incumbent at 4.
      await client.station.update({
        where: { id: "s2" },
        data: {
          badge: {
            create: { id: "b-new", tag: "fresh", rank: 2 },
            update: { rank: { increment: 3 } },
          },
        },
      });

      expect(await badges(client)).toEqual([
        ["b-alt", "alt", 5, null],
        ["b-new", "fresh", 5, "s2"],
        ["b1", "incumbent", 1, "s1"],
      ]);
    });

    test("connectOrCreate FOUND + update adopts the decoy and updates the adopted row", async () => {
      const client = await connect();
      await resetSupplierContinuation(client);

      await client.station.update({
        where: { id: "s1" },
        data: {
          badge: {
            disconnect: true,
            connectOrCreate: {
              where: { id: "b-alt" },
              create: { id: "b-alt", tag: "never-minted" },
            },
            update: { tag: "adopted" },
          },
        },
      });

      // FOUND: `b-alt` kept its rank (the create arm never ran) and took the slot.
      expect(await badges(client)).toEqual([
        ["b-alt", "adopted", 5, "s1"],
        ["b1", "incumbent", 1, null],
      ]);
    });

    test("connectOrCreate MISSING + update mints and updates the fresh row", async () => {
      const client = await connect();
      await resetSupplierContinuation(client);

      await client.station.update({
        where: { id: "s1" },
        data: {
          badge: {
            disconnect: true,
            connectOrCreate: {
              where: { id: "b-new" },
              create: { id: "b-new", tag: "minted", rank: 7 },
            },
            update: { tag: "continued" },
          },
        },
      });

      expect(await badges(client)).toEqual([
        ["b-alt", "alt", 5, null],
        ["b-new", "continued", 7, "s1"],
        ["b1", "incumbent", 1, null],
      ]);
    });

    test("delete + create + update removes the incumbent before supplying and continuing", async () => {
      const client = await connect();
      await resetSupplierContinuation(client);

      // The vacate-prefixed form the ledger used to refuse: the modify was declared as
      // a MEMBERSHIP read, so the sibling `delete` looked like its premise. The locate
      // is a post-supply capture now, so the only ordering that matters is the one the
      // series executes: delete, create, capture, update.
      await client.station.update({
        where: { id: "s1" },
        data: {
          badge: {
            delete: true,
            create: { id: "b-new", tag: "fresh", rank: 2 },
            update: { tag: "continued" },
          },
        },
      });

      expect(await badges(client)).toEqual([
        ["b-alt", "alt", 5, null],
        ["b-new", "continued", 2, "s1"],
      ]);
    });

    test("the continuation carries its own relations, one level deeper", async () => {
      const client = await connect();
      await resetSupplierContinuation(client);

      await client.station.update({
        where: { id: "s2" },
        data: {
          badge: {
            create: { id: "b-new", tag: "fresh" },
            update: {
              tag: "continued",
              notes: { create: { id: "n1", body: "first" } },
            },
          },
        },
      });

      // The note hangs off the SUPPLIED badge, not off the incumbent or the decoy.
      expect(await notes(client)).toEqual([["n1", "first", "b-new"]]);
    });

    test("the continuation recurses into another supplier-plus-modify", async () => {
      const client = await connect();
      await resetSupplierContinuation(client);

      // A record series inside a record series: the outer continuation's own selected
      // record composes `create` + `update` on ITS to-one slot.
      await client.station.update({
        where: { id: "s2" },
        data: {
          badge: {
            create: { id: "b-new", tag: "fresh" },
            update: {
              tag: "continued",
              seal: {
                create: { id: "sl1", wax: "raw" },
                update: { wax: "stamped" },
              },
            },
          },
        },
      });

      expect(
        (await client.seal.findMany({})).map((row: any) => [
          row.id,
          row.wax,
          row.badgeId,
        ])
      ).toEqual([["sl1", "stamped", "b-new"]]);
      expect(await badges(client)).toEqual([
        ["b-alt", "alt", 5, null],
        ["b-new", "continued", 0, "s2"],
        ["b1", "incumbent", 1, "s1"],
      ]);
    });

    test("the continuation carries a nested relation-bearing updateMany", async () => {
      const client = await connect();
      await resetSupplierContinuation(client);

      await client.station.update({
        where: { id: "s2" },
        data: {
          badge: {
            create: {
              id: "b-new",
              tag: "fresh",
              notes: {
                createMany: {
                  data: [
                    { id: "n1", body: "a" },
                    { id: "n2", body: "b" },
                  ],
                },
              },
            },
            update: {
              notes: {
                updateMany: {
                  data: { badge: { update: { tag: "reached" } } },
                },
              },
            },
          },
        },
      });

      // The nested series ran once per captured note and both reached the same badge.
      expect(await badges(client)).toEqual([
        ["b-alt", "alt", 5, null],
        ["b-new", "reached", 0, "s2"],
        ["b1", "incumbent", 1, "s1"],
      ]);
    });

    test("an EMPTY continuation is a no-op: the supplier still lands, nothing else runs", async () => {
      const client = await connect();
      await resetSupplierContinuation(client);

      await client.station.update({
        where: { id: "s1" },
        data: {
          badge: {
            disconnect: true,
            create: { id: "b-new", tag: "fresh", rank: 2 },
            update: {},
          },
        },
      });

      expect(await badges(client)).toEqual([
        ["b-alt", "alt", 5, null],
        ["b-new", "fresh", 2, "s1"],
        ["b1", "incumbent", 1, null],
      ]);
    });

    test("the wrapper's filter rides the capture, so a filter MISS aborts the whole tree", async () => {
      const client = await connect();
      await resetSupplierContinuation(client);

      // The `{ where, data }` wrapper's `where` is a NON-unique filter the connected
      // record must satisfy. It joins the capture, so a supplied row that does not match
      // makes the capture find NO member — which is the family's target-not-found abort,
      // not a silent no-op that would leave the supplier's row behind unmodified.
      await expect(
        client.station.update({
          where: { id: "s2" },
          data: {
            badge: {
              create: { id: "b-new", tag: "fresh" },
              update: { where: { tag: "other" }, data: { rank: 9 } },
            },
          },
        })
      ).rejects.toThrow(RELATION_BADGE);

      expect(await badges(client)).toEqual([
        ["b-alt", "alt", 5, null],
        ["b1", "incumbent", 1, "s1"],
      ]);
    });

    test("an untaken upsert update arm plans the composition and writes none of it", async () => {
      const client = await connect();
      await resetSupplierContinuation(client);

      // Package H recorded this shape as one more instance of "a construction-time
      // refusal in an untaken found arm refuses the whole tree". The refusal is gone,
      // so the arm is now an ordinary untaken PLAN: the row is absent, the create arm
      // runs, and neither the supplier nor its continuation touches a badge.
      await expect(
        client.station.upsert({
          where: { id: "s-absent" },
          create: { id: "s-absent", label: "N" },
          update: {
            badge: {
              create: { id: "b-new", tag: "fresh" },
              update: { tag: "continued" },
            },
          },
        })
      ).resolves.toEqual({ id: "s-absent", label: "N" });

      expect(await badges(client)).toEqual([
        ["b-alt", "alt", 5, null],
        ["b1", "incumbent", 1, "s1"],
      ]);
    });

    test("under a guarded key transition the continuation still follows its supplier", async () => {
      const client = await connect();
      await resetSupplierContinuation(client);

      // `s2`'s slot is empty, so moving the station's own primary key is the guarded
      // (non-cascading) transition regime: every membership write is ordered AFTER the
      // root UPDATE. The supplier lands there, and the continuation has to land in the
      // same bucket — placed with the ordinary child parts it would capture before its
      // own supplier had written, and find no member at all.
      await client.station.update({
        where: { id: "s2" },
        data: {
          id: "s3",
          badge: {
            create: { id: "b-new", tag: "fresh", rank: 2 },
            update: { tag: "continued" },
          },
        },
      });

      expect(await badges(client)).toEqual([
        ["b-alt", "alt", 5, null],
        ["b-new", "continued", 2, "s3"],
        ["b1", "incumbent", 1, "s1"],
      ]);
    });

    test("a failing continuation rolls the supplier back with it", async () => {
      const client = await connect();
      await resetSupplierContinuation(client);

      // `b-alt` already holds rank 5 and the continuation moves the fresh row's id onto
      // it, so the continuation's own UPDATE loses the primary key. Nothing may survive:
      // not the fresh badge, not the station's new membership.
      await expect(
        client.station.update({
          where: { id: "s1" },
          data: {
            badge: {
              disconnect: true,
              create: { id: "b-new", tag: "fresh" },
              update: { id: "b-alt" },
            },
          },
        })
      ).rejects.toThrow(UNIQUE_CONFLICT);

      expect(await badges(client)).toEqual([
        ["b-alt", "alt", 5, null],
        ["b1", "incumbent", 1, "s1"],
      ]);
    });
  });
}

/**
 * The two shapes that stay refused, kept beside the accepted ones because the lift is
 * only honest if the neighbours it did NOT move are shown not to have moved.
 */
export function registerSupplierContinuationRefusals(
  name: string,
  connect: () => Promise<any>,
  register: (label: string, body: () => void) => void = describe
): void {
  register(`E — what supply-then-update did NOT widen (${name})`, () => {
    test("two suppliers are still one slot with two identities", async () => {
      const client = await connect();
      await resetSupplierContinuation(client);

      await expect(
        client.station.update({
          where: { id: "s1" },
          data: {
            badge: {
              connect: { id: "b-alt" },
              create: { id: "b-new", tag: "fresh" },
              update: { tag: "u" },
            },
          },
        })
      ).rejects.toThrow(
        "Unsupported to-one operation combination: create, connect, update"
      );
      expect(await badges(client)).toEqual([
        ["b-alt", "alt", 5, null],
        ["b1", "incumbent", 1, "s1"],
      ]);
    });

    test("delete + connect + update is still the own-write ledger's refusal", async () => {
      const client = await connect();
      await resetSupplierContinuation(client);

      // The `connect` half is UNCHANGED by this package: its modify is located by the
      // supplier's own selector at construction, so the analyzer still has a target read
      // to place against the sibling `delete`, and still refuses it.
      await expect(
        client.station.update({
          where: { id: "s1" },
          data: {
            badge: {
              delete: true,
              connect: { id: "b-alt" },
              update: { tag: "u" },
            },
          },
        })
      ).rejects.toThrow(
        "Nested operation 'update' on relation 'badge' depends on an earlier 'delete' target write in the same nested write. Split these operations into separate queries."
      );
      expect(await badges(client)).toEqual([
        ["b-alt", "alt", 5, null],
        ["b1", "incumbent", 1, "s1"],
      ]);
    });
  });
}
