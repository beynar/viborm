import { UnsupportedOperationError } from "@errors";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * E4-U2 — the compound-referenced child edge under a CREATE root, as behavior every
 * driver leg runs.
 *
 * `CreateOperation.edgeParentId` refused it, measured at f410d6c with 0 statements on
 * both substrates for both adopt kinds:
 *
 *   UnsupportedOperationError: query-engine-v2 create does not support a compound
 *   child edge on relation 'seats'.
 *
 * The refusal was right for the source that existed. A `ParentIdSource` carries ONE
 * value, and `fkAssignData` spent it on every foreign-key column — so a two-column edge
 * would have written the FIRST referenced value into BOTH, which is the cross-pair trap
 * D3 measured one level deeper (silent adoption by whichever row happens to hold the
 * cross-matched tuple). Deleting the arity check without a per-column source would have
 * shipped exactly that.
 *
 * E4-U2 builds the source instead: {@link PerFieldParentIdSource}, one whole-value
 * source per referenced column, KEYED BY THAT COLUMN'S NAME. The decoys below are what
 * makes that a measurement — `orgDecoy` holds the tuple a cross-matched write would
 * produce (`region = code = "eu"`), so a first-value-into-every-column regression does
 * not merely write a wrong string, it hands the child to a DIFFERENT PARENT ROW.
 */
export const compoundAdoptSchema = (() => {
  /** Both referenced columns are spelled in the parent's own create data. */
  const org = s
    .model({
      id: s.int().id(),
      region: s.string(),
      code: s.string(),
      seats: s.oneToMany(() => seat),
    })
    .map("e4u2_orgs")
    .unique(["region", "code"]);

  const seat = s
    .model({
      id: s.int().id(),
      name: s.string(),
      orgRegion: s.string().nullable(),
      orgCode: s.string().nullable(),
      org: s
        .manyToOne(() => org)
        .fields("orgRegion", "orgCode")
        .references("region", "code")
        .optional(),
    })
    .map("e4u2_seats");

  /**
   * MIXED provenance: `id` is DB-generated, so its member is a backward `Ref` to the
   * parent INSERT, while `tag` is a literal from the same create data. One source, two
   * kinds — which is the case a single-value source cannot express at all.
   */
  const crew = s
    .model({
      id: s.int().id().increment(),
      tag: s.string(),
      members: s.oneToMany(() => member),
    })
    .map("e4u2_crews")
    .unique(["id", "tag"]);

  const member = s
    .model({
      id: s.int().id(),
      name: s.string(),
      crewId: s.int().nullable(),
      crewTag: s.string().nullable(),
      crew: s
        .manyToOne(() => crew)
        .fields("crewId", "crewTag")
        .references("id", "tag")
        .optional(),
    })
    .map("e4u2_members");

  /** A NULLABLE referenced column: the per-component refusal's schema. */
  const zone = s
    .model({
      id: s.int().id(),
      area: s.string(),
      slot: s.string().nullable(),
      spots: s.oneToMany(() => spot),
    })
    .map("e4u2_zones")
    .unique(["area", "slot"]);

  const spot = s
    .model({
      id: s.int().id(),
      name: s.string(),
      zoneArea: s.string().nullable(),
      zoneSlot: s.string().nullable(),
      zone: s
        .manyToOne(() => zone)
        .fields("zoneArea", "zoneSlot")
        .references("area", "slot")
        .optional(),
    })
    .map("e4u2_zone_spots");

  return { org, seat, crew, member, zone, spot };
})();

/** Empties every table this suite writes, newest-dependency first. */
export async function resetCompoundAdopt(client: any): Promise<void> {
  await client.seat.deleteMany({});
  await client.org.deleteMany({});
  await client.member.deleteMany({});
  await client.crew.deleteMany({});
  await client.spot.deleteMany({});
  await client.zone.deleteMany({});
}

/**
 * Registers the two behaviour tests for one connection. The assertions live inside
 * `test()` here rather than in a plain helper, so every leg (PGlite transaction, PGlite
 * atomic batch, Docker MySQL, Docker PostgreSQL) reports them individually.
 */
export function registerCompoundAdoptBehavior(
  name: string,
  connect: () => Promise<any>,
  /** `describe.skip` on a leg whose database is not configured (the Docker legs). */
  register: (label: string, body: () => void) => void = describe
): void {
  register(
    `E4-U2 compound-referenced adopt under a create root (${name})`,
    () => {
      test("every referenced column takes its own value, and the decoy owns nothing", async () => {
        const client = await connect();
        await resetCompoundAdopt(client);

        // THE DECOY, seeded first: its tuple is exactly what a first-value-into-every-column
        // write would produce for every `org` below, because every one of them spells
        // `region: "eu"`. If the per-field source ever collapses, these seats land HERE.
        await client.org.create({ data: { id: 90, region: "eu", code: "eu" } });

        // ---------------------------------------------------------------------------
        // connectOrCreate — the CREATE branch (nothing matches the selector)
        // ---------------------------------------------------------------------------
        await client.org.create({
          data: {
            id: 1,
            region: "eu",
            code: "west",
            seats: {
              connectOrCreate: {
                where: { id: 100 },
                create: { id: 100, name: "minted" },
              },
            },
          },
        });
        expect(
          await client.seat.findUnique({ where: { id: 100 } })
        ).toMatchObject({
          name: "minted",
          orgRegion: "eu",
          orgCode: "west",
        });

        // ---------------------------------------------------------------------------
        // connectOrCreate — the FOUND branch (the row exists and is adopted, not described)
        // ---------------------------------------------------------------------------
        await client.seat.create({ data: { id: 200, name: "free" } });
        await client.org.create({
          data: {
            id: 2,
            region: "eu",
            code: "east",
            seats: {
              connectOrCreate: {
                where: { id: 200 },
                create: { id: 200, name: "never-minted" },
              },
            },
          },
        });
        expect(
          await client.seat.findUnique({ where: { id: 200 } })
        ).toMatchObject({
          name: "free",
          orgRegion: "eu",
          orgCode: "east",
        });

        // ---------------------------------------------------------------------------
        // upsert — both arms, on the same compound edge
        // ---------------------------------------------------------------------------
        await client.seat.create({ data: { id: 300, name: "stale" } });
        await client.org.create({
          data: {
            id: 3,
            region: "eu",
            code: "north",
            seats: {
              upsert: [
                {
                  where: { id: 300 },
                  create: { id: 300, name: "unused" },
                  update: { name: "refreshed" },
                },
                {
                  where: { id: 301 },
                  create: { id: 301, name: "created-by-upsert" },
                  update: { name: "unused" },
                },
              ],
            },
          },
        });
        expect(
          await client.seat.findMany({
            where: { orgCode: "north" },
            orderBy: { id: "asc" },
          })
        ).toMatchObject([
          { id: 300, name: "refreshed", orgRegion: "eu", orgCode: "north" },
          {
            id: 301,
            name: "created-by-upsert",
            orgRegion: "eu",
            orgCode: "north",
          },
        ]);

        // THE WRONG-ROW WITNESS. Every seat above belongs to the org that claimed it, and the
        // decoy — the only row holding the cross-matched tuple ("eu","eu") — owns none.
        expect(
          await client.seat.findMany({
            where: { orgRegion: "eu", orgCode: "eu" },
          })
        ).toEqual([]);
        expect(
          (
            await client.seat.findMany({
              orderBy: { id: "asc" },
              select: { id: true, orgRegion: true, orgCode: true },
            })
          ).map((row: any) => `${row.id}:${row.orgRegion}/${row.orgCode}`)
        ).toEqual([
          "100:eu/west",
          "200:eu/east",
          "300:eu/north",
          "301:eu/north",
        ]);

        // ---------------------------------------------------------------------------
        // MIXED components: one `Ref` (the generated parent key), one literal
        // ---------------------------------------------------------------------------
        const alpha = await client.crew.create({
          data: {
            tag: "alpha",
            members: {
              connectOrCreate: {
                where: { id: 1 },
                create: { id: 1, name: "first" },
              },
            },
          },
        });
        expect(
          await client.member.findUnique({ where: { id: 1 } })
        ).toMatchObject({
          crewId: alpha.id,
          crewTag: "alpha",
        });
        // A SECOND crew: its generated key differs, so a stale or shared Ref shows up as the
        // second member pointing at the first crew.
        const beta = await client.crew.create({
          data: {
            tag: "beta",
            members: {
              connectOrCreate: {
                where: { id: 2 },
                create: { id: 2, name: "second" },
              },
            },
          },
        });
        expect(beta.id).not.toBe(alpha.id);
        expect(
          await client.member.findUnique({ where: { id: 2 } })
        ).toMatchObject({
          crewId: beta.id,
          crewTag: "beta",
        });
      }, 120_000);

      test("a component with no knowable value refuses, naming that component", async () => {
        const client = await connect();
        await resetCompoundAdopt(client);
        let caught: unknown;
        try {
          await client.zone.create({
            data: {
              id: 1,
              area: "a",
              slot: null,
              spots: {
                connectOrCreate: {
                  where: { id: 1 },
                  create: { id: 1, name: "s" },
                },
              },
            },
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(UnsupportedOperationError);
        expect((caught as Error).message).toBe(
          "query-engine-v2 create cannot resolve the parent id for relation 'spots': referenced field 'slot' is neither this record's primary key nor a knowable value in its own create data."
        );
        // Nothing was written: the refusal is a construction decision.
        expect(await client.zone.findMany({})).toEqual([]);
        expect(await client.spot.findMany({})).toEqual([]);
      }, 120_000);
    }
  );
}
