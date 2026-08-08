import { s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * E6.7 — the COMPILE-PHASE post-transition value, as behavior every driver leg runs.
 *
 * Three shapes, measured refused at 8c2908d, construction-time, 0 statements:
 *
 *   query-engine-v2 update nested create on relation 'seats' transitions non-cascading
 *   primary key 'id' whose pre-transition value is not pinned by the unique where.
 *
 *   query-engine-v2 update does not support a compound-key nested create on relation
 *   'spots' while the root update rewrites non-cascading referenced column(s) 'code'.
 *
 *   (the same compound message for the `createMany` spelling)
 *
 * The recorded reason was never a dataflow gap — N5-U2 already proved the locate row
 * carries the pre-transition value. It was a PHASE gap, and the engine said so in its
 * own comment: "the derivation `getUpdatedPrimaryKeyValue(before, operand)` can only run
 * once `before` is known, i.e. at COMPILE. Every parent-id source the engine has is fixed
 * at construction." E6.7 builds the source that is not — `transitionedParentId`, resolved
 * through the same derivation at compile, per referenced column.
 *
 * The DECOY in every scenario is a live row sitting at the PRE-transition key. An
 * implementation that bound the vacated value does not merely write a stale string: it
 * hands the fresh child to a DIFFERENT PARENT (N5-U1b's falsification, one level up).
 */
export const compileTransitionSchema = (() => {
  // (A) single non-cascade primary key, located by a DIFFERENT unique.
  const org = s
    .model({
      id: s.string().id(),
      slug: s.string().unique(),
      seats: s.oneToMany(() => seat),
    })
    .map("e67_orgs");
  const seat = s
    .model({
      id: s.string().id(),
      name: s.string(),
      orgId: s.string().nullable(),
      org: s
        .manyToOne(() => org)
        .fields("orgId")
        .references("id")
        .optional()
        .onUpdate("setNull"),
    })
    .map("e67_seats");

  // (B) COMPOUND non-cascade referenced key; the root SET rewrites ONE member.
  const zone = s
    .model({
      region: s.string(),
      code: s.string(),
      label: s.string(),
      spots: s.oneToMany(() => spot),
    })
    .id(["region", "code"])
    .map("e67_zones");
  const spot = s
    .model({
      id: s.string().id(),
      name: s.string(),
      zoneRegion: s.string().nullable(),
      zoneCode: s.string().nullable(),
      zone: s
        .manyToOne(() => zone)
        .fields("zoneRegion", "zoneCode")
        .references("region", "code")
        .optional()
        .onUpdate("setNull"),
    })
    .map("e67_spots");

  // (C) PORTABLE ARITHMETIC on an int primary key, located by a different unique.
  const counter = s
    .model({
      id: s.int().id(),
      tag: s.string().unique(),
      ticks: s.oneToMany(() => tick),
    })
    .map("e67_counters");
  const tick = s
    .model({
      id: s.string().id(),
      counterId: s.int().nullable(),
      counter: s
        .manyToOne(() => counter)
        .fields("counterId")
        .references("id")
        .optional()
        .onUpdate("setNull"),
    })
    .map("e67_ticks");

  // (D) COMPOUND NON-primary-key referenced unique with a NULLABLE member — the one
  // spelling that reaches the compile-time operand refusal through the public client.
  const bay = s
    .model({
      id: s.string().id(),
      area: s.string(),
      slot: s.string().nullable(),
      pads: s.oneToMany(() => pad),
    })
    .unique(["area", "slot"])
    .map("e67_bays");
  const pad = s
    .model({
      id: s.string().id(),
      bayArea: s.string().nullable(),
      baySlot: s.string().nullable(),
      bay: s
        .manyToOne(() => bay)
        .fields("bayArea", "baySlot")
        .references("area", "slot")
        .optional()
        .onUpdate("setNull"),
    })
    .map("e67_pads");

  return { org, seat, zone, spot, counter, tick, bay, pad };
})();

export async function resetCompileTransition(client: any): Promise<void> {
  await client.seat.deleteMany({});
  await client.org.deleteMany({});
  await client.spot.deleteMany({});
  await client.zone.deleteMany({});
  await client.tick.deleteMany({});
  await client.counter.deleteMany({});
  await client.pad.deleteMany({});
  await client.bay.deleteMany({});
}

export function registerCompileTransitionBehavior(
  name: string,
  connect: () => Promise<any>,
  register: (label: string, body: () => void) => void = describe
): void {
  register(`E6.7 the compile-phase post-transition value (${name})`, () => {
    test("an UNPINNED single primary key: the fresh child references the NEW id", async () => {
      const client = await connect();
      await resetCompileTransition(client);
      await client.org.create({ data: { id: "o1", slug: "s1" } });
      // THE DECOY: a live org at the key `o1` is about to vacate. An implementation
      // that bound the pre-transition value hands `st1` to THIS row.
      await client.org.create({ data: { id: "o-old", slug: "decoy" } });

      await client.org.update({
        where: { slug: "s1" },
        data: { id: "o2", seats: { create: { id: "st1", name: "n" } } },
      });

      expect(
        await client.seat.findUnique({ where: { id: "st1" } })
      ).toMatchObject({ orgId: "o2" });
      // Sorted in JS, not by the database: PostgreSQL's default locale collation
      // ignores the hyphen and orders `o-old` AFTER `o2`, while PGlite and SQLite
      // compare bytes and put it first. Which rows exist is the claim; their order
      // is not, so a collation difference must not read as a write-engine one.
      expect(
        (await client.org.findMany({})).map((row: any) => row.id).sort()
      ).toEqual(["o-old", "o2"]);
    });

    test("a COMPOUND referenced key: every member takes its own post-transition value", async () => {
      const client = await connect();
      await resetCompileTransition(client);
      await client.zone.create({
        data: { region: "eu", code: "west", label: "L" },
      });
      // The decoy carries the tuple the PRE-transition binding would produce.
      await client.zone.create({
        data: { region: "eu", code: "decoy", label: "D" },
      });

      await client.zone.update({
        where: { region_code: { region: "eu", code: "west" } },
        data: { code: "east", spots: { create: { id: "sp1", name: "n" } } },
      });

      // `region` was untouched and comes back verbatim; `code` took the SET's value.
      expect(
        await client.spot.findUnique({ where: { id: "sp1" } })
      ).toMatchObject({ zoneRegion: "eu", zoneCode: "east" });
    });

    test("a COMPOUND referenced key through `createMany`", async () => {
      const client = await connect();
      await resetCompileTransition(client);
      await client.zone.create({
        data: { region: "eu", code: "west", label: "L" },
      });

      await client.zone.update({
        where: { region_code: { region: "eu", code: "west" } },
        data: {
          code: "east",
          spots: { createMany: { data: [{ id: "sp2", name: "n" }] } },
        },
      });

      expect(
        await client.spot.findUnique({ where: { id: "sp2" } })
      ).toMatchObject({ zoneRegion: "eu", zoneCode: "east" });
    });

    test("PORTABLE ARITHMETIC on the key: the compile derivation equals the SQL", async () => {
      const client = await connect();
      await resetCompileTransition(client);
      await client.counter.create({ data: { id: 10, tag: "t" } });
      // The decoy sits at the vacated key.
      await client.counter.create({ data: { id: 10_000, tag: "decoy" } });

      await client.counter.update({
        where: { tag: "t" },
        data: { id: { increment: 5 }, ticks: { create: { id: "tk1" } } },
      });

      // The root SET ran as `id = id + 5` in SQL; the fresh child bound 15 from JS.
      // If the two derivations ever disagreed, the INSERT would raise a foreign-key
      // violation rather than land quietly on a wrong row.
      expect(
        await client.tick.findUnique({ where: { id: "tk1" } })
      ).toMatchObject({ counterId: 15 });
      expect(
        (await client.counter.findMany({ orderBy: { id: "asc" } })).map(
          (row: any) => row.id
        )
      ).toEqual([15, 10_000]);
    });

    test("a NULL post-transition member STAYS refused, at compile, having written nothing", async () => {
      const client = await connect();
      await resetCompileTransition(client);
      await client.bay.create({ data: { id: "b1", area: "eu", slot: "west" } });

      // `null` names no row, so there is no post-transition value to reference. The
      // refusal is this family's typed one, raised where the operand is finally paired
      // with a located value — never the internal error `getUpdatedPrimaryKeyValue`
      // raises for the same operand.
      await expect(
        client.bay.update({
          where: { id: "b1" },
          data: { slot: null, pads: { create: { id: "p1" } } },
        })
      ).rejects.toThrow(
        "query-engine-v2 update nested create on relation 'pads' references a non-literal rewritten column 'slot'."
      );
      expect(await client.pad.findMany()).toEqual([]);
      expect((await client.bay.findMany()).map((row: any) => row.slot)).toEqual(
        ["west"]
      );
    });
  });
}
