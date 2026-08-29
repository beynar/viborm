import { hydrateSchemaNames, s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * E5-U2 — **the owned foreign key spelled beside the relation, THE AGREE CASE**, at the
 * parent-held adopt seam (`RelationUpsertPart.buildOneUpsertPart`).
 *
 * Measured at 18ecf0d, through the public client, on every spelling:
 *
 *   UnsupportedOperationError: Relation 'things' owns 'ownerId'; omit it from nested
 *   create and update data.
 *
 * D4 gave that rule one message and one construction site, and the rule is right about a
 * value that DISAGREES: the engine derives the column from the row the enclosing step
 * acted on, so a second, different value for it is a second provenance. A value that
 * AGREES is not a second provenance — it is the same value said twice — and refusing it
 * refuses nothing the engine could get wrong. E5-U2 drops the agreeing spelling before
 * either arm is separated, so the fold stays the single provenance, and keeps D4's
 * message byte-for-byte for everything else.
 *
 * TWO MEASURED WALLS bound what "everything" means here, both pinned below:
 *
 *  1. **The nested CREATE arm cannot spell the owned FK at all.** The create-context
 *     relation schema is `CreateWithOmittedFk` (`src/validation/relations/create.ts`) —
 *     it `v.omit`s the inverse relation's foreign-key fields — so `create: { ownerId }`
 *     under `upsert` / `connectOrCreate` / `create` is a `ValidationError: … Unknown
 *     key: ownerId` at the parse boundary, one layer above this seam. The agreement
 *     decision still covers that payload (it is taken once, on both objects, before
 *     `separateData`, so the fresh create SUBTREE is handed the same stripped object its
 *     incoming membership folds into) — but no client payload exercises it.
 *  2. **Only a `literal` parent source is comparable at construction.** The UPDATE root
 *     hands its children a `planned` source (the located row, read at planning) and a
 *     create root with a DB-generated key hands a `ref` (produced by an INSERT that has
 *     not run). Neither has a value to compare, so both keep the refusal. What is left,
 *     and what the agreement absorbs, is the create root whose own key is SPELLED.
 *
 *     PACKAGE N1 NARROWED THIS, measured: nested UPDATE data is now built from the same
 *     omitted-FK owner nested create data is, EXCEPT in a create context's to-many
 *     `upsert` arm — kept precisely because the absorb above is a capability and this is
 *     the only parent that can supply a comparable value. So a `planned` source no longer
 *     reaches this seam at all (an update root answers `Unknown key` first, pinned below
 *     as its own WALL), and the `ref` source is what still exercises the
 *     no-value-to-compare arm.
 */
/**
 * The shared decimal domain of this fixture's key pair.
 *
 * SQLite-legal (`precision + scale <= 18`), because these behaviors register on
 * every provider, and EQUAL on both sides of the reference: a decimal field
 * reference is only meaningful between two columns with the same precision and
 * scale.
 */
const MONEY = { precision: 16, scale: 2 } as const;

export const adoptOwnedFkSchema = (() => {
  // The main pair: a spelled STRING parent key (a `literal` source) and a NULLABLE child
  // foreign key, so `null` reaches the engine instead of dying at the parse boundary.
  const owner = s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      things: s.toMany(() => thing),
    })
    .map("e5u2_owners");

  const thing = s
    .model({
      id: s.string().id(),
      slug: s.string().unique(),
      label: s.string().default("x"),
      ownerId: s.string().nullable().map("owner_fk"),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
      notes: s.toMany(() => note),
    })
    .map("e5u2_things");

  const note = s
    .model({
      id: s.string().id(),
      body: s.string(),
      thingId: s.string(),
      thing: s
        .toOne(() => thing)
        .fields("thingId")
        .references("id"),
    })
    .map("e5u2_notes");

  // A DB-GENERATED parent key: the child edge's source is a `ref`, so there is no value
  // to compare at construction.
  const genOwner = s
    .model({
      id: s.int().id().increment(),
      email: s.string().unique(),
      items: s.toMany(() => item),
    })
    .map("e5u2_gen_owners");

  const item = s
    .model({
      id: s.string().id(),
      slug: s.string().unique(),
      genId: s.int(),
      genOwner: s
        .toOne(() => genOwner)
        .fields("genId")
        .references("id"),
    })
    .map("e5u2_items");

  // A COMPOUND edge.
  const pair = s
    .model({
      a: s.string(),
      b: s.string(),
      email: s.string().unique(),
      kids: s.toMany(() => kid),
    })
    .id(["a", "b"])
    .map("e5u2_pairs");

  const kid = s
    .model({
      id: s.string().id(),
      slug: s.string().unique(),
      pa: s.string(),
      pb: s.string(),
      pair: s
        .toOne(() => pair)
        .fields("pa", "pb")
        .references("a", "b"),
    })
    .map("e5u2_kids");

  // M6's referenced-scalar table, one spelled-key pair per type.
  const intOwner = s
    .model({ id: s.int().id(), rows: s.toMany(() => intRow) })
    .map("e5u2_int_owners");
  const intRow = s
    .model({
      id: s.string().id(),
      slug: s.string().unique(),
      oid: s.int(),
      owner: s
        .toOne(() => intOwner)
        .fields("oid")
        .references("id"),
    })
    .map("e5u2_int_rows");

  const bigOwner = s
    .model({ id: s.bigInt().id(), rows: s.toMany(() => bigRow) })
    .map("e5u2_big_owners");
  const bigRow = s
    .model({
      id: s.string().id(),
      slug: s.string().unique(),
      oid: s.bigInt(),
      owner: s
        .toOne(() => bigOwner)
        .fields("oid")
        .references("id"),
    })
    .map("e5u2_big_rows");

  const timeOwner = s
    .model({ at: s.dateTime().id(), rows: s.toMany(() => timeRow) })
    .map("e5u2_time_owners");
  const timeRow = s
    .model({
      id: s.string().id(),
      slug: s.string().unique(),
      atRef: s.dateTime(),
      owner: s
        .toOne(() => timeOwner)
        .fields("atRef")
        .references("at"),
    })
    .map("e5u2_time_rows");

  const moneyOwner = s
    .model({ amount: s.decimal(MONEY).id(), rows: s.toMany(() => moneyRow) })
    .map("e5u2_money_owners");
  const moneyRow = s
    .model({
      id: s.string().id(),
      slug: s.string().unique(),
      amt: s.decimal(MONEY),
      owner: s
        .toOne(() => moneyOwner)
        .fields("amt")
        .references("amount"),
    })
    .map("e5u2_money_rows");

  return {
    owner,
    thing,
    note,
    genOwner,
    item,
    pair,
    kid,
    intOwner,
    intRow,
    bigOwner,
    bigRow,
    timeOwner,
    timeRow,
    moneyOwner,
    moneyRow,
  };
})();

hydrateSchemaNames(adoptOwnedFkSchema);

const OWNED =
  "Relation 'things' owns 'ownerId'; omit it from nested create and update data.";

async function reset(client: any): Promise<void> {
  await client.note.deleteMany({});
  await client.thing.deleteMany({});
  await client.owner.deleteMany({});
  await client.item.deleteMany({});
  await client.genOwner.deleteMany({});
  await client.kid.deleteMany({});
  await client.pair.deleteMany({});
  await client.intRow.deleteMany({});
  await client.intOwner.deleteMany({});
  await client.bigRow.deleteMany({});
  await client.bigOwner.deleteMany({});
  await client.timeRow.deleteMany({});
  await client.timeOwner.deleteMany({});
  await client.moneyRow.deleteMany({});
  await client.moneyOwner.deleteMany({});
}

/** A DECOY owner that already holds the target: an adopt that reads the spelled key
 *  instead of the fold's would leave the target where it was. */
async function seedDecoy(client: any, slug: string): Promise<string> {
  await client.owner.create({ data: { id: "decoy", email: "decoy@x" } });
  await client.thing.create({
    data: { id: `t-${slug}`, slug, ownerId: "decoy" },
  });
  return "decoy";
}

export function registerAdoptOwnedFkBehavior(
  name: string,
  connect: () => Promise<any>,
  register: (label: string, body: () => void) => void = describe
): void {
  register(`E5-U2 the agreeing owned FK at the adopt seam (${name})`, () => {
    test("AGREE, spelled bare: the payload is accepted and the target is reparented", async () => {
      const client = await connect();
      await reset(client);
      await seedDecoy(client, "bare");

      await client.owner.create({
        data: {
          id: "o1",
          email: "o1@x",
          things: {
            upsert: {
              where: { slug: "bare" },
              create: { id: "never", slug: "bare" },
              update: { label: "y", ownerId: "o1" },
            },
          },
        },
      });

      expect(
        await client.thing.findUnique({ where: { slug: "bare" } })
      ).toMatchObject({ ownerId: "o1", label: "y" });
      expect(await client.thing.count({ where: { ownerId: "decoy" } })).toBe(0);
    }, 120_000);

    test("AGREE, spelled as { set }: the same decision", async () => {
      const client = await connect();
      await reset(client);
      await seedDecoy(client, "wrapped");

      await client.owner.create({
        data: {
          id: "o2",
          email: "o2@x",
          things: {
            upsert: {
              where: { slug: "wrapped" },
              create: { id: "never", slug: "wrapped" },
              update: { ownerId: { set: "o2" } },
            },
          },
        },
      });

      expect(
        await client.thing.findUnique({ where: { slug: "wrapped" } })
      ).toMatchObject({ ownerId: "o2" });
    }, 120_000);

    test("AGREE beside a relation-carrying create arm (the freshArm subtree)", async () => {
      // The ABSENT arm is the create SUBTREE, and it is handed the same object the
      // agreement decision ran on. Its root INSERT folds the parent key through
      // incoming membership; nothing in the payload competes with it.
      const client = await connect();
      await reset(client);

      await client.owner.create({
        data: {
          id: "o3",
          email: "o3@x",
          things: {
            upsert: {
              where: { slug: "fresh" },
              create: {
                id: "t-fresh",
                slug: "fresh",
                notes: { create: { id: "n-fresh", body: "b" } },
              },
              update: { ownerId: "o3", label: "unused" },
            },
          },
        },
      });

      expect(
        await client.thing.findUnique({ where: { slug: "fresh" } })
      ).toMatchObject({ id: "t-fresh", ownerId: "o3" });
      expect(
        await client.note.findUnique({ where: { id: "n-fresh" } })
      ).toMatchObject({ thingId: "t-fresh" });
    }, 120_000);

    test("DISAGREE is refused, and nothing is written", async () => {
      const client = await connect();
      await reset(client);
      await seedDecoy(client, "clash");

      await expect(
        client.owner.create({
          data: {
            id: "o4",
            email: "o4@x",
            things: {
              upsert: {
                where: { slug: "clash" },
                create: { id: "never", slug: "clash" },
                update: { ownerId: "somebody-else" },
              },
            },
          },
        })
      ).rejects.toThrow(OWNED);

      expect(await client.owner.count({ where: { id: "o4" } })).toBe(0);
      expect(
        await client.thing.findUnique({ where: { slug: "clash" } })
      ).toMatchObject({ ownerId: "decoy" });
    }, 120_000);

    test("null is refused — an FK equal to NULL references no row", async () => {
      const client = await connect();
      await reset(client);
      await seedDecoy(client, "nulled");
      await expect(
        client.owner.create({
          data: {
            id: "o5",
            email: "o5@x",
            things: {
              upsert: {
                where: { slug: "nulled" },
                create: { id: "never", slug: "nulled" },
                update: { ownerId: null },
              },
            },
          },
        })
      ).rejects.toThrow(OWNED);
    }, 120_000);

    test("WALL: an UPDATE root cannot spell the owned FK in the upsert arm either", async () => {
      // Package N1 — this used to be "a PLANNED parent source keeps the refusal", and
      // it did, HERE: the update root hands its children the located row, which has no
      // value at construction to agree with. N1 answers the same payload one layer up,
      // because `update.ts`'s upsert arm is now built from the omitted-FK owner too, so
      // an UPDATE root's nested update data cannot name the column at all. The fact the
      // old test recorded — an update root may not spell it — is unchanged and now
      // holds by construction; what moved is which boundary says so. The seam's own
      // `planned` branch is therefore no longer reachable through this family, and the
      // `ref` branch below is what keeps the no-comparable-value arm honest.
      const client = await connect();
      await reset(client);
      await client.owner.create({ data: { id: "o6", email: "o6@x" } });
      await seedDecoy(client, "planned");
      await expect(
        client.owner.update({
          where: { id: "o6" },
          data: {
            things: {
              upsert: {
                where: { slug: "planned" },
                create: { id: "never", slug: "planned" },
                update: { ownerId: "o6" },
              },
            },
          },
        })
      ).rejects.toThrow("Unknown key: ownerId");
      // Nothing was written: the decoy still owns the row.
      expect(
        await client.thing.findUnique({ where: { slug: "planned" } })
      ).toMatchObject({ ownerId: "decoy" });
    }, 120_000);

    test("a REF parent source (a generated create-root key) keeps the refusal", async () => {
      const client = await connect();
      await reset(client);
      await expect(
        client.genOwner.create({
          data: {
            email: "g@x",
            items: {
              upsert: {
                where: { slug: "gen" },
                create: { id: "never", slug: "gen" },
                update: { genId: 1 },
              },
            },
          },
        })
      ).rejects.toThrow(
        "Relation 'items' owns 'genId'; omit it from nested create and update data."
      );
    }, 120_000);

    test("an arithmetic envelope on the owned FK keeps the refusal", async () => {
      const client = await connect();
      await reset(client);
      await client.intOwner.create({ data: { id: 5 } });
      await client.intRow.create({ data: { id: "r0", slug: "inc", oid: 5 } });
      await expect(
        client.intOwner.create({
          data: {
            id: 6,
            rows: {
              upsert: {
                where: { slug: "inc" },
                create: { id: "never", slug: "inc" },
                update: { oid: { increment: 1 } },
              },
            },
          },
        })
      ).rejects.toThrow(
        "Relation 'rows' owns 'oid'; omit it from nested create and update data."
      );
    }, 120_000);

    test("a COMPOUND edge accepts agreeing partial and complete spellings", async () => {
      const client = await connect();
      await reset(client);
      await client.pair.create({
        data: { a: "old", b: "pair", email: "old@x" },
      });
      await client.kid.create({
        data: {
          id: "k-half",
          slug: "half",
          pa: "old",
          pb: "pair",
        },
      });
      await client.kid.create({
        data: {
          id: "k-whole",
          slug: "whole",
          pa: "old",
          pb: "pair",
        },
      });

      await client.pair.create({
        data: {
          a: "a1",
          b: "b1",
          email: "p1@x",
          kids: {
            upsert: {
              where: { slug: "half" },
              create: { id: "never-half", slug: "half" },
              update: { pa: "a1" },
            },
          },
        },
      });
      await client.pair.create({
        data: {
          a: "a2",
          b: "b2",
          email: "p2@x",
          kids: {
            upsert: {
              where: { slug: "whole" },
              create: { id: "never-whole", slug: "whole" },
              update: { pa: "a2", pb: "b2" },
            },
          },
        },
      });

      expect(
        await client.kid.findMany({
          where: { slug: { in: ["half", "whole"] } },
          orderBy: { slug: "asc" },
          select: { slug: true, pa: true, pb: true },
        })
      ).toEqual([
        { slug: "half", pa: "a1", pb: "b1" },
        { slug: "whole", pa: "a2", pb: "b2" },
      ]);
    }, 120_000);

    test("WALL: a nested CREATE arm cannot spell the owned FK — the parse boundary omits it", async () => {
      const client = await connect();
      await reset(client);
      // The same wall for both members of the adopt family, so the seam's create half
      // is unreachable through the public client.
      await expect(
        client.owner.create({
          data: {
            id: "o7",
            email: "o7@x",
            things: {
              upsert: {
                where: { slug: "walled" },
                create: { id: "t-walled", slug: "walled", ownerId: "o7" },
                update: { label: "y" },
              },
            },
          },
        })
      ).rejects.toThrow("Unknown key: ownerId");
      await expect(
        client.owner.create({
          data: {
            id: "o8",
            email: "o8@x",
            things: {
              connectOrCreate: {
                where: { slug: "walled2" },
                create: { id: "t-walled2", slug: "walled2", ownerId: "o8" },
              },
            },
          },
        })
      ).rejects.toThrow("Unknown key: ownerId");
    }, 120_000);

    // ─────────────────────────────────────────────────────────────────────────
    // M6's referenced-scalar table. Every operand on both sides is what the parse
    // boundary produced, so an instance-typed value never reaches the comparator and
    // `fkEquals` (with its bigint normalization) is the whole of it.
    // ─────────────────────────────────────────────────────────────────────────
    test("AGREE on an int referenced key", async () => {
      const client = await connect();
      await reset(client);
      await client.intOwner.create({ data: { id: 1 } });
      await client.intRow.create({ data: { id: "i0", slug: "i", oid: 1 } });
      await client.intOwner.create({
        data: {
          id: 2,
          rows: {
            upsert: {
              where: { slug: "i" },
              create: { id: "never", slug: "i" },
              update: { oid: 2 },
            },
          },
        },
      });
      expect(
        await client.intRow.findUnique({ where: { slug: "i" } })
      ).toMatchObject({ oid: 2 });
    }, 120_000);

    test("AGREE on a bigInt referenced key", async () => {
      const client = await connect();
      await reset(client);
      await client.bigOwner.create({ data: { id: 1n } });
      await client.bigRow.create({ data: { id: "b0", slug: "b", oid: 1n } });
      await client.bigOwner.create({
        data: {
          id: 2n,
          rows: {
            upsert: {
              where: { slug: "b" },
              create: { id: "never", slug: "b" },
              update: { oid: 2n },
            },
          },
        },
      });
      expect(
        (await client.bigRow.findUnique({ where: { slug: "b" } })).oid
      ).toBe(2n);
    }, 120_000);

    test("AGREE on a dateTime referenced key", async () => {
      // The comparison succeeds because both operands are the canonical ISO string the
      // parse boundary produced (M6's ALL-CANONICAL measurement; a refusal would be an
      // `UnsupportedOperationError` at CONSTRUCTION, before any statement). Until
      // U-E6.0 the agreement could only be pinned at compile: the reparent write one
      // statement later carried a SEPARATE, pre-existing destination-cast defect
      // (`SET "atRef" = CAST(? AS TEXT)` — PostgreSQL 42804 against a `timestamptz`
      // column, and the ISO `Z` spelling MySQL's `DATETIME` rejects). That defect is
      // fixed, so this witness now says what it always wanted to: the agreeing spelling
      // reparents the row, and the row carries the new key.
      const client = await connect();
      await reset(client);
      const first = new Date("2020-01-01T00:00:00.000Z");
      const second = new Date("2021-06-02T03:04:05.000Z");
      await client.timeOwner.create({ data: { at: first } });
      await client.timeRow.create({
        data: { id: "d0", slug: "d", atRef: first },
      });
      await client.timeOwner.create({
        data: {
          at: second,
          rows: {
            upsert: {
              where: { slug: "d" },
              create: { id: "never", slug: "d" },
              update: { atRef: second },
            },
          },
        },
      });
      const moved = await client.timeRow.findUnique({ where: { slug: "d" } });
      expect(moved.id).toBe("d0");
      expect(new Date(moved.atRef).toISOString()).toBe(second.toISOString());
    }, 120_000);

    test("AGREE on a decimal referenced key", async () => {
      const client = await connect();
      await reset(client);
      await client.moneyOwner.create({ data: { amount: "1.50" } });
      await client.moneyRow.create({
        data: { id: "m0", slug: "m", amt: "1.50" },
      });
      await client.moneyOwner.create({
        data: {
          amount: "2.75",
          rows: {
            upsert: {
              where: { slug: "m" },
              create: { id: "never", slug: "m" },
              update: { amt: "2.75" },
            },
          },
        },
      });
      expect(
        String((await client.moneyRow.findUnique({ where: { slug: "m" } })).amt)
      ).toBe("2.75");
    }, 120_000);
  });
}
