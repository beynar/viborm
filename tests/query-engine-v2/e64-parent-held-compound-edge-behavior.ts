import { s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * E6.4 (the `~2457` compound half) — a parent-held to-one `update` / `delete` /
 * `upsert` across a COMPOUND edge, as behavior every driver leg runs.
 *
 * Measured at 8c2908d, construction-time, 0 statements on both substrates:
 *
 *   UnsupportedOperationError: query-engine-v2 update supports only a single-field
 *   reference for 'update' on the parent-held to-one relation 'depot'.
 *   … for 'delete' …
 *   … for 'upsert' …
 *
 * The same measurement run also drove `connect`, `disconnect` and `create` on the
 * VERY SAME compound edge, and all three executed. That is what makes the refusal a
 * conflation rather than a boundary: `parentHeldCorrelationFilters` already emits one
 * conjunct per referenced column, index-aligned with the parent FK column it reads —
 * the identical per-field loop the three executing kinds use. The single value in the
 * ledger is the CHILD'S OWN PRIMARY KEY (what the probe captures and the arm's write
 * addresses), and its arity is a fact about the child model, not about the edge. The
 * guard now asserts only that fact.
 *
 * THE DECOYS ARE THE MEASUREMENT. `depotRegionTwin` agrees with the target on the
 * REGION alone and `depotCodeTwin` on the CODE alone, so an implementation that spent
 * one member on both columns, or that compared only the first, does not write a wrong
 * string — it mutates, deletes, or adopts A DIFFERENT ROW.
 *
 * THE NULL MEMBER NEEDS NO CARVE-OUT, and that is a measurement rather than a hope. The
 * parse admits a half-null parent foreign key (both columns are ordinary nullable
 * scalars — nothing here goes through a compound where-unique), and the correlation is a
 * plain conjunction of equalities, so SQL's three-valued logic answers it with zero rows.
 * Measured at 58271e2: `update` raises the family's OWN typed
 * `Cannot update relation 'depot': target record was not found for this parent.`,
 * `delete` nulls the surviving parent column and removes nothing, `upsert` takes its
 * absent arm — and in all three the twin that AGREES on the surviving member is
 * untouched. That is Prisma's "a partially-null foreign key is no relation", reached
 * without an engine guard, so adding one would be the redundant second guard the rules
 * forbid. The test below is what keeps it true.
 */
export const parentHeldCompoundEdgeSchema = (() => {
  const depot = s
    .model({
      id: s.string().id(),
      region: s.string(),
      code: s.string(),
      note: s.string(),
      stations: s.oneToMany(() => station),
    })
    .map("e64_depots")
    .unique(["region", "code"]);

  const station = s
    .model({
      id: s.string().id(),
      label: s.string(),
      depotRegion: s.string().nullable(),
      depotCode: s.string().nullable(),
      depot: s
        .manyToOne(() => depot)
        .fields("depotRegion", "depotCode")
        .references("region", "code")
        .optional(),
    })
    .map("e64_stations");

  /** The half of the compound-identity family this unit does NOT absorb: a child
   *  whose OWN primary key is compound, so the probe cannot capture one handle. */
  const berth = s
    .model({
      tenantId: s.string(),
      slot: s.string(),
      note: s.string(),
      docks: s.oneToMany(() => dock),
    })
    .id(["tenantId", "slot"])
    .map("e64_berths");

  const dock = s
    .model({
      id: s.string().id(),
      berthTenant: s.string().nullable(),
      berthSlot: s.string().nullable(),
      berth: s
        .manyToOne(() => berth)
        .fields("berthTenant", "berthSlot")
        .references("tenantId", "slot")
        .optional(),
    })
    .map("e64_docks");

  return { depot, station, berth, dock };
})();

/** Empties every table this suite writes, dependent side first. */
export async function resetParentHeldCompoundEdge(client: any): Promise<void> {
  await client.station.deleteMany({});
  await client.depot.deleteMany({});
  await client.dock.deleteMany({});
  await client.berth.deleteMany({});
}

/** Target + the two one-member twins, plus the station pointing at the target. */
async function seed(client: any): Promise<void> {
  await resetParentHeldCompoundEdge(client);
  await client.depot.create({
    data: { id: "d-target", region: "eu", code: "west", note: "before" },
  });
  // Agrees on REGION only.
  await client.depot.create({
    data: { id: "d-region-twin", region: "eu", code: "east", note: "before" },
  });
  // Agrees on CODE only.
  await client.depot.create({
    data: { id: "d-code-twin", region: "us", code: "west", note: "before" },
  });
  await client.station.create({
    data: {
      id: "s1",
      label: "L",
      depotRegion: "eu",
      depotCode: "west",
    },
  });
}

async function depots(client: any): Promise<Record<string, string>> {
  const rows = await client.depot.findMany({ orderBy: { id: "asc" } });
  return Object.fromEntries(
    rows.map((row: any) => [row.id as string, row.note as string])
  );
}

/**
 * Registers the behaviour tests for one connection. The assertions live inside
 * `test()` here rather than in a plain helper, so every leg (PGlite transaction,
 * PGlite atomic batch, Docker MySQL, Docker PostgreSQL) reports them individually.
 */
export function registerParentHeldCompoundEdgeBehavior(
  name: string,
  connect: () => Promise<any>,
  /** `describe.skip` on a leg whose database is not configured (the Docker legs). */
  register: (label: string, body: () => void) => void = describe
): void {
  register(`E6.4 parent-held to-one over a compound edge (${name})`, () => {
    test("update mutates the row BOTH members name, and neither twin", async () => {
      const client = await connect();
      await seed(client);

      await client.station.update({
        where: { id: "s1" },
        data: { depot: { update: { note: "moved" } } },
      });

      expect(await depots(client)).toEqual({
        "d-code-twin": "before",
        "d-region-twin": "before",
        "d-target": "moved",
      });
    });

    test("delete nulls EVERY parent FK column and removes only the named row", async () => {
      const client = await connect();
      await seed(client);

      await client.station.update({
        where: { id: "s1" },
        data: { depot: { delete: true } },
      });

      expect(
        await client.station.findUnique({ where: { id: "s1" } })
      ).toMatchObject({ depotRegion: null, depotCode: null });
      expect(await depots(client)).toEqual({
        "d-code-twin": "before",
        "d-region-twin": "before",
      });
    });

    test("upsert takes its FOUND arm on the row both members name", async () => {
      const client = await connect();
      await seed(client);

      await client.station.update({
        where: { id: "s1" },
        data: {
          depot: {
            upsert: {
              update: { note: "found-arm" },
              create: {
                id: "d-minted",
                region: "eu",
                code: "west",
                note: "unused",
              },
            },
          },
        },
      });

      expect(await depots(client)).toEqual({
        "d-code-twin": "before",
        "d-region-twin": "before",
        "d-target": "found-arm",
      });
    });

    test("upsert takes its ABSENT arm and rebinds EVERY parent FK column", async () => {
      const client = await connect();
      await seed(client);
      await client.station.update({
        where: { id: "s1" },
        data: { depotRegion: null, depotCode: null },
      });

      await client.station.update({
        where: { id: "s1" },
        data: {
          depot: {
            upsert: {
              update: { note: "unused" },
              create: {
                id: "d-minted",
                region: "af",
                code: "south",
                note: "absent-arm",
              },
            },
          },
        },
      });

      expect(
        await client.station.findUnique({ where: { id: "s1" } })
      ).toMatchObject({ depotRegion: "af", depotCode: "south" });
      expect(await depots(client)).toEqual({
        "d-code-twin": "before",
        "d-minted": "absent-arm",
        "d-region-twin": "before",
        "d-target": "before",
      });
    });

    test("a NULL member makes the edge name NO target, on all three kinds", async () => {
      const client = await connect();
      await seed(client);
      // One member kept, one nulled. `d-region-twin` AGREES on the surviving member,
      // so an implementation that dropped the null conjunct — or that compared only
      // the members it could see — would find a row here.
      await client.station.update({
        where: { id: "s1" },
        data: { depotCode: null },
      });

      // `update` gets the family's OWN typed not-found, not a raw driver error and
      // not a wrong row: SQL's three-valued logic answers the correlated probe with
      // zero rows and the probe's postcondition attributes it.
      await expect(
        client.station.update({
          where: { id: "s1" },
          data: { depot: { update: { note: "must-not-land" } } },
        })
      ).rejects.toThrow(
        "Cannot update relation 'depot': target record was not found for this parent."
      );
      expect(await depots(client)).toEqual({
        "d-code-twin": "before",
        "d-region-twin": "before",
        "d-target": "before",
      });

      // `delete` nulls the remaining parent column and removes NOTHING: the
      // correlated DELETE matches no row, and the one-member twin is not it.
      await client.station.update({
        where: { id: "s1" },
        data: { depot: { delete: true } },
      });
      expect(
        await client.station.findUnique({ where: { id: "s1" } })
      ).toMatchObject({ depotRegion: null, depotCode: null });
      expect(await depots(client)).toEqual({
        "d-code-twin": "before",
        "d-region-twin": "before",
        "d-target": "before",
      });

      // `upsert` takes its ABSENT arm for the same reason and rebinds both columns.
      await client.station.update({
        where: { id: "s1" },
        data: { depotRegion: "eu", depotCode: null },
      });
      await client.station.update({
        where: { id: "s1" },
        data: {
          depot: {
            upsert: {
              update: { note: "must-not-land" },
              create: {
                id: "d-minted",
                region: "af",
                code: "south",
                note: "absent-arm",
              },
            },
          },
        },
      });
      expect(
        await client.station.findUnique({ where: { id: "s1" } })
      ).toMatchObject({ depotRegion: "af", depotCode: "south" });
      expect(await depots(client)).toEqual({
        "d-code-twin": "before",
        "d-minted": "absent-arm",
        "d-region-twin": "before",
        "d-target": "before",
      });
    });

    test("a child with a COMPOUND primary key keeps the (narrowed) refusal", async () => {
      const client = await connect();
      await resetParentHeldCompoundEdge(client);
      await client.berth.create({
        data: { tenantId: "t1", slot: "s1", note: "n" },
      });
      await client.dock.create({
        data: { id: "k1", berthTenant: "t1", berthSlot: "s1" },
      });

      await expect(
        client.dock.update({
          where: { id: "k1" },
          data: { berth: { update: { note: "n2" } } },
        })
      ).rejects.toThrow(
        "query-engine-v2 update requires a child with one primary key for 'update' on the parent-held to-one relation 'berth'."
      );
      // Unchanged: the refusal is at construction, so nothing was written.
      expect(
        await client.berth.findUnique({
          where: { tenantId_slot: { tenantId: "t1", slot: "s1" } },
        })
      ).toMatchObject({ note: "n" });
    });
  });
}
